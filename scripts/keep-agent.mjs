#!/usr/bin/env node
/**
 * Keeps one agent running on this machine, and keeps it on the current release.
 *
 * `scripts/self-update.mjs` is the scheduled half of this job, and it stops
 * short on purpose: it pulls, then exits 10 to *ask* for a restart, because a
 * script a scheduler runs does not own the agent process and has no business
 * bouncing it. This one owns it — it started it — so it can do both, and a
 * laptop needs no NSSM service, no systemd unit and no scheduled task to stay
 * in the fleet on the code everyone else is running.
 *
 * Forever, then:
 *
 *   - runs the agent **from the checkout it is keeping current**, so a restart
 *     after a pull is running the new code and not the old;
 *   - restarts it when it dies, with backoff;
 *   - every `--interval-ms`, fetches and fast-forwards that checkout under the
 *     three rules self-update.mjs will not break — it shells out to that script
 *     rather than reimplementing them — and restarts the agent if the pull
 *     moved something.
 *
 * Four things it will not do:
 *
 *   - **Come back from a stand-down.** An agent that exits on its own having
 *     been told `410 stand_down` is not a crash: another process on this
 *     machine holds this worker's registration. Respawning is precisely the
 *     eviction loop the stand-down exists to end, so the supervisor stops too.
 *   - **Restart anything it did not start.** `--also-repo` keeps other
 *     checkouts current and says so; whatever runs them is somebody else's to
 *     bounce. Deciding to restart the thing your household is talking to is not
 *     a supervisor's call.
 *   - **Update over somebody's work.** A dirty checkout stops the *update*, not
 *     the agent: the worker goes on running what it has, and the next tick
 *     tries again.
 *   - **Kill an agent mid-task.** A restart asks over IPC and waits out the
 *     drain, so results already in flight are reported before the worker says
 *     it is leaving.
 *
 * Usage:
 *   node scripts/keep-agent.mjs [--repo <path>] [--interval-ms <ms>]
 *                               [--remote <name>] [--also-repo <path>]...
 *                               [--stop-timeout-ms <ms>]
 *
 * Exit codes:
 *   0   asked to stop (signal), or stood down for another agent on this machine
 *   1   could not start: bad arguments, or no agent in --repo
 */

import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { backoffDelay, sleep } from '../src/common/backoff.js';
import { createLogger } from '../src/common/log.js';
import { AGENT_SHUTDOWN_MESSAGE } from '../src/common/protocol.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF_UPDATE = resolve(HERE, 'self-update.mjs');
const log = createLogger('agent:keeper');

// Three hours. Releases here are not an emergency — the point is that a laptop
// nobody touches is never more than one nap behind the fleet, not that it is
// current to the minute. Checking harder would mean a `git fetch` per machine
// per few minutes for a repository that changes a few times a week.
const DEFAULT_INTERVAL_MS = 3 * 60 * 60 * 1000;

// Long enough for the agent's own drain (SHUTDOWN_DRAIN_MS plus its 3s
// force-exit budget) with room for a task that is slow to report.
const DEFAULT_STOP_TIMEOUT_MS = 20_000;

const EXIT_OK = 0;
const EXIT_FAILED = 1;

function parseArgs(argv) {
  const options = {
    repo: resolve(HERE, '..'),
    remote: 'origin',
    intervalMs: DEFAULT_INTERVAL_MS,
    stopTimeoutMs: DEFAULT_STOP_TIMEOUT_MS,
    alsoRepos: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') options.repo = resolve(argv[++i] ?? '');
    else if (arg === '--remote') options.remote = argv[++i] ?? 'origin';
    else if (arg === '--also-repo') options.alsoRepos.push(resolve(argv[++i] ?? ''));
    else if (arg === '--interval-ms') options.intervalMs = positiveInt(arg, argv[++i]);
    else if (arg === '--stop-timeout-ms') options.stopTimeoutMs = positiveInt(arg, argv[++i]);
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  return options;
}

function positiveInt(name, raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** Runs self-update.mjs against one checkout. Its exit code is the interface. */
function selfUpdate(repo, remote) {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [SELF_UPDATE, '--repo', repo, '--remote', remote, '--json'],
      { encoding: 'utf8', timeout: 300_000, windowsHide: true },
      (error, stdout) => {
        const exitCode = typeof error?.code === 'number' ? error.code : error ? 1 : 0;
        try {
          resolvePromise({ exitCode, ...JSON.parse(stdout) });
        } catch {
          resolvePromise({ exitCode, ok: false, reason: error?.message ?? 'no result from self-update' });
        }
      },
    );
  });
}

class AgentKeeper {
  #options;
  #entry;
  #child = null;
  #expectedExit = false;
  #stopping = false;
  #wake = null;

  constructor(options) {
    this.#options = options;
    // The agent is taken from the checkout being kept current, not from
    // wherever this script happens to live. They are normally the same
    // directory; when --repo says otherwise, running the *updated* code is the
    // whole point of the restart.
    this.#entry = resolve(options.repo, 'src/agent/index.js');
  }

  get entry() {
    return this.#entry;
  }

  async run() {
    if (!existsSync(this.#entry)) {
      log.error('no agent in this checkout', { expected: this.#entry });
      return EXIT_FAILED;
    }
    log.info('keeping an agent on this machine', {
      repo: this.#options.repo,
      intervalMs: this.#options.intervalMs,
      alsoRepos: this.#options.alsoRepos.length || undefined,
    });

    // Both loops run until one of them decides this process is done. The update
    // loop only ever asks for a restart; the supervision loop is the only thing
    // that decides to stop.
    const supervising = this.#superviseForever();
    this.#updateForever().catch((error) => log.error('update loop stopped', { message: error.message }));
    return supervising;
  }

  /** SIGINT/SIGTERM: stop the agent cleanly, then let run() return. */
  async shutdown(signal) {
    if (this.#stopping) return;
    this.#stopping = true;
    log.info('stopping', { signal });
    this.#wake?.();
    if (this.#child) await this.#stopChild(this.#child);
  }

  async #superviseForever() {
    let failures = 0;
    while (!this.#stopping) {
      const child = this.#spawnAgent();
      const { code, signal } = await child.exited;

      if (this.#stopping) break;

      if (this.#expectedExit) {
        // We asked for this one — an update landed. Straight back up on the new
        // code, with no backoff: nothing is wrong here.
        this.#expectedExit = false;
        failures = 0;
        continue;
      }

      if (code === 0) {
        // The agent exits 0 on its own in exactly one case we did not ask for:
        // it was told to stand down because another process on this machine now
        // holds its registration. Starting it again is how the two take turns
        // evicting each other forever, which is the loop the stand-down ends.
        log.info('agent stood down for another agent on this machine; nothing left to keep');
        return EXIT_OK;
      }

      const delay = backoffDelay(failures++);
      log.warn('agent exited; restarting', { code, signal, delayMs: delay, failures });
      await sleep(delay).catch(() => {});
    }
    return EXIT_OK;
  }

  #spawnAgent() {
    // The IPC channel in the fourth slot is what makes a clean restart possible
    // on Windows, where there is no signal that means "drain and stop".
    const child = spawn(process.execPath, [this.#entry], {
      cwd: this.#options.repo,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    });
    // A process that could not be spawned at all emits 'error' and never
    // 'exit'. Settling on either is what keeps the supervision loop from
    // parking forever on a child that does not exist.
    child.exited = new Promise((resolvePromise) => {
      child.once('exit', (code, signal) => resolvePromise({ code, signal }));
      child.once('error', (error) => {
        log.error('could not start the agent', { message: error.message });
        resolvePromise({ code: 1, signal: null });
      });
    });
    this.#child = child;
    log.info('agent started', { pid: child.pid });
    return child;
  }

  async #stopChild(child) {
    this.#expectedExit = true;
    const exited = child.exited;
    if (child.connected) {
      try {
        child.send(AGENT_SHUTDOWN_MESSAGE);
      } catch {
        child.kill('SIGTERM');
      }
    } else {
      child.kill('SIGTERM');
    }

    if (await raceTimeout(exited, this.#options.stopTimeoutMs)) return;

    // It is wedged, not draining. Killing it costs at most one lease: the host
    // requeues whatever it was holding once the lease expires.
    log.warn('agent did not stop in time; killing it', { pid: child.pid });
    child.kill('SIGKILL');
    await exited;
  }

  async #updateForever() {
    while (!this.#stopping) {
      await this.#nap(this.#options.intervalMs);
      if (this.#stopping) return;

      for (const repo of this.#options.alsoRepos) await this.#updateOther(repo);
      if (this.#stopping) return;

      const result = await selfUpdate(this.#options.repo, this.#options.remote);
      if (this.#stopping) return;

      if (!result.ok) {
        // Refusals are the normal case, not an alarm: somebody is editing this
        // checkout, or it has a commit the remote does not. Either way the
        // agent goes on running, and tomorrow's tick tries again.
        log.warn('update skipped', { reason: result.reason });
        continue;
      }
      if (!result.updated) {
        log.debug('already current', { head: result.head?.slice(0, 7) });
        continue;
      }

      log.info('updated; restarting the agent', {
        head: result.head?.slice(0, 7),
        subject: result.subject,
      });
      await this.#warnIfKeeperChanged(result);
      const child = this.#child;
      if (child) await this.#stopChild(child);
    }
  }

  async #updateOther(repo) {
    const result = await selfUpdate(repo, this.#options.remote);
    if (!result.ok) log.warn('update skipped', { repo, reason: result.reason });
    else if (result.updated) {
      // Said plainly because it is the half a supervisor cannot do: nothing
      // here knows what runs this checkout, so nothing here restarts it.
      log.info('other checkout updated; restart whatever runs it', {
        repo,
        head: result.head?.slice(0, 7),
        subject: result.subject,
      });
    }
  }

  /**
   * The child is respawned from the new code; this process is not. Say so when
   * the pull changed the supervisor itself, rather than quietly running last
   * month's keeper against this month's agent.
   */
  async #warnIfKeeperChanged(result) {
    if (!result.previousHead || !result.head) return;
    const changed = await new Promise((resolvePromise) => {
      execFile(
        process.env.ALPHA_GIT ?? 'git',
        ['-C', this.#options.repo, 'diff', '--name-only', result.previousHead, result.head],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true },
        (error, stdout) => resolvePromise(error ? '' : stdout),
      );
    });
    if (/scripts\/keep-agent\.mjs|src\/common\//.test(changed)) {
      log.warn('this keeper changed in that update; restart it when convenient');
    }
  }

  /** A nap the shutdown path can cut short. */
  #nap(ms) {
    return new Promise((resolvePromise) => {
      // Ref'd on purpose: between ticks this timer *is* the pending work of the
      // update loop. Unref'ing it would be harmless only for as long as a child
      // process happens to be holding the loop open, which is exactly the
      // moment we are least able to reason about.
      const timer = setTimeout(finish, ms);
      this.#wake = finish;
      function finish() {
        clearTimeout(timer);
        resolvePromise();
      }
    });
  }
}

/** True if `promise` settled first, false on timeout. */
function raceTimeout(promise, ms) {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), ms);
    promise.then(() => {
      clearTimeout(timer);
      resolvePromise(true);
    });
  });
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  log.error(error.message);
  process.exit(EXIT_FAILED);
}

const keeper = new AgentKeeper(options);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    keeper.shutdown(signal);
  });
}

process.exit(await keeper.run());

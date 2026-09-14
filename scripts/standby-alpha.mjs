#!/usr/bin/env node
/**
 * Runs Alpha on this machine when the main host is not answering, and keeps it
 * running while it is needed.
 *
 * Why this is a local daemon and not a handler
 * --------------------------------------------
 * Everything else in this repository that acts on a machine arrives as a task:
 * the host decides, an agent does it. Failover cannot work that way, because
 * the coordinator is the thing that is down. A standby driven over the tunnel
 * would be a standby that only starts when it is not needed. So this runs on
 * the laptop, watches for itself, and decides for itself — and nothing on the
 * network can ask it to start a program, because it takes no input from the
 * network at all beyond "did the health endpoint answer".
 *
 * What it does
 * ------------
 *   - Probes the main host every --probe-ms (default 30s). The default target
 *     is ALPHA_HOST_URL's /healthz, which every laptop is already configured
 *     for and which is the one unauthenticated GET the coordinator serves.
 *   - After --failures consecutive misses it **promotes**: starts Alpha here
 *     from a pinned script inside --root, and keeps it up — restarting it if it
 *     exits, and (with --local-url) if it stops answering its own health check.
 *   - After --recover consecutive answers from the main host it **demotes**:
 *     stops the copy it started, because two Alphas both live is worse than
 *     the outage was. --stay turns that off for a machine where a person
 *     decides when to hand back.
 *
 * Split brain, honestly
 * ---------------------
 * This machine cannot tell "the host is down" from "I cannot reach the host".
 * If the laptop's link drops, promoting gives the household two Alphas. Two
 * mitigations, both deliberate and neither perfect:
 *
 *   - `--control-url`: something else that is up whenever this machine's
 *     network is (another tailnet machine, or any public URL). If the control
 *     fails too, the fault is here, and a standby that promotes on its own
 *     broken Wi-Fi is worse than no standby. Set it.
 *   - Demotion is on by default, so the split heals as soon as the link does.
 *
 * What it will not do
 * -------------------
 *   - Run a command from anywhere but this machine's own configuration, and
 *     only one that resolves inside --root, with a pinned interpreter chosen by
 *     extension and an argv array — never a shell string.
 *   - Touch the main host, or anything it did not start itself.
 *   - Promote because a task told it to. There is no task.
 *
 * Usage:
 *   node scripts/standby-alpha.mjs --root <alpha dir> --start <script in root>
 *        [--probe-url <url>] [--control-url <url>] [--local-url <url>]
 *        [--probe-ms <ms>] [--failures <n>] [--recover <n>] [--stay]
 *
 * Configuration (CLI wins):
 *   ALPHA_APP_ROOT    where Alpha lives on this machine
 *   ALPHA_APP_START   the start script, relative to that root
 *   ALPHA_HOST_URL    the main host, for the default probe
 *
 * Exit codes:
 *   0   asked to stop (signal)
 *   1   could not start: bad arguments, missing root, or a start script that
 *       does not resolve inside it
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { backoffDelay, sleep } from '../src/common/backoff.js';
import { createLogger } from '../src/common/log.js';
import { loadEnv } from '../src/common/env.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const log = createLogger('alpha:standby');

// Failover, not housekeeping. A three-hour check would mean a three-hour
// outage before the standby noticed, which is not a standby.
const DEFAULT_PROBE_MS = 30_000;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
// Two minutes of silence at the default cadence. Long enough to sit out a host
// restart or a Tailscale reconnection, short enough to matter.
const DEFAULT_FAILURES = 4;
const DEFAULT_RECOVER = 4;
const DEFAULT_LOCAL_FAILURES = 3;
// A web app takes a while to answer for the first time; counting that as
// unhealthy would restart it forever.
const DEFAULT_LOCAL_GRACE_MS = 60_000;
const DEFAULT_STOP_TIMEOUT_MS = 20_000;

const EXIT_OK = 0;
const EXIT_FAILED = 1;

// npm scripts are named, not pathed, so the root's package.json is the
// allowlist: `--npm-script dev` runs whatever `dev` is there and nothing else.
const NPM_SCRIPT_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,63}$/;

/**
 * `npm run <script>` in the root, which is how most apps actually start.
 *
 * The executable is pinned the same way an interpreter is, and on Windows it
 * has to be `npm.cmd`: `npm` there is a shim, and spawning it without a shell —
 * which is the whole point — fails with ENOENT. (This is the same execution-
 * policy corner the README warns about from the other side: PowerShell blocks
 * `npm.ps1`, so nothing here goes through PowerShell to reach npm.)
 */
function npmCommand(script) {
  if (!NPM_SCRIPT_PATTERN.test(script)) {
    throw new Error(
      `--npm-script must be a script name from the root's package.json, got ${JSON.stringify(script)}`,
    );
  }
  const npm = process.env.ALPHA_NPM ?? (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  return [npm, ['run', script]];
}

/**
 * Interpreters this will run, chosen by the start script's extension. Pinned,
 * argv-array, no shell: the script path is the only thing that varies, and it
 * has already been proven to live inside the root.
 */
function interpreterFor(script) {
  switch (extname(script).toLowerCase()) {
    case '.ps1':
      return [
        process.env.ALPHA_POWERSHELL ?? 'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      ];
    case '.cmd':
    case '.bat':
      return [process.env.ALPHA_CMD ?? 'cmd.exe', ['/d', '/s', '/c', script]];
    case '.js':
    case '.mjs':
      return [process.execPath, [script]];
    case '.sh':
      return [process.env.ALPHA_SHELL ?? 'sh', [script]];
    default:
      throw new Error(
        `start script must be .ps1, .cmd, .bat, .js, .mjs or .sh, got ${JSON.stringify(script)}`,
      );
  }
}

function parseArgs(argv) {
  const options = {
    root: process.env.ALPHA_APP_ROOT ?? '',
    start: process.env.ALPHA_APP_START ?? '',
    npmScript: process.env.ALPHA_APP_NPM_SCRIPT ?? '',
    probeUrl: '',
    controlUrl: '',
    localUrl: '',
    probeMs: DEFAULT_PROBE_MS,
    probeTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
    failures: DEFAULT_FAILURES,
    recover: DEFAULT_RECOVER,
    localFailures: DEFAULT_LOCAL_FAILURES,
    localGraceMs: DEFAULT_LOCAL_GRACE_MS,
    stopTimeoutMs: DEFAULT_STOP_TIMEOUT_MS,
    stay: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') options.root = argv[++i] ?? '';
    else if (arg === '--start') options.start = argv[++i] ?? '';
    else if (arg === '--npm-script') options.npmScript = argv[++i] ?? '';
    else if (arg === '--probe-url') options.probeUrl = argv[++i] ?? '';
    else if (arg === '--control-url') options.controlUrl = argv[++i] ?? '';
    else if (arg === '--local-url') options.localUrl = argv[++i] ?? '';
    else if (arg === '--probe-ms') options.probeMs = positiveInt(arg, argv[++i]);
    else if (arg === '--probe-timeout-ms') options.probeTimeoutMs = positiveInt(arg, argv[++i]);
    else if (arg === '--failures') options.failures = positiveInt(arg, argv[++i]);
    else if (arg === '--recover') options.recover = positiveInt(arg, argv[++i]);
    else if (arg === '--local-failures') options.localFailures = positiveInt(arg, argv[++i]);
    else if (arg === '--local-grace-ms') options.localGraceMs = positiveInt(arg, argv[++i]);
    else if (arg === '--stop-timeout-ms') options.stopTimeoutMs = positiveInt(arg, argv[++i]);
    else if (arg === '--stay') options.stay = true;
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }

  if (!options.probeUrl) {
    const host = process.env.ALPHA_HOST_URL;
    if (!host) {
      throw new Error('no --probe-url and no ALPHA_HOST_URL to derive one from');
    }
    options.probeUrl = `${host.replace(/\/+$/, '')}/healthz`;
  }
  if (!options.root) throw new Error('--root (or ALPHA_APP_ROOT) is required');
  if (options.start && options.npmScript) {
    throw new Error('--start and --npm-script name two different ways to start; pick one');
  }
  if (!options.start && !options.npmScript) {
    throw new Error('one of --start (or ALPHA_APP_START) and --npm-script is required');
  }

  const base = resolve(options.root);
  if (!existsSync(base)) throw new Error(`no such directory: ${base}`);

  if (options.npmScript) {
    // Prove the script exists now rather than at the moment of the outage,
    // which is the same reason --start is checked here.
    const manifest = resolve(base, 'package.json');
    if (!existsSync(manifest)) throw new Error(`no package.json in ${base}`);
    let scripts;
    try {
      scripts = JSON.parse(readFileSync(manifest, 'utf8')).scripts ?? {};
    } catch (error) {
      throw new Error(`could not read ${manifest}: ${error.message}`);
    }
    if (!Object.hasOwn(scripts, options.npmScript)) {
      throw new Error(
        `package.json has no "${options.npmScript}" script (found: ${Object.keys(scripts).join(', ') || 'none'})`,
      );
    }
    options.root = base;
    options.script = `npm run ${options.npmScript}`;
    options.command = npmCommand(options.npmScript);
    return options;
  }

  // Same rule as the coordination handler's script: relative to the root, no
  // traversal, and proven to land inside it after resolution rather than by
  // looking at the string.
  const relative = options.start.replace(/\\/g, '/');
  if (isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) {
    throw new Error(`--start must be relative to --root, got ${JSON.stringify(options.start)}`);
  }
  if (relative.split('/').includes('..')) {
    throw new Error(`--start must not traverse upward, got ${JSON.stringify(options.start)}`);
  }
  const script = resolve(base, relative);
  if (!script.startsWith(base + sep)) {
    throw new Error(`--start escapes the root: ${JSON.stringify(options.start)}`);
  }
  if (!existsSync(script)) throw new Error(`no such start script: ${script}`);

  options.root = base;
  options.script = script;
  options.command = interpreterFor(script);
  return options;
}

function positiveInt(name, raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** True when the URL answered with any 2xx inside the timeout. */
async function reachable(url, timeoutMs) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    // Read and discard: an unconsumed body keeps the socket out of the pool.
    await response.arrayBuffer().catch(() => {});
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Stops the child *and everything it started*.
 *
 * `npm run dev` is a wrapper: the server is its grandchild. Kill only the npm
 * process and the server keeps the port, so the restart this was meant to
 * perform fails to bind — which is the failure mode of every naive supervisor
 * of a script that launches something else.
 *
 * POSIX: the child was spawned detached, so it leads its own process group and
 * a negative pid signals the whole group. Windows has no groups worth the name,
 * so `taskkill /T` walks the tree instead.
 */
function killTree(child, { force }) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const args = ['/pid', String(child.pid), '/T'];
    if (force) args.push('/F');
    execFile('taskkill', args, { windowsHide: true }, () => {});
    return;
  }
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is already gone, or this platform refused it. The child
    // itself is still worth a try.
    try {
      child.kill(signal);
    } catch {
      /* already dead */
    }
  }
}

/**
 * Alpha, as run by this machine. Owns the child it started and nothing else:
 * start() keeps it up until stop() is called, restarting it with backoff if it
 * exits, because a standby whose copy of Alpha died an hour ago is not a
 * standby either.
 */
class LocalAlpha {
  #options;
  #child = null;
  #running = false;
  #expectedExit = false;
  #startedAt = 0;
  #wake = null;

  constructor(options) {
    this.#options = options;
  }

  get running() {
    return this.#running;
  }

  /** Milliseconds this copy has been up, or 0 when nothing is running. */
  get uptimeMs() {
    return this.#startedAt ? Date.now() - this.#startedAt : 0;
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#superviseForever().catch((error) =>
      log.error('supervision stopped', { message: error.message }),
    );
  }

  async #superviseForever() {
    const [command, args] = this.#options.command;
    let failures = 0;
    while (this.#running) {
      log.info('starting Alpha here', { script: this.#options.script });
      const child = spawn(command, args, {
        cwd: this.#options.root,
        stdio: ['ignore', 'inherit', 'inherit'],
        windowsHide: true,
        // Its own process group, so stopping it stops what it started. Not on
        // Windows, where detached means a new console window rather than a
        // group — taskkill /T does that job there.
        detached: process.platform !== 'win32',
      });
      this.#child = child;
      this.#startedAt = Date.now();
      const exited = new Promise((resolvePromise) => {
        child.once('exit', (code, signal) => resolvePromise({ code, signal }));
        child.once('error', (error) => {
          log.error('could not start Alpha', { message: error.message });
          resolvePromise({ code: 1, signal: null });
        });
      });
      child.exited = exited;
      const { code, signal } = await exited;
      this.#child = null;
      this.#startedAt = 0;

      if (!this.#running) break;
      if (this.#expectedExit) {
        // A restart we asked for: it stopped answering its health check.
        this.#expectedExit = false;
        failures = 0;
        continue;
      }

      // Every other exit is Alpha falling over while this machine is the one
      // serving. Nothing else is going to bring it back.
      const delay = backoffDelay(failures++);
      log.warn('Alpha exited; restarting it', { code, signal, delayMs: delay, failures });
      await this.#nap(delay);
    }
    log.info('no longer running Alpha here');
  }

  /** Stops the current child and lets the supervision loop start a new one. */
  async restart(reason) {
    if (!this.#child) return;
    log.warn('restarting Alpha', { reason });
    this.#expectedExit = true;
    await this.#stopChild(this.#child);
  }

  async stop() {
    if (!this.#running) return;
    this.#running = false;
    this.#wake?.();
    if (this.#child) await this.#stopChild(this.#child);
  }

  async #stopChild(child) {
    const exited = child.exited;
    killTree(child, { force: false });
    const done = await Promise.race([
      exited.then(() => true),
      sleep(this.#options.stopTimeoutMs).then(() => false),
    ]);
    if (!done) {
      log.warn('Alpha did not stop in time; killing it', { pid: child.pid });
      killTree(child, { force: true });
      await exited;
    }
  }

  /** A backoff nap the stop path can cut short. */
  #nap(ms) {
    return new Promise((resolvePromise) => {
      // Ref'd: while Alpha is down between restarts, this nap is the only
      // pending work there is.
      const timer = setTimeout(finish, ms);
      this.#wake = finish;
      function finish() {
        clearTimeout(timer);
        resolvePromise();
      }
    });
  }
}

class Standby {
  #options;
  #alpha;
  #stopping = false;
  #wake = null;
  #misses = 0;
  #hits = 0;
  #localMisses = 0;

  constructor(options) {
    this.#options = options;
    this.#alpha = new LocalAlpha(options);
  }

  async run() {
    log.info('standing by for the main host', {
      probe: this.#options.probeUrl,
      everyMs: this.#options.probeMs,
      promoteAfter: this.#options.failures,
      demote: !this.#options.stay,
      control: this.#options.controlUrl || undefined,
    });

    while (!this.#stopping) {
      const up = await reachable(this.#options.probeUrl, this.#options.probeTimeoutMs);
      if (this.#stopping) break;

      if (up) await this.#hostAnswered();
      else await this.#hostMissed();

      if (this.#alpha.running) await this.#checkLocalHealth();
      await this.#nap(this.#options.probeMs);
    }

    await this.#alpha.stop();
    return EXIT_OK;
  }

  async #hostAnswered() {
    this.#misses = 0;
    this.#hits += 1;
    if (!this.#alpha.running || this.#options.stay) return;
    if (this.#hits < this.#options.recover) return;

    // Hand back. Two live Alphas is the failure mode this whole script is
    // trying not to cause, so recovery is not something to sit on.
    log.info('main host is back; stopping the copy here', { answers: this.#hits });
    await this.#alpha.stop();
  }

  async #hostMissed() {
    this.#hits = 0;
    this.#misses += 1;
    if (this.#alpha.running) return;
    if (this.#misses < this.#options.failures) {
      log.warn('main host did not answer', { misses: this.#misses, of: this.#options.failures });
      return;
    }

    if (this.#options.controlUrl) {
      const controlUp = await reachable(this.#options.controlUrl, this.#options.probeTimeoutMs);
      if (!controlUp) {
        // The control is up whenever this machine's network is. It is not, so
        // what is broken is here — and a standby that promotes on its own
        // broken Wi-Fi hands the household a second Alpha for no reason.
        log.warn('control URL is unreachable too; this machine is the one offline, staying put');
        return;
      }
    }

    log.warn('main host is not answering; taking over', { misses: this.#misses });
    this.#localMisses = 0;
    this.#alpha.start();
  }

  /** Alive is not the same as serving. */
  async #checkLocalHealth() {
    if (!this.#options.localUrl) return;
    if (this.#alpha.uptimeMs < this.#options.localGraceMs) return;

    if (await reachable(this.#options.localUrl, this.#options.probeTimeoutMs)) {
      this.#localMisses = 0;
      return;
    }
    this.#localMisses += 1;
    if (this.#localMisses < this.#options.localFailures) return;
    this.#localMisses = 0;
    await this.#alpha.restart('local Alpha stopped answering its health check');
  }

  async shutdown(signal) {
    if (this.#stopping) return;
    this.#stopping = true;
    log.info('stopping', { signal });
    this.#wake?.();
    await this.#alpha.stop();
  }

  #nap(ms) {
    return new Promise((resolvePromise) => {
      const timer = setTimeout(finish, ms);
      this.#wake = finish;
      function finish() {
        clearTimeout(timer);
        resolvePromise();
      }
    });
  }
}

// The laptop's own configuration, same precedence as the agent's: .env.agent
// first, then .env, and a real environment variable beats both.
process.chdir(resolve(HERE, '..'));
loadEnv('.env.agent');
loadEnv();

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  log.error(error.message);
  process.exit(EXIT_FAILED);
}

const standby = new Standby(options);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    standby.shutdown(signal).then(() => process.exit(EXIT_OK));
  });
}

process.exit(await standby.run());

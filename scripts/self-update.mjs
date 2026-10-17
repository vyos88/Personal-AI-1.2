#!/usr/bin/env node
/**
 * Keeps this machine's copy of alpha-tunnel current, for a scheduler to run.
 *
 * Every laptop in the fleet runs the agent, and the host warns when one is on a
 * different release than it is — but a warning nobody is reading is not a
 * mechanism. This is the mechanism: fetch, fast-forward if it is safe to, and
 * say whether the worker needs restarting to pick it up.
 *
 * It is deliberately dull. There are no runtime dependencies in this repo, so
 * updating is a `git pull` and a service restart — there is no install step to
 * get wrong, and nothing to rebuild.
 *
 * Three rules it will not break:
 *
 * - **Fast-forward only.** It can move this machine onto what the remote
 *   already has, and do nothing else. It cannot merge, rebase, or force.
 * - **Never over local work.** A dirty working copy means somebody is doing
 *   something here; it reports and stops.
 * - **It does not restart anything itself.** Which service to bounce, and
 *   whether now is a good moment, is the machine owner's call — see
 *   docs/AUTO_UPDATE.md for the one-liner per platform. This exits 10 when a
 *   restart is needed so a scheduled task can decide.
 *
 * Usage:
 *   node scripts/self-update.mjs [--repo <path>] [--remote <name>] [--json]
 *
 * Exit codes:
 *   0   already current — nothing to do
 *   10  updated; restart the agent to pick it up
 *   1   refused or failed; nothing was changed
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const EXIT_CURRENT = 0;
const EXIT_FAILED = 1;
const EXIT_UPDATED = 10;

function parseArgs(argv) {
  const options = { repo: resolve(HERE, '..'), remote: 'origin', json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--repo') options.repo = resolve(argv[++i] ?? '');
    else if (arg === '--remote') options.remote = argv[++i] ?? 'origin';
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.remote)) {
    throw new Error(`remote must be a git remote name, got ${JSON.stringify(options.remote)}`);
  }
  return options;
}

function git(repo, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      process.env.ALPHA_GIT ?? 'git',
      ['-C', repo, ...args],
      { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && error.code === 'ENOENT') {
          rejectPromise(new Error('git not found; set ALPHA_GIT to its path'));
          return;
        }
        resolvePromise({
          stdout: (stdout ?? '').trim(),
          stderr: (stderr ?? '').trim(),
          exitCode: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
        });
      },
    );
  });
}

/**
 * How far this checkout has fallen behind, as a count of the commits it is
 * missing and the age of the oldest one.
 *
 * Every refusal below names the remedy -- the file somebody is holding, or the
 * divergence a person has to resolve -- and none of them names the cost. That
 * is what makes a refusal easy to leave alone: the Host's autopilot reported
 * `checkout cannot update` from 07:49Z on 2026-10-08 and was still pinned at
 * e175472 eight hours and sixteen commits later, the line reading the same on
 * every pass. `channel-watch.mjs` has the rule for this shape of report -- a
 * silent heartbeat names the work it has stranded, not only the symptom.
 *
 * It fetches first, because the answer is worthless against a remote ref as
 * old as the stall itself. Fetching is not updating: it writes `refs/remotes`
 * and touches no tracked file, so the "never over local work" rule above
 * stands. A fetch that fails costs nothing -- the refusal is already decided,
 * so the gap is left out rather than guessed at, and the reason the caller
 * came for is never replaced by a second one about the network.
 */
async function behindUpstream(options, { fetch = true } = {}) {
  if (fetch) {
    const fetched = await git(options.repo, ['fetch', '--prune', options.remote]);
    if (fetched.exitCode !== 0) return {};
  }
  // --format with no -n: the count is the line count, so one call answers both,
  // and the oldest is the last line. `log -1 --reverse` would not work here --
  // the limit applies before the reversal, which hands back the newest.
  const log = await git(options.repo, ['log', '--format=%cI', 'HEAD..@{upstream}']);
  if (log.exitCode !== 0 || !log.stdout) return {};
  const dates = log.stdout.split('\n');
  return { behind: dates.length, oldestMissing: dates[dates.length - 1] };
}

async function main(argv) {
  const options = parseArgs(argv);

  if (!existsSync(resolve(options.repo, '.git'))) {
    return { ok: false, reason: `not a git working copy: ${options.repo}`, exit: EXIT_FAILED };
  }

  const before = await git(options.repo, ['rev-parse', 'HEAD']);
  if (before.exitCode !== 0) {
    return { ok: false, reason: before.stderr || 'could not read HEAD', exit: EXIT_FAILED };
  }

  const dirty = await git(options.repo, ['status', '--porcelain']);
  if (dirty.stdout) {
    // Somebody is working here. Updating under them is how you lose an
    // afternoon's changes and gain a bug report about a machine that "just
    // broke on its own".
    return {
      ok: false,
      reason: 'working copy has uncommitted changes',
      files: dirty.stdout.split('\n').length,
      head: before.stdout,
      ...(await behindUpstream(options)),
      exit: EXIT_FAILED,
    };
  }

  const fetched = await git(options.repo, ['fetch', '--prune', options.remote]);
  if (fetched.exitCode !== 0) {
    return { ok: false, reason: fetched.stderr || 'fetch failed', exit: EXIT_FAILED };
  }

  const pulled = await git(options.repo, ['pull', '--ff-only', options.remote]);
  const after = await git(options.repo, ['rev-parse', 'HEAD']);

  if (pulled.exitCode !== 0) {
    // Almost always a diverged branch: this machine has a commit the remote
    // does not. That is a person's decision to resolve, not a script's.
    return {
      ok: false,
      reason: pulled.stderr || 'pull failed',
      head: after.stdout,
      // This path has already fetched, and asking the network twice on a pass
      // that is going to fail anyway buys nothing.
      ...(await behindUpstream(options, { fetch: false })),
      exit: EXIT_FAILED,
    };
  }

  const moved = after.stdout !== before.stdout;
  const subject = await git(options.repo, ['log', '-1', '--pretty=%s']);

  return {
    ok: true,
    updated: moved,
    previousHead: before.stdout,
    head: after.stdout,
    subject: subject.stdout,
    exit: moved ? EXIT_UPDATED : EXIT_CURRENT,
  };
}

const result = await main(process.argv.slice(2)).catch((error) => ({
  ok: false,
  reason: error.message,
  exit: EXIT_FAILED,
}));

if (result.json ?? process.argv.includes('--json')) {
  console.log(JSON.stringify(result));
} else if (!result.ok) {
  console.error(`self-update: ${result.reason}`);
  if (result.behind) {
    console.error(
      `self-update: this checkout is ${result.behind} commit(s) behind its upstream`
      + `, the oldest waiting since ${result.oldestMissing}`,
    );
  }
} else if (result.updated) {
  console.log(`self-update: now on ${result.head.slice(0, 7)} — ${result.subject}`);
  console.log('self-update: restart the agent to pick this up');
} else {
  console.log(`self-update: already current at ${result.head.slice(0, 7)}`);
}

process.exit(result.exit);

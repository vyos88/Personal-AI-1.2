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
    return { ok: false, reason: pulled.stderr || 'pull failed', head: after.stdout, exit: EXIT_FAILED };
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
} else if (result.updated) {
  console.log(`self-update: now on ${result.head.slice(0, 7)} — ${result.subject}`);
  console.log('self-update: restart the agent to pick this up');
} else {
  console.log(`self-update: already current at ${result.head.slice(0, 7)}`);
}

process.exit(result.exit);

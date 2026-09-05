import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as update from '../src/agent/handlers/alpha-update.js';
import { ProtocolError } from '../src/common/protocol.js';

// Real repositories on disk rather than a stubbed git. The whole point of this
// handler is what git actually does with a working copy — a fake would only
// assert that the arguments were the ones I chose to write down.

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo(t, { bare = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'alpha-update-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (bare) {
    git(dir, 'init', '--bare', '--initial-branch=main', '.');
    return dir;
  }
  git(dir, 'init', '--initial-branch=main', '.');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  return dir;
}

function commit(dir, name, contents, message) {
  writeFileSync(join(dir, name), contents);
  git(dir, 'add', name);
  git(dir, 'commit', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/** Points the handler at a working copy for one test. */
function useRoot(t, root) {
  const previous = process.env.ALPHA_REPO_ROOT;
  process.env.ALPHA_REPO_ROOT = root;
  t.after(() => {
    if (previous === undefined) delete process.env.ALPHA_REPO_ROOT;
    else process.env.ALPHA_REPO_ROOT = previous;
  });
}

// ------------------------------------------------------------------ validation

test('only the three read-or-fast-forward actions are accepted', () => {
  for (const action of ['Status', 'Fetch', 'Pull']) {
    assert.equal(update.validateAction(action), action);
  }
  // Status is the harmless one, so an empty payload means that.
  assert.equal(update.validateAction(undefined), 'Status');

  // The ones deliberately absent: nothing here may rewrite history, discard
  // local work, or move the working copy to a different branch.
  for (const action of ['Reset', 'Checkout', 'Push', 'Clean', 'pull', 'Build', 'Restart']) {
    assert.throws(() => update.validateAction(action), ProtocolError);
  }
});

test('a remote is a name, never a URL', () => {
  assert.equal(update.validateRemote('origin'), 'origin');
  assert.equal(update.validateRemote(undefined), 'origin');
  assert.equal(update.validateRemote('alpha-host'), 'alpha-host');

  // The reason this is constrained at all: git would take a URL in this argv
  // slot, and an update that can be pointed anywhere is a way to run somebody
  // else's code on the Alpha host.
  for (const bad of [
    'https://example.com/evil.git',
    'git@example.com:evil.git',
    '../elsewhere',
    '--upload-pack=touch /tmp/pwned',
    '',
    42,
  ]) {
    assert.throws(() => update.validateRemote(bad), ProtocolError);
  }
});

test('the repository is named in the argv, not just inherited from cwd', () => {
  assert.deepEqual(update.buildArgs('/srv/alpha', ['status', '--porcelain']), [
    '-C',
    '/srv/alpha',
    'status',
    '--porcelain',
  ]);
});

// --------------------------------------------------------------- configuration

test('an agent with nowhere to update says so rather than guessing', async (t) => {
  const previous = process.env.ALPHA_REPO_ROOT;
  delete process.env.ALPHA_REPO_ROOT;
  t.after(() => {
    if (previous !== undefined) process.env.ALPHA_REPO_ROOT = previous;
  });

  await assert.rejects(() => update.run({ action: 'Status' }), (error) => {
    assert.equal(error.code, 'not_configured');
    return true;
  });
});

test('a directory that is not a working copy is refused', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'alpha-not-a-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'frontend'), { recursive: true });
  useRoot(t, dir);

  await assert.rejects(() => update.run({ action: 'Status' }), (error) => {
    assert.equal(error.code, 'not_configured');
    assert.match(error.message, /not a git working copy/);
    return true;
  });
});

// --------------------------------------------------------------------- status

test('Status reports where the working copy actually is', async (t) => {
  const repo = makeRepo(t);
  const head = commit(repo, 'AppShell.tsx', 'const ALPHA_VERSION = "9.0";\n', 'Alpha 9.0');
  useRoot(t, repo);

  const result = await update.run({ action: 'Status' });

  assert.equal(result.action, 'Status');
  assert.equal(result.head, head);
  assert.equal(result.branch, 'main');
  assert.equal(result.subject, 'Alpha 9.0');
  assert.equal(result.dirty, false);
  assert.equal(result.changedFiles, 0);
  assert.equal(result.untrackedFiles, 0);
  // Nothing published, so there is nothing to be behind.
  assert.equal(result.upstream, null);
  assert.equal(result.behind, null);
});

test('Status separates uncommitted edits from untracked files', async (t) => {
  // These are different problems for an update, and on the Alpha host the
  // second is the likely one: code that runs there but was never committed.
  const repo = makeRepo(t);
  commit(repo, 'AppShell.tsx', 'v9\n', 'Alpha 9.0');
  writeFileSync(join(repo, 'AppShell.tsx'), 'v9 edited\n');
  writeFileSync(join(repo, 'backend.py'), 'never committed\n');
  useRoot(t, repo);

  const result = await update.run({ action: 'Status' });

  assert.equal(result.dirty, true);
  assert.equal(result.changedFiles, 1);
  assert.equal(result.untrackedFiles, 1);
});

test('Status counts how far behind the upstream the host is', async (t) => {
  const origin = makeRepo(t, { bare: true });
  const work = makeRepo(t);
  commit(work, 'AppShell.tsx', 'v9\n', 'Alpha 9.0');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-u', 'origin', 'main');

  // Somebody else lands two commits.
  const other = mkdtempSync(join(tmpdir(), 'alpha-other-'));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  git(other, 'clone', origin, '.');
  git(other, 'config', 'user.email', 'test@example.com');
  git(other, 'config', 'user.name', 'Test');
  commit(other, 'AppShell.tsx', 'v9.1\n', 'Alpha 9.1');
  commit(other, 'notes.md', 'x\n', 'Notes');
  git(other, 'push', 'origin', 'main');

  useRoot(t, work);

  // Before fetching, the host has no idea anything happened.
  const stale = await update.run({ action: 'Status' });
  assert.equal(stale.behind, 0);

  // Fetch moves the remote-tracking ref and nothing else.
  const fetched = await update.run({ action: 'Fetch' });
  assert.equal(fetched.exitCode, 0);
  assert.equal(fetched.behind, 2, 'two commits are waiting');
  assert.equal(fetched.ahead, 0);
  assert.equal(fetched.head, stale.head, 'Fetch must not move the working copy');
});

// ----------------------------------------------------------------------- pull

test('Pull fast-forwards the host onto what the remote already has', async (t) => {
  const origin = makeRepo(t, { bare: true });
  const work = makeRepo(t);
  const first = commit(work, 'AppShell.tsx', 'v9\n', 'Alpha 9.0');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-u', 'origin', 'main');

  const other = mkdtempSync(join(tmpdir(), 'alpha-other-'));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  git(other, 'clone', origin, '.');
  git(other, 'config', 'user.email', 'test@example.com');
  git(other, 'config', 'user.name', 'Test');
  const next = commit(other, 'AppShell.tsx', 'v9.1\n', 'Alpha 9.1');
  git(other, 'push', 'origin', 'main');

  useRoot(t, work);
  const result = await update.run({ action: 'Pull' });

  assert.equal(result.pulled, true);
  assert.equal(result.previousHead, first);
  assert.equal(result.head, next);
  assert.equal(result.subject, 'Alpha 9.1');
  assert.equal(result.behind, 0);
});

test('Pull on an already-current host is a no-op, not a failure', async (t) => {
  const origin = makeRepo(t, { bare: true });
  const work = makeRepo(t);
  const head = commit(work, 'AppShell.tsx', 'v9\n', 'Alpha 9.0');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-u', 'origin', 'main');
  useRoot(t, work);

  const result = await update.run({ action: 'Pull' });

  assert.equal(result.exitCode, 0);
  assert.equal(result.pulled, false, 'nothing moved');
  assert.equal(result.head, head);
});

test('Pull refuses outright when the host has uncommitted work', async (t) => {
  // The case that matters most here: the Alpha host's working copy is where
  // Alpha actually runs. A half-applied update to a machine somebody is using
  // is worse than no update, so this is refused before git is even asked.
  const origin = makeRepo(t, { bare: true });
  const work = makeRepo(t);
  const head = commit(work, 'AppShell.tsx', 'v9\n', 'Alpha 9.0');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-u', 'origin', 'main');

  const other = mkdtempSync(join(tmpdir(), 'alpha-other-'));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  git(other, 'clone', origin, '.');
  git(other, 'config', 'user.email', 'test@example.com');
  git(other, 'config', 'user.name', 'Test');
  commit(other, 'AppShell.tsx', 'v9.1\n', 'Alpha 9.1');
  git(other, 'push', 'origin', 'main');

  // Uncommitted local work on the host — Alpha's own, say.
  writeFileSync(join(work, 'backend.py'), 'running code nobody committed\n');
  useRoot(t, work);

  const result = await update.run({ action: 'Pull' });

  assert.equal(result.pulled, false);
  assert.match(result.refused, /uncommitted/);
  assert.equal(result.head, head, 'the working copy did not move');
  assert.equal(result.untrackedFiles, 1);
});

test('a diverged host is refused rather than merged', async (t) => {
  // --ff-only is the whole safety story for Pull: it can move the branch
  // forward onto what the remote has, and do nothing else.
  const origin = makeRepo(t, { bare: true });
  const work = makeRepo(t);
  commit(work, 'AppShell.tsx', 'v9\n', 'Alpha 9.0');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-u', 'origin', 'main');

  const other = mkdtempSync(join(tmpdir(), 'alpha-other-'));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  git(other, 'clone', origin, '.');
  git(other, 'config', 'user.email', 'test@example.com');
  git(other, 'config', 'user.name', 'Test');
  commit(other, 'notes.md', 'theirs\n', 'Theirs');
  git(other, 'push', 'origin', 'main');

  // And the host commits something of its own, so the two have diverged.
  const mine = commit(work, 'local.md', 'mine\n', 'Mine');
  useRoot(t, work);

  const result = await update.run({ action: 'Pull' });

  assert.equal(result.pulled, false);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.head, mine, 'the host kept its own commit');
});

// ---------------------------------------------- the laptops' own self-update
// Driven as a subprocess, the way the scheduled task on each machine runs it.

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF_UPDATE = fileURLToPath(new URL('../scripts/self-update.mjs', import.meta.url));

function runSelfUpdate(repo) {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [SELF_UPDATE, '--repo', repo, '--json'],
      { encoding: 'utf8' },
      (error, stdout) => resolvePromise({ exitCode: error?.code ?? 0, result: JSON.parse(stdout) }),
    );
  });
}

test('a laptop already on the current release does nothing and says so', async (t) => {
  const origin = makeRepo(t, { bare: true });
  const work = makeRepo(t);
  const head = commit(work, 'README.md', 'v1\n', 'Release 1');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-u', 'origin', 'main');

  const { exitCode, result } = await runSelfUpdate(work);

  assert.equal(exitCode, 0, 'exit 0 means the scheduler need not restart anything');
  assert.equal(result.updated, false);
  assert.equal(result.head, head);
});

test('a laptop behind the fleet fast-forwards and asks to be restarted', async (t) => {
  const origin = makeRepo(t, { bare: true });
  const work = makeRepo(t);
  const before = commit(work, 'README.md', 'v1\n', 'Release 1');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-u', 'origin', 'main');

  const other = mkdtempSync(join(tmpdir(), 'alpha-fleet-'));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  git(other, 'clone', origin, '.');
  git(other, 'config', 'user.email', 'test@example.com');
  git(other, 'config', 'user.name', 'Test');
  const next = commit(other, 'README.md', 'v2\n', 'Release 2');
  git(other, 'push', 'origin', 'main');

  const { exitCode, result } = await runSelfUpdate(work);

  // 10 is the whole point: it is how a scheduled task knows to bounce the
  // agent, without this script deciding that for the machine's owner.
  assert.equal(exitCode, 10);
  assert.equal(result.updated, true);
  assert.equal(result.previousHead, before);
  assert.equal(result.head, next);
  assert.equal(result.subject, 'Release 2');
});

test('a laptop somebody is working on is left alone', async (t) => {
  const origin = makeRepo(t, { bare: true });
  const work = makeRepo(t);
  const head = commit(work, 'README.md', 'v1\n', 'Release 1');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-u', 'origin', 'main');
  writeFileSync(join(work, 'scratch.txt'), 'half-finished\n');

  const { exitCode, result } = await runSelfUpdate(work);

  assert.equal(exitCode, 1);
  assert.equal(result.ok, false);
  assert.match(result.reason, /uncommitted/);
  assert.equal(git(work, 'rev-parse', 'HEAD'), head, 'nothing moved');
});

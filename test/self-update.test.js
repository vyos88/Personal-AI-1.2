import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dirname, '../scripts/self-update.mjs');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

/** One commit at a fixed date, so a test can assert on the age it reports. */
function commit(repo, name, text, at) {
  writeFileSync(join(repo, name), text);
  git(repo, 'add', '-A');
  execFileSync('git', ['commit', '-qm', name], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
  });
}

/**
 * An upstream with three commits the checkout has not got, cloned at the
 * first. Stands in for the Host on 2026-10-08: a laptop pinned where its last
 * successful update left it, with main moving on without it.
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'self-update-test-'));
  const origin = join(dir, 'origin');
  mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  git(origin, 'config', 'user.email', 't@t');
  git(origin, 'config', 'user.name', 't');
  commit(origin, 'a.txt', 'base\n', '2026-10-08T07:00:00+00:00');

  const repo = join(dir, 'checkout');
  git(dir, 'clone', '-q', origin, repo);
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');

  commit(origin, 'b.txt', 'one\n', '2026-10-08T07:30:00+00:00');
  commit(origin, 'c.txt', 'two\n', '2026-10-08T09:00:00+00:00');
  commit(origin, 'd.txt', 'three\n', '2026-10-08T15:00:00+00:00');
  return { dir, origin, repo };
}

/**
 * The real entrypoint, as the autopilot and the keeper run it. Its 1 and its 10
 * are both deliberate exits, and execFileSync throws on either, so the status
 * is handed back rather than raised.
 */
function run(repo, ...args) {
  const opts = {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  };
  try {
    return { stdout: execFileSync(process.execPath, [SCRIPT, '--repo', repo, ...args], opts), stderr: '', code: 0 };
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.status };
  }
}

test('a refused update says how far behind the stall has left this checkout', () => {
  const { repo } = fixture();
  writeFileSync(join(repo, 'a.txt'), 'somebody is working here\n');

  const { stdout, code } = run(repo, '--json');
  assert.equal(code, 1);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'working copy has uncommitted changes');
  // The remedy is still the headline; the cost is what is new.
  assert.equal(result.behind, 3);
  assert.match(result.oldestMissing, /^2026-10-08T07:30/);
});

test('the refusal prints the cost beside the reason, not instead of it', () => {
  const { repo } = fixture();
  writeFileSync(join(repo, 'a.txt'), 'held\n');

  const { stderr, code } = run(repo);
  assert.equal(code, 1);
  assert.match(stderr, /working copy has uncommitted changes/);
  assert.match(stderr, /3 commit\(s\) behind its upstream/);
  assert.match(stderr, /oldest waiting since 2026-10-08T07:30/);
});

test('a checkout that is dirty but current reports no gap at all', () => {
  const { dir, origin } = fixture();
  const repo = join(dir, 'current');
  git(dir, 'clone', '-q', origin, repo);
  writeFileSync(join(repo, 'a.txt'), 'held\n');

  const { stdout, stderr, code } = run(repo, '--json');
  assert.equal(code, 1);
  const result = JSON.parse(stdout);
  assert.equal(result.reason, 'working copy has uncommitted changes');
  assert.equal(result.behind, undefined);
  assert.doesNotMatch(stderr, /behind its upstream/);
});

test('an unreachable remote does not replace the reason the caller came for', () => {
  const { dir, repo } = fixture();
  writeFileSync(join(repo, 'a.txt'), 'held\n');
  git(repo, 'remote', 'set-url', 'origin', join(dir, 'gone'));

  const { stdout, code } = run(repo, '--json');
  assert.equal(code, 1);
  const result = JSON.parse(stdout);
  // Still the dirty tree, not a second error about the network, and no guess
  // at a gap it could not measure.
  assert.equal(result.reason, 'working copy has uncommitted changes');
  assert.equal(result.behind, undefined);
});

test('a clean checkout still fast-forwards and asks for a restart', () => {
  const { repo } = fixture();

  const { stdout, code } = run(repo, '--json');
  assert.equal(code, 10);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.updated, true);
  assert.equal(result.subject, 'd.txt');
});

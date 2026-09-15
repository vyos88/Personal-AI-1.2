// The supervisor that keeps one agent running on a laptop and keeps it current.
//
// Driven as a real subprocess against real git repositories, because every
// interesting thing here is a process lifetime: a child that is restarted onto
// new code, one that crashed, one that was told to stand down. A stubbed
// spawn() would assert that I called the functions I wrote down.
//
// The "agent" in these checkouts is a stub at src/agent/index.js — the path the
// keeper runs from the checkout it is keeping current. That is the seam: it
// lets a test move the remote forward and then see the *new* stub start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEEPER = fileURLToPath(new URL('../scripts/keep-agent.mjs', import.meta.url));

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo(t, { bare = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'alpha-keeper-'));
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

/**
 * A stand-in for src/agent/index.js.
 *
 * `marker` is what it appends to the log on startup, so a test can tell the
 * release before a pull from the release after it. `mode` is how it behaves:
 * it stays up, exits 0 like an agent that was told to stand down, or exits 1
 * like one that crashed — the three cases the keeper has to tell apart.
 */
function stubAgent({ marker, mode = 'stay' }) {
  return `
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
const log = process.env.KEEPER_TEST_LOG;
appendFileSync(log, 'start ${marker}\\n');
const mode = ${JSON.stringify(mode)};
if (mode === 'stand-down') process.exit(0);
if (mode === 'crash-once') {
  const flag = log + '.crashed';
  if (!existsSync(flag)) {
    writeFileSync(flag, '1');
    process.exit(1);
  }
}
process.on('message', (m) => {
  if (m !== 'alpha:shutdown') return;
  appendFileSync(log, 'stop ${marker}\\n');
  process.exit(0);
});
setInterval(() => {}, 1000);
`;
}

function writeAgent(repo, source) {
  mkdirSync(join(repo, 'src', 'agent'), { recursive: true });
  writeFileSync(join(repo, 'src', 'agent', 'index.js'), source);
}

/** A checkout with a stub agent in it, wired to a bare origin. */
function fleetRepo(t, { marker = 'v1', mode = 'stay' } = {}) {
  const origin = makeRepo(t, { bare: true });
  const work = makeRepo(t);
  writeAgent(work, stubAgent({ marker, mode }));
  git(work, 'add', '-A');
  git(work, 'commit', '-m', `Release ${marker}`);
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-u', 'origin', 'main');
  return { origin, work };
}

/** Pushes a new release to `origin` from a clone of it. */
function releaseTo(t, origin, { marker, mode = 'stay' }) {
  const other = mkdtempSync(join(tmpdir(), 'alpha-release-'));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  git(other, 'clone', origin, '.');
  git(other, 'config', 'user.email', 'test@example.com');
  git(other, 'config', 'user.name', 'Test');
  writeAgent(other, stubAgent({ marker, mode }));
  git(other, 'add', '-A');
  git(other, 'commit', '-m', `Release ${marker}`);
  git(other, 'push', 'origin', 'main');
}

function startKeeper(t, repo, extraArgs = []) {
  const logFile = join(mkdtempSync(join(tmpdir(), 'alpha-keeperlog-')), 'events.log');
  writeFileSync(logFile, '');
  const child = spawn(
    process.execPath,
    [KEEPER, '--repo', repo, '--interval-ms', '150', '--stop-timeout-ms', '3000', ...extraArgs],
    { env: { ...process.env, KEEPER_TEST_LOG: logFile, ALPHA_LOG_LEVEL: 'error' }, stdio: 'ignore' },
  );
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  t.after(() => {
    child.kill('SIGKILL');
    rmSync(logFile, { force: true });
  });
  return {
    child,
    exited,
    events: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : []),
    logFile,
  };
}

async function waitFor(what, predicate, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ------------------------------------------------------------- the whole job

test('a new release restarts the agent onto the new code', async (t) => {
  const { origin, work } = fleetRepo(t, { marker: 'v1' });
  const keeper = startKeeper(t, work);

  await waitFor('the agent to start', () => keeper.events().includes('start v1'));

  releaseTo(t, origin, { marker: 'v2' });

  await waitFor('the agent to restart on the new release', () =>
    keeper.events().includes('start v2'),
  );

  // Drained rather than killed: the old process was asked to stop and said so
  // before the new one started. That is what keeps a finished task's result
  // from being re-run by the host.
  const events = keeper.events();
  assert.deepEqual(events.slice(0, 3), ['start v1', 'stop v1', 'start v2']);
  assert.equal(git(work, 'log', '-1', '--pretty=%s'), 'Release v2');

  keeper.child.kill('SIGTERM');
  assert.equal(await keeper.exited, 0);
});

test('a stand-down stops the keeper too, instead of respawning into an eviction loop', async (t) => {
  const { work } = fleetRepo(t, { marker: 'v1', mode: 'stand-down' });
  const keeper = startKeeper(t, work);

  assert.equal(await keeper.exited, 0, 'the supervisor stands down with its agent');
  assert.deepEqual(keeper.events(), ['start v1'], 'and does not start a second one');
});

test('an agent that crashes is brought back', async (t) => {
  const { work } = fleetRepo(t, { marker: 'v1', mode: 'crash-once' });
  const keeper = startKeeper(t, work);

  await waitFor('the agent to come back after crashing', () => keeper.events().length >= 2);
  assert.deepEqual(keeper.events(), ['start v1', 'start v1']);

  keeper.child.kill('SIGTERM');
  assert.equal(await keeper.exited, 0);
});

test('a checkout somebody is working on stops the update, not the agent', async (t) => {
  const { origin, work } = fleetRepo(t, { marker: 'v1' });
  writeFileSync(join(work, 'scratch.txt'), 'half-finished\n');
  const keeper = startKeeper(t, work);

  await waitFor('the agent to start', () => keeper.events().includes('start v1'));
  releaseTo(t, origin, { marker: 'v2' });

  // Several ticks' worth. The agent should still be the one that was running.
  await new Promise((r) => setTimeout(r, 900));
  assert.deepEqual(keeper.events(), ['start v1']);
  assert.equal(git(work, 'log', '-1', '--pretty=%s'), 'Release v1', 'nothing moved under the work');

  keeper.child.kill('SIGTERM');
  assert.equal(await keeper.exited, 0);
});

test('another checkout is kept current, and nothing is restarted for it', async (t) => {
  const { work } = fleetRepo(t, { marker: 'v1' });
  const alphaOrigin = makeRepo(t, { bare: true });
  const alpha = makeRepo(t);
  writeFileSync(join(alpha, 'app.txt'), 'v1\n');
  git(alpha, 'add', '-A');
  git(alpha, 'commit', '-m', 'Alpha 1');
  git(alpha, 'remote', 'add', 'origin', alphaOrigin);
  git(alpha, 'push', '-u', 'origin', 'main');

  const keeper = startKeeper(t, work, ['--also-repo', alpha]);
  await waitFor('the agent to start', () => keeper.events().includes('start v1'));

  const other = mkdtempSync(join(tmpdir(), 'alpha-other-'));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  git(other, 'clone', alphaOrigin, '.');
  git(other, 'config', 'user.email', 'test@example.com');
  git(other, 'config', 'user.name', 'Test');
  writeFileSync(join(other, 'app.txt'), 'v2\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-m', 'Alpha 2');
  git(other, 'push', 'origin', 'main');

  await waitFor('the other checkout to fast-forward', () =>
    git(alpha, 'log', '-1', '--pretty=%s') === 'Alpha 2',
  );
  assert.deepEqual(keeper.events(), ['start v1'], 'the agent was not restarted for it');

  keeper.child.kill('SIGTERM');
  assert.equal(await keeper.exited, 0);
});

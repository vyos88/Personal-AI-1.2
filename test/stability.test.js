// Resource bounds on a host and agent that are meant to run for months: what
// the coordinator keeps, what a hung-up connection leaves behind, and what a
// handler that will not stop costs the worker running it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHost } from '../src/host/server.js';
import { TaskQueue } from '../src/host/queue.js';
import { AuthService, DEFAULT_SESSION_TTL_MS } from '../src/host/auth/service.js';
import { AuthStore } from '../src/host/auth/store.js';
import { TunnelAgent } from '../src/agent/agent.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';
import { fetchJson } from '../src/common/http.js';
import { TaskStatus } from '../src/common/protocol.js';
import { TokenKind, parseToken } from '../src/host/auth/tokens.js';

const TOKEN = 'test-token-that-is-long-enough';

// The CPU load these agents report, in place of the machine's real one. None
// of these tests is about load, but an agent reading the real figure stands
// aside for up to LOAD_THROTTLE_MAX_MS whenever the box running the suite is
// busy (the suite itself, run in parallel, is enough), and every task deadline
// here is shorter than that. load.test.js is where throttling is exercised.
const IDLE_LOAD = { snapshot: () => ({ cpus: 1, busy: 0, loadAverage1: 0, loadFactor: 0 }) };

async function startHost(options = {}) {
  const host = createHost({ token: TOKEN, ...options });
  await new Promise((resolve) => host.server.listen(0, '127.0.0.1', resolve));
  const { port } = host.server.address();
  return { ...host, port, url: `http://127.0.0.1:${port}` };
}

async function waitForTask(url, taskId, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await fetchJson(`${url}/tasks/${taskId}`, { token: TOKEN });
    if (body.status !== TaskStatus.QUEUED && body.status !== TaskStatus.LEASED) return body;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`task ${taskId} did not finish within ${timeoutMs}ms`);
}

// ------------------------------------------------------------ queue retention

test('the queue forgets finished tasks after their retention', async () => {
  let clock = 1_000;
  const queue = new TaskQueue({ now: () => clock, finishedRetentionMs: 10_000 });

  const done = queue.enqueue({ type: 'echo', payload: {}, leaseMs: 60_000, maxAttempts: 1 });
  await queue.lease({ agentId: 'a', capabilities: ['echo'], waitMs: 0 });
  queue.complete(done.id, 'a', { ok: 1 });
  const waiting = queue.enqueue({ type: 'nobody-runs-this', payload: {}, leaseMs: 60_000, maxAttempts: 1 });

  clock += 9_000;
  queue.sweep();
  assert.equal(queue.get(done.id)?.status, TaskStatus.SUCCEEDED, 'kept inside its retention');

  clock += 2_000;
  queue.sweep();
  assert.equal(queue.get(done.id), null, 'dropped once past it');
  // Only finished work is ever forgotten, however old the rest is.
  assert.equal(queue.get(waiting.id)?.status, TaskStatus.QUEUED);
  assert.equal(queue.stats().total, 1);
  queue.stop();
});

test('the queue keeps at most maxFinished finished tasks, dropping the oldest', async () => {
  const queue = new TaskQueue({ maxFinished: 3 });
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const task = queue.enqueue({ type: 'echo', payload: { i }, leaseMs: 60_000, maxAttempts: 1 });
    ids.push(task.id);
    queue.cancel(task.id);
  }
  const leased = queue.enqueue({ type: 'echo', payload: {}, leaseMs: 60_000, maxAttempts: 1 });
  await queue.lease({ agentId: 'a', capabilities: ['echo'], waitMs: 0 });

  assert.equal(queue.get(ids[0]), null);
  assert.equal(queue.get(ids[1]), null);
  assert.deepEqual(
    ids.slice(2).map((id) => queue.get(id)?.status),
    [TaskStatus.CANCELLED, TaskStatus.CANCELLED, TaskStatus.CANCELLED],
  );
  assert.equal(queue.get(leased.id)?.status, TaskStatus.LEASED, 'live work is never counted against the cap');
  queue.stop();
});

test('a finished task still reaches the ledger before the queue forgets it', async () => {
  const recorded = [];
  const queue = new TaskQueue({ maxFinished: 0, onTerminal: (task) => recorded.push(task.id) });
  const task = queue.enqueue({ type: 'echo', payload: {}, leaseMs: 60_000, maxAttempts: 1 });
  queue.cancel(task.id);
  assert.deepEqual(recorded, [task.id]);
  assert.equal(queue.get(task.id), null);
  queue.stop();
});

// ------------------------------------------------------------- dead long polls

test('a poll whose connection is already gone is handed nothing', async () => {
  const queue = new TaskQueue();
  const task = queue.enqueue({ type: 'echo', payload: {}, leaseMs: 60_000, maxAttempts: 1 });

  const controller = new AbortController();
  controller.abort();
  const leased = await queue.lease({
    agentId: 'a',
    capabilities: ['echo'],
    waitMs: 5_000,
    signal: controller.signal,
  });

  assert.equal(leased, null);
  assert.equal(task.status, TaskStatus.QUEUED, 'the task was not leased into a dead connection');
  assert.equal(queue.stats().waiters, 0, 'and nothing was parked for it either');
  queue.stop();
});

test('a task leased into a poll that hung up is handed back without costing an attempt', async () => {
  const queue = new TaskQueue();
  // One attempt: charging it for a delivery that never happened would fail
  // this task outright without a machine ever having seen it.
  const task = queue.enqueue({ type: 'echo', payload: {}, leaseMs: 60_000, maxAttempts: 1 });
  const leased = await queue.lease({ agentId: 'a', capabilities: ['echo'], waitMs: 0 });
  assert.equal(leased.id, task.id);

  queue.undelivered(task.id, 'a');
  assert.equal(task.status, TaskStatus.QUEUED);
  assert.equal(task.attempts, 0);
  assert.equal(task.declines, 0, 'nobody declined it');

  // And it is still there for a poll that does reach an agent.
  const again = await queue.lease({ agentId: 'b', capabilities: ['echo'], waitMs: 0 });
  assert.equal(again.id, task.id);
  queue.complete(task.id, 'b', { ok: 1 });
  assert.equal(task.status, TaskStatus.SUCCEEDED);
  assert.equal(task.attempts, 1);
  queue.stop();
});

test('a body declared over the cap is refused without being read', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  let received = '';
  const outcome = await new Promise((resolve) => {
    const socket = connect(host.port, '127.0.0.1', () => {
      socket.write(
        'POST /tasks HTTP/1.1\r\nHost: x\r\n' +
          `Authorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\n` +
          'Content-Length: 50000000\r\n\r\n{',
      );
    });
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      received += chunk;
    });
    socket.on('error', () => {});
    socket.on('close', () => resolve('closed'));
    setTimeout(() => {
      socket.destroy();
      resolve('still open');
    }, 3_000);
  });
  assert.equal(outcome, 'closed', 'the host hung up instead of waiting for 50 MB');
  // And said why, rather than resetting the connection: a client that waits
  // for an answer can tell "too large" from "the host fell over".
  assert.match(received, /^HTTP\/1\.1 413 /);
  assert.match(received, /connection: close/i);
  assert.match(received, /payload_too_large/);

  const { body } = await fetchJson(`${host.url}/healthz`);
  assert.equal(body.ok, true);
});

test('a client that hangs up mid-body does not hold up the host closing', async () => {
  const host = await startHost();

  await new Promise((resolve) => {
    const socket = connect(host.port, '127.0.0.1', () => {
      socket.write(
        'POST /tasks HTTP/1.1\r\nHost: x\r\n' +
          `Authorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\n` +
          'Content-Length: 100\r\n\r\n{"type":',
      );
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 100);
    });
    socket.on('error', () => {});
  });

  const started = Date.now();
  await host.close({ graceMs: 10_000 });
  assert.ok(Date.now() - started < 2_000, `close took ${Date.now() - started}ms`);
});

// ---------------------------------------------------------- a handler that hangs

test('a handler that ignores its abort does not keep the worker forever', async (t) => {
  const host = await startHost();
  const handlers = new HandlerRegistry();
  handlers.register({
    type: 'hang',
    description: 'never settles, and ignores its signal',
    run: () => new Promise(() => {}),
  });

  const agent = new TunnelAgent({
    loadSampler: IDLE_LOAD,
    hostUrl: host.url,
    token: TOKEN,
    name: 'hang-test',
    instanceId: 'hang-test-instance',
    handlers,
    pollWaitMs: 500,
    abortGraceMs: 100,
  });
  const running = agent.start();
  t.after(async () => {
    await agent.stop({ drainMs: 0 });
    await running;
    await host.close();
  });

  const { body: hung } = await fetchJson(`${host.url}/tasks`, {
    method: 'POST',
    token: TOKEN,
    body: { type: 'hang', payload: {}, leaseMs: 1_000, maxAttempts: 1 },
  });
  const failed = await waitForTask(host.url, hung.id);
  assert.equal(failed.status, TaskStatus.FAILED);
  assert.equal(failed.error.code, 'handler_unresponsive');

  // The point: at concurrency 1 the slot is free again, so the next task runs.
  const { body: next } = await fetchJson(`${host.url}/tasks`, {
    method: 'POST',
    token: TOKEN,
    body: { type: 'echo', payload: { after: 'hang' }, maxAttempts: 1 },
  });
  const done = await waitForTask(host.url, next.id);
  assert.equal(done.status, TaskStatus.SUCCEEDED);
});

// ------------------------------------------------------------- login failures

test('failed logins for made-up emails are tracked within a bound', async () => {
  const auth = new AuthService({
    store: new AuthStore({ path: null }),
    bootstrapToken: TOKEN,
    maxTrackedLoginFailures: 3,
  });
  await auth.load();

  for (let i = 0; i < 6; i++) {
    await assert.rejects(() => auth.login({ email: `nobody${i}@example.com`, password: 'wrong-password' }));
  }
  assert.ok(auth.trackedLoginFailures <= 3, `tracked ${auth.trackedLoginFailures}`);
});

// ---------------------------------------------------------------- login sessions

test('expired login sessions are pruned from the store, live ones and API keys are not', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'alpha-sessions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'auth.json');
  let clock = Date.now();
  const open = async () => {
    const auth = new AuthService({ store: new AuthStore({ path }), bootstrapToken: TOKEN, now: () => clock });
    await auth.load();
    return auth;
  };
  const sessionIds = (auth) =>
    Object.values(auth.store.data.apiKeys).filter((key) => key.kind === TokenKind.SESSION).map((key) => key.id);

  const auth = await open();
  const admin = await auth.authenticate(TOKEN);
  const { token: inviteToken } = await auth.createInvite({ email: 'long@example.com', scopes: 'viewer', invitedBy: admin });
  const { user, token: apiKey } = await auth.redeemInvite({ token: inviteToken, password: 'a-perfectly-fine-password' });
  // An API key that has expired is a named credential an operator may still
  // want listed; only sessions are pruned.
  await auth.createApiKey({ userId: user.id, name: 'short', scopes: 'viewer', expiresInMs: 1_000 }, admin);

  const login = () => auth.login({ email: 'long@example.com', password: 'a-perfectly-fine-password' });
  const first = await login();
  const second = await login();
  assert.equal(sessionIds(auth).length, 2);

  // Past the first two's expiry, the next login sheds them as it issues.
  clock += DEFAULT_SESSION_TTL_MS + 1;
  const third = await login();
  assert.deepEqual(sessionIds(auth), [parseToken(third.token).id]);
  assert.ok(await auth.authenticate(third.token), 'the live session still works');
  assert.ok(await auth.authenticate(apiKey), 'and so does the API key');
  assert.equal(Object.keys(auth.store.data.apiKeys).length, 3, 'API keys, expired or not, are kept');

  const raw = await readFile(path, 'utf8');
  for (const gone of [first, second]) assert.ok(!raw.includes(parseToken(gone.token).id));
  assert.ok(!raw.includes(parseToken(third.token).secret), 'no session secret reaches disk');

  // And a host that restarts after the last one expired sheds it on load.
  // (authenticate() persists lastUsedAt without waiting; let that land before
  // a second store opens the same file.)
  await auth.store.save();
  clock += DEFAULT_SESSION_TTL_MS + 1;
  const reopened = await open();
  assert.deepEqual(sessionIds(reopened), []);
  assert.ok(!(await readFile(path, 'utf8')).includes(parseToken(third.token).id), 'and says so on disk');
  assert.ok(await reopened.authenticate(apiKey));
});

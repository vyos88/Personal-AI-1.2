// Resource bounds on a host and agent that are meant to run for months: what
// the coordinator keeps, what a hung-up connection leaves behind, and what a
// handler that will not stop costs the worker running it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';

import { createHost } from '../src/host/server.js';
import { TaskQueue } from '../src/host/queue.js';
import { AuthService } from '../src/host/auth/service.js';
import { AuthStore } from '../src/host/auth/store.js';
import { TunnelAgent } from '../src/agent/agent.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';
import { fetchJson } from '../src/common/http.js';
import { TaskStatus } from '../src/common/protocol.js';

const TOKEN = 'test-token-that-is-long-enough';

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

test('a body declared over the cap is refused without being read', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  const outcome = await new Promise((resolve) => {
    const socket = connect(host.port, '127.0.0.1', () => {
      socket.write(
        'POST /tasks HTTP/1.1\r\nHost: x\r\n' +
          `Authorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\n` +
          'Content-Length: 50000000\r\n\r\n{',
      );
    });
    socket.on('error', () => {});
    socket.on('close', () => resolve('closed'));
    setTimeout(() => {
      socket.destroy();
      resolve('still open');
    }, 3_000);
  });
  assert.equal(outcome, 'closed', 'the host hung up instead of waiting for 50 MB');

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

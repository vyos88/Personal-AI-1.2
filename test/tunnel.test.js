import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

import { createHost } from '../src/host/server.js';
import { TaskQueue } from '../src/host/queue.js';
import { TunnelAgent } from '../src/agent/agent.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';
import { fetchJson, HttpError } from '../src/common/http.js';
import { TaskStatus } from '../src/common/protocol.js';

const TOKEN = 'test-token-that-is-long-enough';

async function startHost(options = {}) {
  const host = createHost({ token: TOKEN, ...options });
  await new Promise((resolve) => host.server.listen(0, '127.0.0.1', resolve));
  const { port } = host.server.address();
  return { ...host, url: `http://127.0.0.1:${port}` };
}

function enqueue(url, body) {
  return fetchJson(`${url}/tasks`, { method: 'POST', token: TOKEN, body });
}

/** Polls a task until it reaches a terminal state or the deadline passes. */
async function waitForTask(url, taskId, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await fetchJson(`${url}/tasks/${taskId}`, { token: TOKEN });
    if (body.status !== TaskStatus.QUEUED && body.status !== TaskStatus.LEASED) return body;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`task ${taskId} did not finish within ${timeoutMs}ms`);
}

test('host serves /healthz without a token', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  const { status, body } = await fetchJson(`${host.url}/healthz`);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test('host rejects an unauthenticated request', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  await assert.rejects(
    () => fetchJson(`${host.url}/agents`),
    (error) => error instanceof HttpError && error.status === 401,
  );
});

test('host rejects a wrong token', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  await assert.rejects(
    () => fetchJson(`${host.url}/agents`, { token: 'not-the-right-token-at-all' }),
    (error) => error instanceof HttpError && error.status === 401,
  );
});

test('agent registers, runs an echo task, and reports the result', async (t) => {
  const host = await startHost();
  const agent = new TunnelAgent({ hostUrl: host.url, token: TOKEN, name: 'test-agent', pollWaitMs: 1_000 });
  const running = agent.start();

  t.after(async () => {
    await agent.stop();
    await running;
    await host.close();
  });

  const { body: created } = await enqueue(host.url, { type: 'echo', payload: { hello: 'tunnel' } });
  const finished = await waitForTask(host.url, created.id);

  assert.equal(finished.status, TaskStatus.SUCCEEDED);
  assert.deepEqual(finished.result.echoed, { hello: 'tunnel' });
  assert.equal(finished.attempts, 1);

  const { body: agents } = await fetchJson(`${host.url}/agents`, { token: TOKEN });
  assert.equal(agents.agents.length, 1);
  assert.equal(agents.agents[0].name, 'test-agent');
  assert.equal(agents.agents[0].tasksCompleted, 1);
});

test('agent runs a task enqueued before it attached', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  // Queued while nothing is listening — the host reports that fact rather than
  // rejecting the task.
  const { body: created } = await enqueue(host.url, { type: 'sysinfo' });
  assert.equal(created.agentAvailable, false);

  const agent = new TunnelAgent({ hostUrl: host.url, token: TOKEN, pollWaitMs: 1_000 });
  const running = agent.start();
  t.after(async () => {
    await agent.stop();
    await running;
  });

  const finished = await waitForTask(host.url, created.id);
  assert.equal(finished.status, TaskStatus.SUCCEEDED);
  assert.equal(typeof finished.result.hostname, 'string');
  assert.equal(typeof finished.result.cpus, 'number');
});

test('an agent started before its host connects once the host comes up', async (t) => {
  // Reserve a port and release it, so the agent spends its first attempts
  // talking to nothing at all before the host claims the same port.
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));

  const url = `http://127.0.0.1:${port}`;
  const agent = new TunnelAgent({ hostUrl: url, token: TOKEN, name: 'early-agent', pollWaitMs: 1_000 });
  const running = agent.start();

  // Long enough for the connection to be refused and a backoff nap to start.
  await new Promise((resolve) => setTimeout(resolve, 400));

  const host = createHost({ token: TOKEN });
  await new Promise((resolve) => host.server.listen(port, '127.0.0.1', resolve));

  t.after(async () => {
    await agent.stop();
    await running;
    await host.close();
  });

  const { body: created } = await fetchJson(`${url}/tasks`, {
    method: 'POST',
    token: TOKEN,
    body: { type: 'echo', payload: { late: true } },
  });
  const finished = await waitForTask(url, created.id, { timeoutMs: 25_000 });

  assert.equal(finished.status, TaskStatus.SUCCEEDED);
  assert.deepEqual(finished.result.echoed, { late: true });
});

test('a failing handler is retried and then marked failed', async (t) => {
  const host = await startHost();

  let calls = 0;
  const handlers = new HandlerRegistry([
    { type: 'always-fails', run: async () => { calls += 1; throw new Error('boom'); } },
  ]);
  const agent = new TunnelAgent({ hostUrl: host.url, token: TOKEN, handlers, pollWaitMs: 1_000 });
  const running = agent.start();

  t.after(async () => {
    await agent.stop();
    await running;
    await host.close();
  });

  const { body: created } = await enqueue(host.url, { type: 'always-fails', maxAttempts: 2 });
  const finished = await waitForTask(host.url, created.id);

  assert.equal(finished.status, TaskStatus.FAILED);
  assert.equal(finished.attempts, 2);
  assert.equal(calls, 2);
  assert.match(finished.error.message, /boom/);
});

test('a task nobody can run stays queued instead of failing', async (t) => {
  const host = await startHost();
  const agent = new TunnelAgent({ hostUrl: host.url, token: TOKEN, capabilities: ['echo'], pollWaitMs: 500 });
  const running = agent.start();

  t.after(async () => {
    await agent.stop();
    await running;
    await host.close();
  });

  const { body: created } = await enqueue(host.url, { type: 'sysinfo' });
  await new Promise((r) => setTimeout(r, 400));

  const { body: task } = await fetchJson(`${host.url}/tasks/${created.id}`, { token: TOKEN });
  assert.equal(task.status, TaskStatus.QUEUED);
  assert.equal(task.attempts, 0);
});

test('an unknown agent id gets 410 so it re-registers', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  await assert.rejects(
    () => fetchJson(`${host.url}/agent/agent_doesnotexist/heartbeat`, { method: 'POST', token: TOKEN }),
    (error) => error instanceof HttpError && error.status === 410,
  );
});

test('host rejects a protocol version mismatch at registration', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  await assert.rejects(
    () => fetchJson(`${host.url}/agent/register`, {
      method: 'POST',
      token: TOKEN,
      body: { protocolVersion: 999, name: 'future-agent', capabilities: ['echo'] },
    }),
    (error) => error instanceof HttpError && error.status === 409,
  );
});

test('host rejects a malformed task type', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  await assert.rejects(
    () => enqueue(host.url, { type: 'NOT VALID' }),
    (error) => error instanceof HttpError && error.status === 400,
  );
});

test('a task can be cancelled while queued', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  const { body: created } = await enqueue(host.url, { type: 'echo' });
  const { body: cancelled } = await fetchJson(`${host.url}/tasks/${created.id}/cancel`, {
    method: 'POST',
    token: TOKEN,
  });
  assert.equal(cancelled.status, TaskStatus.CANCELLED);
});

test('queue requeues a task whose lease expired', () => {
  let clock = 1_000;
  const queue = new TaskQueue({ now: () => clock });

  const task = queue.enqueue({ type: 'echo', payload: {}, leaseMs: 5_000, maxAttempts: 3 });
  const leasePromise = queue.lease({ agentId: 'agent_a', capabilities: ['echo'], waitMs: 0 });

  return leasePromise.then((leased) => {
    assert.equal(leased.id, task.id);
    assert.equal(leased.status, TaskStatus.LEASED);

    // The agent never reports back and its lease runs out.
    clock += 6_000;
    queue.sweep();

    assert.equal(task.status, TaskStatus.QUEUED);
    assert.equal(task.agentId, null);
    assert.equal(task.attempts, 1);

    return queue.lease({ agentId: 'agent_b', capabilities: ['echo'], waitMs: 0 }).then((again) => {
      assert.equal(again.id, task.id);
      assert.equal(again.attempts, 2);
      queue.stop();
    });
  });
});

test('queue fails a task permanently once attempts are exhausted', () => {
  let clock = 1_000;
  const queue = new TaskQueue({ now: () => clock });

  const task = queue.enqueue({ type: 'echo', payload: {}, leaseMs: 1_000, maxAttempts: 1 });
  return queue.lease({ agentId: 'agent_a', capabilities: ['echo'], waitMs: 0 }).then(() => {
    clock += 2_000;
    queue.sweep();
    assert.equal(task.status, TaskStatus.FAILED);
    assert.equal(task.error.code, 'lease_expired');
    queue.stop();
  });
});

test('a parked long poll is handed a task as soon as one is enqueued', async () => {
  const queue = new TaskQueue();
  const pending = queue.lease({ agentId: 'agent_a', capabilities: ['echo'], waitMs: 5_000 });

  const created = queue.enqueue({ type: 'echo', payload: { via: 'waiter' }, leaseMs: 5_000, maxAttempts: 1 });
  const leased = await pending;

  assert.equal(leased.id, created.id);
  assert.deepEqual(leased.payload, { via: 'waiter' });
  queue.stop();
});

test('a long poll returns nothing once its wait elapses', async () => {
  const queue = new TaskQueue();
  const started = Date.now();
  const result = await queue.lease({ agentId: 'agent_a', capabilities: ['echo'], waitMs: 150 });

  assert.equal(result, null);
  assert.ok(Date.now() - started >= 140);
  queue.stop();
});

test('a late report from a previous lease holder is rejected', async () => {
  const queue = new TaskQueue();
  const task = queue.enqueue({ type: 'echo', payload: {}, leaseMs: 5_000, maxAttempts: 3 });
  await queue.lease({ agentId: 'agent_a', capabilities: ['echo'], waitMs: 0 });

  assert.throws(
    () => queue.complete(task.id, 'agent_b', { some: 'result' }),
    (error) => error.status === 409,
  );
  queue.stop();
});

test('handler registry refuses a duplicate or malformed handler', () => {
  const registry = new HandlerRegistry();
  assert.ok(registry.has('echo'));
  assert.throws(() => registry.register({ type: 'echo', run: async () => {} }), /already registered/);
  assert.throws(() => registry.register({ type: 'no-run' }), /must export a run/);
  assert.throws(() => registry.register({ type: 'Bad Type', run: async () => {} }), /must match/);
});

test('agent refuses to advertise a capability it cannot run', () => {
  assert.throws(
    () => new TunnelAgent({ hostUrl: 'http://127.0.0.1:1', token: TOKEN, capabilities: ['nope'] }),
    /no handler registered/,
  );
});

test('the coordinator can serve several addresses at once', async (t) => {
  const host = createHost({ token: TOKEN });
  // 127.0.0.1 and 127.0.0.2 stand in for loopback and a tailnet address:
  // two distinct addresses on this machine, one shared coordinator.
  const addresses = await host.listen({ port: 0, binds: ['127.0.0.1', '127.0.0.2'] });
  t.after(() => host.close());

  const [primary, secondary] = addresses;
  assert.equal(primary.address, '127.0.0.1');
  assert.equal(secondary.address, '127.0.0.2');

  const urls = addresses.map((entry) => `http://${entry.address}:${entry.port}`);
  for (const url of urls) {
    const { body } = await fetchJson(`${url}/healthz`);
    assert.equal(body.ok, true);
  }

  // Same coordinator, not two: a task queued on one address is visible on the
  // other, and auth is shared.
  const { body: created } = await enqueue(urls[0], { type: 'echo' });
  const { body: seen } = await fetchJson(`${urls[1]}/tasks/${created.id}`, { token: TOKEN });
  assert.equal(seen.id, created.id);

  await assert.rejects(
    () => fetchJson(`${urls[1]}/tasks`, { token: 'wrong-token-entirely-here' }),
    (error) => error instanceof HttpError && error.status === 401,
  );
});

test('closing drains every listener, not just the first', async () => {
  const host = createHost({ token: TOKEN });
  const addresses = await host.listen({ port: 0, binds: ['127.0.0.1', '127.0.0.2'] });
  const urls = addresses.map((entry) => `http://${entry.address}:${entry.port}`);

  await host.close();

  // Both should now refuse connections rather than one lingering.
  for (const url of urls) {
    await assert.rejects(() => fetchJson(`${url}/healthz`, { timeoutMs: 2_000 }));
  }
});

test('binding an address this machine does not have fails clearly', async () => {
  const host = createHost({ token: TOKEN });
  await assert.rejects(
    () => host.listen({ port: 0, binds: ['203.0.113.99'] }),
    (error) => error.code === 'EADDRNOTAVAIL' || error.code === 'EINVAL',
  );
  await host.close();
});

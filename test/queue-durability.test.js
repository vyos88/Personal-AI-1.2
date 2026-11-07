import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';

import { createHost } from '../src/host/server.js';
import { TaskQueue } from '../src/host/queue.js';
import { TaskStore } from '../src/host/task-store.js';
import { AgentRegistry } from '../src/host/registry.js';
import { fetchJson, HttpError } from '../src/common/http.js';
import { TaskStatus, PROTOCOL_VERSION, validateTaskInput } from '../src/common/protocol.js';

const TOKEN = 'test-token-that-is-long-enough';

const tempStore = async () => join(await mkdtemp(join(tmpdir(), 'alpha-tasks-')), 'tasks.json');
const task = (extra = {}) => ({ type: 'echo', payload: {}, leaseMs: 5_000, maxAttempts: 3, ...extra });

// ------------------------------------------------------------------ expiry

test('a queued task past its expiresInMs is cancelled as expired', () => {
  let clock = 1_000;
  const queue = new TaskQueue({ now: () => clock });
  const queued = queue.enqueue(task({ expiresInMs: 10_000 }));
  assert.equal(queued.expiresAt, 11_000);

  clock = 10_999;
  queue.sweep();
  assert.equal(queued.status, TaskStatus.QUEUED);

  clock = 11_000;
  queue.sweep();
  assert.equal(queued.status, TaskStatus.CANCELLED);
  assert.equal(queued.error.code, 'expired');
  assert.equal(queue.stats().pending, 0);
});

test('the host default TTL applies when a task names none, and null never expires', () => {
  let clock = 0;
  const withDefault = new TaskQueue({ now: () => clock, defaultTtlMs: 60_000 });
  const forever = new TaskQueue({ now: () => clock });
  const a = withDefault.enqueue(task());
  const b = forever.enqueue(task());
  assert.equal(a.expiresAt, 60_000);
  assert.equal(b.expiresAt, null);

  clock = 10 * 24 * 3_600_000;
  withDefault.sweep();
  forever.sweep();
  assert.equal(a.status, TaskStatus.CANCELLED);
  assert.equal(b.status, TaskStatus.QUEUED);
});

test('a leased task is never expired out from under its agent', async () => {
  let clock = 0;
  const queue = new TaskQueue({ now: () => clock });
  const queued = queue.enqueue(task({ expiresInMs: 1_000, leaseMs: 60_000 }));
  await queue.lease({ agentId: 'agent_a', capabilities: ['echo'], waitMs: 0 });

  clock = 5_000;
  queue.sweep();
  assert.equal(queued.status, TaskStatus.LEASED);
  queue.complete(queued.id, 'agent_a', { done: true });
  assert.equal(queued.status, TaskStatus.SUCCEEDED);
});

test('expiresInMs is validated', () => {
  assert.equal(validateTaskInput({ type: 'echo' }).expiresInMs, null);
  assert.equal(validateTaskInput({ type: 'echo', expiresInMs: 600_000 }).expiresInMs, 600_000);
  assert.throws(() => validateTaskInput({ type: 'echo', expiresInMs: 5 }), /expiresInMs/);
  assert.throws(() => validateTaskInput({ type: 'echo', expiresInMs: '1h' }), /expiresInMs/);
});

// ------------------------------------------------------------- receipts

test('a terminal result gets a receipt, and the same report again gets the same one', async () => {
  const queue = new TaskQueue();
  const queued = queue.enqueue(task());
  await queue.lease({ agentId: 'agent_a', capabilities: ['echo'], waitMs: 0 });

  const first = queue.complete(queued.id, 'agent_a', { n: 1 });
  assert.match(first.receiptId, /^rcpt_/);
  const again = queue.complete(queued.id, 'agent_a', { n: 2 });
  assert.equal(again.receiptId, first.receiptId);
  assert.deepEqual(again.result, { n: 1 }, 'a repeat must not overwrite the stored result');

  // Another agent still cannot claim it.
  assert.throws(() => queue.complete(queued.id, 'agent_b', {}), (error) => error.status === 409);
});

test('a retried failure gets no receipt; the final one does', async () => {
  const queue = new TaskQueue();
  const queued = queue.enqueue(task({ maxAttempts: 2 }));

  await queue.lease({ agentId: 'agent_a', capabilities: ['echo'], waitMs: 0 });
  queue.fail(queued.id, 'agent_a', { message: 'boom' });
  assert.equal(queued.status, TaskStatus.QUEUED);
  assert.equal(queued.receiptId, null);

  await queue.lease({ agentId: 'agent_a', capabilities: ['echo'], waitMs: 0 });
  queue.fail(queued.id, 'agent_a', { message: 'boom' });
  assert.equal(queued.status, TaskStatus.FAILED);
  assert.match(queued.receiptId, /^rcpt_/);
});

// ----------------------------------------------------------- persistence

test('queued, leased and finished tasks survive a restart', async () => {
  const path = await tempStore();
  const first = new TaskQueue({ store: new TaskStore({ path }) });
  const waiting = first.enqueue(task({ payload: { n: 1 } }));
  const running = first.enqueue(task({ payload: { n: 2 } }));
  const done = first.enqueue(task({ payload: { n: 3 } }));

  // Leases go oldest first, so this holds `waiting` and then `running`.
  await first.lease({ agentId: 'agent_a', capabilities: ['echo'], waitMs: 0 });
  await first.lease({ agentId: 'agent_a', capabilities: ['echo'], waitMs: 0 });
  await first.lease({ agentId: 'agent_a', capabilities: ['echo'], waitMs: 0 });
  first.complete(done.id, 'agent_a', { ok: 3 });
  // Put `waiting` back so the three end in three different states.
  first.decline(waiting.id, 'agent_a', { message: 'no room' });
  await first.flush();

  const second = new TaskQueue({ store: new TaskStore({ path }) });
  assert.equal(await second.restore(), 3);

  assert.equal(second.get(waiting.id).status, TaskStatus.QUEUED);
  const restoredRunning = second.get(running.id);
  assert.equal(restoredRunning.status, TaskStatus.QUEUED, 'a lease held by the dead process is requeued');
  assert.equal(restoredRunning.attempts, 1, 'the attempt it spent stays spent');
  assert.equal(second.get(done.id).status, TaskStatus.SUCCEEDED);
  assert.equal(second.get(done.id).receiptId, done.receiptId);
  assert.equal(second.stats().pending, 2);

  // And the restored queue hands them out again, oldest first.
  const next = await second.lease({ agentId: 'agent_b', capabilities: ['echo'], waitMs: 0 });
  assert.equal(next.id, waiting.id);
});

test('the store keeps every open task but only the newest finished ones', async () => {
  const path = await tempStore();
  let clock = 0;
  const queue = new TaskQueue({ now: () => clock, store: new TaskStore({ path, retainFinished: 2 }) });
  const finished = [];
  for (let i = 0; i < 4; i++) {
    clock += 1;
    const t = queue.enqueue(task());
    queue.cancel(t.id);
    finished.push(t.id);
  }
  const open = queue.enqueue(task());
  await queue.flush();

  const saved = JSON.parse(await readFile(path, 'utf8'));
  const ids = saved.tasks.map((t) => t.id);
  assert.ok(ids.includes(open.id));
  assert.deepEqual(ids.filter((id) => id !== open.id).sort(), finished.slice(2).sort());
});

test('a burst of changes coalesces into few writes, and the last write has them all', async () => {
  const path = await tempStore();
  const store = new TaskStore({ path });
  let snapshots = 0;
  const original = store.save.bind(store);
  store.save = (snapshot) => original(() => {
    snapshots += 1;
    return snapshot();
  });
  const queue = new TaskQueue({ store });
  for (let i = 0; i < 50; i++) queue.enqueue(task());
  await queue.flush();

  assert.ok(snapshots <= 3, `expected the burst to coalesce, got ${snapshots} writes`);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.tasks.length, 50);
});

test('a missing store file starts empty; a foreign one is refused', async () => {
  const path = await tempStore();
  assert.deepEqual(await new TaskStore({ path }).load(), []);
  await writeFile(path, JSON.stringify({ users: [] }));
  await assert.rejects(new TaskStore({ path }).load(), /not an alpha\.tasks\.v1/);
  assert.deepEqual(await new TaskStore({ path: null }).load(), []);
});

// ------------------------------------------------------------- over HTTP

async function startHost(queue, registry) {
  const host = createHost({ token: TOKEN, queue, registry });
  await new Promise((resolve) => host.server.listen(0, '127.0.0.1', resolve));
  return { ...host, url: `http://127.0.0.1:${host.server.address().port}` };
}

async function register(url) {
  const { body } = await fetchJson(`${url}/agent/register`, {
    method: 'POST',
    token: TOKEN,
    body: { protocolVersion: PROTOCOL_VERSION, name: 'laptop', capabilities: ['echo'] },
  });
  return body.agentId;
}

test('the result endpoint answers with a stored receipt, and a repeat with the same one', async (t) => {
  const path = await tempStore();
  const registry = new AgentRegistry();
  const queue = new TaskQueue({ admission: registry, store: new TaskStore({ path }) });
  const host = await startHost(queue, registry);
  t.after(() => host.close());

  const agentId = await register(host.url);
  const { body: created } = await fetchJson(`${host.url}/tasks`, {
    method: 'POST',
    token: TOKEN,
    body: { type: 'echo', expiresInMs: 60_000 },
  });
  const { body: leased } = await fetchJson(`${host.url}/agent/${agentId}/tasks/next?wait=0`, { token: TOKEN });
  assert.equal(leased.id, created.id);

  const report = () =>
    fetchJson(`${host.url}/agent/${agentId}/tasks/${created.id}/result`, {
      method: 'POST',
      token: TOKEN,
      body: { ok: true, result: { hello: 'world' } },
    });
  const { body: first } = await report();
  assert.equal(first.status, TaskStatus.SUCCEEDED);
  assert.match(first.receiptId, /^rcpt_/);

  // On disk by the time the agent hears back.
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.tasks.find((t) => t.id === created.id).receiptId, first.receiptId);

  const { body: second } = await report();
  assert.equal(second.receiptId, first.receiptId);
});

test('the result endpoint answers 503 when the result cannot be stored', async (t) => {
  const registry = new AgentRegistry();
  const store = new TaskStore({ path: await tempStore() });
  const queue = new TaskQueue({ admission: registry, store });
  const host = await startHost(queue, registry);
  t.after(() => host.close());

  const agentId = await register(host.url);
  const { body: created } = await fetchJson(`${host.url}/tasks`, { method: 'POST', token: TOKEN, body: { type: 'echo' } });
  await fetchJson(`${host.url}/agent/${agentId}/tasks/next?wait=0`, { token: TOKEN });
  await queue.flush();

  store.save = () => Promise.reject(new Error('disk full'));
  await assert.rejects(
    fetchJson(`${host.url}/agent/${agentId}/tasks/${created.id}/result`, {
      method: 'POST',
      token: TOKEN,
      retries: 0,
      body: { ok: true, result: {} },
    }),
    (error) => error instanceof HttpError && error.status === 503,
  );
});

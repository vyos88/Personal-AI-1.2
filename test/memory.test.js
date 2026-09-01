import test from 'node:test';
import assert from 'node:assert/strict';

import { createHost } from '../src/host/server.js';
import { TaskQueue } from '../src/host/queue.js';
import { AgentRegistry } from '../src/host/registry.js';
import { TunnelAgent } from '../src/agent/agent.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';
import { MemoryStore } from '../src/agent/memstore.js';
import * as memstoreHandler from '../src/agent/handlers/memstore.js';
import { memorySnapshot, reserveFromEnv } from '../src/agent/memory.js';
import { fetchJson } from '../src/common/http.js';
import {
  TaskStatus,
  MB,
  MEMORY_REPORT_STALE_MS,
  DEFAULT_MEMORY_RESERVE_BYTES,
  validateTaskInput,
  validateRegistration,
  validateMemoryReport,
  ProtocolError,
} from '../src/common/protocol.js';

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

async function waitForTask(url, taskId, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await fetchJson(`${url}/tasks/${taskId}`, { token: TOKEN });
    if (body.status !== TaskStatus.QUEUED && body.status !== TaskStatus.LEASED) return body;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`task ${taskId} did not finish within ${timeoutMs}ms`);
}

/** A registry on a clock we control, so staleness can be tested without waiting. */
function fixedRegistry(startAt = 1_000) {
  let clock = startAt;
  const registry = new AgentRegistry({ now: () => clock });
  return { registry, tick: (ms) => (clock += ms) };
}

const gb = (n) => n * 1024 * MB;

// ------------------------------------------------------------------ protocol

test('a task may ask for memory, and defaults to asking for none', () => {
  assert.equal(validateTaskInput({ type: 'echo' }).minMemoryMB, 0);
  assert.equal(validateTaskInput({ type: 'echo', minMemoryMB: 2048 }).minMemoryMB, 2048);
  assert.throws(
    () => validateTaskInput({ type: 'echo', minMemoryMB: -1 }),
    (error) => error instanceof ProtocolError,
  );
  assert.throws(
    () => validateTaskInput({ type: 'echo', minMemoryMB: 1.5 }),
    (error) => error instanceof ProtocolError,
  );
});

test('registration carries an optional memory report', () => {
  const bare = validateRegistration({ protocolVersion: 1, name: 'a', capabilities: ['echo'] });
  assert.equal(bare.memory, null);

  const reported = validateRegistration({
    protocolVersion: 1,
    name: 'a',
    capabilities: ['echo'],
    memory: { totalBytes: gb(16), freeBytes: gb(8), offerableBytes: gb(7) },
  });
  assert.equal(reported.memory.offerableBytes, gb(7));
});

test('an agent may not offer more memory than it says is free', () => {
  const memory = validateMemoryReport({ totalBytes: gb(16), freeBytes: gb(2), offerableBytes: gb(9) });
  assert.equal(memory.offerableBytes, gb(2));
});

test('a malformed memory report is rejected rather than trusted', () => {
  assert.throws(() => validateMemoryReport({ totalBytes: -1, freeBytes: 0 }), ProtocolError);
  assert.throws(() => validateMemoryReport({ totalBytes: gb(1) }), ProtocolError);
  assert.throws(() => validateMemoryReport('lots'), ProtocolError);
});

// ------------------------------------------------------------------ registry

test('registry offers what an agent reported, less its own reserve', () => {
  const { registry } = fixedRegistry();
  const agent = registry.register({
    name: 'laptop',
    capabilities: ['echo'],
    memory: { totalBytes: gb(16), freeBytes: gb(10), offerableBytes: gb(8) },
  });
  assert.equal(registry.offerableBytes(agent.id), gb(8));
});

test('an agent that reports no memory can run ordinary work but nothing memory-hungry', () => {
  const { registry } = fixedRegistry();
  const agent = registry.register({ name: 'quiet', capabilities: ['echo'] });

  assert.equal(registry.offerableBytes(agent.id), 0);
  assert.equal(registry.canAdmit(agent.id, { type: 'echo', minMemoryMB: 0 }), true);
  assert.equal(registry.canAdmit(agent.id, { type: 'echo', minMemoryMB: 1 }), false);
});

test('a stale memory report counts as no memory at all', () => {
  const { registry, tick } = fixedRegistry();
  const agent = registry.register({
    name: 'laptop',
    capabilities: ['echo'],
    memory: { totalBytes: gb(16), freeBytes: gb(8), offerableBytes: gb(8) },
  });

  tick(MEMORY_REPORT_STALE_MS + 1);
  assert.equal(registry.offerableBytes(agent.id), 0);

  // A heartbeat brings it back.
  registry.reportMemory(agent.id, { totalBytes: gb(16), freeBytes: gb(8), offerableBytes: gb(8) });
  assert.equal(registry.offerableBytes(agent.id), gb(8));
});

test('a lease holds its memory until the task finishes', () => {
  const { registry } = fixedRegistry();
  const agent = registry.register({
    name: 'laptop',
    capabilities: ['big'],
    memory: { totalBytes: gb(16), freeBytes: gb(8), offerableBytes: gb(8) },
  });
  const task = { type: 'big', minMemoryMB: 6 * 1024 };

  assert.equal(registry.canAdmit(agent.id, task), true);
  registry.admit(agent.id, task);

  // The second task cannot go here too: the first one's 6 GB is spoken for
  // even though nothing has allocated it yet.
  assert.equal(registry.canAdmit(agent.id, task), false);
  assert.equal(registry.offerableBytes(agent.id), gb(2));

  registry.release(agent.id, task);
  assert.equal(registry.canAdmit(agent.id, task), true);
});

test('registry reports which agents could take a task, and what is on offer overall', () => {
  const { registry } = fixedRegistry();
  registry.register({
    name: 'laptop',
    capabilities: ['big'],
    memory: { totalBytes: gb(16), freeBytes: gb(8), offerableBytes: gb(8) },
  });
  registry.register({
    name: 'pi',
    capabilities: ['big'],
    memory: { totalBytes: gb(1), freeBytes: gb(1) / 2, offerableBytes: gb(1) / 2 },
  });

  assert.equal(registry.candidatesFor({ type: 'big', minMemoryMB: 4096 }).length, 1);
  assert.equal(registry.candidatesFor({ type: 'big', minMemoryMB: 256 }).length, 2);
  assert.equal(registry.candidatesFor({ type: 'other', minMemoryMB: 0 }).length, 0);
  assert.equal(registry.offeredBytes(), gb(8) + gb(1) / 2);
});

// --------------------------------------------------------------------- queue

test('the queue leases a memory-hungry task only to an agent that has the RAM', async () => {
  const { registry } = fixedRegistry();
  const queue = new TaskQueue({ admission: registry });

  const small = registry.register({
    name: 'small',
    capabilities: ['crunch'],
    memory: { totalBytes: gb(4), freeBytes: gb(1), offerableBytes: gb(1) },
  });
  const big = registry.register({
    name: 'big',
    capabilities: ['crunch'],
    memory: { totalBytes: gb(32), freeBytes: gb(16), offerableBytes: gb(16) },
  });

  const task = queue.enqueue({ type: 'crunch', payload: {}, leaseMs: 1_000, maxAttempts: 1, minMemoryMB: 8192 });

  assert.equal(await queue.lease({ agentId: small.id, capabilities: ['crunch'], waitMs: 0 }), null);
  assert.equal(queue.get(task.id).status, TaskStatus.QUEUED);

  const leased = await queue.lease({ agentId: big.id, capabilities: ['crunch'], waitMs: 0 });
  assert.equal(leased.id, task.id);
  assert.equal(registry.offerableBytes(big.id), gb(8));
});

test('a released lease frees the memory for the next task', async () => {
  const { registry } = fixedRegistry();
  const queue = new TaskQueue({ admission: registry });
  const agent = registry.register({
    name: 'laptop',
    capabilities: ['crunch'],
    memory: { totalBytes: gb(16), freeBytes: gb(8), offerableBytes: gb(8) },
  });

  const first = queue.enqueue({ type: 'crunch', payload: {}, leaseMs: 1_000, maxAttempts: 1, minMemoryMB: 6144 });
  const second = queue.enqueue({ type: 'crunch', payload: {}, leaseMs: 1_000, maxAttempts: 1, minMemoryMB: 6144 });

  assert.equal((await queue.lease({ agentId: agent.id, capabilities: ['crunch'], waitMs: 0 })).id, first.id);
  assert.equal(await queue.lease({ agentId: agent.id, capabilities: ['crunch'], waitMs: 0 }), null);

  queue.complete(first.id, agent.id, { ok: true });
  assert.equal(registry.offerableBytes(agent.id), gb(8));
  assert.equal((await queue.lease({ agentId: agent.id, capabilities: ['crunch'], waitMs: 0 })).id, second.id);
});

test('an expired lease hands its memory back', () => {
  let clock = 1_000;
  const registry = new AgentRegistry({ now: () => clock });
  const queue = new TaskQueue({ admission: registry, now: () => clock });
  const agent = registry.register({
    name: 'laptop',
    capabilities: ['crunch'],
    memory: { totalBytes: gb(16), freeBytes: gb(8), offerableBytes: gb(8) },
  });

  const task = queue.enqueue({ type: 'crunch', payload: {}, leaseMs: 1_000, maxAttempts: 2, minMemoryMB: 8192 });
  queue.lease({ agentId: agent.id, capabilities: ['crunch'], waitMs: 0 });
  assert.equal(registry.offerableBytes(agent.id), 0);

  clock += 2_000; // lease expires; still inside the memory report's freshness
  queue.sweep();

  assert.equal(queue.get(task.id).status, TaskStatus.QUEUED);
  assert.equal(registry.offerableBytes(agent.id), gb(8));
});

test('a cancelled lease hands its memory back', async () => {
  const { registry } = fixedRegistry();
  const queue = new TaskQueue({ admission: registry });
  const agent = registry.register({
    name: 'laptop',
    capabilities: ['crunch'],
    memory: { totalBytes: gb(16), freeBytes: gb(8), offerableBytes: gb(8) },
  });

  const task = queue.enqueue({ type: 'crunch', payload: {}, leaseMs: 60_000, maxAttempts: 1, minMemoryMB: 4096 });
  await queue.lease({ agentId: agent.id, capabilities: ['crunch'], waitMs: 0 });
  queue.cancel(task.id);

  assert.equal(registry.offerableBytes(agent.id), gb(8));
});

test('a parked poll is skipped for work its agent has no room for', async () => {
  const { registry } = fixedRegistry();
  const queue = new TaskQueue({ admission: registry });
  const agent = registry.register({
    name: 'small',
    capabilities: ['crunch'],
    memory: { totalBytes: gb(4), freeBytes: gb(1), offerableBytes: gb(1) },
  });

  const parked = queue.lease({ agentId: agent.id, capabilities: ['crunch'], waitMs: 200 });
  const task = queue.enqueue({ type: 'crunch', payload: {}, leaseMs: 1_000, maxAttempts: 1, minMemoryMB: 4096 });

  assert.equal(await parked, null);
  assert.equal(queue.get(task.id).status, TaskStatus.QUEUED);
  assert.equal(queue.memoryBlocked().length, 1);
});

test('a queue with no admission controller places everything', async () => {
  const queue = new TaskQueue();
  const task = queue.enqueue({ type: 'crunch', payload: {}, leaseMs: 1_000, maxAttempts: 1, minMemoryMB: 999_999 });
  const leased = await queue.lease({ agentId: 'agent_anything', capabilities: ['crunch'], waitMs: 0 });
  assert.equal(leased.id, task.id);
});

// ---------------------------------------------------------------- agent side

test('a memory snapshot never offers more than is free, and holds back the reserve', () => {
  const snapshot = memorySnapshot({ reserveBytes: 0 });
  assert.ok(snapshot.totalBytes > 0);
  assert.ok(snapshot.freeBytes >= 0);
  assert.equal(snapshot.offerableBytes, snapshot.freeBytes);

  const reserved = memorySnapshot({ reserveBytes: snapshot.freeBytes + gb(1) });
  assert.equal(reserved.offerableBytes, 0);
});

test('the reserve is read from the environment in MB', () => {
  assert.equal(reserveFromEnv(undefined), DEFAULT_MEMORY_RESERVE_BYTES);
  assert.equal(reserveFromEnv(''), DEFAULT_MEMORY_RESERVE_BYTES);
  assert.equal(reserveFromEnv('2048'), 2048 * MB);
  assert.equal(reserveFromEnv('0'), 0);
  assert.throws(() => reserveFromEnv('-1'));
  assert.throws(() => reserveFromEnv('plenty'));
});

// --------------------------------------------------------------- memory store

test('the store round-trips a value and counts its real size', () => {
  const store = new MemoryStore({ limitBytes: 1 * MB });
  const put = store.put('a/1', { hello: 'world' });

  assert.equal(put.bytes, Buffer.byteLength(JSON.stringify({ hello: 'world' })));
  assert.equal(store.usedBytes, put.bytes);

  const got = store.get('a/1');
  assert.equal(got.hit, true);
  assert.deepEqual(got.value, { hello: 'world' });
  assert.equal(store.get('a/2').hit, false);
});

test('replacing a key does not double-count its bytes', () => {
  const store = new MemoryStore({ limitBytes: 1 * MB });
  store.put('k', 'x'.repeat(1_000));
  const used = store.usedBytes;
  store.put('k', 'y'.repeat(1_000));

  assert.equal(store.size, 1);
  assert.equal(store.usedBytes, used);
});

test('the store evicts least-recently-used entries to stay inside its budget', () => {
  // Room for two ~1 KB values and no more.
  const store = new MemoryStore({ limitBytes: 2_400, maxValueBytes: 2_000 });
  store.put('one', 'a'.repeat(1_000));
  store.put('two', 'b'.repeat(1_000));

  // Touching 'one' makes 'two' the least recently used.
  assert.equal(store.get('one').hit, true);

  const put = store.put('three', 'c'.repeat(1_000));
  assert.deepEqual(put.evicted, ['two']);
  assert.equal(store.get('two').hit, false);
  assert.equal(store.get('one').hit, true);
  assert.ok(store.usedBytes <= store.limitBytes);
});

test('a value bigger than the per-entry limit is refused, not made room for', () => {
  const store = new MemoryStore({ limitBytes: 4_000, maxValueBytes: 1_000 });
  store.put('keep', 'a'.repeat(500));

  assert.throws(
    () => store.put('huge', 'b'.repeat(2_000)),
    (error) => error.code === 'value_too_large',
  );
  // The refusal cost nothing: what was already there is still there.
  assert.equal(store.get('keep').hit, true);
});

test('an entry past its TTL is a miss, and stops counting against the budget', () => {
  let clock = 0;
  const store = new MemoryStore({ limitBytes: 1 * MB, now: () => clock });
  store.put('temp', 'value', { ttlMs: 1_000 });

  assert.equal(store.get('temp').hit, true);
  clock = 1_001;

  const miss = store.get('temp');
  assert.equal(miss.hit, false);
  assert.equal(miss.expired, true);
  assert.equal(store.usedBytes, 0);
});

test('a value with no JSON representation is refused', () => {
  const store = new MemoryStore({ limitBytes: 1 * MB });
  assert.throws(() => store.put('u', undefined), (error) => error.code === 'unserializable_value');

  const circular = { name: 'loop' };
  circular.self = circular;
  assert.throws(() => store.put('c', circular), (error) => error.code === 'unserializable_value');
});

test('keys lists metadata without handing back the values', () => {
  const store = new MemoryStore({ limitBytes: 1 * MB });
  store.put('cache/a', 'one');
  store.put('cache/b', 'two');
  store.put('other', 'three');

  const keys = store.keys({ prefix: 'cache/' });
  assert.deepEqual(keys.map((entry) => entry.key), ['cache/a', 'cache/b']);
  assert.ok(keys.every((entry) => !('value' in entry)));

  const stats = store.stats();
  assert.equal(stats.entries, 3);
  assert.equal(stats.usedBytes, store.usedBytes);
  assert.equal(stats.freeBytes, stats.limitBytes - stats.usedBytes);
});

// ------------------------------------------------------------ store handler

test('the memstore handler serves put/get/keys/delete/clear over one task type', async (t) => {
  memstoreHandler.setStore(new MemoryStore({ limitBytes: 1 * MB }));
  t.after(() => memstoreHandler.setStore(null));

  const put = await memstoreHandler.run({ action: 'put', key: 'sess/1', value: { tokens: [1, 2, 3] } });
  assert.equal(put.entries, 1);

  const got = await memstoreHandler.run({ action: 'get', key: 'sess/1' });
  assert.deepEqual(got.value, { tokens: [1, 2, 3] });

  const listed = await memstoreHandler.run({ action: 'keys', prefix: 'sess/' });
  assert.deepEqual(listed.keys.map((entry) => entry.key), ['sess/1']);

  assert.equal((await memstoreHandler.run({ action: 'delete', key: 'sess/1' })).deleted, true);
  assert.equal((await memstoreHandler.run({ action: 'get', key: 'sess/1' })).hit, false);

  await memstoreHandler.run({ action: 'put', key: 'sess/2', value: 'x' });
  assert.equal((await memstoreHandler.run({ action: 'clear' })).cleared, 1);
});

test('the memstore handler reports its own usage and the machine it runs on', async (t) => {
  memstoreHandler.setStore(new MemoryStore({ limitBytes: 8 * MB }));
  t.after(() => memstoreHandler.setStore(null));

  const stats = await memstoreHandler.run({});
  assert.equal(stats.action, 'stats');
  assert.equal(stats.store.limitBytes, 8 * MB);
  assert.ok(stats.machine.totalBytes > 0);
  assert.ok(stats.machine.availableBytes >= 0);
});

test('the memstore handler refuses unknown actions and malformed keys', async (t) => {
  memstoreHandler.setStore(new MemoryStore({ limitBytes: 1 * MB }));
  t.after(() => memstoreHandler.setStore(null));

  await assert.rejects(() => memstoreHandler.run({ action: 'drop-everything' }), ProtocolError);
  await assert.rejects(() => memstoreHandler.run({ action: 'get', key: '../../etc/passwd' }), ProtocolError);
  await assert.rejects(() => memstoreHandler.run({ action: 'get', key: 42 }), ProtocolError);
  await assert.rejects(
    () => memstoreHandler.run({ action: 'put', key: 'k', value: 1, ttlMs: -5 }),
    ProtocolError,
  );
});

test('the store limit comes from the environment, falling back to a share of the machine', () => {
  assert.equal(memstoreHandler.limitFromEnv({ ALPHA_MEMSTORE_LIMIT_MB: '64' }), 64 * MB);
  const derived = memstoreHandler.limitFromEnv({});
  assert.ok(derived > 0 && derived <= 1024 * MB);
});

// ----------------------------------------------------------------- end to end

test('an attached agent publishes its free memory to the host', async (t) => {
  const host = await startHost();
  const agent = new TunnelAgent({
    hostUrl: host.url,
    token: TOKEN,
    name: 'ram-lender',
    pollWaitMs: 500,
    memoryReserveBytes: 0,
  });
  const running = agent.start();

  t.after(async () => {
    await agent.stop();
    await running;
    await host.close();
  });

  // Registration is what publishes the first report; wait for it to land.
  const deadline = Date.now() + 5_000;
  let attached = [];
  while (Date.now() < deadline && attached.length === 0) {
    ({ body: { agents: attached } } = await fetchJson(`${host.url}/agents`, { token: TOKEN }));
    if (attached.length === 0) await new Promise((r) => setTimeout(r, 25));
  }

  assert.equal(attached.length, 1);
  assert.ok(attached[0].memory.totalBytes > 0);
  assert.ok(attached[0].availableBytes > 0);

  const { body: stats } = await fetchJson(`${host.url}/stats`, { token: TOKEN });
  assert.equal(stats.memory.offeredBytes, attached[0].availableBytes);
});

test('a task asking for more RAM than any agent has waits instead of running', async (t) => {
  const host = await startHost();
  const agent = new TunnelAgent({
    hostUrl: host.url,
    token: TOKEN,
    capabilities: ['echo'],
    pollWaitMs: 300,
    // Everything is held back for the machine itself, so nothing is on offer.
    memoryReserveBytes: Number.MAX_SAFE_INTEGER,
  });
  const running = agent.start();

  t.after(async () => {
    await agent.stop();
    await running;
    await host.close();
  });

  await new Promise((r) => setTimeout(r, 300));

  const { body: created } = await enqueue(host.url, { type: 'echo', payload: {}, minMemoryMB: 1024 });
  assert.equal(created.agentAvailable, false);
  // The type is covered — it is the RAM that is missing, and the caller is
  // told which of the two it is.
  assert.equal(created.memoryAvailable, false);

  await new Promise((r) => setTimeout(r, 400));
  const { body: task } = await fetchJson(`${host.url}/tasks/${created.id}`, { token: TOKEN });
  assert.equal(task.status, TaskStatus.QUEUED);
  assert.equal(task.attempts, 0);
});

test('a task within the agent\'s free memory runs there', async (t) => {
  const host = await startHost();
  const handlers = new HandlerRegistry([
    { type: 'crunch', run: async () => ({ crunched: true }) },
  ]);
  const agent = new TunnelAgent({
    hostUrl: host.url,
    token: TOKEN,
    handlers,
    pollWaitMs: 500,
    memoryReserveBytes: 0,
  });
  const running = agent.start();

  t.after(async () => {
    await agent.stop();
    await running;
    await host.close();
  });

  const { body: created } = await enqueue(host.url, { type: 'crunch', minMemoryMB: 1 });
  const finished = await waitForTask(host.url, created.id);

  assert.equal(finished.status, TaskStatus.SUCCEEDED);
  assert.deepEqual(finished.result, { crunched: true });

  // The lease is over, so the memory it held is on offer again.
  const { body: agents } = await fetchJson(`${host.url}/agents`, { token: TOKEN });
  assert.equal(agents.agents[0].reservedBytes, 0);
});

test('the host stores data in the laptop\'s RAM and reads it back', async (t) => {
  const host = await startHost();
  const handlers = new HandlerRegistry([memstoreHandler]);
  memstoreHandler.setStore(new MemoryStore({ limitBytes: 1 * MB }));

  const agent = new TunnelAgent({ hostUrl: host.url, token: TOKEN, handlers, pollWaitMs: 500 });
  const running = agent.start();

  t.after(async () => {
    await agent.stop();
    await running;
    await host.close();
    memstoreHandler.setStore(null);
  });

  const { body: stored } = await enqueue(host.url, {
    type: 'memory.store',
    payload: { action: 'put', key: 'embeddings/batch-1', value: [0.1, 0.2, 0.3] },
  });
  assert.equal((await waitForTask(host.url, stored.id)).status, TaskStatus.SUCCEEDED);

  const { body: read } = await enqueue(host.url, {
    type: 'memory.store',
    payload: { action: 'get', key: 'embeddings/batch-1' },
  });
  const finished = await waitForTask(host.url, read.id);

  assert.equal(finished.status, TaskStatus.SUCCEEDED);
  assert.equal(finished.result.hit, true);
  assert.deepEqual(finished.result.value, [0.1, 0.2, 0.3]);
});

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
  memoryReportFromQuery,
  memoryReportToQuery,
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

async function until(predicate, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition not met in time');
}

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

// --------------------------------------------------- settling a reservation

const task4gb = { type: 'echo', minMemoryMB: 4096 };
const task2gb = { type: 'echo', minMemoryMB: 2048 };

function laptop(registry, offerableBytes = gb(8)) {
  return registry.register({
    name: 'laptop',
    capabilities: ['echo'],
    memory: { totalBytes: gb(16), freeBytes: offerableBytes, offerableBytes },
  });
}

test('a reservation holds the whole requirement until the machine reports it gone', () => {
  // The window the hold exists for: the task has been placed but has not
  // allocated anything yet, so the agent still reports every byte as free.
  const { registry } = fixedRegistry();
  const agent = laptop(registry);

  registry.admit(agent.id, task4gb);
  assert.equal(registry.unmaterializedBytes(agent.id), gb(4));
  assert.equal(registry.offerableBytes(agent.id), gb(4));

  // And it is still a hard gate while it is unmaterialized: two 4 GB tasks fit
  // an 8 GB machine, a third does not.
  registry.admit(agent.id, task4gb);
  assert.equal(registry.offerableBytes(agent.id), 0);
  assert.equal(registry.canAdmit(agent.id, task4gb), false);
});

test('a reservation stops being held once the report shows the memory taken', () => {
  // The bug this closes: the task allocates, the drop lands in the agent's own
  // report, and subtracting the reservation from it too charged the machine
  // twice — an 8 GB laptop running one 4 GB task looked like it had nothing
  // left, for the rest of the lease.
  const { registry } = fixedRegistry();
  const agent = laptop(registry);

  registry.admit(agent.id, task4gb);
  registry.reportMemory(agent.id, { totalBytes: gb(16), freeBytes: gb(4), offerableBytes: gb(4) });

  assert.equal(registry.unmaterializedBytes(agent.id), 0);
  assert.equal(registry.offerableBytes(agent.id), gb(4));
  assert.equal(registry.canAdmit(agent.id, task4gb), true);
});

test('a drop larger than the promise leaves the agent poorer, not richer', () => {
  // The credit is capped by what was promised, and the report is the ceiling
  // either way: a machine that has lost more than the reservation cannot come
  // out of the arithmetic with memory to spare.
  const { registry } = fixedRegistry();
  const agent = laptop(registry);

  registry.admit(agent.id, task4gb);
  registry.reportMemory(agent.id, { totalBytes: gb(16), freeBytes: gb(6), offerableBytes: gb(6) });
  // 2 GB of the 4 has shown up, so 2 GB is still held by hand.
  assert.equal(registry.unmaterializedBytes(agent.id), gb(2));
  assert.equal(registry.offerableBytes(agent.id), gb(4));

  registry.reportMemory(agent.id, { totalBytes: gb(16), freeBytes: gb(2), offerableBytes: gb(2) });
  assert.equal(registry.unmaterializedBytes(agent.id), 0);
  assert.equal(registry.offerableBytes(agent.id), gb(2));
});

test('settling cannot tell the task\'s allocation from the owner\'s, and overcommits', () => {
  // The known cost of settling holds against the report. The host cannot see
  // *why* memory moved, so a drop the machine's owner caused releases the hold
  // while the placed task is still holding nothing — and a second task can then
  // be placed against memory the first one is going to take.
  //
  // Pinned deliberately rather than left implicit: holding for the whole lease
  // refused this, at the cost of the far commoner fault of a working laptop
  // looking empty until its lease ran out. If the agent ever gains a memory
  // check of its own (it is not handed minMemoryMB today, so it cannot), this
  // is the case that check closes, and this test is the one that changes.
  const { registry } = fixedRegistry();
  const agent = laptop(registry);

  registry.admit(agent.id, task4gb);
  // The owner's build takes 4 GB. The task has allocated nothing.
  registry.reportMemory(agent.id, { totalBytes: gb(16), freeBytes: gb(4), offerableBytes: gb(4) });

  assert.equal(registry.unmaterializedBytes(agent.id), 0);
  assert.equal(registry.offerableBytes(agent.id), gb(4));
  // Truthfully there is no headroom at all: those 4 GB are spoken for.
  assert.equal(registry.canAdmit(agent.id, task4gb), true);
});

test('a second reservation is not credited with the first one\'s drop', () => {
  // Re-anchoring on every admission would forget what the earlier tasks have
  // already accounted for and hold their memory a second time.
  const { registry } = fixedRegistry();
  const agent = laptop(registry);

  registry.admit(agent.id, task4gb);
  registry.reportMemory(agent.id, { totalBytes: gb(16), freeBytes: gb(4), offerableBytes: gb(4) });
  assert.equal(registry.offerableBytes(agent.id), gb(4));

  // 8 GB machine, 4 taken by the first task, 2 promised to the second: 2 left.
  registry.admit(agent.id, task2gb);
  assert.equal(registry.unmaterializedBytes(agent.id), gb(2));
  assert.equal(registry.offerableBytes(agent.id), gb(2));
});

test('the agent\'s own report is the whole truth again once nothing is reserved', () => {
  const { registry } = fixedRegistry();
  const agent = laptop(registry);

  registry.admit(agent.id, task4gb);
  registry.release(agent.id, task4gb);

  assert.equal(registry.unmaterializedBytes(agent.id), 0);
  assert.equal(registry.offerableBytes(agent.id), gb(8));
  assert.equal(registry.list()[0].unmaterializedBytes, 0);
});

test('a stale report is still worth nothing, reservation or not', () => {
  const { registry, tick } = fixedRegistry();
  const agent = laptop(registry);
  registry.admit(agent.id, task4gb);

  tick(MEMORY_REPORT_STALE_MS + 1);
  assert.equal(registry.reportedOfferableBytes(agent.id), 0);
  assert.equal(registry.offerableBytes(agent.id), 0);
  assert.equal(registry.canAdmit(agent.id, { type: 'echo', minMemoryMB: 1 }), false);
});

// ------------------------------------------------------ declining a placement

test('a declined task is requeued without being charged an attempt', async () => {
  // Nothing was run, so charging for it would spend the task's retry budget on
  // machines that never touched it — and a fleet briefly tight everywhere
  // would fail work outright rather than waiting for room.
  const queue = new TaskQueue();
  const task = queue.enqueue({ type: 'echo', payload: {}, leaseMs: 1_000, maxAttempts: 3 });
  const leased = await (queue.lease({ agentId: 'a1', capabilities: ['echo'], waitMs: 0 }));

  assert.equal(leased.id, task.id);
  assert.equal(task.attempts, 1);

  queue.decline(task.id, 'a1', { message: 'needs 4096 MB', code: 'insufficient_memory' });

  assert.equal(task.status, TaskStatus.QUEUED);
  assert.equal(task.attempts, 0);
  assert.equal(task.agentId, null);
  // Why it went round again is kept, so it does not look like it was never
  // picked up at all.
  assert.equal(task.error.code, 'insufficient_memory');
});

test('a task may be declined more times than it has attempts', async () => {
  // The point of not charging: three declines do not exhaust maxAttempts, so
  // the task is still there to run when a machine finally has room.
  const queue = new TaskQueue();
  const task = queue.enqueue({ type: 'echo', payload: {}, leaseMs: 1_000, maxAttempts: 2 });

  for (const agentId of ['a1', 'a2', 'a3']) {
    await queue.lease({ agentId, capabilities: ['echo'], waitMs: 0 });
    queue.decline(task.id, agentId, { message: 'no room', code: 'insufficient_memory' });
  }

  assert.equal(task.status, TaskStatus.QUEUED);
  assert.equal(task.attempts, 0);

  const finally_ = await queue.lease({ agentId: 'a4', capabilities: ['echo'], waitMs: 0 });
  assert.equal(finally_.id, task.id);
  assert.equal(task.attempts, 1);
});

test('declines are counted, so being refused is distinguishable from waiting', async () => {
  // Nothing acts on the count, and nothing should: a task waiting for a
  // machine with room ought to wait, so any limit would break the legitimate
  // case. What it makes visible is the illegitimate one — an agent
  // misreporting its own memory refuses the same task forever, and that looks
  // exactly like patience: same status, same attempts, nothing accumulating.
  const queue = new TaskQueue();
  const task = queue.enqueue({ type: 'echo', payload: {}, leaseMs: 1_000, maxAttempts: 2 });
  assert.equal(task.declines, 0);

  for (const agentId of ['a1', 'a2', 'a3']) {
    await queue.lease({ agentId, capabilities: ['echo'], waitMs: 0 });
    queue.decline(task.id, agentId, { message: 'no room', code: 'insufficient_memory' });
  }

  assert.equal(task.declines, 3);
  // The two figures that would otherwise be identical to a task simply waiting.
  assert.equal(task.attempts, 0);
  assert.equal(task.status, TaskStatus.QUEUED);
});

test('work that is never refused carries no decline count', async () => {
  const queue = new TaskQueue();
  const task = queue.enqueue({ type: 'echo', payload: {}, leaseMs: 1_000, maxAttempts: 2 });
  await queue.lease({ agentId: 'a1', capabilities: ['echo'], waitMs: 0 });
  queue.complete(task.id, 'a1', { ok: true });

  assert.equal(task.declines, 0);
  assert.equal(task.status, TaskStatus.SUCCEEDED);
});

test('an agent that no longer holds the lease cannot decline the task', async () => {
  // Same protection as a result from a stale holder: a straggler must not be
  // able to bounce work the agent that owns it is busy running.
  const queue = new TaskQueue();
  const task = queue.enqueue({ type: 'echo', payload: {}, leaseMs: 1_000, maxAttempts: 3 });
  await queue.lease({ agentId: 'a1', capabilities: ['echo'], waitMs: 0 });

  assert.throws(() => queue.decline(task.id, 'someone-else', { message: 'no room' }), (error) => {
    assert.equal(error.status, 409);
    return true;
  });
  assert.equal(task.status, TaskStatus.LEASED);
});

test('declining frees the memory the placement was holding', async () => {
  const { registry } = fixedRegistry();
  const agent = laptop(registry);
  const queue = new TaskQueue({ admission: registry });
  const task = queue.enqueue({ type: 'echo', payload: {}, leaseMs: 1_000, maxAttempts: 3, minMemoryMB: 4096 });

  await queue.lease({ agentId: agent.id, capabilities: ['echo'], waitMs: 0 });
  assert.equal(registry.offerableBytes(agent.id), gb(4));

  queue.decline(task.id, agent.id, { message: 'no room', code: 'insufficient_memory' });
  assert.equal(registry.offerableBytes(agent.id), gb(8));
  assert.equal(registry.get(agent.id).inFlight, 0);
});

test('the host records the reading that came with a decline before requeueing', async (t) => {
  // The whole reason a decline carries one: without it the host would place
  // the task straight back on the machine that just said it could not hold it.
  const host = await startHost();
  t.after(() => host.close());

  const { body: registered } = await fetchJson(`${host.url}/agent/register`, {
    method: 'POST',
    token: TOKEN,
    body: {
      protocolVersion: 1,
      name: 'laptop',
      capabilities: ['echo'],
      memory: { totalBytes: gb(16), freeBytes: gb(8), offerableBytes: gb(8) },
    },
  });
  const { body: queued } = await enqueue(host.url, { type: 'echo', payload: {}, minMemoryMB: 4096 });

  const { body: dispatched } = await fetchJson(
    `${host.url}/agent/${registered.agentId}/tasks/next?wait=0`,
    { token: TOKEN },
  );
  // The agent is told what the task needs, or it could not check at all.
  assert.equal(dispatched.minMemoryMB, 4096);

  await fetchJson(`${host.url}/agent/${registered.agentId}/tasks/${queued.id}/result`, {
    method: 'POST',
    token: TOKEN,
    body: {
      ok: false,
      declined: true,
      memory: { totalBytes: gb(16), freeBytes: gb(1), offerableBytes: gb(1) },
      error: { message: 'needs 4096 MB, this machine can offer 1024 MB', code: 'insufficient_memory' },
    },
  });

  const { body: after } = await fetchJson(`${host.url}/tasks/${queued.id}`, { token: TOKEN });
  assert.equal(after.status, TaskStatus.QUEUED);
  assert.equal(after.attempts, 0);
  // Visible to a reader over /tasks, which is the whole point of counting it.
  assert.equal(after.declines, 1);

  // And the reading is in, so polling again does not simply get it back.
  const { body: agents } = await fetchJson(`${host.url}/agents`, { token: TOKEN });
  assert.equal(agents.agents[0].availableBytes, gb(1));

  const { status } = await fetchJson(
    `${host.url}/agent/${registered.agentId}/tasks/next?wait=0`,
    { token: TOKEN },
  );
  assert.equal(status, 204);
});

test('a real agent hands back work its machine went too tight to hold, and runs it once it can', async (t) => {
  // The end-to-end case, and the one that cannot be built from a machine's real
  // figures because it is temporal: the host places on a reading carried by a
  // parked poll, the owner's build takes the memory in the window that follows,
  // and the task arrives at a machine that can no longer hold it.
  const host = await startHost();
  t.after(() => host.close());

  let offerableBytes = gb(8);
  const agent = new TunnelAgent({
    hostUrl: host.url,
    token: TOKEN,
    name: 'laptop',
    handlers: new HandlerRegistry(),
    capabilities: ['echo'],
    memoryReader: () => ({ totalBytes: gb(16), freeBytes: offerableBytes, offerableBytes }),
  });
  const running = agent.start();
  t.after(async () => {
    await agent.stop();
    await running;
  });

  // Wait for its long poll to park. The 8 GB reading it carried is now the one
  // the host will place against.
  await until(async () => {
    const { body } = await fetchJson(`${host.url}/stats`, { token: TOKEN });
    return body.queue.waiters === 1;
  });

  // The owner's build takes 7 GB while the poll sits there.
  offerableBytes = gb(1);
  const { body: queued } = await enqueue(host.url, { type: 'echo', payload: {}, minMemoryMB: 4096 });

  // Handed straight to the parked agent, which reads its own memory and says no.
  await until(async () => {
    const { body } = await fetchJson(`${host.url}/tasks/${queued.id}`, { token: TOKEN });
    return body.status === TaskStatus.QUEUED && body.error?.code === 'insufficient_memory';
  });
  const { body: bounced } = await fetchJson(`${host.url}/tasks/${queued.id}`, { token: TOKEN });
  assert.equal(bounced.attempts, 0, 'a decline must not spend an attempt');

  // The build finishes. Nothing was lost: the task is still queued with its
  // whole retry budget, and the next poll that can hold it takes it.
  //
  // That next poll is what the trivial task below provokes. Matching runs when
  // a task is enqueued or requeued, not when a report improves, so the agent
  // parked here with its 1 GB reading is not reconsidered until its own poll
  // cycles — up to MAX_POLL_WAIT_MS away. That is inherent to pulling work
  // rather than pushing it, and it is bounded; waiting 25s in a test to watch
  // it is not. Any task the agent can take releases the poll, and the reading
  // it carries on the way back is the current one.
  offerableBytes = gb(8);
  const { body: nudge } = await enqueue(host.url, { type: 'echo', payload: {} });
  assert.equal((await waitForTask(host.url, nudge.id)).status, TaskStatus.SUCCEEDED);

  const finished = await waitForTask(host.url, queued.id);
  assert.equal(finished.status, TaskStatus.SUCCEEDED);
  assert.equal(finished.attempts, 1, 'the run that succeeded is the only attempt charged');
});

// ------------------------------------------- memory a handler holds for itself

test('a handler\'s own budget is not offered to the host as well', (t) => {
  // memory.store may grow into its limit at any moment. Offering that headroom
  // to the host as lendable promises the same RAM twice: once to a memory-
  // hungry task, once to the next put that fills the cache up.
  const handlers = new HandlerRegistry([memstoreHandler]);
  memstoreHandler.setStore(new MemoryStore({ limitBytes: 200 * MB }));
  t.after(() => memstoreHandler.setStore(null));

  assert.equal(handlers.committedBytes(), 200 * MB);

  // Read from one snapshot, so a machine whose free memory moves under the
  // test cannot make this flake.
  const snapshot = memorySnapshot({ reserveBytes: 0, committedBytes: handlers.committedBytes() });
  // The machine's honest free figure is untouched; only what it will lend moves.
  assert.equal(snapshot.offerableBytes, Math.max(0, snapshot.freeBytes - 200 * MB));
});

test('only a handler\'s unused budget is withheld', (t) => {
  // What the store already holds is real heap and has left the machine's free
  // memory on its own. Withholding it again would take it off the offer twice.
  const store = new MemoryStore({ limitBytes: 200 * MB, maxValueBytes: 200 * MB });
  const handlers = new HandlerRegistry([memstoreHandler]);
  memstoreHandler.setStore(store);
  t.after(() => memstoreHandler.setStore(null));

  store.put('batch', 'x'.repeat(10 * MB));
  assert.ok(store.usedBytes >= 10 * MB);
  assert.equal(store.headroomBytes, store.limitBytes - store.usedBytes);
  assert.equal(handlers.committedBytes(), store.headroomBytes);
});

test('handlers that hold nothing cost nothing', () => {
  // The built-ins hold no budget, so an agent running them offers exactly what
  // it has free less its own reserve — unchanged from before any of this.
  assert.equal(new HandlerRegistry().committedBytes(), 0);
  const snapshot = memorySnapshot({ reserveBytes: 0, committedBytes: 0 });
  assert.equal(snapshot.offerableBytes, snapshot.freeBytes);
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

// ------------------------------------------------------------ report on poll

test('memory survives the round trip through a poll\'s query string', () => {
  const report = { totalBytes: gb(16), freeBytes: gb(8), offerableBytes: gb(7) };
  const params = memoryReportToQuery(new URLSearchParams({ wait: '25000' }), report);
  assert.equal(params.get('wait'), '25000');
  assert.deepEqual(memoryReportFromQuery(params), report);
});

test('a poll carrying no memory leaves the last report standing', () => {
  // An older agent polls with nothing but `wait`, and a partial report is no
  // report: recording either would wipe out a good reading from its heartbeat.
  assert.equal(memoryReportFromQuery(new URLSearchParams({ wait: '25000' })), null);
  assert.equal(memoryReportFromQuery(new URLSearchParams({ moffer: String(gb(4)) })), null);
  // Including one that names what the machine has but not what it will lend:
  // treating the whole free figure as the offer would lend out the reserve the
  // agent is holding back for itself.
  assert.equal(
    memoryReportFromQuery(new URLSearchParams({ mtotal: String(gb(16)), mfree: String(gb(8)) })),
    null,
  );
});

test('the host takes an agent\'s memory from the poll, not just the heartbeat', async (t) => {
  // The heartbeat is 20s apart and a report is trusted for two minutes, but
  // the poll is the moment the agent is asking to be given work. Memory has to
  // be current there, because it is what decides whether a task may be placed
  // on this machine at all.
  const host = await startHost();
  t.after(() => host.close());

  const { body: registered } = await fetchJson(`${host.url}/agent/register`, {
    method: 'POST',
    token: TOKEN,
    body: {
      protocolVersion: 1,
      name: 'laptop',
      capabilities: ['echo'],
      memory: { totalBytes: gb(16), freeBytes: gb(8), offerableBytes: gb(8) },
    },
  });

  const query = memoryReportToQuery(new URLSearchParams({ wait: '0' }), {
    totalBytes: gb(16),
    freeBytes: gb(1),
    offerableBytes: gb(1),
  });
  await fetchJson(`${host.url}/agent/${registered.agentId}/tasks/next?${query}`, { token: TOKEN });

  const { body } = await fetchJson(`${host.url}/agents`, { token: TOKEN });
  assert.equal(body.agents[0].availableBytes, gb(1));
});

test('a task is not placed against memory the machine has since given up', async (t) => {
  // The failure this closes: the agent reports 8 GB, its owner then starts a
  // build that eats 7 of them, and the agent polls. Reading the placement off
  // the heartbeat hands it a 4 GB task the machine can no longer hold, and the
  // agent has no memory check of its own with which to refuse it.
  const host = await startHost();
  t.after(() => host.close());

  const { body: registered } = await fetchJson(`${host.url}/agent/register`, {
    method: 'POST',
    token: TOKEN,
    body: {
      protocolVersion: 1,
      name: 'laptop',
      capabilities: ['echo'],
      memory: { totalBytes: gb(16), freeBytes: gb(8), offerableBytes: gb(8) },
    },
  });
  await enqueue(host.url, { type: 'echo', payload: {}, minMemoryMB: 4096 });

  const shrunk = memoryReportToQuery(new URLSearchParams({ wait: '0' }), {
    totalBytes: gb(16),
    freeBytes: gb(1),
    offerableBytes: gb(1),
  });
  const { status } = await fetchJson(
    `${host.url}/agent/${registered.agentId}/tasks/next?${shrunk}`,
    { token: TOKEN },
  );
  assert.equal(status, 204);

  // And the other half of the same fix: once the build finishes, the machine
  // is eligible again on the strength of its poll rather than having to wait
  // out a heartbeat while the task sits there reported as blocked on memory.
  const recovered = memoryReportToQuery(new URLSearchParams({ wait: '0' }), {
    totalBytes: gb(16),
    freeBytes: gb(8),
    offerableBytes: gb(8),
  });
  const { status: after, body: task } = await fetchJson(
    `${host.url}/agent/${registered.agentId}/tasks/next?${recovered}`,
    { token: TOKEN },
  );
  assert.equal(after, 200);
  assert.equal(task.type, 'echo');
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

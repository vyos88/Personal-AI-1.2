import test from 'node:test';
import assert from 'node:assert/strict';

import { createHost } from '../src/host/server.js';
import { TaskQueue } from '../src/host/queue.js';
import { AgentRegistry } from '../src/host/registry.js';
import { TunnelAgent } from '../src/agent/agent.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';
import { LoadSampler } from '../src/agent/load.js';
import { maxLoadFromEnv, concurrencyFromEnv } from '../src/agent/load.js';
import { fetchJson } from '../src/common/http.js';
import {
  TaskStatus,
  loadReportFromQuery,
  loadReportToQuery,
  LOAD_REPORT_STALE_MS,
  UNKNOWN_LOAD_FACTOR,
  DEFAULT_MAX_LOAD,
  validateRegistration,
  validateLoadReport,
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

const report = (loadFactor, extra = {}) => ({
  cpus: 8,
  busy: Math.min(loadFactor, 1),
  loadAverage1: loadFactor * 8,
  loadFactor,
  ...extra,
});

/** A sampler that reports whatever load the test wants this machine to have. */
function fakeSampler(loadFactor) {
  const state = { loadFactor };
  return {
    state,
    snapshot: () => report(state.loadFactor),
  };
}

const attach = (registry, name, { capabilities = ['echo'], load = null } = {}) =>
  registry.register({ name, capabilities, load });

// ------------------------------------------------------------------ protocol

test('a load report is optional, so an agent too old to send one still attaches', () => {
  const registration = validateRegistration({
    protocolVersion: 1,
    name: 'old-laptop',
    capabilities: ['echo'],
  });
  assert.equal(registration.load, null);
});

test('a load report survives the wire with every field intact', () => {
  const load = validateLoadReport({ cpus: 8, busy: 0.5, loadAverage1: 4, loadFactor: 0.5 });
  assert.deepEqual(load, { cpus: 8, busy: 0.5, loadAverage1: 4, loadFactor: 0.5 });
});

test('a machine that could not measure a figure reports it as null, not as zero', () => {
  // Windows has no load average at all; some containers hide CPU times. Either
  // way "I do not know" must not arrive as "I am idle".
  const load = validateLoadReport({ cpus: 4, busy: null, loadAverage1: null, loadFactor: null });
  assert.deepEqual(load, { cpus: 4, busy: null, loadAverage1: null, loadFactor: null });
});

test('nonsense in a load report is rejected rather than scheduled on', () => {
  assert.throws(() => validateLoadReport({ busy: 5 }), ProtocolError);
  assert.throws(() => validateLoadReport({ loadFactor: -1 }), ProtocolError);
  assert.throws(() => validateLoadReport('busy'), ProtocolError);
});

// ------------------------------------------------------------------- sampler

test('the sampler reports this machine\'s cores and a load factor in range', () => {
  const load = new LoadSampler().snapshot();
  assert.ok(load.cpus >= 1);
  assert.ok(load.loadFactor === null || (load.loadFactor >= 0 && load.loadFactor <= 8));
  assert.ok(load.busy === null || (load.busy >= 0 && load.busy <= 1));
});

test('a sampler with no real interval yet reports unknown, not 100%', () => {
  // The first reading lands microseconds after the sampler primes itself, so
  // the tick delta is a couple of ticks of quantised accounting and the ratio
  // is noise — in practice a clean 100%. Reporting that had a freshly enrolled
  // agent announce itself at full load and decline the first work it was
  // offered, which looks exactly like a broken enrolment.
  const sampler = new LoadSampler();
  assert.equal(sampler.snapshot().busy, null);
});

test('the baseline is kept until a window is worth dividing', () => {
  // Advancing it on every too-short call would reset the window each time and
  // the sampler would never measure anything at all.
  let clock = 0;
  const sampler = new LoadSampler({ now: () => clock });
  assert.equal(sampler.utilisation(), null);

  clock += 50;
  assert.equal(sampler.utilisation(), null, 'still too short a window');

  clock += 5_000;
  const busy = sampler.utilisation();
  assert.ok(busy === null || (busy >= 0 && busy <= 1), 'measures once the window is real');
});

test('two reads in the same instant reuse one sample instead of measuring nothing', () => {
  // CPU ticks are cumulative, so readings taken microseconds apart span no
  // ticks and would come back unknown. The heartbeat and the poll loop both
  // ask, and they must agree.
  let clock = 0;
  const sampler = new LoadSampler({ now: () => clock });
  const first = sampler.snapshot();
  assert.equal(sampler.snapshot(), first);

  clock += 10_000;
  assert.notEqual(sampler.snapshot(), first);
});

test('the load ceiling and concurrency are read from the environment with limits', () => {
  assert.equal(maxLoadFromEnv(undefined, DEFAULT_MAX_LOAD), DEFAULT_MAX_LOAD);
  assert.equal(maxLoadFromEnv('0.5', DEFAULT_MAX_LOAD), 0.5);
  assert.throws(() => maxLoadFromEnv('0', DEFAULT_MAX_LOAD), /positive number/);
  assert.throws(() => maxLoadFromEnv('lots', DEFAULT_MAX_LOAD), /positive number/);

  assert.equal(concurrencyFromEnv(undefined, 1), 1);
  assert.equal(concurrencyFromEnv('4', 1), 4);
  assert.throws(() => concurrencyFromEnv('0', 1), /between 1 and 64/);
  assert.throws(() => concurrencyFromEnv('2.5', 1), /between 1 and 64/);
});

// ------------------------------------------------------------------ registry

test('an agent that reports no load is unknown, and unknown is not idle', () => {
  const { registry } = fixedRegistry();
  const silent = attach(registry, 'silent');
  assert.equal(registry.loadFactor(silent.id), null);
  // Ranked mid-scale: it must not beat a machine known to be idle, nor lose to
  // one known to be pinned.
  assert.equal(registry.rank(silent.id), UNKNOWN_LOAD_FACTOR * 0.999);
});

test('a load report goes unknown once it is stale, rather than staying trusted', () => {
  const { registry, tick } = fixedRegistry();
  const laptop = attach(registry, 'laptop', { load: report(0.1) });
  assert.equal(registry.loadFactor(laptop.id), 0.1);

  tick(LOAD_REPORT_STALE_MS + 1);
  assert.equal(registry.loadFactor(laptop.id), null);
});

test('between two idle agents the less loaded one is the better target', () => {
  const { registry } = fixedRegistry();
  const busy = attach(registry, 'busy', { load: report(0.9) });
  const quiet = attach(registry, 'quiet', { load: report(0.05) });
  assert.ok(registry.rank(quiet.id) < registry.rank(busy.id));
});

test('work already in hand outranks any load reading', () => {
  const { registry } = fixedRegistry();
  // The machine that is nearly pinned but holding nothing is still the better
  // target than the idle one already running a task: one task placed is a
  // certainty, a load average is a measurement from up to a heartbeat ago.
  const pinned = attach(registry, 'pinned', { load: report(0.99) });
  const holding = attach(registry, 'holding', { load: report(0.0) });
  registry.admit(holding.id, { type: 'echo' });

  assert.ok(registry.rank(pinned.id) < registry.rank(holding.id));
});

test('a task with no memory requirement is still counted against the agent holding it', () => {
  // This is the gap that let a burst of ordinary tasks all land on one laptop:
  // nothing was reserved for them, so nothing distinguished the machine that
  // had just been given three of them from an idle one.
  const { registry } = fixedRegistry();
  const laptop = attach(registry, 'laptop', { load: report(0.1) });

  registry.admit(laptop.id, { type: 'echo' });
  registry.admit(laptop.id, { type: 'echo' });
  assert.equal(registry.list()[0].inFlight, 2);

  registry.release(laptop.id, { type: 'echo' });
  assert.equal(registry.list()[0].inFlight, 1);
  assert.equal(registry.list()[0].reservedBytes, 0);
});

test('candidates come back best target first', () => {
  const { registry } = fixedRegistry();
  attach(registry, 'busy', { load: report(0.95) });
  attach(registry, 'middling', { load: report(0.4) });
  attach(registry, 'quiet', { load: report(0.02) });

  assert.deepEqual(
    registry.candidatesFor({ type: 'echo' }).map((agent) => agent.name),
    ['quiet', 'middling', 'busy'],
  );
});

// --------------------------------------------------------------------- queue

/** Parks a long poll for `agentId` and resolves with whatever it is handed. */
function park(queue, agentId, capabilities = ['echo']) {
  const settled = { task: undefined };
  const promise = queue
    .lease({ agentId, capabilities, waitMs: 1_000 })
    .then((task) => (settled.task = task));
  return { promise, settled };
}

test('a task goes to the least loaded parked agent, not the one that parked first', async () => {
  // The headline case. Both laptops are attached and both are waiting; the one
  // that happened to park its long poll first used to win every dispatch,
  // which is how a machine already at full tilt kept being handed work.
  const { registry } = fixedRegistry();
  const queue = new TaskQueue({ admission: registry });

  const first = attach(registry, 'first-to-ask', { load: report(0.95) });
  const second = attach(registry, 'has-cores-free', { load: report(0.05) });

  const a = park(queue, first.id);
  const b = park(queue, second.id);
  await new Promise((r) => setImmediate(r));

  queue.enqueue({ type: 'echo', payload: {}, leaseMs: 1_000, maxAttempts: 1 });
  await Promise.all([a.promise, b.promise]);

  assert.equal(a.settled.task, null, 'the loaded machine was left alone');
  assert.equal(b.settled.task.type, 'echo');
  queue.stop();
});

test('the second task goes to the other machine once the first is holding one', async () => {
  const { registry } = fixedRegistry();
  const queue = new TaskQueue({ admission: registry });

  const quiet = attach(registry, 'quiet', { load: report(0.05) });
  const other = attach(registry, 'other', { load: report(0.30) });

  const a = park(queue, quiet.id);
  const b = park(queue, other.id);
  await new Promise((r) => setImmediate(r));

  // Enqueued back to back, before either could report the first one landing.
  queue.enqueue({ type: 'echo', payload: {}, leaseMs: 5_000, maxAttempts: 1 });
  const c = park(queue, quiet.id); // the quiet machine comes back for more
  await new Promise((r) => setImmediate(r));
  queue.enqueue({ type: 'echo', payload: {}, leaseMs: 5_000, maxAttempts: 1 });

  await Promise.all([a.promise, b.promise, c.promise]);
  assert.ok(a.settled.task, 'the quiet machine took the first task');
  assert.ok(b.settled.task, 'the second task went to the other machine, not back to the first');
  assert.equal(c.settled.task, null);
  queue.stop();
});

test('with nothing to tell two agents apart, the first to park still wins', async () => {
  const { registry } = fixedRegistry();
  const queue = new TaskQueue({ admission: registry });
  const first = attach(registry, 'first', { load: report(0.2) });
  const second = attach(registry, 'second', { load: report(0.2) });

  const a = park(queue, first.id);
  const b = park(queue, second.id);
  await new Promise((r) => setImmediate(r));

  queue.enqueue({ type: 'echo', payload: {}, leaseMs: 1_000, maxAttempts: 1 });
  await Promise.all([a.promise, b.promise]);

  assert.ok(a.settled.task);
  assert.equal(b.settled.task, null);
  queue.stop();
});

test('a queue with no registry behind it places work exactly as it always did', async () => {
  const queue = new TaskQueue();
  const a = park(queue, 'agent_a');
  const b = park(queue, 'agent_b');
  await new Promise((r) => setImmediate(r));

  queue.enqueue({ type: 'echo', payload: {}, leaseMs: 1_000, maxAttempts: 1 });
  await Promise.all([a.promise, b.promise]);
  assert.ok(a.settled.task);
  queue.stop();
});

// ------------------------------------------------------------- host and agent

test('the host records an agent\'s load and shows it to an operator', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  const { body: registered } = await fetchJson(`${host.url}/agent/register`, {
    method: 'POST',
    token: TOKEN,
    body: {
      protocolVersion: 1,
      name: 'laptop',
      capabilities: ['echo'],
      load: report(0.75),
    },
  });

  const { body: listed } = await fetchJson(`${host.url}/agents`, { token: TOKEN });
  assert.equal(listed.agents[0].loadFactor, 0.75);
  assert.equal(listed.agents[0].inFlight, 0);

  // And a heartbeat moves it, because a laptop's CPU picture from a minute ago
  // is not worth placing work on.
  await fetchJson(`${host.url}/agent/${registered.agentId}/heartbeat`, {
    method: 'POST',
    token: TOKEN,
    body: { load: report(0.1) },
  });
  const { body: after } = await fetchJson(`${host.url}/agents`, { token: TOKEN });
  assert.equal(after.agents[0].loadFactor, 0.1);

  const { body: stats } = await fetchJson(`${host.url}/stats`, { token: TOKEN });
  assert.equal(stats.load.reporting, 1);
  assert.equal(stats.load.busiest, 0.1);
});

test('load survives the round trip through a poll\'s query string', () => {
  const params = loadReportToQuery(new URLSearchParams({ wait: '25000' }), report(0.42));
  assert.equal(params.get('wait'), '25000');
  assert.deepEqual(loadReportFromQuery(params), report(0.42));
});

test('a poll carrying no load leaves the last report standing', () => {
  // An older agent polls with nothing but `wait`. Recording a report of nulls
  // would wipe out a perfectly good reading from its last heartbeat.
  assert.equal(loadReportFromQuery(new URLSearchParams({ wait: '25000' })), null);
});

test('the host takes an agent\'s load from the poll, not just the heartbeat', async (t) => {
  // The heartbeat is 20s apart; the poll is the moment the agent is actually
  // asking for work. A laptop that has just finished a build must not keep
  // being passed over on the strength of a reading from a heartbeat ago.
  const host = await startHost();
  t.after(() => host.close());

  const { body: registered } = await fetchJson(`${host.url}/agent/register`, {
    method: 'POST',
    token: TOKEN,
    body: { protocolVersion: 1, name: 'laptop', capabilities: ['echo'], load: report(0.95) },
  });

  const query = loadReportToQuery(new URLSearchParams({ wait: '0' }), report(0.07));
  await fetchJson(`${host.url}/agent/${registered.agentId}/tasks/next?${query}`, { token: TOKEN });

  const { body } = await fetchJson(`${host.url}/agents`, { token: TOKEN });
  assert.equal(body.agents[0].loadFactor, 0.07);
});

test('an agent over its load ceiling leaves the work for its neighbour', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  const loaded = fakeSampler(0.99);
  const busy = new TunnelAgent({
    hostUrl: host.url,
    token: TOKEN,
    name: 'pinned-laptop',
    handlers: new HandlerRegistry(),
    maxLoad: 0.85,
    loadSampler: loaded,
    loadBackoffMs: 50,
    // Long enough that the safety valve cannot fire during this test.
    throttleMaxMs: 60_000,
  });
  const running = busy.start();
  t.after(async () => {
    await busy.stop();
    await running;
  });

  // Wait for it to attach, so "the task stayed queued" cannot just mean "no
  // agent had registered yet".
  const deadline = Date.now() + 5_000;
  while (!busy.agentId && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.ok(busy.agentId, 'the loaded agent still registers and still heartbeats');

  const { body: queued } = await enqueue(host.url, { type: 'echo', payload: { value: 1 } });
  await new Promise((r) => setTimeout(r, 500));
  const { body: stillQueued } = await fetchJson(`${host.url}/tasks/${queued.id}`, { token: TOKEN });
  assert.equal(stillQueued.status, TaskStatus.QUEUED, 'a pinned machine does not ask for work');

  // The load drops, and the same agent picks it straight up — this is a pause,
  // not a refusal.
  loaded.state.loadFactor = 0.05;
  const finished = await waitForTask(host.url, queued.id);
  assert.equal(finished.status, TaskStatus.SUCCEEDED);
});

test('a fleet that is loaded everywhere runs work late rather than never', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  const agent = new TunnelAgent({
    hostUrl: host.url,
    token: TOKEN,
    name: 'only-laptop',
    handlers: new HandlerRegistry(),
    maxLoad: 0.5,
    loadSampler: fakeSampler(0.99), // never recovers
    loadBackoffMs: 50,
    throttleMaxMs: 300,
  });
  const running = agent.start();
  t.after(async () => {
    await agent.stop();
    await running;
  });

  const { body: queued } = await enqueue(host.url, { type: 'echo', payload: { value: 2 } });
  const finished = await waitForTask(host.url, queued.id);
  assert.equal(finished.status, TaskStatus.SUCCEEDED);
});

test('an agent runs one task at a time by default', async (t) => {
  const host = await startHost();
  const { handlers, overlapped, releaseAll } = blockingHandler();
  const agent = new TunnelAgent({
    hostUrl: host.url,
    token: TOKEN,
    name: 'serial-laptop',
    handlers,
    loadSampler: fakeSampler(0),
  });
  const running = agent.start();
  // Ordered so the agent is stopped and its parked tasks have reported before
  // the host goes away — otherwise teardown fills the log with report failures
  // that look like real ones.
  t.after(async () => {
    releaseAll();
    await agent.stop();
    await running;
  });
  t.after(() => host.close());

  await enqueue(host.url, { type: 'block', leaseMs: 10_000 });
  await enqueue(host.url, { type: 'block', leaseMs: 10_000 });
  await new Promise((r) => setTimeout(r, 500));

  assert.equal(agent.inFlight, 1);
  assert.equal(overlapped.max, 1);
});

test('a machine that opts into concurrency actually uses its cores', async (t) => {
  const host = await startHost();
  const { handlers, overlapped, releaseAll } = blockingHandler();
  const agent = new TunnelAgent({
    hostUrl: host.url,
    token: TOKEN,
    name: 'parallel-laptop',
    handlers,
    concurrency: 3,
    loadSampler: fakeSampler(0),
  });
  const running = agent.start();
  // Ordered so the agent is stopped and its parked tasks have reported before
  // the host goes away — otherwise teardown fills the log with report failures
  // that look like real ones.
  t.after(async () => {
    releaseAll();
    await agent.stop();
    await running;
  });
  t.after(() => host.close());

  for (let i = 0; i < 3; i++) await enqueue(host.url, { type: 'block', leaseMs: 10_000 });

  const deadline = Date.now() + 5_000;
  while (overlapped.max < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(overlapped.max, 3, 'all three ran at once rather than one after another');

  // And the host knows it is holding all three, so a second machine would win
  // the next task.
  const { body } = await fetchJson(`${host.url}/agents`, { token: TOKEN });
  assert.equal(body.agents[0].inFlight, 3);
});

test('a stopping agent lets its running task report before it disconnects', async (t) => {
  // Otherwise the result comes back 410, the host waits out the whole lease,
  // and work that actually succeeded gets run a second time on the other
  // laptop — the opposite of spreading load.
  const host = await startHost();
  const { handlers, overlapped, releaseAll } = blockingHandler();
  const agent = new TunnelAgent({
    hostUrl: host.url,
    token: TOKEN,
    name: 'stopping-laptop',
    handlers,
    loadSampler: fakeSampler(0),
  });
  const running = agent.start();
  t.after(() => host.close());

  const { body: queued } = await enqueue(host.url, { type: 'block', leaseMs: 30_000 });
  const deadline = Date.now() + 5_000;
  while (overlapped.now === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(overlapped.now, 1, 'the task is running when the agent is asked to stop');

  const stopping = agent.stop();
  releaseAll();
  await stopping;
  await running;

  const { body: finished } = await fetchJson(`${host.url}/tasks/${queued.id}`, { token: TOKEN });
  assert.equal(finished.status, TaskStatus.SUCCEEDED);
  assert.equal(finished.attempts, 1, 'and it was not handed out a second time');
});

/** A handler that parks until released, so overlap can be observed. */
function blockingHandler() {
  const overlapped = { now: 0, max: 0 };
  const releases = [];
  const handlers = new HandlerRegistry([
    {
      type: 'block',
      async run() {
        overlapped.now += 1;
        overlapped.max = Math.max(overlapped.max, overlapped.now);
        await new Promise((resolve) => releases.push(resolve));
        overlapped.now -= 1;
        return { ok: true };
      },
    },
  ]);
  return {
    handlers,
    overlapped,
    releaseAll() {
      for (const resolve of releases.splice(0)) resolve();
    },
  };
}

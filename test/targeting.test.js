// Work that is only real on one machine.
//
// Placement normally picks: capability, then free RAM, then load, and the best
// machine wins. Some work has no best machine, though — `alpha.render` needs
// the GPU and the generator sitting beside it, and a laptop that has the
// handler enabled can accept that task and fail it. So a task may name the
// machine it must run on, and naming one narrows the candidates and changes
// nothing else: the named machine still has to offer the type, still has to
// have the RAM, and still gets to decline.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createHost } from '../src/host/server.js';
import { TaskQueue } from '../src/host/queue.js';
import { AgentRegistry } from '../src/host/registry.js';
import { TunnelAgent } from '../src/agent/agent.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';
import { fetchJson } from '../src/common/http.js';
import { TaskStatus, validateTaskInput, ProtocolError } from '../src/common/protocol.js';

const TOKEN = 'test-token-that-is-long-enough';
const gb = (n) => n * 1024 ** 3;

async function startHost(options = {}) {
  const host = createHost({ token: TOKEN, ...options });
  await new Promise((resolve) => host.server.listen(0, '127.0.0.1', resolve));
  const { port } = host.server.address();
  return { ...host, url: `http://127.0.0.1:${port}` };
}

const enqueue = (url, body) =>
  fetchJson(`${url}/tasks`, { method: 'POST', token: TOKEN, body }).then((r) => r.body);

async function waitFor(what, predicate, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const task = (extra = {}) => ({ type: 'echo', minMemoryMB: 0, ...extra });

// ------------------------------------------------------------------ protocol

test('a task may name the machine it has to run on, and usually names none', () => {
  assert.equal(validateTaskInput({ type: 'echo' }).targetAgent, null);
  assert.equal(validateTaskInput({ type: 'echo', targetAgent: 'alpha-host' }).targetAgent, 'alpha-host');
  // Empty is not a name, and reads as "anywhere" rather than as a machine
  // called "" that will never attach.
  assert.equal(validateTaskInput({ type: 'echo', targetAgent: '' }).targetAgent, null);
  assert.throws(() => validateTaskInput({ type: 'echo', targetAgent: 42 }), ProtocolError);
  assert.throws(() => validateTaskInput({ type: 'echo', targetAgent: 'x'.repeat(129) }), ProtocolError);
});

// ------------------------------------------------------------------ registry

test('only the named machine may be given a task that names one', () => {
  const registry = new AgentRegistry();
  const host = registry.register({ name: 'alpha-host', capabilities: ['echo'] });
  const laptop = registry.register({ name: 'laptop', capabilities: ['echo'] });

  assert.equal(registry.canAdmit(host.id, task({ targetAgent: 'alpha-host' })), true);
  assert.equal(registry.canAdmit(laptop.id, task({ targetAgent: 'alpha-host' })), false);
  // And a task that names nobody is still offered to both.
  assert.equal(registry.canAdmit(laptop.id, task()), true);

  assert.deepEqual(
    registry.candidatesFor(task({ targetAgent: 'alpha-host' })).map((a) => a.name),
    ['alpha-host'],
  );
});

test('naming a machine narrows the candidates and excuses nothing', () => {
  // The point of targeting is *which* machine, never *whether* the machine can
  // take it: the named one still has to offer the type and have the RAM.
  const registry = new AgentRegistry();
  const host = registry.register({
    name: 'alpha-host',
    capabilities: ['echo'],
    memory: { totalBytes: gb(16), freeBytes: gb(2), offerableBytes: gb(1) },
  });

  assert.equal(registry.canAdmit(host.id, task({ targetAgent: 'alpha-host', minMemoryMB: 4096 })), false);
  assert.equal(
    registry.candidatesFor({ type: 'alpha.render', minMemoryMB: 0, targetAgent: 'alpha-host' }).length,
    0,
  );
});

test('a name that two machines answer to means either of them', () => {
  // Two laptops set up from one copied configuration share a name, which the
  // host allows. Refusing the work would be the wrong answer; ranking between
  // them is the right one.
  const registry = new AgentRegistry();
  const first = registry.register({ name: 'laptop', capabilities: ['echo'] });
  const second = registry.register({ name: 'laptop', capabilities: ['echo'] });
  registry.admit(first.id, task());

  const candidates = registry.candidatesFor(task({ targetAgent: 'laptop' }));
  assert.equal(candidates.length, 2);
  // The one already holding a lease ranks worse, so the idle one is offered it.
  assert.equal(candidates[0].id, second.id);
});

test('the host can say whether a name is attached, and who covers a type', () => {
  const registry = new AgentRegistry();
  registry.register({ name: 'laptop', capabilities: ['echo', 'alpha.render'] });

  assert.equal(registry.hasAgentNamed('laptop'), true);
  assert.equal(registry.hasAgentNamed('alpha-host'), false);
  assert.equal(registry.coversType('alpha.render'), true);
  // The question a targeted task actually asks: not "does anyone render?" but
  // "does the machine I named render?".
  assert.equal(registry.coversType('alpha.render', { agentName: 'alpha-host' }), false);
});

// --------------------------------------------------------------------- queue

test('a parked machine is skipped for work that names another one', async () => {
  const registry = new AgentRegistry();
  const queue = new TaskQueue({ admission: registry });
  const host = registry.register({ name: 'alpha-host', capabilities: ['echo'] });
  const laptop = registry.register({ name: 'laptop', capabilities: ['echo'] });

  const laptopPoll = queue.lease({ agentId: laptop.id, capabilities: ['echo'], waitMs: 50 });
  const queued = queue.enqueue(validateTaskInput({ type: 'echo', targetAgent: 'alpha-host' }));
  assert.equal(queued.status, TaskStatus.QUEUED);
  assert.equal(await laptopPoll, null);

  // And it goes as soon as the machine it asked for asks for work.
  const dispatched = await queue.lease({ agentId: host.id, capabilities: ['echo'], waitMs: 50 });
  assert.equal(dispatched.id, queued.id);
  queue.stop();
});

test('a queue with no registry behind it places a named task anyway', async () => {
  // Same degradation as every other admission rule: with nothing tracking
  // agents there are no names to match, and the queue behaves as it always
  // did rather than stranding the work.
  const queue = new TaskQueue();
  const queued = queue.enqueue(validateTaskInput({ type: 'echo', targetAgent: 'alpha-host' }));
  const dispatched = await queue.lease({
    agentId: 'agent_whoever',
    capabilities: ['echo'],
    waitMs: 50,
  });
  assert.equal(dispatched.id, queued.id);
  queue.stop();
});

// ----------------------------------------------------------------- over HTTP

test('a task tells its caller which of the three reasons it is waiting for', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  await fetchJson(`${host.url}/agent/register`, {
    method: 'POST',
    token: TOKEN,
    body: {
      protocolVersion: 1,
      name: 'laptop',
      capabilities: ['echo', 'alpha.render'],
      memory: { totalBytes: gb(8), freeBytes: gb(2), offerableBytes: gb(1) },
    },
  });

  // 1. The machine it named is not here. Not a memory problem, and not a
  //    "nobody renders" problem — the laptop does.
  const absent = await enqueue(host.url, { type: 'alpha.render', targetAgent: 'alpha-host' });
  assert.equal(absent.targetAgent, 'alpha-host');
  assert.equal(absent.targetAttached, false);
  assert.equal(absent.agentAvailable, false);
  assert.equal(absent.memoryAvailable, true);

  // 2. The machine is here and offers the type, but not with that much RAM.
  const hungry = await enqueue(host.url, {
    type: 'echo',
    targetAgent: 'laptop',
    minMemoryMB: 4096,
  });
  assert.equal(hungry.targetAttached, true);
  assert.equal(hungry.agentAvailable, false);
  assert.equal(hungry.memoryAvailable, false);

  // 3. The machine is here but does not run that type.
  const wrongMachine = await enqueue(host.url, { type: 'sysinfo', targetAgent: 'laptop' });
  assert.equal(wrongMachine.targetAttached, true);
  assert.equal(wrongMachine.agentAvailable, false);
  assert.equal(wrongMachine.memoryAvailable, true);

  // And an untargeted task says nothing about a target.
  const anywhere = await enqueue(host.url, { type: 'echo' });
  assert.equal(anywhere.targetAgent, null);
  assert.equal(anywhere.targetAttached, null);
  assert.equal(anywhere.agentAvailable, true);
});

// --------------------------------------------------------------- real agents

test('a task named for one machine runs there, not on the better target', async (t) => {
  // The case this exists for: the laptop is idle and would win on every
  // ranking signal there is, and the work still has to run on the host.
  const host = await startHost();
  t.after(() => host.close());

  const agents = ['alpha-host', 'laptop'].map(
    (name) =>
      new TunnelAgent({
        hostUrl: host.url,
        token: TOKEN,
        name,
        instanceId: `inst_${name.replace('-', '_')}`,
        handlers: new HandlerRegistry(),
        pollWaitMs: 500,
      }),
  );
  const runs = agents.map((agent) => agent.start());
  t.after(async () => {
    await Promise.all(agents.map((agent) => agent.stop({ drainMs: 0 })));
    await Promise.all(runs);
  });
  await waitFor('both machines to attach', async () => {
    const { body } = await fetchJson(`${host.url}/agents`, { token: TOKEN });
    return body.agents.length === 2;
  });

  // Give the laptop a head start on the queue, so first-to-park cannot be what
  // decides this.
  const queued = await enqueue(host.url, {
    type: 'echo',
    payload: { message: 'render me' },
    targetAgent: 'alpha-host',
  });
  const finished = await waitFor('the task to finish', async () => {
    const { body } = await fetchJson(`${host.url}/tasks/${queued.id}`, { token: TOKEN });
    return body.status === TaskStatus.SUCCEEDED ? body : null;
  });

  const { body: listed } = await fetchJson(`${host.url}/agents`, { token: TOKEN });
  const ran = listed.agents.find((a) => a.id === finished.agentId);
  assert.equal(ran.name, 'alpha-host');
  assert.equal(finished.targetAgent, 'alpha-host');
});

test('a task waits for the machine it named rather than running elsewhere', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  const laptop = new TunnelAgent({
    hostUrl: host.url,
    token: TOKEN,
    name: 'laptop',
    instanceId: 'inst_only_laptop',
    handlers: new HandlerRegistry(),
    pollWaitMs: 250,
  });
  const laptopRun = laptop.start();
  t.after(async () => {
    await laptop.stop({ drainMs: 0 });
    await laptopRun;
  });
  await waitFor('the laptop to attach', async () => {
    const { body } = await fetchJson(`${host.url}/agents`, { token: TOKEN });
    return body.agents.length === 1;
  });

  const queued = await enqueue(host.url, { type: 'echo', targetAgent: 'alpha-host' });
  assert.equal(queued.targetAttached, false);

  // Long enough for the laptop to have polled several times over.
  await new Promise((r) => setTimeout(r, 750));
  const { body: still } = await fetchJson(`${host.url}/tasks/${queued.id}`, { token: TOKEN });
  assert.equal(still.status, TaskStatus.QUEUED);
  assert.equal(still.attempts, 0);

  // Then the machine it asked for attaches, and it goes straight there.
  const alphaHost = new TunnelAgent({
    hostUrl: host.url,
    token: TOKEN,
    name: 'alpha-host',
    instanceId: 'inst_alpha_host',
    handlers: new HandlerRegistry(),
    pollWaitMs: 250,
  });
  const hostRun = alphaHost.start();
  t.after(async () => {
    await alphaHost.stop({ drainMs: 0 });
    await hostRun;
  });

  const finished = await waitFor('the task to run on the machine it named', async () => {
    const { body } = await fetchJson(`${host.url}/tasks/${queued.id}`, { token: TOKEN });
    return body.status === TaskStatus.SUCCEEDED ? body : null;
  });
  assert.equal(finished.agentId, alphaHost.agentId);
});

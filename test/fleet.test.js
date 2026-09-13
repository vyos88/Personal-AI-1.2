// Two machines lending at once, and one machine that keeps coming back.
//
// The fleet this exists for is the Alpha host plus a laptop or two, and the
// thing that goes wrong with more than one worker is identity: every agent
// dials out, so a worker that crashed and restarted arrives looking exactly
// like a brand new machine. With one laptop the duplicate row it leaves behind
// is obvious. With two it is not, and a host that counts one machine twice
// places work on memory that does not exist.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createHost } from '../src/host/server.js';
import { AgentRegistry } from '../src/host/registry.js';
import { TunnelAgent } from '../src/agent/agent.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';
import { instanceIdFor, machineFingerprint } from '../src/agent/identity.js';
import { fetchJson, HttpError } from '../src/common/http.js';
import {
  SUPERSEDED_MEMORY_MS,
  validateInstanceId,
  validateRegistration,
  ProtocolError,
} from '../src/common/protocol.js';

const TOKEN = 'test-token-that-is-long-enough';
const gb = (n) => n * 1024 ** 3;
const RAM = { totalBytes: gb(16), freeBytes: gb(9), offerableBytes: gb(8) };

async function startHost(options = {}) {
  const host = createHost({ token: TOKEN, ...options });
  await new Promise((resolve) => host.server.listen(0, '127.0.0.1', resolve));
  const { port } = host.server.address();
  return { ...host, url: `http://127.0.0.1:${port}` };
}

function fixedRegistry(startAt = 1_000) {
  let clock = startAt;
  const registry = new AgentRegistry({ now: () => clock });
  return { registry, tick: (ms) => (clock += ms) };
}

const register = (url, body) =>
  fetchJson(`${url}/agent/register`, {
    method: 'POST',
    token: TOKEN,
    body: { protocolVersion: 1, capabilities: ['echo'], ...body },
  });

const agents = async (url) => (await fetchJson(`${url}/agents`, { token: TOKEN })).body.agents;

async function waitFor(what, predicate, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ------------------------------------------------------------------ identity

test('a worker reports the same instance id across restarts of it', () => {
  // Nothing else works: if the id changed per process, a restarted agent could
  // never be recognised as the machine that was already lending.
  assert.equal(instanceIdFor({ name: 'laptop' }), instanceIdFor({ name: 'laptop' }));
  validateInstanceId(instanceIdFor({ name: 'laptop' }));
});

test('two workers on one machine are two identities, not one', () => {
  // A machine may deliberately run a second agent — narrowed to a capability,
  // or a whole test fleet in one process. Those are separate workers and must
  // not evict each other, so the name is part of the identity.
  assert.notEqual(instanceIdFor({ name: 'laptop' }), instanceIdFor({ name: 'jacks-laptop' }));
});

test('the identity is derived from the machine, not from configuration', () => {
  // `.env.agent` gets copied from the first laptop to the second — that is how
  // a second machine is usually set up — so an id written into it would arrive
  // already belonging to another machine. Everything in the fingerprint is
  // read off the machine itself.
  const fingerprint = machineFingerprint();
  assert.ok(fingerprint.includes('|'));
  assert.equal(fingerprint, machineFingerprint());
});

test('an operator can name the identity for the case the machine cannot', () => {
  const env = { ALPHA_AGENT_INSTANCE_ID: 'jacks-laptop' };
  assert.equal(instanceIdFor({ name: 'laptop', env }), 'jacks-laptop');
  assert.throws(
    () => instanceIdFor({ name: 'laptop', env: { ALPHA_AGENT_INSTANCE_ID: 'no spaces' } }),
    /ALPHA_AGENT_INSTANCE_ID/,
  );
});

test('registration carries an optional instance id', () => {
  const bare = validateRegistration({ protocolVersion: 1, name: 'a', capabilities: ['echo'] });
  assert.equal(bare.instanceId, null);
  const reported = validateRegistration({
    protocolVersion: 1,
    name: 'a',
    capabilities: ['echo'],
    instanceId: 'inst_0123456789abcdef',
  });
  assert.equal(reported.instanceId, 'inst_0123456789abcdef');
  assert.throws(() => validateInstanceId('inst 0123'), ProtocolError);
  assert.throws(() => validateInstanceId('-leading-punctuation'), ProtocolError);
});

// ------------------------------------------------------ one registration each

test('a worker coming back takes its own place over instead of doubling it', () => {
  const { registry } = fixedRegistry();
  const first = registry.register({
    name: 'laptop',
    capabilities: ['echo'],
    instanceId: 'inst_laptop',
    memory: RAM,
    userId: 'user_1',
  });
  const second = registry.register({
    name: 'laptop',
    capabilities: ['echo'],
    instanceId: 'inst_laptop',
    memory: RAM,
    userId: 'user_1',
  });

  assert.deepEqual(
    registry.list().map((a) => a.id),
    [second.id],
  );
  // The whole point: one 16 GB laptop lends 8 GB, not 16.
  assert.equal(registry.offeredBytes(), gb(8));
  assert.equal(registry.knows(first.id), false);
  assert.equal(registry.supersededBy(first.id).byAgentId, second.id);
});

test('a superseded registration keeps nothing back for the tasks it was holding', () => {
  // The dead process was running a 4 GB task. Its reservation must not go on
  // being charged to the machine that has just come back with the RAM free.
  const { registry } = fixedRegistry();
  const first = registry.register({
    name: 'laptop',
    capabilities: ['echo'],
    instanceId: 'inst_laptop',
    memory: RAM,
  });
  registry.admit(first.id, { minMemoryMB: 4096 });
  assert.equal(registry.offerableBytes(first.id), gb(4));

  const second = registry.register({
    name: 'laptop',
    capabilities: ['echo'],
    instanceId: 'inst_laptop',
    memory: RAM,
  });
  assert.equal(registry.offerableBytes(second.id), gb(8));
  assert.equal(registry.offeredBytes(), gb(8));
});

test('one user\'s credential cannot evict another user\'s worker', () => {
  // Same rule the agent plane enforces on every other request: a credential
  // drives its owner's workers and nobody else's.
  const { registry } = fixedRegistry();
  const theirs = registry.register({
    name: 'laptop',
    capabilities: ['echo'],
    instanceId: 'inst_shared',
    userId: 'user_1',
  });
  const mine = registry.register({
    name: 'laptop',
    capabilities: ['echo'],
    instanceId: 'inst_shared',
    userId: 'user_2',
  });

  assert.deepEqual(
    registry.list().map((a) => a.id).sort(),
    [theirs.id, mine.id].sort(),
  );
});

test('two machines under one name are two workers, however confusing that reads', () => {
  // Placement does not care about names, and refusing the second machine would
  // be refusing capacity over a label. `alpha-admin agents` marks them instead.
  const { registry } = fixedRegistry();
  const one = registry.register({
    name: 'laptop',
    capabilities: ['echo'],
    instanceId: 'inst_one',
    memory: RAM,
  });
  const two = registry.register({
    name: 'laptop',
    capabilities: ['echo'],
    instanceId: 'inst_two',
    memory: RAM,
  });

  assert.equal(registry.list().length, 2);
  assert.equal(registry.offeredBytes(), gb(16));
  assert.notEqual(one.id, two.id);
});

test('an agent too old to report an identity is never mistaken for one coming back', () => {
  // Reporting an instance id is the agent's to do, so the host has to keep
  // working for one that does not — as two workers, exactly as before.
  const { registry } = fixedRegistry();
  registry.register({ name: 'laptop', capabilities: ['echo'], memory: RAM });
  registry.register({ name: 'laptop', capabilities: ['echo'], memory: RAM });
  assert.equal(registry.list().length, 2);
});

test('the host forgets a supersession once nothing could still be asking about it', () => {
  const { registry, tick } = fixedRegistry();
  const first = registry.register({ name: 'laptop', capabilities: ['echo'], instanceId: 'inst_x' });
  registry.register({ name: 'laptop', capabilities: ['echo'], instanceId: 'inst_x' });
  assert.ok(registry.supersededBy(first.id));

  tick(SUPERSEDED_MEMORY_MS + 1);
  registry.prune();
  // Past this point the id means nothing again, and an agent asking about it
  // is told to register rather than to stand down.
  assert.equal(registry.supersededBy(first.id), null);
});

// ----------------------------------------------------------------- over HTTP

test('a restarted machine is one agent to the host, and lends its RAM once', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  const { body: first } = await register(host.url, {
    name: 'laptop',
    instanceId: 'inst_laptop',
    memory: RAM,
  });
  const { body: second } = await register(host.url, {
    name: 'laptop',
    instanceId: 'inst_laptop',
    memory: RAM,
  });

  const listed = await agents(host.url);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, second.agentId);
  assert.equal(listed[0].instanceId, 'inst_laptop');

  const { body: stats } = await fetchJson(`${host.url}/stats`, { token: TOKEN });
  assert.equal(stats.memory.offeredBytes, gb(8));
  assert.equal(stats.agents, 1);

  // And the registration it replaced is told to stand down rather than to
  // register again, which is what stops the two taking turns.
  const error = await fetchJson(`${host.url}/agent/${first.agentId}/tasks/next?wait=0`, {
    token: TOKEN,
  }).then(
    () => null,
    (e) => e,
  );
  assert.ok(error instanceof HttpError);
  assert.equal(error.status, 410);
  assert.equal(error.body.error, 'superseded');
  assert.equal(error.body.code, 'stand_down');
  assert.equal(error.body.byAgentId, second.agentId);
});

test('a registration the host merely forgot is still told to register again', async (t) => {
  // The other 410, and the reason the two need different answers: a host that
  // restarted knows nothing about this agent, and it should come back.
  const host = await startHost();
  t.after(() => host.close());

  const error = await fetchJson(`${host.url}/agent/agent_nosuchthing/tasks/next?wait=0`, {
    token: TOKEN,
  }).then(
    () => null,
    (e) => e,
  );
  assert.equal(error.status, 410);
  assert.equal(error.body.code, 'reregister');
});

test('work is never handed to a registration the host has dropped', async (t) => {
  // A long poll outlives its registration: 25 seconds is plenty of time to be
  // superseded or pruned. Placing a task on it costs the task a whole lease —
  // the reply it sends back is a 410 — so it is skipped instead.
  const host = await startHost();
  t.after(() => host.close());

  const { body: ghost } = await register(host.url, { name: 'laptop', instanceId: 'inst_laptop' });
  const parked = fetchJson(`${host.url}/agent/${ghost.agentId}/tasks/next?wait=3000`, {
    token: TOKEN,
  }).then(
    (ok) => ok,
    (e) => e,
  );
  // Let the poll park before the machine comes back under a new registration.
  await waitFor('the poll to park', async () => host.queue.stats().waiters === 1);
  await register(host.url, { name: 'laptop', instanceId: 'inst_laptop' });

  const { body: task } = await fetchJson(`${host.url}/tasks`, {
    method: 'POST',
    token: TOKEN,
    body: { type: 'echo', payload: { message: 'hello' } },
  });

  const { body: queued } = await fetchJson(`${host.url}/tasks/${task.id}`, { token: TOKEN });
  assert.equal(queued.status, 'queued');
  assert.equal(queued.agentId, null);

  // The poll itself comes back empty-handed, which is the whole point: it is
  // the registration that was dropped, not the machine behind it.
  const result = await parked;
  const handed = result instanceof HttpError ? null : (result.body?.task ?? null);
  assert.equal(handed, null);
});

// --------------------------------------------------------------- real agents

test('a second agent process on one machine makes the first stand down', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  // Both claim the same machine, which is what two agent processes started
  // from one checkout do. Passed explicitly so the pair can share a machine
  // here without sharing this test runner's own identity.
  const options = {
    hostUrl: host.url,
    token: TOKEN,
    name: 'laptop',
    instanceId: 'inst_one_laptop',
    handlers: new HandlerRegistry(),
    // Short, so the loser hears about it from its next poll rather than from
    // a heartbeat twenty seconds out.
    pollWaitMs: 250,
  };
  const first = new TunnelAgent(options);
  const second = new TunnelAgent(options);

  const firstRun = first.start();
  await waitFor('the first agent to attach', async () => (await agents(host.url)).length === 1);

  const secondRun = second.start();
  t.after(async () => {
    await second.stop({ drainMs: 0 });
    await Promise.all([firstRun, secondRun]);
  });

  await waitFor('the first agent to stand down', () => first.stoodDown);
  await firstRun;

  // One machine, one registration, and the survivor is the newer process.
  const listed = await agents(host.url);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, second.agentId);
  assert.equal(second.stoodDown, false);
});

test('a superseded agent hears it from its heartbeat too, and still stands down', async (t) => {
  // The poll is not the only request that can come back superseded, and the
  // heartbeat is the one place where treating it as an ordinary 410 does real
  // damage: clearing the agent id there is exactly what makes the next pass
  // register straight back in and evict the process that has just taken over.
  const host = await startHost({ heartbeatIntervalMs: 50 });
  t.after(() => host.close());

  const options = {
    hostUrl: host.url,
    token: TOKEN,
    name: 'laptop',
    instanceId: 'inst_heartbeat_laptop',
    handlers: new HandlerRegistry(),
    // Long enough that the heartbeat, not the poll, is what hears first.
    pollWaitMs: 5_000,
  };
  const first = new TunnelAgent(options);
  const second = new TunnelAgent(options);

  const firstRun = first.start();
  await waitFor('the first agent to attach', async () => (await agents(host.url)).length === 1);
  const secondRun = second.start();
  t.after(async () => {
    await second.stop({ drainMs: 0 });
    await Promise.all([firstRun, secondRun]);
  });

  await waitFor('the first agent to stand down', () => first.stoodDown, { timeoutMs: 4_000 });
  await firstRun;

  // And it stays stood down: one registration, still the newer process's.
  await new Promise((r) => setTimeout(r, 200));
  const listed = await agents(host.url);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, second.agentId);
});

test('a machine that comes back after a crash keeps lending, without a ghost', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  const options = {
    hostUrl: host.url,
    token: TOKEN,
    name: 'jacks-laptop',
    instanceId: 'inst_jacks_laptop',
    handlers: new HandlerRegistry(),
    pollWaitMs: 250,
  };

  // A crash, not a shutdown: nothing deregisters, so the host is still holding
  // the registration when the machine comes back.
  const crashed = new TunnelAgent(options);
  const crashedRun = crashed.start();
  await waitFor('the first run to attach', async () => (await agents(host.url)).length === 1);
  const ghostId = crashed.agentId;

  const restarted = new TunnelAgent(options);
  const restartedRun = restarted.start();
  t.after(async () => {
    await Promise.all([crashed.stop({ drainMs: 0 }), restarted.stop({ drainMs: 0 })]);
    await Promise.all([crashedRun, restartedRun]);
  });

  await waitFor('the restart to take over', async () => {
    const listed = await agents(host.url);
    return listed.length === 1 && listed[0].id === restarted.agentId;
  });
  assert.notEqual(restarted.agentId, ghostId);

  // And the machine still runs work afterwards — taking a registration over is
  // not a state anything has to be rescued from.
  const { body: task } = await fetchJson(`${host.url}/tasks`, {
    method: 'POST',
    token: TOKEN,
    body: { type: 'echo', payload: { message: 'still here' } },
  });
  await waitFor('the task to finish', async () => {
    const { body } = await fetchJson(`${host.url}/tasks/${task.id}`, { token: TOKEN });
    return body.status === 'succeeded';
  });
});

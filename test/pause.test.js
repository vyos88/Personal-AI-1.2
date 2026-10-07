// Pausing a machine: "take no new work", by name, with the creator's word final.
//
// A supervisor (Alpha) is meant to hold `agents:control` and nothing else, so
// it can stand a machine down when it misbehaves without being able to queue
// work or touch credentials. Three properties hold that together, all tested:
// a pause follows the name across re-registration, it never touches work in
// flight, and a pause made with admin is not something that key can lift.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createHost } from '../src/host/server.js';
import { AgentRegistry } from '../src/host/registry.js';
import { AuthService } from '../src/host/auth/service.js';
import { AuthStore } from '../src/host/auth/store.js';
import { TunnelAgent } from '../src/agent/agent.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';
import { fetchJson, HttpError } from '../src/common/http.js';
import { TaskStatus } from '../src/common/protocol.js';

const BOOTSTRAP = 'bootstrap-token-long-enough-for-tests';
const PASSWORD = 'a-perfectly-fine-password';
const IDLE_LOAD = { snapshot: () => ({ cpus: 1, busy: 0, loadAverage1: 0, loadFactor: 0 }) };
const task = (extra = {}) => ({ type: 'echo', minMemoryMB: 0, ...extra });
const rejectsWith = (status, code) => (error) =>
  error instanceof HttpError && error.status === status && (!code || error.body?.error === code);

async function startHost() {
  const auth = new AuthService({ store: new AuthStore({ path: null }), bootstrapToken: BOOTSTRAP });
  await auth.load();
  const host = createHost({ auth });
  await new Promise((resolve) => host.server.listen(0, '127.0.0.1', resolve));
  const { port } = host.server.address();
  return { ...host, url: `http://127.0.0.1:${port}` };
}

const call = (url, path, { token = BOOTSTRAP, ...rest } = {}) => fetchJson(`${url}${path}`, { token, ...rest });

async function keyWithScopes(url, email, scopes) {
  const { body: created } = await call(url, '/invites', { method: 'POST', body: { email, scopes } });
  const { body: redeemed } = await call(url, '/invites/redeem', {
    method: 'POST',
    token: null,
    body: { token: created.token, password: PASSWORD },
  });
  return redeemed.token;
}

async function waitFor(what, predicate, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ------------------------------------------------------------------ registry

test('a paused name is offered nothing, and the pause outlives re-registration', () => {
  const registry = new AgentRegistry();
  const first = registry.register({ name: 'laptop', capabilities: ['echo'] });
  const other = registry.register({ name: 'desk', capabilities: ['echo'] });

  registry.pause('laptop', { reason: 'too hot', by: { label: 'alpha', admin: false } });
  assert.equal(registry.canAdmit(first.id, task()), false);
  assert.equal(registry.canAdmit(other.id, task()), true);
  // Even work that names it: a pause is stronger than a target.
  assert.equal(registry.canAdmit(first.id, task({ targetAgent: 'laptop' })), false);
  assert.deepEqual(registry.candidatesFor(task()).map((a) => a.name), ['desk']);

  // The laptop restarts and registers with a fresh id; it is still paused.
  registry.deregister(first.id);
  const again = registry.register({ name: 'laptop', capabilities: ['echo'] });
  assert.equal(registry.canAdmit(again.id, task()), false);
  assert.equal(registry.list().find((a) => a.id === again.id).paused, true);

  assert.equal(registry.resume('laptop', { by: { label: 'alpha', admin: false } }).reason, 'too hot');
  assert.equal(registry.canAdmit(again.id, task()), true);
  assert.equal(registry.resume('laptop', { by: { label: 'alpha', admin: false } }), null);
});

test("an admin's pause can be lifted only by an admin, and a re-pause never downgrades it", () => {
  const registry = new AgentRegistry();
  registry.register({ name: 'laptop', capabilities: ['echo'] });
  const supervisor = { label: 'alpha', admin: false };
  const creator = { label: 'creator', admin: true };

  registry.pause('laptop', { reason: 'mine', by: creator });
  registry.pause('laptop', { reason: 'supervisor says so too', by: supervisor });
  assert.equal(registry.pauses()[0].creatorHold, true);
  assert.throws(() => registry.resume('laptop', { by: supervisor }), (e) => e.code === 'creator_hold');
  assert.ok(registry.resume('laptop', { by: creator }));
});

// ------------------------------------------------------------------ over HTTP

test('a supervisor key can pause and resume, and queued work moves the moment it resumes', async (t) => {
  const host = await startHost();
  t.after(() => host.close());
  const supervisor = await keyWithScopes(host.url, 'alpha@example.com', 'agents:read,agents:control');
  const operator = await keyWithScopes(host.url, 'ops@example.com', 'tasks:read,tasks:write');

  const laptop = new TunnelAgent({
    loadSampler: IDLE_LOAD,
    hostUrl: host.url,
    token: BOOTSTRAP,
    name: 'laptop',
    instanceId: 'inst_pause_laptop',
    handlers: new HandlerRegistry(),
    // Longer than the wait below: if resume did not hand the task out itself,
    // it would sit until this poll came back and the test would time out.
    pollWaitMs: 20_000,
  });
  const run = laptop.start();
  t.after(async () => {
    await laptop.stop({ drainMs: 0 });
    await run;
  });
  await waitFor('the laptop to attach', async () => (await call(host.url, '/agents')).body.agents.length === 1);

  // Without the scope, no pause.
  await assert.rejects(
    () => call(host.url, '/agents/pause', { method: 'POST', token: operator, body: { name: 'laptop' } }),
    rejectsWith(403),
  );

  const { body: paused } = await call(host.url, '/agents/pause', {
    method: 'POST',
    token: supervisor,
    body: { name: 'laptop', reason: 'testing' },
  });
  assert.equal(paused.pause.creatorHold, false);
  assert.equal(paused.pause.attached, true);

  const { body: queued } = await call(host.url, '/tasks', {
    method: 'POST',
    token: operator,
    body: { type: 'echo', payload: { message: 'wait for me' } },
  });
  assert.equal(queued.agentAvailable, false);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await call(host.url, `/tasks/${queued.id}`, { token: operator })).body.status, TaskStatus.QUEUED);

  const { body: resumed } = await call(host.url, '/agents/resume', {
    method: 'POST',
    token: supervisor,
    body: { name: 'laptop' },
  });
  assert.equal(resumed.dispatched, 1);
  await waitFor('the task to run once resumed', async () => {
    const { body } = await call(host.url, `/tasks/${queued.id}`, { token: operator });
    return body.status === TaskStatus.SUCCEEDED;
  }, { timeoutMs: 5_000 });

  await assert.rejects(
    () => call(host.url, '/agents/resume', { method: 'POST', token: supervisor, body: { name: 'laptop' } }),
    rejectsWith(404, 'not_paused'),
  );
});

test("a supervisor key cannot lift the creator's pause", async (t) => {
  const host = await startHost();
  t.after(() => host.close());
  const supervisor = await keyWithScopes(host.url, 'alpha@example.com', 'agents:read,agents:control');

  await call(host.url, '/agents/pause', { method: 'POST', body: { name: 'jacks-laptop', reason: 'creator says stop' } });
  const { body: listed } = await call(host.url, '/agents/pauses', { token: supervisor });
  assert.deepEqual(listed.pauses.map((p) => [p.name, p.creatorHold, p.attached]), [['jacks-laptop', true, false]]);

  await assert.rejects(
    () => call(host.url, '/agents/resume', { method: 'POST', token: supervisor, body: { name: 'jacks-laptop' } }),
    rejectsWith(403, 'creator_hold'),
  );
  const { body: lifted } = await call(host.url, '/agents/resume', { method: 'POST', body: { name: 'jacks-laptop' } });
  assert.equal(lifted.resumed, 'jacks-laptop');
});

test('pause rejects a missing or oversized name', async (t) => {
  const host = await startHost();
  t.after(() => host.close());
  for (const name of [undefined, '', '   ', 'x'.repeat(129), 42]) {
    await assert.rejects(
      () => call(host.url, '/agents/pause', { method: 'POST', body: { name } }),
      rejectsWith(400, 'invalid_name'),
    );
  }
});

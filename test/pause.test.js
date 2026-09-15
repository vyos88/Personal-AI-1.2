import test from 'node:test';
import assert from 'node:assert/strict';

import { createHost } from '../src/host/server.js';
import { AuthService } from '../src/host/auth/service.js';
import { AuthStore } from '../src/host/auth/store.js';
import { TunnelAgent } from '../src/agent/agent.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';
import { SCOPE_PRESETS, SCOPES, hasScope } from '../src/host/auth/scopes.js';
import { fetchJson, HttpError } from '../src/common/http.js';
import { TaskStatus, validatePauseReason } from '../src/common/protocol.js';

/**
 * Stopping the whole fleet from handing out work.
 *
 * The thing being pinned here is mostly what a pause does *not* do. Every
 * other way of stopping a machine taking work is blunt — stop the keeper, and
 * whatever it was running dies with it — and the reason to pause is usually to
 * look at what the fleet is doing, which a pause that took the fleet off the
 * air would make impossible.
 */

const TOKEN = 'test-token-that-is-long-enough';
const BOOTSTRAP = 'bootstrap-token-long-enough-for-tests';

async function startHost(options = {}) {
  const host = createHost({ token: TOKEN, ...options });
  await new Promise((resolve) => host.server.listen(0, '127.0.0.1', resolve));
  const { port } = host.server.address();
  return { ...host, url: `http://127.0.0.1:${port}` };
}

const enqueue = (url, body) => fetchJson(`${url}/tasks`, { method: 'POST', token: TOKEN, body });
const pause = (url, reason) =>
  fetchJson(`${url}/fleet/pause`, { method: 'POST', token: TOKEN, body: { reason } });
const resume = (url) => fetchJson(`${url}/fleet/resume`, { method: 'POST', token: TOKEN });
const statusOf = async (url, id) =>
  (await fetchJson(`${url}/tasks/${id}`, { token: TOKEN })).body.status;

async function waitForTask(url, taskId, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await fetchJson(`${url}/tasks/${taskId}`, { token: TOKEN });
    if (body.status !== TaskStatus.QUEUED && body.status !== TaskStatus.LEASED) return body;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`task ${taskId} did not finish within ${timeoutMs}ms`);
}

/** A real agent over loopback, attached and parked on its long poll. */
async function attachAgent(t, host, { handlers = new HandlerRegistry(), name = 'laptop' } = {}) {
  const agent = new TunnelAgent({ hostUrl: host.url, token: TOKEN, name, handlers });
  const running = agent.start();
  t.after(async () => {
    await agent.stop();
    await running;
  });

  const deadline = Date.now() + 5_000;
  while (!agent.agentId && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.ok(agent.agentId, 'the agent attached');
  return agent;
}

// ------------------------------------------------------------- what it stops

test('a paused fleet does not hand work to an idle agent that could run it', async (t) => {
  const host = await startHost();
  t.after(() => host.close());
  await attachAgent(t, host);

  const { body: fleet } = await pause(host.url, 'laptop unusable');
  assert.equal(fleet.paused, true);
  assert.equal(fleet.reason, 'laptop unusable');
  assert.equal(fleet.stillRunning, 0);

  const { body: queued } = await enqueue(host.url, { type: 'echo', payload: { value: 1 } });
  // Long enough to cover the agent's poll cycle several times over.
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await statusOf(host.url, queued.id), TaskStatus.QUEUED);

  // And the same agent takes it the moment the pause lifts, which is what
  // makes this a pause rather than a refusal.
  const { body: resumed } = await resume(host.url);
  assert.equal(resumed.paused, false);
  const finished = await waitForTask(host.url, queued.id);
  assert.equal(finished.status, TaskStatus.SUCCEEDED);
});

test('resuming dispatches what queued up rather than waiting for the next poll', async (t) => {
  const host = await startHost();
  t.after(() => host.close());
  await attachAgent(t, host);

  await pause(host.url);
  const ids = [];
  for (const value of [1, 2, 3]) {
    const { body } = await enqueue(host.url, { type: 'echo', payload: { value } });
    ids.push(body.id);
  }
  await new Promise((r) => setTimeout(r, 300));

  const { body: resumed } = await resume(host.url);
  // One agent at concurrency 1, so exactly one can be placed into its parked
  // poll; the rest stay queued and follow as it frees up. The number matters
  // less than it being immediate — a resume reporting 0 here would mean every
  // task was left to wait out a poll on a fleet that is plainly idle.
  assert.equal(resumed.dispatched, 1);

  for (const id of ids) {
    assert.equal((await waitForTask(host.url, id)).status, TaskStatus.SUCCEEDED);
  }
});

test('an agent attaching during a pause is not handed the backlog', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  // Queued with nobody attached, so it parks in the pending list rather than
  // going straight to a waiter — then paused. The laptop that shows up next is
  // the case this exists for: it wakes up, polls for the first time, and the
  // host has a queue sitting there. Dispatch on that path is a *different*
  // branch from the one enqueue takes, and it needs its own gate: without it a
  // machine reconnecting mid-pause is handed everything that built up, which
  // is the precise opposite of what pausing was for.
  const { body: queued } = await enqueue(host.url, { type: 'echo', payload: { value: 9 } });
  await pause(host.url, 'both laptops');

  await attachAgent(t, host, { name: 'just-woke-up' });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await statusOf(host.url, queued.id), TaskStatus.QUEUED);

  await resume(host.url);
  assert.equal((await waitForTask(host.url, queued.id)).status, TaskStatus.SUCCEEDED);
});

// --------------------------------------------------- what it deliberately does not

test('a task already running when the pause lands finishes and reports normally', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let started;
  const startedSignal = new Promise((resolve) => { started = resolve; });

  const handlers = new HandlerRegistry([
    {
      type: 'slow',
      async run() {
        started();
        await held;
        return { finished: true };
      },
    },
  ]);
  await attachAgent(t, host, { handlers });

  const { body: task } = await enqueue(host.url, { type: 'slow', leaseMs: 30_000 });
  await startedSignal;

  // Paused with the work in hand. Killing it here would cost an attempt and a
  // re-run of something that was going to succeed, which is the one thing a
  // pause must never do.
  const { body: fleet } = await pause(host.url, 'mid-render');
  assert.equal(fleet.stillRunning, 1, 'the pause counts, and does not stop, what is running');
  assert.equal(await statusOf(host.url, task.id), TaskStatus.LEASED);

  release();
  const finished = await waitForTask(host.url, task.id);
  assert.equal(finished.status, TaskStatus.SUCCEEDED);
  assert.deepEqual(finished.result, { finished: true });
});

test('agents stay attached and keep reporting while the fleet is paused', async (t) => {
  const host = await startHost();
  t.after(() => host.close());
  const agent = await attachAgent(t, host, { name: 'the-laptop' });

  await pause(host.url, 'looking at where the load actually is');

  // This is the whole reason the pause leaves the long poll parked rather than
  // hanging up: memory and load ride the poll, so a paused fleet is one an
  // operator can still watch. A pause that blinded them would defeat itself.
  await new Promise((r) => setTimeout(r, 300));
  const { body } = await fetchJson(`${host.url}/agents`, { token: TOKEN });
  assert.equal(body.agents.length, 1);
  const [attached] = body.agents;
  assert.equal(attached.name, 'the-laptop');
  assert.equal(attached.id, agent.agentId);
  assert.ok(attached.capabilities.includes('echo'), 'it still advertises what it can do');
  assert.ok(attached.memory, 'and still says how much RAM it has to lend');
});

test('queueing still works while paused, and the answer says why nothing moves', async (t) => {
  const host = await startHost();
  t.after(() => host.close());
  await attachAgent(t, host);

  const { body: before } = await enqueue(host.url, { type: 'echo' });
  assert.equal(before.fleetPaused, false);

  await pause(host.url, 'laptops');
  const { status, body: during } = await enqueue(host.url, { type: 'echo' });
  assert.equal(status, 202, 'refusing would push the decision onto the wrong person');
  // Without this the caller is told a capable agent with room is attached, and
  // then watches the task sit there with no explanation anywhere.
  assert.equal(during.agentAvailable, true);
  assert.equal(during.fleetPaused, true);
});

// ------------------------------------------------------------------ the edges

test('pausing twice keeps the fleet paused and takes the newer reason', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  const { body: first } = await pause(host.url, 'first go');
  assert.equal(first.paused, true);
  const since = first.since;

  const { body: second } = await pause(host.url, 'actually, the 41 HPL too');
  assert.equal(second.paused, true);
  assert.equal(second.reason, 'actually, the 41 HPL too');
  // Re-pausing is not a fresh pause: the clock still runs from when work
  // actually stopped, or "paused since" would reset every time somebody
  // clarified why.
  assert.equal(second.since, since);
});

test('resuming a fleet that was never paused is a no-op, not an error', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  const { status, body } = await resume(host.url);
  assert.equal(status, 200);
  assert.equal(body.paused, false);
  assert.equal(body.dispatched, 0);
});

test('a pause reason is optional, bounded, and survives to stats', async (t) => {
  assert.equal(validatePauseReason(undefined), null);
  assert.equal(validatePauseReason(''), null);
  assert.equal(validatePauseReason('because'), 'because');
  assert.throws(() => validatePauseReason('x'.repeat(501)), /exceeds 500/);
  assert.throws(() => validatePauseReason(42), /non-empty string/);

  const host = await startHost();
  t.after(() => host.close());

  const { body: idle } = await fetchJson(`${host.url}/stats`, { token: TOKEN });
  assert.equal(idle.queue.fleet.paused, false);

  await pause(host.url, 'killing my laptop');
  const { body: stats } = await fetchJson(`${host.url}/stats`, { token: TOKEN });
  // On stats because "every agent is idle and nothing is moving" is alarming
  // unless you can see, in the same place, that somebody stopped it on purpose.
  assert.equal(stats.queue.fleet.paused, true);
  assert.equal(stats.queue.fleet.reason, 'killing my laptop');
  assert.ok(Number.isFinite(stats.queue.fleet.since));
});

// --------------------------------------------------------------- who may do it

test('stopping the fleet is an operator capability, not a reader one', async () => {
  assert.ok(hasScope(SCOPE_PRESETS.operator, SCOPES.FLEET_PAUSE));
  assert.ok(!hasScope(SCOPE_PRESETS.viewer, SCOPES.FLEET_PAUSE));
  assert.ok(!hasScope(SCOPE_PRESETS.agent, SCOPES.FLEET_PAUSE));
  // admin implies everything, so an existing admin key can pause with no
  // reissue — which matters, because needing a new credential first is not
  // what you want when the reason you are here is that a laptop is unusable.
  assert.ok(hasScope(SCOPE_PRESETS.admin, SCOPES.FLEET_PAUSE));
});

test('a key that may only read cannot stop the fleet', async (t) => {
  const auth = new AuthService({
    store: new AuthStore({ path: null }),
    bootstrapToken: BOOTSTRAP,
  });
  await auth.load();
  const host = createHost({ auth });
  await new Promise((resolve) => host.server.listen(0, '127.0.0.1', resolve));
  t.after(() => host.close());
  const url = `http://127.0.0.1:${host.server.address().port}`;

  const { body: invite } = await fetchJson(`${url}/invites`, {
    method: 'POST',
    token: BOOTSTRAP,
    body: { email: 'reader@example.com', scopes: 'viewer' },
  });
  const { body: redeemed } = await fetchJson(`${url}/invites/redeem`, {
    method: 'POST',
    body: { token: invite.token, password: 'a-perfectly-fine-password' },
  });

  await assert.rejects(
    fetchJson(`${url}/fleet/pause`, { method: 'POST', token: redeemed.token, body: {} }),
    (error) => error instanceof HttpError && error.status === 403,
  );

  // And an operator key can, without being an admin.
  const { body: opInvite } = await fetchJson(`${url}/invites`, {
    method: 'POST',
    token: BOOTSTRAP,
    body: { email: 'operator@example.com', scopes: 'operator' },
  });
  const { body: operator } = await fetchJson(`${url}/invites/redeem`, {
    method: 'POST',
    body: { token: opInvite.token, password: 'a-perfectly-fine-password' },
  });
  const { body: paused } = await fetchJson(`${url}/fleet/pause`, {
    method: 'POST',
    token: operator.token,
    body: { reason: 'from an operator key' },
  });
  assert.equal(paused.paused, true);
});

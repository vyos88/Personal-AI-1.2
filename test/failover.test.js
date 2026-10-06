// The fleet with the host switched off.
//
// A standby that runs Alpha on a laptop is only half an answer: the workers
// still dial the coordinator that is not there, so the fleet has an Alpha and
// nothing to run work on. These drive the other half — an agent that finds
// whichever coordinator is answering, and comes home to the primary by itself
// rather than quietly living on the laptop for a week.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createHost } from '../src/host/server.js';
import { TunnelAgent, normalizeHosts } from '../src/agent/agent.js';
import { fetchJson } from '../src/common/http.js';

const TOKEN = 'failover-token-that-is-long-enough';

async function startHost() {
  const host = createHost({ token: TOKEN });
  await new Promise((r) => host.server.listen(0, '127.0.0.1', r));
  return { ...host, url: `http://127.0.0.1:${host.server.address().port}` };
}

/** A port nothing is listening on: the coordinator that is switched off. */
async function deadUrl() {
  const host = await startHost();
  const { url } = host;
  await host.close();
  return url;
}

const agents = async (url) => (await fetchJson(`${url}/agents`, { token: TOKEN })).body.agents;

async function waitFor(what, predicate, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function makeAgent(hostUrls, options = {}) {
  return new TunnelAgent({
    hostUrls,
    token: TOKEN,
    name: 'laptop',
    pollWaitMs: 500,
    ...options,
  });
}

test('the host list is read primary-first, whichever way it is written', () => {
  assert.deepEqual(normalizeHosts('http://a:1/'), ['http://a:1']);
  assert.deepEqual(normalizeHosts('http://a:1, http://b:2/'), ['http://a:1', 'http://b:2']);
  assert.deepEqual(normalizeHosts(['http://a:1', 'http://a:1', '']), ['http://a:1']);
  assert.deepEqual(normalizeHosts(''), []);
  assert.deepEqual(normalizeHosts(undefined), []);
});

test('an agent works off the standby when the host is not answering', async (t) => {
  const primary = await deadUrl();
  const standby = await startHost();
  t.after(() => standby.close());

  const agent = makeAgent([primary, standby.url]);
  const running = agent.start();
  t.after(async () => {
    await agent.stop({ drainMs: 0 });
    await running;
  });

  await waitFor('the standby to have the laptop', async () => (await agents(standby.url)).length === 1);
  assert.equal(agent.hostUrl, standby.url);
  assert.equal(agent.onStandby, true);
});

test('the primary is preferred, and the standby left alone, while it is up', async (t) => {
  const primary = await startHost();
  const standby = await startHost();
  t.after(() => Promise.all([primary.close(), standby.close()]));

  const agent = makeAgent([primary.url, standby.url]);
  const running = agent.start();
  t.after(async () => {
    await agent.stop({ drainMs: 0 });
    await running;
  });

  await waitFor('the primary to have the laptop', async () => (await agents(primary.url)).length === 1);
  assert.equal(agent.onStandby, false);
  // The standby is not a second registration: one machine, one place.
  assert.deepEqual(await agents(standby.url), []);
});

test('an agent on a standby comes home when the primary answers again', async (t) => {
  // The primary's port, held so it can be started on the same address later —
  // the agent was configured with that URL and nothing tells it a new one.
  const placeholder = await startHost();
  const primaryUrl = placeholder.url;
  const port = placeholder.server.address().port;
  await placeholder.close();

  const standby = await startHost();
  t.after(() => standby.close());

  const agent = makeAgent([primaryUrl, standby.url], { primaryRecheckMs: 100 });
  const running = agent.start();
  t.after(async () => {
    await agent.stop({ drainMs: 0 });
    await running;
  });

  await waitFor('the standby to take it', async () => (await agents(standby.url)).length === 1);

  // The host comes back on its own address.
  const primary = createHost({ token: TOKEN });
  await new Promise((r) => primary.server.listen(port, '127.0.0.1', r));
  t.after(() => primary.close());

  await waitFor('the laptop to move back', async () => (await agents(primaryUrl)).length === 1, {
    timeoutMs: 20_000,
  });
  assert.equal(agent.onStandby, false);

  // And it let the standby go rather than leaving a registration behind that
  // lends the same RAM twice until the stale sweep.
  await waitFor('the standby to be released', async () => (await agents(standby.url)).length === 0);
});

test('a coordinator that answers and refuses is not failed over from', async (t) => {
  // A bad token says the same thing on the standby, and moving on would bury
  // the reason under a second, less useful error.
  const primary = await startHost();
  const standby = await startHost();
  t.after(() => Promise.all([primary.close(), standby.close()]));

  const agent = new TunnelAgent({
    hostUrls: [primary.url, standby.url],
    token: 'not-the-token-this-host-knows',
    name: 'laptop',
    pollWaitMs: 500,
  });

  await assert.rejects(agent.start(), (error) => error.status === 401);
  assert.deepEqual(await agents(standby.url), []);
});

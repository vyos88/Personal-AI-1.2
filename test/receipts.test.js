// A receipt one agent posts is otherwise invisible to the rest of the fleet:
// task results are private to whoever queued the task. This is the feed that
// closes that gap without the host ever reaching into an agent — every
// machine pulls what it missed on its own next heartbeat.
import test from 'node:test';
import assert from 'node:assert/strict';

import { ReceiptLog, sanitizeBroadcast } from '../src/host/receipts.js';
import { createHost } from '../src/host/server.js';
import { TunnelAgent } from '../src/agent/agent.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';
import { fetchJson } from '../src/common/http.js';

const TOKEN = 'test-token-that-is-long-enough';

async function startHost(options = {}) {
  const host = createHost({ token: TOKEN, ...options });
  await new Promise((resolve) => host.server.listen(0, '127.0.0.1', resolve));
  const { port } = host.server.address();
  return { ...host, url: `http://127.0.0.1:${port}` };
}

async function waitFor(what, predicate, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// -------------------------------------------------------------- the log itself

test('an agent attaching now hears nothing from before it existed', () => {
  const log = new ReceiptLog();
  log.push({ agentId: 'a1', agentName: 'host', type: 'echo', taskId: 't1', broadcast: { n: 1 } });

  log.attach('a2');
  assert.deepEqual(log.pull('a2'), []);

  log.push({ agentId: 'a1', agentName: 'host', type: 'echo', taskId: 't2', broadcast: { n: 2 } });
  const pulled = log.pull('a2');
  assert.equal(pulled.length, 1);
  assert.equal(pulled[0].taskId, 't2');
});

test('pulling twice in a row does not repeat what was already delivered', () => {
  const log = new ReceiptLog();
  log.attach('a1');
  log.push({ agentId: 'a2', agentName: 'laptop', type: 'echo', taskId: 't1', broadcast: { ok: true } });

  assert.equal(log.pull('a1').length, 1);
  assert.deepEqual(log.pull('a1'), []);
});

test('two agents each get their own place in the feed', () => {
  const log = new ReceiptLog();
  log.attach('a1');
  log.push({ agentId: 'x', agentName: 'x', type: 'echo', taskId: 't1', broadcast: { n: 1 } });
  log.attach('a2'); // attaches after the first push, so it should not see it
  log.push({ agentId: 'x', agentName: 'x', type: 'echo', taskId: 't2', broadcast: { n: 2 } });

  assert.deepEqual(log.pull('a1').map((e) => e.taskId), ['t1', 't2']);
  assert.deepEqual(log.pull('a2').map((e) => e.taskId), ['t2']);
});

test('an agent id nobody attached pulls nothing, rather than everything', () => {
  const log = new ReceiptLog();
  log.push({ agentId: 'x', agentName: 'x', type: 'echo', taskId: 't1', broadcast: { n: 1 } });
  assert.deepEqual(log.pull('never-attached'), []);
});

test('detaching forgets the cursor without disturbing anyone else\'s', () => {
  const log = new ReceiptLog();
  log.attach('a1');
  log.detach('a1');
  log.push({ agentId: 'x', agentName: 'x', type: 'echo', taskId: 't1', broadcast: {} });
  // Re-attaching after a push starts fresh at "now", same as any other agent.
  log.attach('a1');
  assert.deepEqual(log.pull('a1'), []);
});

test('the feed is bounded, so a quiet agent does not make it grow forever', () => {
  const log = new ReceiptLog({ limit: 3 });
  log.attach('a1');
  for (let i = 0; i < 10; i += 1) {
    log.push({ agentId: 'x', agentName: 'x', type: 'echo', taskId: `t${i}`, broadcast: { i } });
  }
  // Nothing throws, and what is still available is just whatever survived —
  // there is no gap error, only fewer entries than were actually posted.
  const pulled = log.pull('a1');
  assert.ok(pulled.length <= 3);
  assert.equal(pulled[pulled.length - 1].taskId, 't9');
});

// -------------------------------------------------------------- sanitization

test('a broadcast must be a plain, serializable object', () => {
  assert.equal(sanitizeBroadcast(undefined), null);
  assert.equal(sanitizeBroadcast(null), null);
  assert.equal(sanitizeBroadcast('a string'), null);
  assert.equal(sanitizeBroadcast(42), null);
  assert.equal(sanitizeBroadcast(['array']), null);

  const circular = {};
  circular.self = circular;
  assert.equal(sanitizeBroadcast(circular), null);

  assert.equal(sanitizeBroadcast({ big: 'x'.repeat(20_000) }), null);

  const clean = { actor: 'claude', message: 'receipt', paths: ['a.py'] };
  const sanitized = sanitizeBroadcast(clean);
  assert.deepEqual(sanitized, clean);
  assert.notEqual(sanitized, clean); // a clone, not the same reference
});

// -------------------------------------------------------------------- over HTTP

test('a receipt posted by one agent reaches another over its heartbeat', async (t) => {
  const host = await startHost({ heartbeatIntervalMs: 100 });
  t.after(() => host.close());

  const posterHandlers = new HandlerRegistry();
  posterHandlers.add({
    type: 'coord.post',
    async run() {
      return { broadcast: { message: 'work is claimed' } };
    },
  });
  const poster = new TunnelAgent({
    hostUrl: host.url,
    token: TOKEN,
    name: 'alpha-host',
    instanceId: 'inst_poster',
    handlers: posterHandlers,
    pollWaitMs: 250,
  });

  // `echo` is already built in — no need to add it.
  const listener = new TunnelAgent({
    hostUrl: host.url,
    token: TOKEN,
    name: 'laptop',
    instanceId: 'inst_listener',
    handlers: new HandlerRegistry(),
    pollWaitMs: 250,
  });

  const posterRun = poster.start();
  const listenerRun = listener.start();
  t.after(async () => {
    await Promise.all([poster.stop({ drainMs: 0 }), listener.stop({ drainMs: 0 })]);
    await Promise.all([posterRun, listenerRun]);
  });

  await waitFor('both agents to attach', async () => {
    const { body } = await fetchJson(`${host.url}/agents`, { token: TOKEN });
    return body.agents.length === 2;
  });

  const { body: task } = await fetchJson(`${host.url}/tasks`, {
    method: 'POST',
    token: TOKEN,
    body: { type: 'coord.post', payload: {} },
  });
  await waitFor('the receipt task to finish', async () => {
    const { body } = await fetchJson(`${host.url}/tasks/${task.id}`, { token: TOKEN });
    return body.status === 'succeeded';
  });

  // Delivered through the listener's own heartbeat, never pushed to it.
  await waitFor('the listener to log the fleet update', async () => host.receipts.since(0).length === 1);
  const { body: heartbeat } = await fetchJson(`${host.url}/agent/${listener.agentId}/heartbeat`, {
    method: 'POST',
    token: TOKEN,
    body: { memory: null, load: null },
  });
  assert.equal(heartbeat.broadcasts.length, 1);
  assert.equal(heartbeat.broadcasts[0].agentName, 'alpha-host');
  assert.equal(heartbeat.broadcasts[0].type, 'coord.post');
  assert.deepEqual(heartbeat.broadcasts[0].broadcast, { message: 'work is claimed' });
});

test('a task result with no broadcast field adds nothing to the feed', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  // `echo` is already built in — no need to add it.
  const agent = new TunnelAgent({
    hostUrl: host.url,
    token: TOKEN,
    name: 'laptop',
    instanceId: 'inst_quiet',
    handlers: new HandlerRegistry(),
    pollWaitMs: 250,
  });
  const run = agent.start();
  t.after(async () => {
    await agent.stop({ drainMs: 0 });
    await run;
  });

  await waitFor('the agent to attach', async () => {
    const { body } = await fetchJson(`${host.url}/agents`, { token: TOKEN });
    return body.agents.length === 1;
  });

  const { body: task } = await fetchJson(`${host.url}/tasks`, {
    method: 'POST',
    token: TOKEN,
    body: { type: 'echo', payload: { hello: 'world' } },
  });
  await waitFor('the task to finish', async () => {
    const { body } = await fetchJson(`${host.url}/tasks/${task.id}`, { token: TOKEN });
    return body.status === 'succeeded';
  });

  assert.equal(host.receipts.since(0).length, 0);
});

test('a failed task never reaches the feed, even if it names a broadcast', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  const handlers = new HandlerRegistry();
  handlers.add({
    type: 'fails',
    async run() {
      throw new Error('nope');
    },
  });
  const agent = new TunnelAgent({
    hostUrl: host.url,
    token: TOKEN,
    name: 'laptop',
    instanceId: 'inst_failer',
    handlers,
    pollWaitMs: 250,
  });
  const run = agent.start();
  t.after(async () => {
    await agent.stop({ drainMs: 0 });
    await run;
  });

  await waitFor('the agent to attach', async () => {
    const { body } = await fetchJson(`${host.url}/agents`, { token: TOKEN });
    return body.agents.length === 1;
  });

  const { body: task } = await fetchJson(`${host.url}/tasks`, {
    method: 'POST',
    token: TOKEN,
    body: { type: 'fails', payload: {}, maxAttempts: 1 },
  });
  await waitFor('the task to fail', async () => {
    const { body } = await fetchJson(`${host.url}/tasks/${task.id}`, { token: TOKEN });
    return body.status === 'failed';
  });

  assert.equal(host.receipts.since(0).length, 0);
});

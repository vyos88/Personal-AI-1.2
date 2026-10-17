import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';

import { createHost } from '../src/host/server.js';
import { TaskQueue } from '../src/host/queue.js';
import { TaskJournal, MAX_KEPT_BYTES, toRecord } from '../src/host/journal.js';
import { TunnelAgent } from '../src/agent/agent.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';
import * as echo from '../src/agent/handlers/echo.js';
import { fetchJson, HttpError } from '../src/common/http.js';
import { TaskStatus } from '../src/common/protocol.js';

const TOKEN = 'test-token-that-is-long-enough';
const IDLE_LOAD = { snapshot: () => ({ cpus: 1, busy: 0, loadAverage1: 0, loadFactor: 0 }) };

async function journalPath() {
  return join(await mkdtemp(join(tmpdir(), 'alpha-journal-')), 'tasks.json');
}

/** A coordinator on `port` (0 for any), writing its queue to `path`. */
async function startHost({ path, port = 0, ...options }) {
  const host = createHost({ token: TOKEN, journal: new TaskJournal({ path }), ...options });
  await host.ready;
  await new Promise((resolve) => host.server.listen(port, '127.0.0.1', resolve));
  const bound = host.server.address().port;
  return { ...host, port: bound, url: `http://127.0.0.1:${bound}` };
}

function enqueue(url, body) {
  return fetchJson(`${url}/tasks`, { method: 'POST', token: TOKEN, body });
}

async function getTask(url, id) {
  return (await fetchJson(`${url}/tasks/${id}`, { token: TOKEN })).body;
}

async function waitFor(check, { timeoutMs = 10_000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function agentOn(url, handlers, options = {}) {
  return new TunnelAgent({
    loadSampler: IDLE_LOAD,
    hostUrl: url,
    token: TOKEN,
    name: 'journal-agent',
    instanceId: `journal-${Math.random()}`,
    pollWaitMs: 500,
    handlers: new HandlerRegistry(handlers),
    ...options,
  });
}

test('a queued task survives a coordinator restart and runs on the new one', async (t) => {
  const path = await journalPath();

  const first = await startHost({ path });
  const { body: created } = await enqueue(first.url, { type: 'echo', payload: { track: 'night drive' } });
  assert.equal(created.status, TaskStatus.QUEUED);
  await first.close();

  const second = await startHost({ path });
  const agent = agentOn(second.url, [echo]);
  const running = agent.start();
  t.after(async () => {
    await agent.stop();
    await running;
    await second.close();
  });

  const finished = await waitFor(async () => {
    const task = await getTask(second.url, created.id);
    return task.status === TaskStatus.SUCCEEDED && task;
  }, { what: 'the restored task to run' });
  assert.deepEqual(finished.result.echoed, { track: 'night drive' });
  assert.equal(finished.attempts, 1);
});

test('a leased task is requeued by a restart, and the late result from its old lease is refused', async (t) => {
  const path = await journalPath();

  // The first run holds until released, so the task is leased across the
  // restart; every run after that returns at once.
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let runs = 0;
  const hold = {
    type: 'hold',
    async run() {
      runs += 1;
      const run = runs;
      if (run === 1) await gate;
      return { run };
    },
  };

  const first = await startHost({ path, heartbeatIntervalMs: 50 });
  const agent = agentOn(first.url, [hold]);
  const running = agent.start();
  let second = null;
  t.after(async () => {
    release();
    await agent.stop();
    await running;
    await second?.close();
  });

  const { body: created } = await enqueue(first.url, { type: 'hold', maxAttempts: 3 });
  const leased = await waitFor(async () => {
    const task = await getTask(first.url, created.id);
    return task.status === TaskStatus.LEASED && task;
  }, { what: 'the task to be leased' });
  const oldAgentId = leased.agentId;

  // Same port, so the agent that is still running finds the new process.
  await first.close();
  second = await startHost({ path, port: first.port, heartbeatIntervalMs: 50 });

  const restored = await getTask(second.url, created.id);
  assert.equal(restored.status, TaskStatus.QUEUED);
  assert.equal(restored.attempts, 1, 'the attempt the old lease took stays spent');
  assert.equal(restored.agentId, null);

  // The registration the old lease belonged to died with the old process.
  await assert.rejects(
    fetchJson(`${second.url}/agent/${oldAgentId}/tasks/${created.id}/result`, {
      method: 'POST',
      token: TOKEN,
      body: { ok: true, result: { run: 'stale' } },
    }),
    (error) => error instanceof HttpError && error.status === 410,
  );

  // Let the straggler finish: its report has nowhere to land, and the same
  // agent re-registers and runs the task again.
  release();
  const finished = await waitFor(async () => {
    const task = await getTask(second.url, created.id);
    return task.status === TaskStatus.SUCCEEDED && task;
  }, { what: 'the requeued task to run again' });
  assert.equal(finished.result.run, 2);
  assert.equal(finished.attempts, 2);
});

test('a leased task with no attempts left fails on restore and gets its receipt', async () => {
  const path = await journalPath();
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      tasks: [
        {
          id: 'task_spent',
          type: 'echo',
          payload: {},
          status: TaskStatus.LEASED,
          attempts: 1,
          maxAttempts: 1,
          agentId: 'agent_gone',
          createdAt: Date.now() - 1_000,
          leasedAt: Date.now() - 500,
          leaseExpiresAt: Date.now() + 60_000,
        },
      ],
    }),
  );

  const host = await startHost({ path });
  try {
    const task = await getTask(host.url, 'task_spent');
    assert.equal(task.status, TaskStatus.FAILED);
    assert.equal(task.error.code, 'coordinator_restarted');
    assert.equal(host.receipts.list()[0]?.id, 'task_spent');
  } finally {
    await host.close();
  }
});

test('finished tasks come back with small results kept and bulky ones trimmed', async () => {
  const path = await journalPath();
  const first = await startHost({ path });
  const queue = first.queue;

  const small = queue.enqueue({ type: 'echo', payload: {}, leaseMs: 60_000, maxAttempts: 1 });
  const bulky = queue.enqueue({ type: 'echo', payload: {}, leaseMs: 60_000, maxAttempts: 1 });
  for (const task of [small, bulky]) {
    const leased = await queue.lease({ agentId: 'agent_a', capabilities: ['echo'], waitMs: 0 });
    assert.equal(leased.id, task.id);
  }
  queue.complete(small.id, 'agent_a', { outputs: [{ name: 'a.wav', bytes: 10 }] });
  queue.complete(bulky.id, 'agent_a', {
    outputs: [{ name: 'b.wav', bytes: 2_000_000 }],
    data: 'A'.repeat(MAX_KEPT_BYTES * 4),
  });
  await first.close();

  const raw = await readFile(path, 'utf8');
  assert.ok(raw.length < MAX_KEPT_BYTES * 2, 'the bulky result body never reached disk');

  const second = await startHost({ path });
  try {
    const keptSmall = await getTask(second.url, small.id);
    assert.equal(keptSmall.status, TaskStatus.SUCCEEDED);
    assert.deepEqual(keptSmall.result, { outputs: [{ name: 'a.wav', bytes: 10 }] });

    const keptBulky = await getTask(second.url, bulky.id);
    assert.equal(keptBulky.status, TaskStatus.SUCCEEDED);
    assert.equal(keptBulky.result.data, undefined);
    assert.deepEqual(keptBulky.result.outputs, [{ name: 'b.wav', path: null, bytes: 2_000_000 }]);
  } finally {
    await second.close();
  }
});

test('a task carrying a credential is never written down', async () => {
  const path = await journalPath();
  const host = await startHost({ path });
  host.queue.enqueue({
    type: 'alpha.panel',
    payload: { action: 'Provision', ssid: 'home', password: 'hunter2-hunter2' },
    leaseMs: 60_000,
    maxAttempts: 1,
  });
  host.queue.enqueue({ type: 'alpha.music', payload: { key: 'A minor' }, leaseMs: 60_000, maxAttempts: 1 });
  await host.close();

  const raw = await readFile(path, 'utf8');
  assert.ok(!raw.includes('hunter2'));
  assert.ok(raw.includes('A minor'), 'a musical key is not a secret');
  assert.equal(toRecord({ status: 'queued', payload: { nested: { apiKey: 'x' } } }), null);
});

test('finished tasks past retention are dropped on restore, so the file stays bounded', async () => {
  const path = await journalPath();
  let clock = 1_000_000;
  const now = () => clock;

  const journal = new TaskJournal({ path });
  const queue = new TaskQueue({ now, maxFinished: 2, onChange: () => journal.schedule(() => queue.snapshot()) });
  for (let i = 0; i < 4; i++) {
    const task = queue.enqueue({ type: 'echo', payload: { i }, leaseMs: 60_000, maxAttempts: 1 });
    await queue.lease({ agentId: 'agent_a', capabilities: ['echo'], waitMs: 0 });
    clock += 1;
    queue.complete(task.id, 'agent_a', { i });
  }
  await journal.flush();
  const written = JSON.parse(await readFile(path, 'utf8')).tasks;
  assert.equal(written.length, 2, 'the cap applies to what is written, not just what is held');

  const restored = new TaskQueue({ now, finishedRetentionMs: 0 });
  restored.restore(written);
  assert.equal(restored.stats().total, 0, 'expired while the host was down');
});

test('an unreadable journal is moved aside and the host starts with an empty queue', async () => {
  const path = await journalPath();
  await writeFile(path, '{ not json');
  const host = await startHost({ path });
  try {
    assert.equal(host.queue.stats().total, 0);
    const files = await readdir(join(path, '..'));
    assert.ok(files.some((name) => name.startsWith('tasks.json.corrupt-')));
  } finally {
    await host.close();
  }
});

test('ALPHA_TASK_JOURNAL=off keeps nothing', () => {
  assert.equal(new TaskJournal({ path: 'off' }).persistent, false);
  assert.equal(new TaskJournal({ path: null }).persistent, false);
});

/** Collects what the logger writes while `fn` runs. */
function captureLogs() {
  const lines = [];
  const originals = { out: process.stdout.write, err: process.stderr.write };
  const tap = (original) =>
    function (chunk, ...rest) {
      lines.push(String(chunk));
      return original.call(this, chunk, ...rest);
    };
  process.stdout.write = tap(originals.out);
  process.stderr.write = tap(originals.err);
  return {
    lines,
    restore() {
      process.stdout.write = originals.out;
      process.stderr.write = originals.err;
    },
  };
}

test('an agent warns once when heartbeats stop being answered, and says when they are again', async (t) => {
  const path = await journalPath();
  const first = await startHost({ path, heartbeatIntervalMs: 40 });
  const agent = agentOn(first.url, [echo], { heartbeatWarnAfter: 3 });
  const logs = captureLogs();
  const running = agent.start();
  let second = null;
  t.after(async () => {
    logs.restore();
    await agent.stop();
    await running;
    await second?.close();
  });

  await waitFor(() => agent.agentId, { what: 'registration' });
  await first.close();

  await waitFor(() => agent.heartbeatFailures >= 5, { what: 'heartbeats to go unanswered' });
  const lost = logs.lines.filter((line) => line.includes('heartbeats are not being answered'));
  assert.equal(lost.length, 1, 'warned once, not on every beat');
  assert.match(lost[0], /WARN/);

  second = await startHost({ path, port: first.port, heartbeatIntervalMs: 40 });
  await waitFor(() => agent.heartbeatFailures === 0, { what: 'heartbeats to be answered again' });
  await waitFor(
    () => logs.lines.some((line) => line.includes('coordinator is answering heartbeats again')),
    { what: 'the recovery to be logged' },
  );
  logs.restore();
});

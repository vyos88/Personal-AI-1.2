// The record that outlives the queue.
//
// The task queue is one in-memory Map, on purpose — but that meant the answer
// to "how many renders ran last night, and which species came back" died with
// it at every restart. Terminal tasks are now appended to a ledger that
// persists, which is what makes a morning-after report possible at all.
//
// The ledger is deliberately the expendable half of the pair: it must never
// cost a task that succeeded, and it must never stop the host from starting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReceiptStore, summarizeResult } from '../src/host/receipts.js';
import { TaskQueue } from '../src/host/queue.js';
import { createHost } from '../src/host/server.js';
import { AuthService } from '../src/host/auth/service.js';
import { AuthStore } from '../src/host/auth/store.js';
import { fetchJson } from '../src/common/http.js';
import { TaskStatus } from '../src/common/protocol.js';

const TOKEN = 'test-token-that-is-long-enough';

const finished = (over = {}) => ({
  id: 'task_abc',
  type: 'alpha.render',
  status: TaskStatus.SUCCEEDED,
  agentId: 'agent_1',
  attempts: 1,
  declines: 0,
  createdAt: 1_000,
  finishedAt: 4_000,
  error: null,
  result: null,
  ...over,
});

const tempDir = () => mkdtemp(join(tmpdir(), 'alpha-receipts-'));

test('a finished render is recorded with its recipe and where the image landed', async () => {
  const store = new ReceiptStore({ path: null });
  await store.load();

  const receipt = store.record(
    finished({
      result: {
        recipe: { species: 'fern', seed: 7 },
        outputs: [{ name: 'fern_7.png', path: '/out/fern_7.png', bytes: 191_234_567 }],
        renderedInMs: 41_200,
      },
    }),
    { agentName: 'alpha-host' },
  );

  assert.equal(receipt.status, 'succeeded');
  assert.equal(receipt.agent, 'alpha-host');
  assert.equal(receipt.durationMs, 3_000);
  assert.deepEqual(receipt.recipe, { species: 'fern', seed: 7 });
  assert.equal(receipt.outputs[0].bytes, 191_234_567);
  assert.equal(receipt.renderedInMs, 41_200);
});

// A render returns up to 8 KB of stdout and 8 KB of stderr. Keeping that per
// receipt is megabytes a day of Blender chatter in a file meant to be read.
test('Blender chatter is dropped rather than stored forever', () => {
  const summarized = summarizeResult({
    recipe: { species: 'beetle', seed: 1 },
    outputs: [{ name: 'beetle_1.png', path: '/out/beetle_1.png', bytes: 10 }],
    stdout: 'x'.repeat(8_000),
    stderr: 'y'.repeat(8_000),
  });

  assert.ok(summarized.recipe);
  assert.ok(summarized.outputs);
  assert.equal(summarized.stdout, undefined);
  assert.equal(summarized.stderr, undefined);
});

test('a task still running is not a receipt', async () => {
  const store = new ReceiptStore({ path: null });
  await store.load();

  assert.equal(store.record(finished({ status: TaskStatus.LEASED })), null);
  assert.equal(store.record(finished({ status: TaskStatus.QUEUED })), null);
  assert.equal(store.size, 0);
});

test('a permanent failure is recorded, with why', async () => {
  const store = new ReceiptStore({ path: null });
  await store.load();

  const receipt = store.record(
    finished({
      status: TaskStatus.FAILED,
      error: { message: 'Blender exited 1', code: 'render_failed' },
    }),
  );

  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.error.code, 'render_failed');
});

test('the ledger is bounded, and drops the oldest first', async () => {
  const store = new ReceiptStore({ path: null, maxReceipts: 3 });
  await store.load();

  for (let i = 0; i < 5; i += 1) store.record(finished({ id: `task_${i}` }));

  assert.equal(store.size, 3);
  // Newest first.
  assert.deepEqual(
    store.list().map((r) => r.id),
    ['task_4', 'task_3', 'task_2'],
  );
});

test('the summary is the proof-of-work answer: how many, which species, which machine', async () => {
  const store = new ReceiptStore({ path: null });
  await store.load();

  store.record(
    finished({
      id: 'a',
      result: { recipe: { species: 'fern', seed: 0 }, outputs: [{ name: 'f.png', bytes: 100 }] },
    }),
    { agentName: 'alpha-host' },
  );
  store.record(
    finished({
      id: 'b',
      result: { recipe: { species: 'fern', seed: 1 }, outputs: [{ name: 'f1.png', bytes: 200 }] },
    }),
    { agentName: 'alpha-host' },
  );
  store.record(finished({ id: 'c', status: TaskStatus.FAILED }), { agentName: 'laptop' });

  const summary = store.summary();
  assert.equal(summary.total, 3);
  assert.equal(summary.byStatus.succeeded, 2);
  assert.equal(summary.byStatus.failed, 1);
  assert.equal(summary.species.fern, 2);
  assert.equal(summary.machines['alpha-host'], 2);
  assert.equal(summary.outputs, 2);
  assert.equal(summary.bytes, 300);
});

test('a species with no renders is absent rather than zero', async () => {
  const store = new ReceiptStore({ path: null });
  await store.load();
  store.record(finished({ status: TaskStatus.FAILED }));

  assert.deepEqual(store.summary().species, {});
});

test('the record survives the restart that empties the queue', async () => {
  const dir = await tempDir();
  const path = join(dir, 'receipts.json');

  const first = new ReceiptStore({ path });
  await first.load();
  first.record(finished({ result: { recipe: { species: 'kelp', seed: 3 } } }), {
    agentName: 'alpha-host',
  });
  await first.save();

  const second = new ReceiptStore({ path });
  await second.load();

  assert.equal(second.size, 1);
  assert.deepEqual(second.list()[0].recipe, { species: 'kelp', seed: 3 });
});

// AuthStore refuses to start on a corrupt file, because overwriting
// credentials silently un-revokes access. Receipts are the opposite trade:
// blocking the coordinator over a damaged history file is worse than losing
// the history — but the damaged file is kept, not deleted.
test('a corrupt ledger is moved aside rather than stopping the host', async () => {
  const dir = await tempDir();
  const path = join(dir, 'receipts.json');
  await writeFile(path, '{ this is not json');

  const store = new ReceiptStore({ path });
  await store.load();

  assert.equal(store.size, 0);
  const left = await readdir(dir);
  assert.ok(
    left.some((name) => name.includes('.corrupt-')),
    `expected the damaged file to be kept, saw ${left.join(', ')}`,
  );
});

// The half that must never cost real work: a full disk is a lost receipt, not
// a re-run of a render that already succeeded.
test('a ledger that throws does not fail the task that succeeded', () => {
  const queue = new TaskQueue({
    onTerminal: () => {
      throw new Error('disk full');
    },
  });
  const task = queue.enqueue({ type: 'echo', payload: {}, leaseMs: 1_000, maxAttempts: 1 });
  queue.lease({ agentId: 'agent_1', capabilities: ['echo'], waitMs: 0 });

  const done = queue.complete(task.id, task.agentId, { ok: true });
  assert.equal(done.status, TaskStatus.SUCCEEDED);
});

test('every terminal route reaches the ledger, including cancel', () => {
  const recorded = [];
  const queue = new TaskQueue({ onTerminal: (task) => recorded.push(task.status) });

  const cancelled = queue.enqueue({ type: 'echo', payload: {}, leaseMs: 1_000, maxAttempts: 1 });
  queue.cancel(cancelled.id);

  const failed = queue.enqueue({ type: 'echo', payload: {}, leaseMs: 1_000, maxAttempts: 1 });
  queue.lease({ agentId: 'agent_1', capabilities: ['echo'], waitMs: 0 });
  queue.fail(failed.id, failed.agentId, new Error('nope'));

  assert.deepEqual(recorded.sort(), ['cancelled', 'failed']);
});

test('/receipts and /receipts/summary answer what the fleet has done', async () => {
  const host = createHost({ token: TOKEN });
  await new Promise((resolve) => host.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${host.server.address().port}`;

  try {
    const task = host.queue.enqueue({
      type: 'echo',
      payload: {},
      leaseMs: 1_000,
      maxAttempts: 1,
    });
    host.queue.lease({ agentId: 'agent_1', capabilities: ['echo'], waitMs: 0 });
    host.queue.complete(task.id, task.agentId, { recipe: { species: 'tree', seed: 2 } });

    const listed = await fetchJson(`${url}/receipts`, { token: TOKEN });
    assert.equal(listed.body.receipts.length, 1);
    assert.deepEqual(listed.body.receipts[0].recipe, { species: 'tree', seed: 2 });

    const summary = await fetchJson(`${url}/receipts/summary`, { token: TOKEN });
    assert.equal(summary.body.total, 1);
    assert.equal(summary.body.species.tree, 1);
  } finally {
    await host.close();
  }
});

test('/receipts needs tasks:read', async () => {
  const host = createHost({ token: TOKEN });
  await new Promise((resolve) => host.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${host.server.address().port}`;

  try {
    await assert.rejects(
      () => fetchJson(`${url}/receipts`, { token: 'not-a-real-token' }),
      (error) => error.status === 401 || error.status === 403,
    );
  } finally {
    await host.close();
  }
});

// The regression this pins: the ledger defaulted to the real ./data path for
// every host, so `npm test` wrote kilobytes of fabricated receipts into the
// one file a person would later read as history.
test('an ephemeral host keeps an ephemeral ledger', async () => {
  const host = createHost({ token: TOKEN });
  assert.equal(host.receipts.persistent, false);

  const auth = new AuthService({
    store: new AuthStore({ path: null }),
    bootstrapToken: TOKEN,
  });
  await auth.load();
  assert.equal(createHost({ auth }).receipts.persistent, false);
});

test('a host with real credentials keeps a real ledger', async () => {
  const dir = await tempDir();
  const auth = new AuthService({
    store: new AuthStore({ path: join(dir, 'auth.json') }),
    bootstrapToken: TOKEN,
  });
  await auth.load();

  assert.equal(createHost({ auth }).receipts.persistent, true);
});

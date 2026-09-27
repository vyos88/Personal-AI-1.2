// The scheduled half: approve, queue, continue, report.
//
// run-jobs queues a batch and waits. That is right for a person and wrong for
// a loop: a loop must not re-render the seeds it rendered last pass, must not
// fill a disk while nobody watches, and must not still be running when the
// next pass starts. These are the three things this adds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { approve, nextSeedFor, parseDuration, parseList } from '../scripts/alpha-manager.mjs';
import { createHost } from '../src/host/server.js';
import { TaskStatus } from '../src/common/protocol.js';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const MANAGER = join(HERE, '..', 'scripts', 'alpha-manager.mjs');
const TOKEN = 'test-token-that-is-long-enough';

const recipe = (species, seed) => ({ recipe: { species, seed } });

test('durations parse, and a nonsense one throws rather than meaning "everything"', () => {
  assert.equal(parseDuration('90m'), 90 * 60_000);
  assert.equal(parseDuration('24h'), 24 * 3_600_000);
  assert.equal(parseDuration('7d'), 7 * 86_400_000);

  // A quota window that silently became Infinity is not a quota.
  assert.throws(() => parseDuration('soon'), /duration must be/);
  assert.throws(() => parseDuration(''), /duration must be/);
  assert.throws(() => parseDuration('24'), /duration must be/);
});

test('lists tolerate the spacing people actually type', () => {
  assert.deepEqual(parseList('fern, beetle ,kelp'), ['fern', 'beetle', 'kelp']);
  assert.deepEqual(parseList(''), []);
  assert.deepEqual(parseList(undefined), []);
});

// The bug a scheduled loop built on `run-jobs --seed 0` has: every pass
// re-renders seeds 0..n. Recipes are reproducible, which is exactly why a
// fixed start is wrong for a loop.
test('seeds continue from the ledger instead of repeating', () => {
  const receipts = [recipe('fern', 0), recipe('fern', 3), recipe('fern', 1)];
  assert.equal(nextSeedFor(receipts, 'fern'), 4);
});

test('seeds are counted per species, not shared', () => {
  const receipts = [recipe('fern', 9), recipe('beetle', 2)];
  assert.equal(nextSeedFor(receipts, 'fern'), 10);
  assert.equal(nextSeedFor(receipts, 'beetle'), 3);
  // Never rendered: start at the beginning.
  assert.equal(nextSeedFor(receipts, 'kelp'), 0);
});

// Its seed was spent. Re-issuing it re-runs work that already failed, usually
// for a reason that has not changed since.
test('a failed render still consumes its seed', () => {
  const receipts = [{ status: 'failed', ...recipe('fern', 5) }];
  assert.equal(nextSeedFor(receipts, 'fern'), 6);
});

test('receipts without a recipe do not disturb the count', () => {
  const receipts = [{ status: 'succeeded' }, { recipe: null }, recipe('fern', 2)];
  assert.equal(nextSeedFor(receipts, 'fern'), 3);
});

test('an allowlist refuses the species that is not on it', () => {
  const verdict = approve({ species: ['fern', 'dragon'], count: 2, allow: ['fern', 'beetle'] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /dragon/);
});

test('no allowlist means any well-formed species passes the gate', () => {
  assert.equal(approve({ species: ['anything'], count: 1 }).ok, true);
});

test('the quota refuses a pass once the window is full', () => {
  const verdict = approve({ species: ['fern'], count: 1, maxPerWindow: 40, recentCount: 40 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /quota reached/);
});

// "I rendered some of what you asked" is a worse answer for an unattended job
// than "I rendered none, and here is why".
test('a pass that would overrun the quota is refused whole, not trimmed', () => {
  const verdict = approve({ species: ['fern'], count: 10, maxPerWindow: 40, recentCount: 35 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /room for 5 not 10/);
});

test('a pass that fits is approved', () => {
  assert.equal(approve({ species: ['fern'], count: 5, maxPerWindow: 40, recentCount: 35 }).ok, true);
});

test('no species is a refusal, not an empty batch', () => {
  assert.equal(approve({ species: [], count: 1 }).ok, false);
});

/* ── Against a real host ─────────────────────────────────────────────────── */

async function startHost() {
  const host = createHost({ token: TOKEN });
  await new Promise((resolve) => host.server.listen(0, '127.0.0.1', resolve));
  return { ...host, url: `http://127.0.0.1:${host.server.address().port}` };
}

const env = (url) => ({
  ...process.env,
  ALPHA_HOST_URL: url,
  ALPHA_ADMIN_TOKEN: TOKEN,
  // .env beside the checkout must not leak a real host into the test.
  ALPHA_BOOTSTRAP_TOKEN: TOKEN,
});

test('render --dry-run says what it would queue and queues nothing', async () => {
  const host = await startHost();
  try {
    const { stdout } = await run(
      process.execPath,
      [MANAGER, 'render', '--species', 'fern,beetle', '--count', '4', '--dry-run'],
      { env: env(host.url) },
    );

    assert.match(stdout, /Approved 4 render/);
    assert.match(stdout, /fern\/0/);
    assert.match(stdout, /beetle\/0/);
    assert.match(stdout, /fern\/1/);
    assert.equal(host.queue.stats().total, 0, 'dry run must not queue anything');
  } finally {
    await host.close();
  }
});

test('render queues real tasks and does not wait for them', async () => {
  const host = await startHost();
  try {
    const { stdout } = await run(
      process.execPath,
      [MANAGER, 'render', '--species', 'fern', '--count', '2', '--agent', 'alpha-host'],
      { env: env(host.url) },
    );

    assert.match(stdout, /Queued 2/);
    assert.match(stdout, /Not waiting/);

    const queued = host.queue.list({});
    assert.equal(queued.length, 2);
    assert.equal(queued[0].type, 'alpha.render');
    assert.equal(queued[0].targetAgent, 'alpha-host');
    // A render needs a lease that covers it, not the 60s default.
    assert.equal(queued[0].leaseMs, 900_000);
    assert.deepEqual(
      queued.map((t) => t.payload.seed).sort(),
      [0, 1],
    );
  } finally {
    await host.close();
  }
});

test('a second pass continues the seeds rather than repeating them', async () => {
  const host = await startHost();
  try {
    // A finished render from an earlier pass, recorded the way a real one is.
    const task = host.queue.enqueue({
      type: 'alpha.render',
      payload: { species: 'fern', seed: 0 },
      leaseMs: 1_000,
      maxAttempts: 1,
    });
    host.queue.lease({ agentId: 'agent_1', capabilities: ['alpha.render'], waitMs: 0 });
    host.queue.complete(task.id, task.agentId, {
      recipe: { species: 'fern', seed: 0 },
      outputs: [{ name: 'fern_0.png', path: '/out/fern_0.png', bytes: 100 }],
    });

    const { stdout } = await run(
      process.execPath,
      [MANAGER, 'render', '--species', 'fern', '--count', '1', '--dry-run'],
      { env: env(host.url) },
    );

    assert.match(stdout, /fern\/1/, 'should continue from the recorded seed 0');
    assert.doesNotMatch(stdout, /fern\/0/);
  } finally {
    await host.close();
  }
});

test('the quota refuses the pass over a real ledger, and exits non-zero', async () => {
  const host = await startHost();
  try {
    const task = host.queue.enqueue({
      type: 'alpha.render',
      payload: { species: 'fern', seed: 0 },
      leaseMs: 1_000,
      maxAttempts: 1,
    });
    host.queue.lease({ agentId: 'agent_1', capabilities: ['alpha.render'], waitMs: 0 });
    host.queue.complete(task.id, task.agentId, recipe('fern', 0));

    await assert.rejects(
      () =>
        run(
          process.execPath,
          [MANAGER, 'render', '--species', 'fern', '--count', '1', '--max-per-window', '1'],
          { env: env(host.url) },
        ),
      (error) => {
        assert.equal(error.code, 3);
        assert.match(error.stdout, /Refused.*quota reached/s);
        return true;
      },
    );
    assert.equal(host.queue.stats().byStatus[TaskStatus.QUEUED] ?? 0, 0);
  } finally {
    await host.close();
  }
});

test('report reads the ledger, not the run', async () => {
  const host = await startHost();
  try {
    const task = host.queue.enqueue({
      type: 'alpha.render',
      payload: { species: 'kelp', seed: 4 },
      leaseMs: 1_000,
      maxAttempts: 1,
    });
    host.queue.lease({ agentId: 'agent_1', capabilities: ['alpha.render'], waitMs: 0 });
    host.queue.complete(task.id, task.agentId, {
      recipe: { species: 'kelp', seed: 4 },
      outputs: [{ name: 'kelp_4.png', path: '/out/kelp/kelp_4.png', bytes: 2 * 1024 * 1024 }],
    });

    const { stdout } = await run(process.execPath, [MANAGER, 'report'], { env: env(host.url) });
    assert.match(stdout, /Tasks finished\s+1/);
    assert.match(stdout, /Images produced\s+1/);
    assert.match(stdout, /2\.0 MB/);
    assert.match(stdout, /kelp\s+1/);
  } finally {
    await host.close();
  }
});

// An empty ledger is not the same claim as "nothing was ever rendered", and
// saying so is the difference between a report and a wrong report.
test('an empty report says why it might be empty', async () => {
  const host = await startHost();
  try {
    const { stdout } = await run(process.execPath, [MANAGER, 'report'], { env: env(host.url) });
    assert.match(stdout, /Nothing recorded yet/);
    assert.match(stdout, /never written down/);
  } finally {
    await host.close();
  }
});

/* ── inventory, end to end ───────────────────────────────────────────────── */

// The whole point of the handler: `report` reads what the host was told,
// `inventory` reads what is really on the machine's disk. A fleet whose ledger
// is younger than its renders needs the second one to count the first.
test('inventory reports the images a real agent finds on disk', async (t) => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { TunnelAgent } = await import('../src/agent/agent.js');
  const { HandlerRegistry } = await import('../src/agent/handlers/index.js');
  const inventory = await import('../src/agent/handlers/alpha-render-inventory.js');

  const renderRoot = await mkdtemp(join(tmpdir(), 'alpha-mgr-inv-'));
  await mkdir(join(renderRoot, 'output', 'fern'), { recursive: true });
  await mkdir(join(renderRoot, 'output', 'beetle'), { recursive: true });
  await writeFile(join(renderRoot, 'output', 'fern', 'fern_0.png'), 'x'.repeat(2048));
  await writeFile(join(renderRoot, 'output', 'fern', 'fern_1.png'), 'x'.repeat(1024));
  await writeFile(join(renderRoot, 'output', 'beetle', 'beetle_0.png'), 'x'.repeat(512));
  // Predates filing by species — the back catalogue.
  await writeFile(join(renderRoot, 'output', 'legacy.png'), 'x'.repeat(256));

  const before = { ...process.env };
  process.env.ALPHA_RENDER_ROOT = renderRoot;
  delete process.env.ALPHA_RENDER_OUTPUT;

  const host = await startHost();
  const agent = new TunnelAgent({
    hostUrl: host.url,
    token: TOKEN,
    name: 'render-box',
    instanceId: 'inst_render_box',
    handlers: new HandlerRegistry([inventory]),
    pollWaitMs: 500,
  });
  // start() is the run loop, not a handshake: awaiting it here waits forever.
  const running = agent.start();

  t.after(async () => {
    process.env = before;
    await agent.stop({ drainMs: 0 });
    await running;
    await host.close();
    await rm(renderRoot, { recursive: true, force: true });
  });

  const { fetchJson } = await import('../src/common/http.js');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { body } = await fetchJson(`${host.url}/agents`, { token: TOKEN });
    if (body.agents.length === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const { stdout } = await run(
    process.execPath,
    [MANAGER, 'inventory', '--agent', 'render-box'],
    { env: { ...env(host.url), ALPHA_RENDER_ROOT: renderRoot } },
  );

  assert.match(stdout, /Images\s+4/);
  assert.match(stdout, /fern\s+2/);
  assert.match(stdout, /beetle\s+1/);
  assert.match(stdout, /\(unfiled\)\s+1/);
  assert.match(stdout, /rendered before images were filed by species/);
  // The ledger is empty and the disk is not: say so rather than let the two
  // numbers quietly disagree.
  assert.match(stdout, /the host ledger records 0 image\(s\), the disk holds 4/);
});

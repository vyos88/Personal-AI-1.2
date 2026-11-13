// Owner policy 2026-11-07: GPU targets are always-available with zero idle
// timeout. The laptop GPU runner refused idle_seconds 0 and would not start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHost } from '../src/host/server.js';
import { fetchJson } from '../src/common/http.js';
import { runGpuDemand } from '../src/agent/gpu-demand.js';
import { ownerGpuIdleMs } from '../src/agent/execution-policy.js';

test('always-available with zero idle means no idle teardown', () => {
  assert.equal(ownerGpuIdleMs({ gpu_mode: 'always-available', idle_seconds: 0 }), Infinity);
  assert.equal(Number(String(Infinity)), Infinity); // survives ALPHA_GPU_IDLE_MS
});

test('a positive idle keeps the timed teardown; anything else is refused', () => {
  assert.equal(ownerGpuIdleMs({ gpu_mode: 'queued-demand', idle_seconds: 30 }), 30_000);
  assert.equal(ownerGpuIdleMs({ idle_seconds: 30 }), 30_000);
  assert.throws(() => ownerGpuIdleMs({ gpu_mode: 'queued-demand', idle_seconds: 0 }), /idle policy is invalid/);
  assert.throws(() => ownerGpuIdleMs({ idle_seconds: -1 }), /idle policy is invalid/);
  assert.throws(() => ownerGpuIdleMs({ gpu_mode: 'always-available', idle_seconds: 30 }), /requires idle_seconds 0/);
});

test('an always-available worker stays registered after its job until aborted', async (t) => {
  const token = 'gpu-zero-idle-test-token-long-enough';
  const host = createHost({ token });
  await host.listen({ port: 0, binds: ['127.0.0.1'] });
  t.after(() => host.close());
  const hostUrl = `http://127.0.0.1:${host.server.address().port}`;
  const { body: queued } = await fetchJson(`${hostUrl}/tasks`, { method: 'POST', token,
    body: { type: 'alpha.render', payload: { seed: 3 }, targetAgent: 'gpu-laptop' } });
  const abort = new AbortController();
  let stopped = false;
  const pass = runGpuDemand({ hostUrl, queueToken: token, workerToken: token, name: 'gpu-laptop',
    handlers: [{ type: 'alpha.render', run: async (payload) => ({ seed: payload.seed }) }],
    idleMs: Infinity, checkMs: 5, pollWaitMs: 20, memoryReserveBytes: 0, maxLoad: 1,
    imageBackend: { async ensure() {}, async busy() { return false; }, async stop() { stopped = true; } },
    signal: abort.signal });
  const deadline = Date.now() + 5000;
  while (host.queue.get(queued.id).status !== 'succeeded' && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.equal(host.queue.get(queued.id).status, 'succeeded');
  await new Promise((done) => setTimeout(done, 300)); // far past any finite grace the test uses
  assert.equal(host.registry.list().length, 1, 'still registered after the job');
  assert.equal(stopped, false, 'backend kept up');
  abort.abort();
  const result = await pass;
  assert.equal(result.completed, 1);
  assert.equal(stopped, true);
  assert.equal(host.registry.list().length, 0);
});

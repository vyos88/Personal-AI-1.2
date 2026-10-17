import test from 'node:test';
import assert from 'node:assert/strict';
import { createHost } from '../src/host/server.js';
import { fetchJson } from '../src/common/http.js';
import { runGpuDemand } from '../src/agent/gpu-demand.js';

const token = 'gpu-demand-test-token-long-enough';
async function hostFor(t) {
  const host = createHost({ token });
  await host.listen({ port: 0, binds: ['127.0.0.1'] });
  const { port } = host.server.address();
  t.after(() => host.close());
  const hostUrl = `http://127.0.0.1:${port}`;
  return { host, hostUrl, post: (task) => fetchJson(`${hostUrl}/tasks`, { method: 'POST', token, body: task }) };
}
const options = (hostUrl, handlers) => ({ hostUrl, handlers, queueToken: token,
  workerToken: token, name: 'gpu-laptop', idleMs: 1000, checkMs: 5, pollWaitMs: 20, memoryReserveBytes: 0, maxLoad: 1 });

test('insufficient GPU resources leave work queued without spending an attempt', async (t) => {
  const { host, hostUrl, post } = await hostFor(t);
  const { body: task } = await post({ type: 'alpha.render', payload: {}, targetAgent: 'gpu-laptop' });
  const result = await runGpuDemand({ ...options(hostUrl, [{ type: 'alpha.render', run: async () => assert.fail() }]),
    canStart: async () => ({ ok: false, reason: 'GPU memory busy' }) });
  assert.equal(result.started, false);
  assert.equal(host.queue.get(task.id).status, 'queued');
  assert.equal(host.queue.get(task.id).attempts, 0);
  assert.equal(host.registry.list().length, 0);
});

test('idle GPU scheduler does not register for CPU work or another GPU machine', async (t) => {
  const { host, hostUrl, post } = await hostFor(t);
  await post({ type: 'echo', payload: {} });
  await post({ type: 'alpha.render', payload: {}, targetAgent: 'other-gpu' });
  const result = await runGpuDemand(options(hostUrl, [{ type: 'alpha.render', run: async () => assert.fail('must not run') }]));
  assert.equal(result.started, false);
  assert.equal(host.registry.list().length, 0);
  assert.equal(host.queue.list({ status: 'queued' }).length, 2);
});

test('GPU demand runs on the named laptop, reports before stopping and leaves CPU work queued', async (t) => {
  const { host, hostUrl, post } = await hostFor(t);
  await post({ type: 'echo', payload: {} });
  const { body: queued } = await post({ type: 'alpha.render', payload: { seed: 7 }, targetAgent: 'gpu-laptop' });
  const result = await runGpuDemand(options(hostUrl, [{ type: 'alpha.render', async run(payload) {
    await new Promise((done) => setTimeout(done, 1200)); // Longer than the idle grace.
    return { seed: payload.seed };
  } }]));
  assert.equal(result.completed, 1);
  assert.equal(host.queue.get(queued.id).status, 'succeeded');
  assert.deepEqual(host.queue.get(queued.id).result, { seed: 7 });
  assert.equal(host.registry.list().length, 0);
  assert.equal(host.queue.list({ status: 'queued' })[0].type, 'echo');
});

test('cold GPU backend is started only for image work and stops after its accepted result', async (t) => {
  const { host, hostUrl, post } = await hostFor(t);
  const { body: queued } = await post({ type: 'alpha.image', payload: {}, targetAgent: 'gpu-laptop' });
  let ready = false;
  let stopped = false;
  await runGpuDemand({ ...options(hostUrl, [{ type: 'alpha.image', run: async () => {
    assert.equal(ready, true);
    return { image: 'recipe' };
  } }]), imageBackend: {
    async ensure() { await new Promise((done) => setTimeout(done, 1200)); ready = true; },
    async busy() { return false; },
    async stop() { assert.equal(host.queue.get(queued.id).status, 'succeeded'); stopped = true; },
  } });
  assert.equal(stopped, true);
  assert.equal(host.registry.list().length, 0);
});

test('Singing wake stays registered while its external GPU queue is busy', async (t) => {
  const { host, hostUrl, post } = await hostFor(t);
  const { body: queued } = await post({ type: 'alpha.singing.wake', payload: {}, targetAgent: 'gpu-laptop' });
  let until = 0;
  let stopped = false;
  await runGpuDemand({ ...options(hostUrl, [{ type: 'alpha.singing.wake', async run() {
    until = Date.now() + 1700;
    return { ready: true, device: 'cuda' };
  } }]), imageBackend: {
    async busy() { return Date.now() < until; },
    async stop() {
      assert.ok(Date.now() >= until);
      assert.equal(host.queue.get(queued.id).status, 'succeeded');
      stopped = true;
    },
  } });
  assert.equal(stopped, true);
  assert.equal(host.registry.list().length, 0);
});

// Alpha's AUTOMATIC1111 calls answered by the fleet: a real coordinator, a real
// agent running alpha.image against a stand-in A1111, and the bridge between.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHost } from '../src/host/server.js';
import { TunnelAgent } from '../src/agent/agent.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';
import * as image from '../src/agent/handlers/alpha-image.js';
import * as imageFile from '../src/agent/handlers/alpha-image-file.js';
import { createImageBridge } from '../src/bridge/image.js';
import { describeAgent, parsePool, pickMachine } from '../src/bridge/pick.js';

const TOKEN = 'test-token-that-is-long-enough';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

async function startHost(t) {
  const host = createHost({ token: TOKEN });
  const url = await listen(host.server);
  t.after(() => host.close());
  return { ...host, url };
}

async function startBridge(t, hostUrl, options = {}) {
  const { server } = createImageBridge({ hostUrl, token: TOKEN, pollMs: 20, ...options });
  const url = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return url;
}

async function txt2img(url, body) {
  const response = await fetch(`${url}/sdapi/v1/txt2img`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function get(url, path) {
  const response = await fetch(`${url}${path}`);
  return { status: response.status, body: await response.json() };
}

/** Waits until the bridge has queued `count` tasks of `type`. */
async function queuedTasks(host, type, count = 1) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const tasks = host.queue.list({}).filter((task) => task.type === type);
    if (tasks.length >= count) return tasks;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no ${type} task was queued`);
}

test('choosing an image machine', () => {
  assert.equal(parsePool('auto'), 'auto');
  assert.deepEqual(parsePool('worker1, host'), ['worker1', 'host']);
  assert.equal(parsePool('worker1'), null);
  const agents = [
    { name: 'a', capabilities: ['alpha.image'], inFlight: 1, idleMs: 9 },
    { name: 'b', capabilities: ['alpha.image'], inFlight: 0, idleMs: 1 },
    { name: 'c', capabilities: ['alpha.image', 'alpha.music'], inFlight: 0, idleMs: 5, stale: false },
    { name: 'd', capabilities: ['alpha.image'], inFlight: 0, idleMs: 99, stale: true },
    { name: 'e', capabilities: ['alpha.music'], inFlight: 0, idleMs: 99 },
  ];
  assert.equal(pickMachine(agents, 'alpha.image', 'auto'), 'c');
  assert.equal(pickMachine(agents, 'alpha.music', 'auto'), 'e');
  assert.equal(pickMachine(agents, 'alpha.image', ['a', 'b']), 'b');
  assert.equal(pickMachine(agents, 'alpha.image', ['e']), null);
  assert.deepEqual(describeAgent(agents[2], 'alpha.image'), { name: 'c', idleMs: 5, inFlight: 0, stale: false });
  assert.equal(describeAgent(agents[4], 'alpha.image'), null);
});

test('sd-models is up while a machine offers alpha.image, and 503 while none does', async (t) => {
  const host = await startHost(t);
  const bridge = await startBridge(t, host.url);
  assert.deepEqual((await get(bridge, '/healthz')).body, { ok: true });

  host.registry.register({ name: 'render-box', capabilities: ['alpha.render'], remoteAddress: '100.64.0.11' });
  let response = await get(bridge, '/sdapi/v1/sd-models');
  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'no_image_machine');

  host.registry.register({ name: 'worker1', capabilities: ['alpha.image', 'alpha.image.file'], remoteAddress: '100.64.0.9' });
  host.registry.register({ name: 'host', capabilities: ['alpha.image', 'alpha.image.file'], remoteAddress: '100.64.0.10' });
  response = await get(bridge, '/sdapi/v1/sd-models');
  assert.equal(response.status, 200);
  assert.equal(response.body.length, 1);
  assert.equal(response.body[0].model_name, 'alpha-tunnel');
  assert.match(response.body[0].title, /^alpha-tunnel \((worker1, host|host, worker1)\)$/);
  assert.doesNotMatch(JSON.stringify(response.body), /100\.64|render-box/);

  // With nobody attached, a render is refused at once rather than queued.
  const empty = await startHost(t);
  const emptyBridge = await startBridge(t, empty.url);
  const refused = await txt2img(emptyBridge, { prompt: 'x' });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error, 'no_image_machine');
  assert.equal(empty.queue.stats().total, 0);
});

test('bad settings are refused with the reason, and nothing is queued', async (t) => {
  const host = await startHost(t);
  host.registry.register({ name: 'worker1', capabilities: ['alpha.image'], remoteAddress: '100.64.0.9' });
  const bridge = await startBridge(t, host.url);
  for (const [body, reason] of [
    [{ prompt: 'x', width: 513 }, /width/],
    [{ prompt: 'x', batch_size: 5 }, /batch_size/],
    // An unknown field is dropped (as A1111 does), so it cannot smuggle a task type in.
    [{ prompt: 'x', type: 'codex.exec', width: 7 }, /width/],
    [{}, /prompt/],
    ['{not json', /not valid JSON/],
  ]) {
    const response = await txt2img(bridge, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.match(response.body.message, reason);
  }
  assert.equal(host.queue.stats().total, 0);
});

test('each image goes to the least busy image machine and is pinned there', async (t) => {
  const host = await startHost(t);
  const worker = host.registry.register({ name: 'worker1', capabilities: ['alpha.image', 'alpha.image.file'], remoteAddress: '100.64.0.9' });
  host.registry.register({ name: 'host', capabilities: ['alpha.image', 'alpha.image.file'], remoteAddress: '100.64.0.10' });
  host.registry.register({ name: 'render-box', capabilities: ['alpha.render'], remoteAddress: '100.64.0.11' });
  host.registry.admit(worker.id, { type: 'alpha.image', minMemoryMB: 0 });
  const bridge = await startBridge(t, host.url, { leaseMs: 123_000, timeoutMs: 300 });

  const pending = txt2img(bridge, { prompt: 'a red fox' });
  const [task] = await queuedTasks(host, 'alpha.image');
  assert.equal(task.targetAgent, 'host', 'worker1 is busy, so host gets it');
  assert.equal(task.leaseMs, 123_000);
  assert.deepEqual(task.payload, image.validateImageSettings({ prompt: 'a red fox' }));
  // Nobody runs it here, so it times out: a 504, not a hang.
  const timedOut = await pending;
  assert.equal(timedOut.status, 504);
  assert.equal(timedOut.body.error, 'image_timeout');
});

test('a failed render is a 502 with the machine\'s reason', async (t) => {
  const host = await startHost(t);
  host.registry.register({ name: 'worker1', capabilities: ['alpha.image'], remoteAddress: '100.64.0.9' });
  const bridge = await startBridge(t, host.url, { targetAgent: 'worker1,host' });

  const pending = txt2img(bridge, { prompt: 'x' });
  const [task] = await queuedTasks(host, 'alpha.image');
  assert.equal(task.targetAgent, 'worker1');
  Object.assign(host.queue.get(task.id), { status: 'failed', error: { message: 'AUTOMATIC1111 answered HTTP 500: CUDA out of memory' } });
  const { status, body, headers } = await pending;
  assert.equal(status, 502);
  assert.equal(body.error, 'image_failed');
  assert.match(body.message, /CUDA out of memory/);
  assert.equal(headers.get('access-control-allow-origin'), null);
});

test('txt2img round trip: bridge, coordinator, agent, alpha.image and the chunked fetch', async (t) => {
  const saved = Object.fromEntries(['ALPHA_IMAGE_BACKEND', 'ALPHA_IMAGE_URL', 'ALPHA_IMAGE_OUTPUT'].map((n) => [n, process.env[n]]));
  const dir = await mkdtemp(join(tmpdir(), 'image-bridge-'));
  t.after(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });

  // Over one slice, so the fetch has to stitch: a PNG signature and padding.
  const png = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(imageFile.CHUNK_BYTES + 1_000, 7)]);
  const requests = [];
  const a1111 = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ images: [png.toString('base64')], parameters: body, info: JSON.stringify({ seed: body.seed }) }));
  });
  const a1111Url = await listen(a1111);
  t.after(() => new Promise((resolve) => a1111.close(resolve)));
  delete process.env.ALPHA_IMAGE_BACKEND;
  process.env.ALPHA_IMAGE_URL = `${a1111Url}/sdapi/v1/txt2img`;
  process.env.ALPHA_IMAGE_OUTPUT = dir;

  const host = await startHost(t);
  const handlers = new HandlerRegistry([]);
  assert.equal(handlers.add(image).registered, true);
  assert.equal(handlers.add(imageFile).registered, true);
  const agent = new TunnelAgent({ hostUrl: host.url, token: TOKEN, name: 'worker1', handlers, pollWaitMs: 500 });
  const running = agent.start();
  t.after(async () => {
    await agent.stop({ drainMs: 0 });
    await running;
  });
  const deadline = Date.now() + 5_000;
  while (!host.registry.list().some((a) => a.name === 'worker1') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const bridge = await startBridge(t, host.url);
  const models = await get(bridge, '/sdapi/v1/sd-models');
  assert.equal(models.status, 200);
  assert.equal(models.body[0].title, 'alpha-tunnel (worker1)');

  const { status, body } = await txt2img(bridge, { prompt: 'a lighthouse', seed: 99, steps: 5, batch_size: 2 });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.images.length, 2);
  for (const b64 of body.images) assert.ok(Buffer.from(b64, 'base64').equals(png), 'the PNG differs from the one the machine made');
  assert.deepEqual(requests.map((r) => r.seed), [99, 100], 'a batch walks the seed forward, one task per image');
  assert.equal(body.parameters.prompt, 'a lighthouse');
  assert.equal(body.parameters.seed, 99);
  assert.equal(body.parameters.batch_size, 2);
  const info = JSON.parse(body.info);
  assert.equal(info.seed, 99);
  assert.deepEqual(info.all_seeds, [99, 100]);
  assert.equal(info.machine, 'worker1');
  assert.equal(info.backend, 'a1111');
  assert.ok(Number.isFinite(info.durationMs));
  assert.equal(host.queue.get(info.taskId).type, 'alpha.image');

  const slices = host.queue.list({}).filter((task) => task.type === 'alpha.image.file');
  assert.equal(slices.length, 4, 'two slices per image');
  assert.ok(slices.every((task) => task.targetAgent === 'worker1' && task.status === 'succeeded'));
});

// Alpha's real request: its own `_alpha_request_id`, ComfyUI scheduler names,
// and img2img/progress on the same base URL.
test('Alpha\'s own fields are ignored, its scheduler kept, and img2img goes to the direct generator', async (t) => {
  const { validateTxt2img } = await import('../src/bridge/image.js');
  const { settings } = validateTxt2img({ prompt: 'a cat', _alpha_request_id: 'abc', width: 1216, height: 832, steps: 28, cfg_scale: 6.5, sampler_name: 'dpmpp_2m', scheduler: 'karras', seed: 5 });
  assert.equal(settings.scheduler, 'karras');
  assert.equal(settings.sampler_name, 'dpmpp_2m');
  assert.equal('_alpha_request_id' in settings, false);

  const { createServer: makeServer } = await import('node:http');
  const seen = [];
  const direct = makeServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { seen.push(`${req.method} ${req.url} ${body.length}`); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ images: ['eA=='], progress: 0.5 })); });
  });
  await new Promise((r) => direct.listen(0, '127.0.0.1', r));
  t.after(() => { direct.closeAllConnections(); direct.close(); });
  const { createImageBridge } = await import('../src/bridge/image.js');
  const { server } = createImageBridge({ hostUrl: 'http://127.0.0.1:9', token: 'x'.repeat(30), directUrl: `http://127.0.0.1:${direct.address().port}` });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const big = 'A'.repeat(2 * 1024 * 1024); // a reference image is far bigger than a prompt
  const i2i = await fetch(`${base}/sdapi/v1/img2img`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x', init_images: [big] }) });
  assert.equal(i2i.status, 200);
  assert.deepEqual((await i2i.json()).images, ['eA==']);
  const prog = await fetch(`${base}/sdapi/v1/progress?skip_current_image=true`);
  assert.equal(prog.status, 200);
  assert.ok(seen.some((s) => s.startsWith('POST /sdapi/v1/img2img ') && Number(s.split(' ')[2]) > 2_000_000), seen.join('\n'));
  assert.ok(seen.includes('GET /sdapi/v1/progress?skip_current_image=true 0'), seen.join('\n'));
});

test('equal load goes to the first machine a named pool lists (the GPU one)', async () => {
  const { pickMachine } = await import('../src/bridge/pick.js');
  const agents = [
    { name: 'worker1', capabilities: ['alpha.image'], inFlight: 0, idleMs: 900_000 },
    { name: 'host', capabilities: ['alpha.image'], inFlight: 0, idleMs: 5 },
  ];
  assert.equal(pickMachine(agents, 'alpha.image', ['host', 'worker1']), 'host', 'idle longest does not beat the preferred machine');
  assert.equal(pickMachine([{ ...agents[0] }, { ...agents[1], inFlight: 1 }], 'alpha.image', ['host', 'worker1']), 'worker1', 'but a busy preferred machine does lose');
  assert.equal(pickMachine(agents, 'alpha.image', 'auto'), 'worker1', 'auto: idle longest');
});

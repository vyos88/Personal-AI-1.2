// alpha.image against stand-ins for both local generators, and
// alpha.image.file's slicing: everything but the model itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as image from '../src/agent/handlers/alpha-image.js';
import * as imageFile from '../src/agent/handlers/alpha-image-file.js';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_BASE64, 'base64');
const ENV = ['ALPHA_IMAGE_BACKEND', 'ALPHA_IMAGE_URL', 'ALPHA_COMFYUI_URL', 'ALPHA_COMFYUI_CHECKPOINT', 'ALPHA_IMAGE_OUTPUT', 'ALPHA_IMAGE_TIMEOUT_MS'];

/** Sets env for one test and puts every touched variable back afterwards. */
function withEnv(t, vars) {
  const before = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  for (const name of ENV) delete process.env[name];
  Object.assign(process.env, vars);
  t.after(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

async function outputDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'alpha-image-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A loopback server answering with `handle(req, body)` -> { status?, json? | raw? }. */
async function standIn(t, handle) {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? JSON.parse(text) : null;
    seen.push({ method: req.method, url: req.url, body });
    const answer = await handle(req, body);
    if (answer.raw) {
      res.writeHead(answer.status ?? 200, { 'content-type': 'image/png' });
      return res.end(answer.raw);
    }
    res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer.json ?? {}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

test('settings are normalized with defaults, and anything else is refused', () => {
  assert.deepEqual(image.validateImageSettings({ prompt: 'a red fox' }), {
    prompt: 'a red fox',
    negative_prompt: '',
    width: 512,
    height: 512,
    steps: 20,
    seed: -1,
    cfg_scale: 7,
    sampler_name: null,
  });
  for (const [payload, reason] of [
    [null, /object/],
    [[], /object/],
    [{}, /prompt/],
    [{ prompt: '   ' }, /prompt/],
    [{ prompt: 'x'.repeat(2_001) }, /prompt/],
    [{ prompt: 'x', negative_prompt: 5 }, /negative_prompt/],
    [{ prompt: 'x', width: 500 }, /width.*multiple of 8/],
    [{ prompt: 'x', height: 1_544 }, /height/],
    [{ prompt: 'x', width: 56 }, /width/],
    [{ prompt: 'x', steps: 0 }, /steps/],
    [{ prompt: 'x', steps: 81 }, /steps/],
    [{ prompt: 'x', seed: -2 }, /seed/],
    [{ prompt: 'x', seed: 1.5 }, /seed/],
    [{ prompt: 'x', cfg_scale: 31 }, /cfg_scale/],
    [{ prompt: 'x', cfg_scale: '7' }, /cfg_scale/],
    [{ prompt: 'x', sampler_name: 'Euler; rm -rf' }, /sampler_name/],
    [{ prompt: 'x', batch_size: 2 }, /unknown setting.*batch_size/],
    [{ prompt: 'x', override_settings: {} }, /unknown setting/],
  ]) {
    assert.throws(() => image.validateImageSettings(payload), reason, JSON.stringify(payload));
  }
});

test('a misconfigured backend keeps the handler from being offered', (t) => {
  withEnv(t, { ALPHA_IMAGE_BACKEND: 'midjourney' });
  assert.equal(image.available().ok, false);
  assert.match(image.available().reason, /ALPHA_IMAGE_BACKEND/);
  process.env.ALPHA_IMAGE_BACKEND = 'comfyui';
  assert.deepEqual(image.available(), { ok: true });
});

test('a1111: renders through the local server, keeps the PNG, returns a small recipe', async (t) => {
  const dir = await outputDir(t);
  const a1111 = await standIn(t, () => ({
    json: { images: [PNG_BASE64], parameters: {}, info: JSON.stringify({ seed: 1234 }) },
  }));
  withEnv(t, { ALPHA_IMAGE_URL: `${a1111.url}/sdapi/v1/txt2img`, ALPHA_IMAGE_OUTPUT: dir });

  const result = await image.run({ prompt: 'a red fox', width: 640, steps: 4 });
  assert.equal(a1111.seen.length, 1);
  assert.equal(a1111.seen[0].url, '/sdapi/v1/txt2img');
  assert.equal(a1111.seen[0].body.batch_size, 1);
  assert.equal(a1111.seen[0].body.width, 640);
  assert.equal(a1111.seen[0].body.sampler_name, 'Euler a');
  assert.ok(a1111.seen[0].body.seed >= 0, 'a random seed is drawn before rendering, so the recipe can name it');

  assert.equal(result.backend, 'a1111');
  assert.equal(result.recipe.seed, 1234, 'the seed A1111 reports wins');
  assert.equal(result.recipe.prompt, 'a red fox');
  assert.equal(result.outputs.length, 1);
  const [{ name, bytes }] = result.outputs;
  assert.match(name, image.IMAGE_NAME_PATTERN);
  assert.equal(bytes, PNG.length);
  assert.ok((await readFile(join(dir, name))).equals(PNG));
  assert.deepEqual(await readdir(dir), [name], 'no .part file left behind');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 8 * 1024);
});

test('a1111: a generator error or a non-PNG is the task failing, with the reason', async (t) => {
  const dir = await outputDir(t);
  let answer = { status: 500, json: { error: 'CUDA out of memory' } };
  const a1111 = await standIn(t, () => answer);
  withEnv(t, { ALPHA_IMAGE_URL: `${a1111.url}/sdapi/v1/txt2img`, ALPHA_IMAGE_OUTPUT: dir });
  await assert.rejects(image.run({ prompt: 'x' }), /HTTP 500.*CUDA out of memory/);
  answer = { json: { images: [Buffer.from('not a png').toString('base64')] } };
  await assert.rejects(image.run({ prompt: 'x' }), /did not return a PNG/);

  process.env.ALPHA_IMAGE_URL = 'http://127.0.0.1:1/sdapi/v1/txt2img';
  await assert.rejects(image.run({ prompt: 'x' }), (error) => error.code === 'generator_unreachable');
});

test('comfyui: posts a text-to-image workflow, polls history, fetches the PNG from /view', async (t) => {
  const dir = await outputDir(t);
  let polls = 0;
  const comfy = await standIn(t, (req) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/prompt') return { json: { prompt_id: 'p-1', number: 1, node_errors: {} } };
    if (url.pathname === '/history/p-1') {
      polls += 1;
      if (polls < 2) return { json: {} };
      return {
        json: {
          'p-1': {
            status: { status_str: 'success', completed: true },
            outputs: { 9: { images: [{ filename: 'alpha-tunnel_00001_.png', subfolder: '', type: 'output' }] } },
          },
        },
      };
    }
    if (url.pathname === '/view') return { raw: PNG };
    return { status: 404, json: {} };
  });
  withEnv(t, {
    ALPHA_IMAGE_BACKEND: 'comfyui',
    ALPHA_COMFYUI_URL: comfy.url,
    ALPHA_COMFYUI_CHECKPOINT: 'sdxl.safetensors',
    ALPHA_IMAGE_OUTPUT: dir,
  });

  const result = await image.run({ prompt: 'a lighthouse', negative_prompt: 'blurry', seed: 42, sampler_name: 'DPM++ 2M Karras', cfg_scale: 6.5 });
  const workflow = comfy.seen[0].body.prompt;
  assert.equal(typeof comfy.seen[0].body.client_id, 'string');
  const byType = Object.fromEntries(Object.values(workflow).map((node) => [node.class_type, node.inputs]));
  assert.equal(byType.CheckpointLoaderSimple.ckpt_name, 'sdxl.safetensors');
  assert.equal(byType.KSampler.seed, 42);
  assert.equal(byType.KSampler.cfg, 6.5);
  assert.equal(byType.KSampler.sampler_name, 'dpmpp_2m');
  assert.equal(byType.KSampler.scheduler, 'karras');
  assert.equal(byType.SaveImage.filename_prefix, 'alpha-tunnel');
  assert.deepEqual(Object.values(workflow).filter((n) => n.class_type === 'CLIPTextEncode').map((n) => n.inputs.text).sort(), ['a lighthouse', 'blurry']);
  const view = comfy.seen.find((s) => s.url.startsWith('/view'));
  assert.match(view.url, /filename=alpha-tunnel_00001_\.png/);
  assert.match(view.url, /type=output/);
  assert.ok(polls >= 2);

  assert.equal(result.backend, 'comfyui');
  assert.equal(result.recipe.seed, 42);
  assert.ok((await readFile(join(dir, result.outputs[0].name))).equals(PNG));
});

test('comfyui: an execution error fails the task with ComfyUI\'s message', async (t) => {
  const dir = await outputDir(t);
  const comfy = await standIn(t, (req) => {
    if (req.url === '/prompt') return { json: { prompt_id: 'p-2', node_errors: {} } };
    return {
      json: {
        'p-2': {
          status: { status_str: 'error', completed: false, messages: [['execution_error', { exception_message: 'checkpoint not found' }]] },
          outputs: {},
        },
      },
    };
  });
  withEnv(t, { ALPHA_IMAGE_BACKEND: 'comfyui', ALPHA_COMFYUI_URL: comfy.url, ALPHA_IMAGE_OUTPUT: dir });
  await assert.rejects(image.run({ prompt: 'x' }), /checkpoint not found/);
});

test('a render that outruns its signal is abandoned', async (t) => {
  const dir = await outputDir(t);
  const comfy = await standIn(t, (req) => (req.url === '/prompt' ? { json: { prompt_id: 'p-3' } } : { json: {} }));
  withEnv(t, { ALPHA_IMAGE_BACKEND: 'comfyui', ALPHA_COMFYUI_URL: comfy.url, ALPHA_IMAGE_OUTPUT: dir, ALPHA_IMAGE_TIMEOUT_MS: '400' });
  await assert.rejects(image.run({ prompt: 'x' }), (error) => error.code === 'image_killed' && /ALPHA_IMAGE_TIMEOUT_MS/.test(error.message));
  const controller = new AbortController();
  process.env.ALPHA_IMAGE_TIMEOUT_MS = '60000';
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(image.run({ prompt: 'x' }, { signal: controller.signal }), (error) => error.code === 'image_killed');
});

test('alpha.image.file hands a PNG back in CHUNK_BYTES slices', async (t) => {
  const dir = await outputDir(t);
  withEnv(t, { ALPHA_IMAGE_OUTPUT: dir });
  const name = 'img-1700000000000-42-abc123.png';
  const big = Buffer.alloc(imageFile.CHUNK_BYTES * 2 + 100);
  for (let i = 0; i < big.length; i++) big[i] = i % 251;
  await writeFile(join(dir, name), big);

  const parts = [];
  let offset = 0;
  let slices = 0;
  for (;;) {
    const slice = await imageFile.run({ name, offset });
    slices += 1;
    assert.equal(slice.totalBytes, big.length);
    assert.ok(slice.bytes <= imageFile.CHUNK_BYTES);
    const data = Buffer.from(slice.data, 'base64');
    assert.equal(data.length, slice.bytes);
    parts.push(data);
    offset += data.length;
    if (offset >= slice.totalBytes) break;
  }
  assert.equal(slices, 3);
  assert.ok(Buffer.concat(parts).equals(big));

  await assert.rejects(imageFile.run({ name, offset: big.length + 1 }), /past the end/);
  await assert.rejects(imageFile.run({ name: 'img-1700000000000-42-abcdef.png' }), (error) => error.code === 'no_image');
});

test('alpha.image.file takes a name it wrote, never a path', async (t) => {
  const dir = await outputDir(t);
  withEnv(t, { ALPHA_IMAGE_OUTPUT: dir });
  for (const name of [
    '../auth.json',
    '..\\auth.json',
    'img-1-2-abcdef.png/../x',
    'sub/img-1-2-abcdef.png',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    'img-1-2-abcdef.jpg',
    'photo.png',
    '',
    7,
  ]) {
    await assert.rejects(imageFile.run({ name, offset: 0 }), /"name" must be/, JSON.stringify(name));
  }
  await assert.rejects(imageFile.run({ name: 'img-1-2-abcdef.png', offset: -1 }), /offset/);
  await assert.rejects(imageFile.run({ name: 'img-1-2-abcdef.png', path: '/' }), /unknown key/);
  assert.deepEqual(imageFile.available(), { ok: true });
});

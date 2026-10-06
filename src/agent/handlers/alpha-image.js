import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ProtocolError } from '../../common/protocol.js';

/**
 * Renders one image from Alpha's text-to-image settings on THIS machine's own
 * generator, so image work can be spread over the laptops the way music is:
 * the image bridge (src/bridge/image.js) picks the least busy machine offering
 * `alpha.image` and queues the render there.
 *
 * The payload is what Alpha already sends to an AUTOMATIC1111 server, minus
 * `batch_size` (the bridge renders a batch as one task per image, so each
 * image can go to whichever machine is free):
 *
 *   { prompt, negative_prompt?, width?, height?, steps?, seed?, cfg_scale?, sampler_name? }
 *
 * Only the recipe comes back, the same split `alpha.music` makes: a PNG is
 * hundreds of KB, the coordinator caps a body at 1 MB and keeps only results
 * under 8 KiB (src/host/journal.js). The PNG stays in ALPHA_IMAGE_OUTPUT and
 * crosses in slices through `alpha.image.file`.
 *
 * Two local generators are driven, chosen by ALPHA_IMAGE_BACKEND:
 *   - `a1111` (default): POST /sdapi/v1/txt2img on a local AUTOMATIC1111 / Forge.
 *   - `comfyui`: a minimal text-to-image workflow posted to ComfyUI's /prompt,
 *     polled on /history and fetched from /view.
 * Both are loopback HTTP on the same machine; nothing is executed here.
 *
 * Opt-in: ALPHA_EXTRA_HANDLERS=alpha-image,alpha-image-file.
 *
 * Configuration:
 *   ALPHA_IMAGE_BACKEND       `a1111` (default) or `comfyui`
 *   ALPHA_IMAGE_URL           A1111 txt2img URL (default http://127.0.0.1:7860/sdapi/v1/txt2img)
 *   ALPHA_COMFYUI_URL         ComfyUI base URL (default http://127.0.0.1:8188)
 *   ALPHA_COMFYUI_CHECKPOINT  checkpoint name (default v1-5-pruned-emaonly.safetensors)
 *   ALPHA_IMAGE_OUTPUT        where PNGs are kept (default <os tmpdir>/alpha-tunnel-images)
 *   ALPHA_IMAGE_TIMEOUT_MS    hard ceiling on one image (default 10 minutes)
 */

export const type = 'alpha.image';

export const description =
  'Renders one text-to-image picture on this machine (AUTOMATIC1111 or ComfyUI) and returns the recipe.';

export const BACKENDS = new Set(['a1111', 'comfyui']);
const DEFAULT_A1111_URL = 'http://127.0.0.1:7860/sdapi/v1/txt2img';
const DEFAULT_COMFYUI_URL = 'http://127.0.0.1:8188';
const DEFAULT_CHECKPOINT = 'v1-5-pruned-emaonly.safetensors';
const DEFAULT_TIMEOUT_MS = 600_000;
const COMFYUI_POLL_MS = 250;

const MAX_PROMPT = 2_000;
const MIN_SIDE = 64;
const MAX_SIDE = 1_536;
const MAX_STEPS = 80;
// A1111 seeds are 32-bit; keeping to that makes a recipe replayable on either backend.
export const MAX_SEED = 4_294_967_295;
const SAMPLER_PATTERN = /^[A-Za-z0-9 _+-]{1,40}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// The handler names every file itself, so this is the only shape
// `alpha.image.file` will ever be asked for: no separators, no `..`.
export const IMAGE_NAME_PATTERN = /^img-\d{1,16}-\d{1,10}-[0-9a-f]{6}\.png$/;
const KNOWN_KEYS = new Set(['prompt', 'negative_prompt', 'width', 'height', 'steps', 'seed', 'cfg_scale', 'sampler_name', 'scheduler']);
/** What a recipe can carry; the image bridge keeps only these from Alpha's request. */
export const IMAGE_SETTING_KEYS = Object.freeze([...KNOWN_KEYS]);
// Alpha sends ComfyUI's scheduler names (karras, normal, ...) with every request.
const SCHEDULER_PATTERN = /^[a-z0-9_]{1,32}$/;

function configured(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

function notConfigured(message) {
  return new ProtocolError(message, { status: 500, code: 'not_configured' });
}

function side(payload, key) {
  const value = payload[key] ?? 512;
  if (!Number.isInteger(value) || value < MIN_SIDE || value > MAX_SIDE || value % 8 !== 0) {
    throw new ProtocolError(
      `"${key}" must be a multiple of 8 from ${MIN_SIDE} to ${MAX_SIDE} (got ${JSON.stringify(payload[key])})`,
    );
  }
  return value;
}

/**
 * Turns Alpha's settings into a recipe, or refuses them. Exported so the
 * image bridge refuses the same things before queueing, and Alpha gets a 400
 * with the reason instead of a task that fails on a laptop a minute later.
 * `seed` stays -1 here when random; `run()` draws it, so the recipe it
 * returns names the seed that was actually used.
 */
export function validateImageSettings(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProtocolError('payload must be an object of image settings');
  }
  // An unknown key would be dropped on the floor while the caller believes it was applied.
  const unknown = Object.keys(payload).filter((key) => !KNOWN_KEYS.has(key));
  if (unknown.length > 0) {
    throw new ProtocolError(
      `unknown setting(s) ${unknown.map((key) => JSON.stringify(key)).join(', ')}; ` +
        `this generator takes ${[...KNOWN_KEYS].join(', ')}`,
    );
  }

  const { prompt } = payload;
  if (typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > MAX_PROMPT) {
    throw new ProtocolError(`"prompt" must be a non-empty string of at most ${MAX_PROMPT} characters`);
  }
  const negative = payload.negative_prompt ?? '';
  if (typeof negative !== 'string' || negative.length > MAX_PROMPT) {
    throw new ProtocolError(`"negative_prompt" must be a string of at most ${MAX_PROMPT} characters`);
  }

  const width = side(payload, 'width');
  const height = side(payload, 'height');

  const steps = payload.steps ?? 20;
  if (!Number.isInteger(steps) || steps < 1 || steps > MAX_STEPS) {
    throw new ProtocolError(`"steps" must be a whole number from 1 to ${MAX_STEPS} (got ${JSON.stringify(payload.steps)})`);
  }

  const seed = payload.seed ?? -1;
  if (!Number.isInteger(seed) || seed < -1 || seed > MAX_SEED) {
    throw new ProtocolError(`"seed" must be -1 (random) or a whole number from 0 to ${MAX_SEED} (got ${JSON.stringify(payload.seed)})`);
  }

  const cfgScale = payload.cfg_scale ?? 7;
  if (typeof cfgScale !== 'number' || !Number.isFinite(cfgScale) || cfgScale < 1 || cfgScale > 30) {
    throw new ProtocolError(`"cfg_scale" must be a number from 1 to 30 (got ${JSON.stringify(payload.cfg_scale)})`);
  }

  const sampler = payload.sampler_name ?? null;
  if (sampler !== null && (typeof sampler !== 'string' || !SAMPLER_PATTERN.test(sampler))) {
    throw new ProtocolError(`"sampler_name" must be a short sampler name such as "Euler a" (got ${JSON.stringify(sampler)})`);
  }

  const scheduler = payload.scheduler ?? null;
  if (scheduler !== null && (typeof scheduler !== 'string' || !SCHEDULER_PATTERN.test(scheduler))) {
    throw new ProtocolError(`"scheduler" must be a short scheduler name such as "karras" (got ${JSON.stringify(scheduler)})`);
  }

  return {
    prompt,
    negative_prompt: negative,
    width,
    height,
    steps,
    seed,
    cfg_scale: cfgScale,
    sampler_name: sampler,
    ...(scheduler ? { scheduler } : {}),
  };
}

export function imageBackend() {
  const backend = configured('ALPHA_IMAGE_BACKEND', 'a1111').toLowerCase();
  if (!BACKENDS.has(backend)) {
    throw notConfigured(`ALPHA_IMAGE_BACKEND must be ${[...BACKENDS].join(' or ')} (got ${backend})`);
  }
  return backend;
}

/** Exported so `alpha-image-file.js` reads exactly where `run()` writes. */
export function resolveImageOutputDir() {
  return resolve(configured('ALPHA_IMAGE_OUTPUT', join(tmpdir(), 'alpha-tunnel-images')));
}

function timeoutMs() {
  const raw = configured('ALPHA_IMAGE_TIMEOUT_MS', null);
  if (raw === null) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw notConfigured(`ALPHA_IMAGE_TIMEOUT_MS must be a positive whole number of milliseconds (got ${raw})`);
  }
  return parsed;
}

/**
 * Configuration only. Whether the generator is up is asked at run time: it is
 * a separate process that comes and goes (a Forge restart, a model swap), and
 * an agent registers its handlers once at start, so checking here would leave
 * a machine silently not offering images until its agent restarted.
 */
export function available() {
  try {
    imageBackend();
    timeoutMs();
    resolveImageOutputDir();
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  return { ok: true };
}

function generatorError(message, code = 'image_failed') {
  return new ProtocolError(message, { status: 502, code });
}

function decodePng(base64, from) {
  const text = typeof base64 === 'string' ? base64.replace(/^data:image\/png;base64,/, '') : '';
  const data = Buffer.from(text, 'base64');
  if (data.length < PNG_SIGNATURE.length || !data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw generatorError(`${from} did not return a PNG`, 'not_png');
  }
  return data;
}

async function request(url, options, from) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    if (options.signal?.aborted) throw aborted(options.signal);
    throw generatorError(`${from} is not reachable at ${url}: ${error.message}`, 'generator_unreachable');
  }
  if (!response.ok) {
    const text = (await response.text().catch(() => '')).slice(0, 500);
    throw generatorError(`${from} answered HTTP ${response.status}: ${text}`);
  }
  return response;
}

function aborted(signal) {
  const reason = signal.reason?.name === 'TimeoutError'
    ? 'it outran ALPHA_IMAGE_TIMEOUT_MS'
    : 'the task was cancelled or its lease expired';
  return new ProtocolError(`the image was abandoned before it finished: ${reason}`, { status: 500, code: 'image_killed' });
}

async function renderA1111(recipe, signal) {
  const url = configured('ALPHA_IMAGE_URL', DEFAULT_A1111_URL);
  const response = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ ...recipe, batch_size: 1, n_iter: 1 }),
    signal,
  }, 'AUTOMATIC1111');
  const body = await response.json().catch(() => null);
  const data = decodePng(body?.images?.[0], 'AUTOMATIC1111');
  // A1111 reports the seed it used in `info`; trust it over ours when present.
  let seed = recipe.seed;
  try {
    const info = typeof body.info === 'string' ? JSON.parse(body.info) : body.info;
    if (Number.isInteger(info?.seed)) seed = info.seed;
  } catch { /* keep ours */ }
  return { data, seed };
}

/**
 * ComfyUI names its samplers differently. Alpha speaks A1111, so its common
 * names are translated; anything else is passed as ComfyUI would spell it.
 */
export function comfySampler(name) {
  const known = {
    'euler a': ['euler_ancestral', 'normal'],
    euler: ['euler', 'normal'],
    'dpm++ 2m': ['dpmpp_2m', 'normal'],
    'dpm++ 2m karras': ['dpmpp_2m', 'karras'],
    'dpm++ sde karras': ['dpmpp_sde', 'karras'],
    'dpm++ 2m sde karras': ['dpmpp_2m_sde', 'karras'],
    ddim: ['ddim', 'ddim_uniform'],
    lms: ['lms', 'normal'],
    heun: ['heun', 'normal'],
  };
  const hit = known[name.toLowerCase()];
  if (hit) return { sampler: hit[0], scheduler: hit[1] };
  const karras = /\s+karras$/i.test(name);
  const sampler = name.replace(/\s+karras$/i, '').toLowerCase().replace(/\+\+/g, 'pp').replace(/[\s-]+/g, '_');
  return { sampler, scheduler: karras ? 'karras' : 'normal' };
}

/** The smallest text-to-image graph ComfyUI's API format accepts. */
export function comfyWorkflow(recipe, checkpoint) {
  const mapped = comfySampler(recipe.sampler_name);
  const sampler = mapped.sampler;
  // A scheduler Alpha named wins over the one guessed from the sampler name.
  const scheduler = recipe.scheduler ?? mapped.scheduler;
  return {
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: recipe.prompt, clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: recipe.negative_prompt, clip: ['4', 1] } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: recipe.width, height: recipe.height, batch_size: 1 } },
    3: {
      class_type: 'KSampler',
      inputs: {
        seed: recipe.seed,
        steps: recipe.steps,
        cfg: recipe.cfg_scale,
        sampler_name: sampler,
        scheduler,
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'alpha-tunnel', images: ['8', 0] } },
  };
}

function wait(ms, signal) {
  return new Promise((resolveWait, rejectWait) => {
    if (signal.aborted) return rejectWait(aborted(signal));
    const onAbort = () => {
      clearTimeout(timer);
      rejectWait(aborted(signal));
    };
    // Removed on every tick, or a long render piles up one listener per poll.
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolveWait();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function renderComfy(recipe, signal) {
  const base = configured('ALPHA_COMFYUI_URL', DEFAULT_COMFYUI_URL).replace(/\/+$/, '');
  const checkpoint = configured('ALPHA_COMFYUI_CHECKPOINT', DEFAULT_CHECKPOINT);
  const json = { 'content-type': 'application/json', accept: 'application/json' };

  const queued = await request(`${base}/prompt`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ prompt: comfyWorkflow(recipe, checkpoint), client_id: randomUUID() }),
    signal,
  }, 'ComfyUI');
  const { prompt_id: promptId, node_errors: nodeErrors } = (await queued.json().catch(() => null)) ?? {};
  if (nodeErrors && Object.keys(nodeErrors).length > 0) {
    throw generatorError(`ComfyUI refused the workflow: ${JSON.stringify(nodeErrors).slice(0, 500)}`);
  }
  if (typeof promptId !== 'string' || promptId === '') throw generatorError('ComfyUI queued nothing (no prompt_id)');

  // Polled rather than watched over its websocket: one HTTP client, and the
  // signal already bounds how long this can go on.
  let image;
  for (;;) {
    const history = await request(`${base}/history/${encodeURIComponent(promptId)}`, { headers: json, signal }, 'ComfyUI');
    const entry = (await history.json().catch(() => null))?.[promptId];
    if (entry?.status?.status_str === 'error') {
      const message = entry.status.messages?.find?.(([kind]) => kind === 'execution_error')?.[1]?.exception_message;
      throw generatorError(`ComfyUI failed the render: ${message ?? 'execution_error'}`);
    }
    image = Object.values(entry?.outputs ?? {}).flatMap((output) => output?.images ?? [])[0];
    if (image) break;
    if (entry?.status?.completed) throw generatorError('ComfyUI finished but saved no image');
    await wait(COMFYUI_POLL_MS, signal);
  }

  const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' });
  const view = await request(`${base}/view?${query}`, { signal }, 'ComfyUI');
  const data = Buffer.from(await view.arrayBuffer());
  if (!data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw generatorError('ComfyUI did not return a PNG', 'not_png');
  return { data, seed: recipe.seed };
}

export async function run(payload, { signal, log } = {}) {
  const backend = imageBackend();
  const settings = validateImageSettings(payload);
  const outputDir = resolveImageOutputDir();
  const seed = settings.seed === -1 ? randomInt(0, MAX_SEED) : settings.seed;
  const recipe = {
    ...settings,
    seed,
    sampler_name: settings.sampler_name ?? (backend === 'a1111' ? 'Euler a' : 'euler'),
  };
  const limit = AbortSignal.timeout(timeoutMs());
  const combined = signal ? AbortSignal.any([signal, limit]) : limit;

  log?.info?.('rendering image', { backend, width: recipe.width, height: recipe.height, steps: recipe.steps });
  const startedAt = Date.now();
  const { data, seed: usedSeed } = backend === 'comfyui'
    ? await renderComfy(recipe, combined)
    : await renderA1111(recipe, combined);
  recipe.seed = usedSeed;

  mkdirSync(outputDir, { recursive: true });
  const name = `img-${Date.now()}-${usedSeed}-${randomBytes(3).toString('hex')}.png`;
  const path = join(outputDir, name);
  // Written aside and renamed, so `alpha.image.file` never serves half a PNG.
  const partial = `${path}.part`;
  try {
    writeFileSync(partial, data, { flag: 'wx' });
    renameSync(partial, path);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }

  return {
    recipe,
    outputs: [{ name, bytes: statSync(path).size }],
    backend,
    durationMs: Date.now() - startedAt,
  };
}

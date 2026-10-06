import { createServer } from 'node:http';

import { fetchJson, HttpError } from '../common/http.js';
import { ProtocolError } from '../common/protocol.js';
import { IMAGE_NAME_PATTERN, IMAGE_SETTING_KEYS, validateImageSettings } from '../agent/handlers/alpha-image.js';
import { describeAgent, parsePool, pickMachine } from './pick.js';

/**
 * Alpha's image generator, as far as Alpha can tell: the two AUTOMATIC1111
 * routes it uses, answered by spreading the work over the machines offering
 * `alpha.image` — each image to the least busy one, the way music works.
 *
 *   GET  /sdapi/v1/sd-models  → 200 [{ title, model_name }] while a machine can
 *                               render, 503 no_image_machine while none can
 *   POST /sdapi/v1/txt2img    { prompt, negative_prompt?, width?, height?, steps?,
 *                               seed?, cfg_scale?, sampler_name?, batch_size? }
 *                             → 200 { images: [base64png], parameters, info }
 *   GET  /healthz             → { ok: true }
 *
 * Point Alpha's IMAGE_GEN_URL here and nothing on its side changes.
 *
 * One render is one `alpha.image` task pinned to the machine picked for it,
 * then the PNG is brought back in `alpha.image.file` slices queued to that
 * same machine — it is the only one holding the file. A batch is rendered one
 * image at a time, each picked afresh, so two free laptops share it.
 *
 * Like the music bridge, the key stays server-side and is narrow (tasks:read,
 * tasks:write, plus agents:read to pick a machine); the bridge queues only the
 * two image task types, with lease and target from its own configuration,
 * never from the request. There is deliberately no CORS header, and it binds
 * loopback by default (scripts/image-bridge.mjs).
 */

export const DEFAULT_LEASE_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 11 * 60 * 1000;
// Alpha's body is a few KB of settings; 1 MB matches the coordinator's own cap.
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_BATCH = 4;
// A runaway slice loop must end somewhere; no PNG of ≤1536² comes near this.
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MODEL_NAME = 'alpha-tunnel';

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

// img2img carries its reference image in the body: far more than a prompt.
const MAX_PASS_THROUGH_BYTES = 32 * 1024 * 1024;

async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_PASS_THROUGH_BYTES) throw new ProtocolError('request body too large', { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ProtocolError('request body too large', { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') throw new ProtocolError('request body must be the txt2img settings as JSON');
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError('request body is not valid JSON');
  }
}

/**
 * The handler's own rules, plus `batch_size`, which only the bridge takes: it
 * becomes that many tasks rather than travelling in one.
 */
export function validateTxt2img(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ProtocolError('request body must be an object of txt2img settings');
  }
  // Alpha sends what an AUTOMATIC1111 server takes, plus its own fields
  // (`_alpha_request_id` on every request). A1111 ignores what it does not
  // use; so does this bridge, and passes on only what a recipe can carry.
  const { batch_size: rawBatch } = body;
  const settings = Object.fromEntries(Object.entries(body).filter(([key]) => IMAGE_SETTING_KEYS.includes(key)));
  const batchSize = rawBatch ?? 1;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH) {
    throw new ProtocolError(`"batch_size" must be a whole number from 1 to ${MAX_BATCH} (got ${JSON.stringify(rawBatch)})`);
  }
  return { settings: validateImageSettings(settings), batchSize };
}

const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

export function createImageBridge({
  hostUrl,
  token,
  targetAgent = 'auto',
  leaseMs = DEFAULT_LEASE_MS,
  fetch = fetchJson,
  pollMs = 250,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  chunkTimeoutMs = 60_000,
  // This machine's own generator. Alpha also calls /sdapi/v1/img2img (an
  // image from a reference) and /sdapi/v1/progress on the same base URL;
  // neither goes through the fleet, so they are passed straight to it.
  directUrl = null,
  // A machine whose render just failed (on 2026-10-06 the Host's ComfyUI was
  // not running yet) is passed over for this long, so the next image goes
  // to one that works instead of failing the same way.
  failCooldownMs = 10 * 60_000,
  now = Date.now,
}) {
  if (!hostUrl) throw new Error('the image bridge needs the coordinator URL (ALPHA_HOST_URL)');
  if (!token) throw new Error('the image bridge needs a tunnel key with tasks:read and tasks:write');
  const base = hostUrl.replace(/\/+$/, '');
  // Unset means the default, `auto`: an image bridge that let placement pick
  // could not say which machine holds the PNG.
  const pool = parsePool(targetAgent || 'auto');
  const fixedAgent = pool ? null : String(targetAgent).trim();
  const inPool = (name) => (pool === 'auto' ? true : pool ? pool.includes(name) : name === fixedAgent);

  async function coordinator(path, options = {}) {
    const { status, body } = await fetch(`${base}${path}`, { token, ...options });
    return { status, body };
  }

  /** The agent list, or null when this key may not read it. */
  async function agents() {
    try {
      const { body } = await coordinator('/agents');
      return Array.isArray(body?.agents) ? body.agents : [];
    } catch (error) {
      if (error instanceof HttpError && (error.status === 401 || error.status === 403)) return null;
      throw error;
    }
  }

  function imageMachines(list) {
    return list
      .map((agent) => describeAgent(agent, 'alpha.image'))
      .filter((m) => m && m.name && m.stale !== true && inPool(m.name));
  }

  /**
   * The machine for one image. With the agent list readable and nobody able to
   * render, that is a 503 now rather than a task Alpha waits eleven minutes
   * on. Unreadable, it falls back the way music does: a named pool's first
   * machine, or (auto) letting placement choose and asking who took it after.
   */
  const failedAt = new Map();
  function coolingDown() {
    const names = new Set();
    for (const [name, at] of failedAt) {
      if (now() - at < failCooldownMs) names.add(name);
      else failedAt.delete(name);
    }
    return names;
  }

  async function machineForImage(tried = new Set()) {
    let list;
    try {
      list = await agents();
    } catch {
      list = null;
    }
    if (list === null) {
      const fallback = fixedAgent ?? (pool === 'auto' ? null : pool.find((name) => !tried.has(name)) ?? null);
      if (tried.size && !fallback) throw new ProtocolError('no other machine to try', { status: 503, code: 'no_image_machine' });
      return fallback;
    }
    let pick;
    if (fixedAgent) pick = imageMachines(list).length && !tried.has(fixedAgent) ? fixedAgent : null;
    else {
      // Machines that failed recently are a last resort, never a first choice.
      pick = pickMachine(list, 'alpha.image', pool, new Set([...tried, ...coolingDown()]))
        ?? pickMachine(list, 'alpha.image', pool, tried);
    }
    if (!pick) {
      throw new ProtocolError('no attached machine offers alpha.image right now', { status: 503, code: 'no_image_machine' });
    }
    return pick;
  }

  async function sdModels(res) {
    const list = await agents();
    // A key without agents:read cannot tell; say "up" rather than switching
    // Alpha's image feature off over a scope.
    if (list === null) return send(res, 200, [{ title: MODEL_NAME, model_name: MODEL_NAME }]);
    const names = imageMachines(list).map((m) => m.name);
    if (names.length === 0) return send(res, 503, { error: 'no_image_machine', message: 'no attached machine offers alpha.image' });
    return send(res, 200, [{ title: `${MODEL_NAME} (${names.join(', ')})`, model_name: MODEL_NAME }]);
  }

  async function waitFor(taskId, deadline, what, late) {
    while (Date.now() < deadline) {
      const { body: task } = await coordinator(`/tasks/${encodeURIComponent(taskId)}`);
      if (task.status === 'succeeded') return task;
      if (task.status === 'failed' || task.status === 'cancelled') {
        throw new ProtocolError(`${what}: ${task.error?.message ?? task.status}`, { status: 502, code: 'image_failed' });
      }
      await sleep(pollMs);
    }
    // Left to its lease; cancelling needs a scope this key lacks.
    throw new ProtocolError(late(), { status: 504, code: 'image_timeout' });
  }

  /** The name a machine is registered under, for a task placement chose. */
  async function nameOf(agentId) {
    const list = await agents().catch(() => null);
    return list?.find((agent) => agent.id === agentId)?.name ?? null;
  }

  /** Brings one PNG back from `machine`, slice by slice. */
  async function download(machine, name) {
    const parts = [];
    let offset = 0;
    let total = null;
    for (;;) {
      const { body: queued } = await coordinator('/tasks', {
        method: 'POST',
        body: { type: 'alpha.image.file', payload: { name, offset }, targetAgent: machine, leaseMs: 60_000, maxAttempts: 2 },
      });
      const task = await waitFor(
        queued.id,
        Date.now() + chunkTimeoutMs,
        `${machine} could not send the image`,
        () => `${machine} did not send the image within ${Math.round(chunkTimeoutMs / 1000)}s. Is it offering alpha.image.file?`,
      );
      const slice = task.result ?? {};
      if (total === null) total = slice.totalBytes;
      if (!Number.isSafeInteger(total) || total > MAX_IMAGE_BYTES || slice.totalBytes !== total) {
        throw new ProtocolError('the image changed or arrived malformed while it was being fetched', { status: 502, code: 'fetch_failed' });
      }
      const data = Buffer.from(slice.data ?? '', 'base64');
      if (data.length !== slice.bytes) throw new ProtocolError('a slice arrived damaged', { status: 502, code: 'fetch_failed' });
      parts.push(data);
      offset += data.length;
      if (offset >= total) break;
      if (data.length === 0) throw new ProtocolError('the image stopped short', { status: 502, code: 'fetch_failed' });
    }
    return Buffer.concat(parts);
  }

  async function renderOne(settings, deadline, tried = new Set()) {
    const machine = await machineForImage(tried);
    const { body: queued } = await coordinator('/tasks', {
      method: 'POST',
      body: { type: 'alpha.image', payload: settings, leaseMs, ...(machine ? { targetAgent: machine } : {}) },
    });
    let task;
    try {
      task = await waitFor(
        queued.id,
        deadline,
        `${machine ?? 'the image machine'} could not render the image`,
        () => `the image was not ready within ${Math.round(timeoutMs / 1000)}s` +
          (queued.agentAvailable === false ? '; no attached machine offers alpha.image' : ''),
      );
    } catch (error) {
      if (error instanceof ProtocolError && error.code === 'image_failed' && machine) error.machine = machine;
      throw error;
    }
    const output = (Array.isArray(task.result?.outputs) ? task.result.outputs : [])
      .find((o) => typeof o?.name === 'string' && IMAGE_NAME_PATTERN.test(o.name));
    if (!output) throw new ProtocolError('the image task reported no PNG', { status: 502, code: 'no_image' });
    const holder = task.targetAgent ?? (await nameOf(task.agentId));
    if (!holder) {
      throw new ProtocolError('the image was made, but the bridge cannot tell which machine holds it (its key needs agents:read)', {
        status: 502,
        code: 'no_image_machine',
      });
    }
    const png = await download(holder, output.name);
    return { task, holder, png, recipe: task.result.recipe ?? settings };
  }

  /** One image; a machine that fails it is set aside and the next one tries. */
  async function renderWithRetry(settings, deadline) {
    const tried = new Set();
    for (;;) {
      try {
        return await renderOne(settings, deadline, tried);
      } catch (error) {
        const failed = error instanceof ProtocolError && error.code === 'image_failed' ? error.machine : null;
        if (!failed || fixedAgent || Date.now() >= deadline) throw error;
        failedAt.set(failed, now());
        tried.add(failed);
        try {
          await machineForImage(tried);
        } catch {
          throw error; // nobody else to ask: the first failure is the answer
        }
      }
    }
  }

  async function txt2img(req, res) {
    const { settings, batchSize } = validateTxt2img(await readBody(req));
    const deadline = Date.now() + timeoutMs;
    const rendered = [];
    for (let i = 0; i < batchSize; i++) {
      // A fixed seed walks forward per image, as A1111 does with a batch.
      const seed = settings.seed === -1 ? -1 : (settings.seed + i) % 4_294_967_296;
      rendered.push(await renderWithRetry({ ...settings, seed }, deadline));
    }
    const [first] = rendered;
    return send(res, 200, {
      images: rendered.map((r) => r.png.toString('base64')),
      parameters: { ...first.recipe, batch_size: batchSize },
      info: JSON.stringify({
        seed: first.recipe.seed,
        all_seeds: rendered.map((r) => r.recipe.seed),
        machine: first.holder,
        machines: rendered.map((r) => r.holder),
        backend: first.task.result.backend ?? null,
        durationMs: first.task.result.durationMs ?? null,
        taskId: first.task.id,
        taskIds: rendered.map((r) => r.task.id),
      }),
    });
  }

  async function passThrough(req, res, path) {
    if (!directUrl) return send(res, 404, { error: 'not_found', message: `${path} is not shared through the fleet and no direct generator is set (ALPHA_IMAGE_DIRECT_URL)` });
    const body = req.method === 'POST' ? await readRaw(req) : undefined;
    let upstream;
    try {
      upstream = await globalThis.fetch(`${directUrl.replace(/\/+$/, '')}${path}`, {
        method: req.method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body,
      });
    } catch (error) {
      return send(res, 502, { error: 'direct_generator_unreachable', message: `${directUrl} did not answer: ${error.message}` });
    }
    const out = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json', 'Content-Length': out.length });
    res.end(out);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://bridge');
      if (req.method === 'POST' && url.pathname === '/sdapi/v1/img2img') return await passThrough(req, res, '/sdapi/v1/img2img');
      if (req.method === 'GET' && url.pathname === '/sdapi/v1/progress') return await passThrough(req, res, `/sdapi/v1/progress${url.search}`);
      if (req.method === 'POST' && url.pathname === '/sdapi/v1/txt2img') return await txt2img(req, res);
      if (req.method === 'GET' && url.pathname === '/sdapi/v1/sd-models') return await sdModels(res);
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
      return send(res, 404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof ProtocolError) {
        return send(res, error.status ?? 400, { error: error.code ?? 'bad_request', message: error.message });
      }
      if (error instanceof HttpError) {
        // A 401/403 here is the bridge's key, not Alpha, so say so.
        const keyProblem = error.status === 401 || error.status === 403;
        return send(res, 502, {
          error: keyProblem ? 'bridge_key_rejected' : 'coordinator_error',
          message: keyProblem
            ? 'the image bridge\'s tunnel key was refused; it needs tasks:read and tasks:write'
            : (error.body?.message ?? error.message),
        });
      }
      return send(res, 502, { error: 'coordinator_unreachable', message: error.message });
    }
  });

  return { server };
}

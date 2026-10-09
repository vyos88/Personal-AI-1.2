import { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fetchJson, HttpError } from '../common/http.js';
import { ProtocolError, TERMINAL_STATUSES } from '../common/protocol.js';
import { validateSettings } from '../agent/handlers/alpha-music.js';

/**
 * The Music Creator panel's backend: two routes that turn a Generate click
 * into an `alpha.music` task and report on it.
 *
 *   POST /music/generate     { genre, subgenre, bpm?, key, vocals, seed, durationSec? }
 *                            → 202 { taskId, recipe, agentAvailable, targetAttached }
 *   GET  /music/tasks/:id    → { taskId, status, recipe, outputs, error, ... }
 *   GET  /music/tasks/:id/audio → the track itself, with Range support
 *   /music/billing/*         → subscriptions, when billing is configured (billing.js)
 *
 * Why a bridge rather than the browser calling the coordinator: queueing a task
 * needs a bearer token, and a token in a web page is a token anyone who can
 * open that page can read. The bridge keeps its key server-side, and the key
 * it needs is narrow (tasks:read + tasks:write). It narrows further than any
 * scope can: it queues `alpha.music` and nothing else, with a lease and target
 * machine taken from its own configuration, never from the request. And it
 * reads back only `alpha.music` tasks, so it cannot be used to browse the rest
 * of the queue by id.
 *
 * Settings are validated with the handler's own `validateSettings`, so the
 * panel gets a 400 with the reason instead of a task that fails on a laptop a
 * minute later. The one thing it does not decide is vocals: it cannot know
 * which machine will run the task, so that machine's agent says whether it can
 * sing.
 *
 * It binds loopback by default. Alpha's frontend reaches it same-origin:
 * route `/music/*` to it from whatever serves the frontend (Alpha's backend,
 * or the dev server's proxy). There is deliberately no CORS header: a page on
 * another origin has no business queueing work on this fleet.
 */

export const DEFAULT_LEASE_MS = 600_000;
const MAX_BODY_BYTES = 16 * 1024;
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const AUDIO_TYPES = { wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg' };
const AUDIO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.(wav|mp3|flac|ogg)$/;

/** The track a finished music task made, if it made one the bridge can serve. */
export function audioOutput(task) {
  const outputs = Array.isArray(task?.result?.outputs) ? task.result.outputs : [];
  return outputs.find((output) => typeof output?.name === 'string' && AUDIO_NAME.test(output.name) && !output.name.includes('..')) ?? null;
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
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
  if (text.trim() === '') throw new ProtocolError('request body must be the music settings as JSON');
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError('request body is not valid JSON');
  }
}

/**
 * Serves a cached track, honouring a single `Range: bytes=a-b`. Browsers ask
 * for ranges to seek in an <audio> element; answering only with the whole file
 * leaves the scrubber inert in some of them.
 */
function serveFile(req, res, path, contentType) {
  const size = statSync(path).size;
  const headers = { 'content-type': contentType, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] !== '' || range[2] !== '')) {
    let start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
    let end = range[1] === '' || range[2] === '' ? size - 1 : Number(range[2]);
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end || start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    return createReadStream(path, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length': size });
  return createReadStream(path).pipe(res);
}

/**
 * What the panel needs to know about a task, and nothing else. Output paths
 * are paths on the generating machine, meaningless to a browser, so only
 * names and sizes go back.
 */
export function describeTask(task) {
  const result = task.result ?? null;
  return {
    taskId: task.id,
    status: task.status,
    done: TERMINAL_STATUSES.has(task.status),
    recipe: result?.recipe ?? task.payload ?? null,
    bpmTypical: result?.bpmTypical ?? null,
    outputs: Array.isArray(result?.outputs)
      ? result.outputs.map((output) => ({ name: output.name, bytes: output.bytes }))
      : [],
    generatedInMs: result?.generatedInMs ?? null,
    // Whether the panel can offer a player: the track has to exist, and the
    // bridge has to know which machine holds it, which only a targeted task
    // says (see `agent` below).
    playback: task.status !== 'succeeded' || !audioOutput(task) ? null : task.targetAgent ? 'ready' : 'no_music_machine',
    attempts: task.attempts,
    // The machine by name, never the registration id: ids are minted per
    // registration and mean nothing to a person. A targeted task can only run
    // on the machine with that name; an untargeted one names nobody, because
    // the bridge's key cannot read the agent list to look one up.
    agent: task.targetAgent ?? null,
    error: task.error ? { message: task.error.message ?? String(task.error), code: task.error.code ?? null } : null,
  };
}

export function createMusicBridge({
  hostUrl,
  token,
  targetAgent = null,
  leaseMs = DEFAULT_LEASE_MS,
  fetch = fetchJson,
  // Where fetched tracks are kept. Each track crosses the tunnel once: the
  // coordinator holds every task result in memory for as long as it runs, so
  // re-fetching per play would grow it by the size of the track every time.
  cacheDir = join(tmpdir(), 'alpha-music-bridge'),
  chunkTimeoutMs = 60_000,
  pollMs = 150,
  // How many tracks the cache keeps. The generating machine still holds every
  // one, so an evicted track only costs a re-fetch; an unbounded cache costs
  // the bridge's disk, a few MB per track, for as long as it runs.
  cacheMaxTracks = 50,
  // Music Creator subscriptions (src/bridge/billing.js). Null: every click
  // generates, as before billing existed.
  billing = null,
}) {
  if (!hostUrl) throw new Error('the music bridge needs the coordinator URL (ALPHA_HOST_URL)');
  if (!token) throw new Error('the music bridge needs a tunnel key with tasks:read and tasks:write');
  const base = hostUrl.replace(/\/+$/, '');

  async function coordinator(path, options = {}) {
    const { status, body } = await fetch(`${base}${path}`, { token, ...options });
    return { status, body };
  }

  async function generate(req, res) {
    const settings = await readBody(req);
    const recipe = validateSettings(settings, { allowVocals: true });
    // Spent only once the settings are known good, and handed back if the
    // coordinator never takes the task: a refused click costs no free track.
    const refund = billing ? billing.reserve(billing.account(req, res)) : () => {};
    let body;
    try {
      ({ body } = await coordinator('/tasks', {
        method: 'POST',
        body: {
          type: 'alpha.music',
          payload: recipe,
          leaseMs,
          ...(targetAgent ? { targetAgent } : {}),
        },
      }));
    } catch (error) {
      refund();
      throw error;
    }
    return send(res, 202, {
      taskId: body.id,
      status: body.status,
      recipe,
      // Queued is not running. These say whether anything can pick it up, so
      // the panel can say "no machine can make music right now" instead of
      // spinning forever.
      agentAvailable: body.agentAvailable ?? null,
      targetAgent: body.targetAgent ?? null,
      targetAttached: body.targetAttached ?? null,
    });
  }

  /** A music task by id, or null for anything else: not a window onto the queue. */
  async function musicTask(taskId) {
    if (!TASK_ID_PATTERN.test(taskId)) throw new ProtocolError('bad task id', { code: 'bad_task_id' });
    try {
      const { body: task } = await coordinator(`/tasks/${encodeURIComponent(taskId)}`);
      return task?.type === 'alpha.music' ? task : null;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
  }

  async function status(res, taskId) {
    const task = await musicTask(taskId);
    if (!task) return send(res, 404, { error: 'unknown_task' });
    return send(res, 200, describeTask(task));
  }

  /** Queues one slice fetch on the music machine and waits for its answer. */
  async function fetchSlice(machine, genre, name, offset) {
    const { body: queued } = await coordinator('/tasks', {
      method: 'POST',
      body: { type: 'alpha.music.audio', payload: { genre, name, offset }, targetAgent: machine, leaseMs: 60_000, maxAttempts: 2 },
    });
    const deadline = Date.now() + chunkTimeoutMs;
    while (Date.now() < deadline) {
      const { body: task } = await coordinator(`/tasks/${encodeURIComponent(queued.id)}`);
      if (task.status === 'succeeded') return task.result;
      if (task.status === 'failed' || task.status === 'cancelled') {
        throw new ProtocolError(`${machine} could not send the track: ${task.error?.message ?? task.status}`, { status: 502, code: 'fetch_failed' });
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
    }
    // Leave the slice task to its lease; cancelling needs a scope this key lacks.
    throw new ProtocolError(
      `${machine} did not send the track within ${Math.round(chunkTimeoutMs / 1000)}s. Is it attached and offering alpha.music.audio?`,
      { status: 504, code: 'fetch_timeout' },
    );
  }

  /**
   * Brings a whole track across, slice by slice, into the cache. A file that
   * changes mid-download (a re-run with the same recipe replaces it in place)
   * restarts the download rather than stitching two versions together.
   */
  async function download(machine, genre, name, dest) {
    for (let restart = 0; restart < 3; restart++) {
      const partial = `${dest}.part`;
      writeFileSync(partial, Buffer.alloc(0));
      let offset = 0;
      let identity = null;
      let changed = false;
      for (;;) {
        const slice = await fetchSlice(machine, genre, name, offset);
        const sliceIdentity = `${slice.totalBytes}:${slice.mtimeMs}`;
        if (identity !== null && sliceIdentity !== identity) {
          changed = true;
          break;
        }
        identity = sliceIdentity;
        const data = Buffer.from(slice.data ?? '', 'base64');
        if (data.length !== slice.bytes) throw new ProtocolError('a slice arrived damaged', { status: 502, code: 'fetch_failed' });
        appendFileSync(partial, data);
        offset += data.length;
        if (offset >= slice.totalBytes) break;
        if (data.length === 0) throw new ProtocolError('the track stopped short', { status: 502, code: 'fetch_failed' });
      }
      if (!changed) {
        renameSync(partial, dest);
        return;
      }
      rmSync(partial, { force: true });
    }
    throw new ProtocolError(`${name} kept changing while it was being fetched`, { status: 502, code: 'fetch_failed' });
  }

  const downloads = new Map();

  /** Drops the least recently fetched tracks beyond cacheMaxTracks, never `keep`. */
  function pruneCache(keep) {
    const tracks = readdirSync(cacheDir)
      .filter((name) => !name.endsWith('.part'))
      .map((name) => ({ path: join(cacheDir, name), mtimeMs: statSync(join(cacheDir, name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const track of tracks.slice(cacheMaxTracks)) {
      // A download being played right now must not vanish from under it.
      if (track.path !== keep && !downloads.has(track.path)) rmSync(track.path, { force: true });
    }
  }

  async function audio(req, res, taskId) {
    const task = await musicTask(taskId);
    if (!task) return send(res, 404, { error: 'unknown_task' });
    if (task.status !== 'succeeded') return send(res, 409, { error: 'not_ready', message: `the track is ${task.status}` });
    const track = audioOutput(task);
    if (!track) return send(res, 404, { error: 'no_audio', message: 'this task wrote no audio' });
    if (!task.targetAgent) {
      return send(res, 409, {
        error: 'no_music_machine',
        message: 'playback needs ALPHA_MUSIC_AGENT set on the bridge, so it knows which machine holds the track',
      });
    }
    const genre = task.result?.recipe?.genre ?? task.payload?.genre;

    mkdirSync(cacheDir, { recursive: true });
    // Task ids and track names are both pattern-checked, so this stays in cacheDir.
    const dest = join(cacheDir, `${task.id}-${track.name}`);
    if (!existsSync(dest)) {
      // Two plays of the same track while it is fetching share one download.
      let pending = downloads.get(dest);
      if (!pending) {
        pending = download(task.targetAgent, genre, track.name, dest).finally(() => downloads.delete(dest));
        downloads.set(dest, pending);
      }
      await pending;
      pruneCache(dest);
    }
    return serveFile(req, res, dest, AUDIO_TYPES[track.name.split('.').pop().toLowerCase()]);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://bridge');
      if (req.method === 'POST' && url.pathname === '/music/generate') return await generate(req, res);
      const audioMatch = /^\/music\/tasks\/([^/]+)\/audio$/.exec(url.pathname);
      if (req.method === 'GET' && audioMatch) return await audio(req, res, decodeURIComponent(audioMatch[1]));
      const match = /^\/music\/tasks\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && match) return await status(res, decodeURIComponent(match[1]));
      if (req.method === 'GET' && url.pathname === '/music/healthz') return send(res, 200, { ok: true });
      if (url.pathname === '/music/billing' || url.pathname.startsWith('/music/billing/')) {
        if (billing) return await billing.handle(req, res, url.pathname, send);
        if (req.method === 'GET' && url.pathname === '/music/billing') return send(res, 200, { billingEnabled: false });
      }
      return send(res, 404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof ProtocolError) {
        return send(res, error.status ?? 400, { error: error.code ?? 'bad_request', message: error.message });
      }
      if (error instanceof HttpError) {
        // The coordinator's refusal, passed on with its reason. A 401/403 here
        // is the bridge's key, not the person clicking, so say so.
        const keyProblem = error.status === 401 || error.status === 403;
        return send(res, 502, {
          error: keyProblem ? 'bridge_key_rejected' : 'coordinator_error',
          message: keyProblem
            ? 'the music bridge\'s tunnel key was refused; it needs tasks:read and tasks:write'
            : (error.body?.message ?? error.message),
        });
      }
      return send(res, 502, { error: 'coordinator_unreachable', message: error.message });
    }
  });

  return { server };
}

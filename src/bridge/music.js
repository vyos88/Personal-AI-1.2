import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fetchJson, HttpError } from '../common/http.js';
import { ProtocolError, TERMINAL_STATUSES } from '../common/protocol.js';
import { validateSettings } from '../agent/handlers/alpha-music.js';
import { describeAgent, parsePool, pickMachine } from './pick.js';

/**
 * The Music Creator panel's backend: the routes that turn a Generate click
 * into an `alpha.music` task and report on it.
 *
 *   POST /music/generate     { genre, subgenre, bpm?, key, vocals, seed, durationSec? }
 *                            → 202 { taskId, recipe, agentAvailable, targetAttached }
 *   GET  /music/tasks/:id    → { taskId, status, recipe, outputs, error, ... }
 *   GET  /music/tasks/:id/audio → the track itself, with Range support; a
 *                            503 `still_fetching` while it is still coming
 *                            across (press play again: the download goes on)
 *   POST /music/tasks/:id/remove-vocals → queues `alpha.music.stems` against the
 *                            same track, on the same machine → 202 { taskId, ... }
 *                            (poll and play it back with the same two routes above)
 *   GET  /music/recipes      → { recipes: [...] } recent alpha.music receipts
 *   GET  /music/fleet        → { machines: [...] } who offers alpha.music now
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
 * The two read-only routes keep that shape. `/music/recipes` reads the
 * coordinator's ledger with `type=alpha.music` and passes on the recipe, the
 * outcome, the machine's name, output names and sizes and the times — never
 * paths, errors' internals or anything another task type left there. It needs
 * no scope beyond tasks:read, which the key already holds. `/music/fleet` reads
 * `/agents`, which needs agents:read; a key without it gets a 502
 * `bridge_key_rejected` naming that scope, and every other route goes on
 * working. Only machines offering `alpha.music` are listed, and only their
 * name, idle time and in-flight count: not ids, addresses, owners, memory or
 * the rest of their capabilities.
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
// Both task types the bridge will read back: a generation and a vocal removal
// run on one of its tracks. Anything else stays a 404, the "reads back music
// tasks only" rule this bridge has always held.
const MUSIC_TASK_TYPES = new Set(['alpha.music', 'alpha.music.stems']);
const DEFAULT_RECIPES = 50;
// How far back a forgotten track is looked for in the ledger: the most the
// coordinator's /receipts answers in one go.
const LEDGER_LOOKBACK = 1000;
const MAX_RECIPES = 200;

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

/**
 * One ledger receipt as the panel's recipe book sees it. The ledger keeps
 * output paths on the generating machine and an agent id; neither means
 * anything to a browser, so neither goes back. The task id does, because it
 * is what `/music/tasks/:id/audio` plays.
 */
export function describeReceipt(receipt) {
  return {
    taskId: receipt.id,
    status: receipt.status,
    recipe: receipt.recipe ?? null,
    agent: receipt.agent ?? null,
    outputs: Array.isArray(receipt.outputs)
      ? receipt.outputs.map((output) => ({ name: output?.name ?? null, bytes: output?.bytes ?? null }))
      : [],
    createdAt: receipt.createdAt ?? null,
    finishedAt: receipt.finishedAt ?? null,
    durationMs: receipt.durationMs ?? null,
  };
}

/**
 * A ledger receipt in the shape of the task it records, for a generation the
 * queue has let go of: what `describeTask` and playback read, and no more.
 * The receipt's machine is the one that ran it, which is where the file is.
 */
export function taskFromReceipt(receipt) {
  return {
    id: receipt.id,
    type: receipt.type,
    status: receipt.status,
    attempts: receipt.attempts ?? null,
    targetAgent: receipt.agent ?? null,
    payload: null,
    result: { recipe: receipt.recipe ?? null, outputs: Array.isArray(receipt.outputs) ? receipt.outputs : [] },
    error: receipt.error ?? null,
  };
}

/**
 * One attached machine as the panel's fleet line sees it, or null for a
 * machine that does not make music. The rule lives in ./pick.js, shared with
 * the image bridge.
 */
export function describeMachine(agent) {
  return describeAgent(agent, 'alpha.music');
}

/**
 * Which machine makes the next track, when the bridge is given a pool rather
 * than one machine: `auto` (any machine offering alpha.music) or a comma list.
 * The pick is pinned on the task, because playback has to know which machine
 * holds the file. Null when no machine in the pool is attached.
 */
export function pickMusicMachine(agents, pool) {
  return pickMachine(agents, 'alpha.music', pool);
}

/** "auto" or "a,b" -> a pool; one plain name -> null (that machine, always). */
export function musicPool(targetAgent) {
  return parsePool(targetAgent);
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
  // How long one slice may take once the music machine has it in hand.
  chunkTimeoutMs = 60_000,
  // How long a slice may wait to be picked up. The machine that made the
  // track may be making another one: with the express lane (EXPRESS_TASK_TYPES)
  // it reads slices anyway, and without it (an agent or coordinator from
  // before it) the slice waits for the song, which takes minutes, not one.
  queueWaitMs = 15 * 60_000,
  // How long a play request is held while the track comes across. Past it the
  // request is answered 503 `still_fetching` and the download goes on, so a
  // proxy in front of the site (Cloudflare gives up at 100 s) never cuts the
  // request off with nothing said. Pressing play again picks up where it got.
  holdMs = 45_000,
  // Ask the music machine for an MP3 of a WAV or FLAC track: a tenth of the
  // bytes over the tunnel. Machines without ffmpeg send the original.
  compress = true,
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
  const pool = musicPool(targetAgent);
  const fixedAgent = pool ? null : (targetAgent || null);

  // The machine for one track. A pool that cannot be read (a key without
  // agents:read, the coordinator busy) falls back to its first named machine,
  // or to letting placement choose, rather than refusing the click.
  async function machineForTrack() {
    if (!pool) return fixedAgent;
    try {
      const { body } = await coordinator('/agents');
      const pick = pickMusicMachine(body?.agents, pool);
      if (pick) return pick;
    } catch { /* fall through */ }
    return pool === 'auto' ? null : pool[0];
  }

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
      const machine = await machineForTrack();
      ({ body } = await coordinator('/tasks', {
        method: 'POST',
        body: {
          type: 'alpha.music',
          payload: recipe,
          leaseMs,
          ...(machine ? { targetAgent: machine } : {}),
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

  /**
   * A music task (generation or vocal removal) by id, or null for anything
   * else: not a window onto the queue.
   *
   * The coordinator forgets a finished task a day after it ends, or sooner
   * once 1,000 newer tasks have finished, and the fleet's own reports and
   * the slices of every played track count towards those 1,000: a track made
   * this morning was gone by evening. The recipe book lists the ledger, which
   * keeps 5,000 receipts on disk, so it showed tracks that Play then answered
   * `unknown_task`. A generation the queue has forgotten is therefore read
   * back from its receipt, which keeps everything playback needs: the recipe
   * (for the genre folder), the output names, and the machine that made it.
   * The same receipt names the machine for a task that was queued untargeted.
   */
  async function musicTask(taskId) {
    if (!TASK_ID_PATTERN.test(taskId)) throw new ProtocolError('bad task id', { code: 'bad_task_id' });
    let task = null;
    try {
      const { body } = await coordinator(`/tasks/${encodeURIComponent(taskId)}`);
      if (!(body?.type && MUSIC_TASK_TYPES.has(body.type))) return null;
      task = body;
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 404)) throw error;
    }
    if (task && (task.targetAgent || task.status !== 'succeeded' || task.type !== 'alpha.music')) return task;
    const receipt = await musicReceipt(taskId);
    if (task) return receipt?.agent ? { ...task, targetAgent: receipt.agent } : task;
    return receipt ? taskFromReceipt(receipt) : null;
  }

  /** The ledger's receipt for one generation, or null. */
  async function musicReceipt(taskId) {
    try {
      const { body } = await coordinator(`/receipts?type=alpha.music&limit=${LEDGER_LOOKBACK}`);
      const receipts = Array.isArray(body?.receipts) ? body.receipts : [];
      return receipts.find((receipt) => receipt?.id === taskId && receipt?.type === 'alpha.music') ?? null;
    } catch {
      // A ledger that cannot be read leaves the answer it always was.
      return null;
    }
  }

  async function status(res, taskId) {
    const task = await musicTask(taskId);
    if (!task) return send(res, 404, { error: 'unknown_task' });
    return send(res, 200, describeTask(task));
  }

  /**
   * Queues `alpha.music.stems` against a track a Generate click already made,
   * on the same machine that holds it — the file never leaves that machine,
   * so there is nowhere else to run the separation. Reuses the generate
   * route's shape (`taskId`, `agentAvailable`, `targetAttached`) rather than
   * inventing a second one: the panel polls and plays it back exactly the way
   * it does a generated track, via the same `/music/tasks/:id` and
   * `/music/tasks/:id/audio` routes.
   */
  async function removeVocals(res, sourceTaskId) {
    const source = await musicTask(sourceTaskId);
    if (!source || source.type !== 'alpha.music') return send(res, 404, { error: 'unknown_task' });
    if (source.status !== 'succeeded') {
      return send(res, 409, { error: 'not_ready', message: `the track is ${source.status}` });
    }
    const track = audioOutput(source);
    if (!track) return send(res, 404, { error: 'no_audio', message: 'this task wrote no audio' });
    if (!source.targetAgent) {
      return send(res, 409, {
        error: 'no_music_machine',
        message: 'removing vocals needs the machine that holds the track, and this task names none',
      });
    }
    const genre = source.result?.recipe?.genre ?? source.payload?.genre;
    const { body } = await coordinator('/tasks', {
      method: 'POST',
      body: {
        type: 'alpha.music.stems',
        payload: { genre, name: track.name },
        leaseMs,
        targetAgent: source.targetAgent,
      },
    });
    return send(res, 202, {
      taskId: body.id,
      status: body.status,
      agentAvailable: body.agentAvailable ?? null,
      targetAgent: body.targetAgent ?? null,
      targetAttached: body.targetAttached ?? null,
    });
  }

  /**
   * Queues one slice fetch on the music machine and waits for its answer:
   * up to `queueWaitMs` for the machine to pick it up, then `chunkTimeoutMs`
   * for it to answer. One minute for the whole thing was the old rule, and a
   * machine busy making a song never picked a slice up inside it.
   */
  async function fetchSlice(machine, payload) {
    const { body: queued } = await coordinator('/tasks', {
      method: 'POST',
      body: { type: 'alpha.music.audio', payload, targetAgent: machine, leaseMs: 60_000, maxAttempts: 2 },
    });
    const queuedAt = Date.now();
    let leasedAt = null;
    for (;;) {
      const { body: task } = await coordinator(`/tasks/${encodeURIComponent(queued.id)}`);
      if (task.status === 'succeeded') return task.result;
      if (task.status === 'failed' || task.status === 'cancelled') {
        throw new ProtocolError(`${machine} could not send the track: ${task.error?.message ?? task.status}`, { status: 502, code: 'fetch_failed' });
      }
      const now = Date.now();
      // Back to queued means its lease ran out; the minute starts again when
      // it is next picked up.
      leasedAt = task.status === 'leased' ? (leasedAt ?? now) : null;
      // Leave a timed-out slice task to its lease; cancelling needs a scope this key lacks.
      if (leasedAt !== null && now - leasedAt > chunkTimeoutMs) {
        throw new ProtocolError(
          `${machine} did not send the track within ${Math.round(chunkTimeoutMs / 1000)}s of starting to.`,
          { status: 504, code: 'fetch_timeout' },
        );
      }
      if (leasedAt === null && now - queuedAt > queueWaitMs) {
        throw new ProtocolError(
          `${machine} did not pick up the request for the track in ${Math.round(queueWaitMs / 60_000)} min. Is it on, and offering alpha.music.audio?`,
          { status: 504, code: 'fetch_timeout' },
        );
      }
      // Quick at first, when a slice is usually a fraction of a second away;
      // a slice waiting behind a song is polled once a second.
      await new Promise((resolveWait) => setTimeout(resolveWait, now - queuedAt < 5_000 ? pollMs : Math.max(pollMs, 1_000)));
    }
  }

  /**
   * Brings a whole track across, slice by slice, into the cache, and returns
   * where it landed: `<task id>-<name>`, where the name is the one the
   * machine sent (`.mp3` when it encoded the track).
   *
   * What came across is kept in `<task id>-<track>.part`, with what it is a
   * part of beside it in `.part.json`, so a download cut short (a timeout, the
   * machine going to sleep, the bridge restarting) carries on from there next
   * time rather than from the first byte. A file that changes mid-download (a
   * re-run with the same recipe replaces it in place) restarts the download
   * rather than stitching two versions together.
   */
  async function download(machine, genre, name, taskId, progress) {
    const partial = join(cacheDir, `${taskId}-${name}.part`);
    const marker = `${partial}.json`;
    let compressed = compress;
    let identity = null;
    let offset = 0;
    try {
      const saved = JSON.parse(readFileSync(marker, 'utf8'));
      if (typeof saved?.identity === 'string' && existsSync(partial)) {
        identity = saved.identity;
        compressed = saved.compressed === true;
        offset = statSync(partial).size;
      }
    } catch {
      // nothing to resume
    }
    const startOver = () => {
      identity = null;
      offset = 0;
      writeFileSync(partial, Buffer.alloc(0));
      rmSync(marker, { force: true });
    };
    if (identity === null) startOver();

    let restarts = 0;
    for (;;) {
      let slice;
      try {
        slice = await fetchSlice(machine, { genre, name, offset, ...(compressed ? { format: 'mp3' } : {}) });
      } catch (error) {
        // A machine from before `format` refuses the key: ask it for the original.
        if (compressed && error.code === 'fetch_failed' && /unknown key.*format/.test(error.message)) {
          compressed = false;
          startOver();
          continue;
        }
        // Resumed past the end of a file that has since shrunk.
        if (offset > 0 && error.code === 'fetch_failed' && /past the end/.test(error.message) && restarts++ < 3) {
          startOver();
          continue;
        }
        throw error;
      }
      const served = typeof slice.name === 'string' && AUDIO_NAME.test(slice.name) && !slice.name.includes('..') ? slice.name : name;
      const sliceIdentity = `${served}:${slice.totalBytes}:${slice.mtimeMs}`;
      if (identity !== null && sliceIdentity !== identity) {
        if (restarts++ >= 3) throw new ProtocolError(`${name} kept changing while it was being fetched`, { status: 502, code: 'fetch_failed' });
        startOver();
        continue;
      }
      if (identity === null) {
        identity = sliceIdentity;
        writeFileSync(marker, JSON.stringify({ identity, compressed }));
      }
      const data = Buffer.from(slice.data ?? '', 'base64');
      if (data.length !== slice.bytes) throw new ProtocolError('a slice arrived damaged', { status: 502, code: 'fetch_failed' });
      appendFileSync(partial, data);
      offset += data.length;
      progress.received = offset;
      progress.total = slice.totalBytes;
      if (offset >= slice.totalBytes) {
        const dest = join(cacheDir, `${taskId}-${served}`);
        renameSync(partial, dest);
        rmSync(marker, { force: true });
        return dest;
      }
      if (data.length === 0) throw new ProtocolError('the track stopped short', { status: 502, code: 'fetch_failed' });
    }
  }

  async function recipes(res, url) {
    const raw = url.searchParams.get('limit');
    const limit = raw === null ? DEFAULT_RECIPES : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECIPES) {
      throw new ProtocolError(`limit must be a whole number from 1 to ${MAX_RECIPES}`, { code: 'bad_limit' });
    }
    const { body } = await coordinator(`/receipts?type=alpha.music&limit=${limit}`);
    // Filtered again here: the bridge's promise is music only, and it should
    // not rest on the coordinator honouring a query parameter.
    const rows = Array.isArray(body?.receipts) ? body.receipts.filter((r) => r?.type === 'alpha.music') : [];
    return send(res, 200, { recipes: rows.map(describeReceipt) });
  }

  async function fleet(res) {
    let body;
    try {
      ({ body } = await coordinator('/agents'));
    } catch (error) {
      if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
        throw new ProtocolError(
          'the music bridge\'s tunnel key cannot list machines; issue it with agents:read as well to see the fleet',
          { status: 502, code: 'bridge_key_rejected' },
        );
      }
      throw error;
    }
    const agents = Array.isArray(body?.agents) ? body.agents : [];
    return send(res, 200, { machines: agents.map(describeMachine).filter(Boolean) });
  }

  // Downloads under way, by `<task id>-<track name>`. Each settles to the
  // cached file's path or to the Error that stopped it, never a rejection: a
  // download outlives the request that started it, and an unhandled rejection
  // would take the bridge down.
  const downloads = new Map();

  function startDownload(machine, genre, name, taskId) {
    const key = `${taskId}-${name}`;
    let entry = downloads.get(key);
    if (!entry) {
      entry = { received: 0, total: null };
      entry.promise = download(machine, genre, name, taskId, entry)
        .then((dest) => dest, (error) => error)
        .finally(() => downloads.delete(key));
      downloads.set(key, entry);
    }
    return entry;
  }

  /** The cached file for a track, as either name it may have been sent under. */
  function cachedTrack(taskId, name) {
    for (const candidate of [`${taskId}-${name.replace(/\.[^.]+$/, '.mp3')}`, `${taskId}-${name}`]) {
      const path = join(cacheDir, candidate);
      if (existsSync(path)) return path;
    }
    return null;
  }

  /**
   * Drops the least recently fetched tracks beyond cacheMaxTracks, never
   * `keep`, and the parts of downloads nobody has asked about for a day.
   */
  function pruneCache(keep) {
    const entries = readdirSync(cacheDir).map((name) => ({ name, path: join(cacheDir, name), mtimeMs: statSync(join(cacheDir, name)).mtimeMs }));
    const isPart = (entry) => entry.name.endsWith('.part') || entry.name.endsWith('.part.json');
    const dayAgo = Date.now() - 24 * 60 * 60_000;
    for (const entry of entries.filter(isPart)) {
      if (entry.mtimeMs < dayAgo) rmSync(entry.path, { force: true });
    }
    const tracks = entries.filter((entry) => !isPart(entry)).sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const track of tracks.slice(cacheMaxTracks)) {
      if (track.path !== keep) rmSync(track.path, { force: true });
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
    let path = cachedTrack(task.id, track.name);
    if (!path) {
      // Two plays of the same track while it is fetching share one download.
      const entry = startDownload(task.targetAgent, genre, track.name, task.id);
      let timer;
      const held = new Promise((resolveHold) => {
        timer = setTimeout(() => resolveHold(null), holdMs);
      });
      const outcome = await Promise.race([entry.promise, held]);
      clearTimeout(timer);
      if (outcome === null) {
        const kb = (bytes) => Math.round(bytes / 1024).toLocaleString('en-GB');
        res.setHeader('retry-after', '5');
        return send(res, 503, {
          error: 'still_fetching',
          message: `Still bringing the track over from ${task.targetAgent}${entry.total ? ` (${kb(entry.received)} of ${kb(entry.total)} KB)` : ''}. Press play again in a few seconds: it carries on from where it got to.`,
          received: entry.received,
          total: entry.total,
        });
      }
      if (outcome instanceof Error) throw outcome;
      path = outcome;
      pruneCache(path);
    }
    return serveFile(req, res, path, AUDIO_TYPES[path.split('.').pop().toLowerCase()]);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://bridge');
      if (req.method === 'POST' && url.pathname === '/music/generate') return await generate(req, res);
      const audioMatch = /^\/music\/tasks\/([^/]+)\/audio$/.exec(url.pathname);
      if (req.method === 'GET' && audioMatch) return await audio(req, res, decodeURIComponent(audioMatch[1]));
      const stemsMatch = /^\/music\/tasks\/([^/]+)\/remove-vocals$/.exec(url.pathname);
      if (req.method === 'POST' && stemsMatch) return await removeVocals(res, decodeURIComponent(stemsMatch[1]));
      const match = /^\/music\/tasks\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && match) return await status(res, decodeURIComponent(match[1]));
      if (req.method === 'GET' && url.pathname === '/music/recipes') return await recipes(res, url);
      if (req.method === 'GET' && url.pathname === '/music/fleet') return await fleet(res);
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

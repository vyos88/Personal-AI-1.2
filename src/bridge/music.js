import { createServer } from 'node:http';

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
    attempts: task.attempts,
    // The machine by name, never the registration id: ids are minted per
    // registration and mean nothing to a person. A targeted task can only run
    // on the machine with that name; an untargeted one names nobody, because
    // the bridge's key cannot read the agent list to look one up.
    agent: task.targetAgent ?? null,
    error: task.error ? { message: task.error.message ?? String(task.error), code: task.error.code ?? null } : null,
  };
}

export function createMusicBridge({ hostUrl, token, targetAgent = null, leaseMs = DEFAULT_LEASE_MS, fetch = fetchJson }) {
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
    const { body } = await coordinator('/tasks', {
      method: 'POST',
      body: {
        type: 'alpha.music',
        payload: recipe,
        leaseMs,
        ...(targetAgent ? { targetAgent } : {}),
      },
    });
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

  async function status(res, taskId) {
    if (!TASK_ID_PATTERN.test(taskId)) return send(res, 400, { error: 'bad_task_id' });
    let task;
    try {
      ({ body: task } = await coordinator(`/tasks/${encodeURIComponent(taskId)}`));
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return send(res, 404, { error: 'unknown_task' });
      throw error;
    }
    // Only music tasks: this is not a window onto the rest of the queue.
    if (task?.type !== 'alpha.music') return send(res, 404, { error: 'unknown_task' });
    return send(res, 200, describeTask(task));
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://bridge');
      if (req.method === 'POST' && url.pathname === '/music/generate') return await generate(req, res);
      const match = /^\/music\/tasks\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && match) return await status(res, decodeURIComponent(match[1]));
      if (req.method === 'GET' && url.pathname === '/music/healthz') return send(res, 200, { ok: true });
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

import http from 'node:http';

import { TaskQueue } from './queue.js';
import { AgentRegistry } from './registry.js';
import { bearerFrom, tokensMatch } from '../common/auth.js';
import { createLogger } from '../common/log.js';
import {
  PROTOCOL_VERSION,
  ProtocolError,
  MAX_POLL_WAIT_MS,
  validateRegistration,
  validateTaskInput,
} from '../common/protocol.js';

const log = createLogger('host:server');

const MAX_BODY_BYTES = 1_000_000;

export function createHost({ token, queue = new TaskQueue(), registry = new AgentRegistry() } = {}) {
  if (!token) throw new Error('createHost requires a token');

  const server = http.createServer((req, res) => {
    handle(req, res, { token, queue, registry }).catch((error) => {
      log.error('unhandled request error', { message: error.message, url: req.url });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      else res.end();
    });
  });

  // Long polls hold a socket open for up to MAX_POLL_WAIT_MS; the default
  // request timeout would cut them off mid-wait.
  server.requestTimeout = MAX_POLL_WAIT_MS + 15_000;
  server.headersTimeout = MAX_POLL_WAIT_MS + 20_000;
  server.keepAliveTimeout = MAX_POLL_WAIT_MS + 10_000;

  const pruner = setInterval(() => registry.prune(), 15_000);
  pruner.unref?.();

  queue.start();

  /**
   * Ordered shutdown. The queue has to be stopped *before* server.close(),
   * not from its 'close' event: parked long polls are live requests, so
   * server.close() waits on them, while the thing that releases them is
   * queue.stop(). Draining from the close event deadlocks the two against
   * each other and the process hangs until every poll times out.
   */
  async function close({ graceMs = 2_000 } = {}) {
    clearInterval(pruner);

    // Hand server.close() its completion callback up front. With nothing
    // connected it finishes immediately, and a 'close' listener attached
    // afterwards would miss the event and wait for one that never comes.
    const closed = new Promise((resolve) => server.close(() => resolve()));

    // Releases every parked waiter, so each handler resumes and answers 204.
    queue.stop();
    // Give those responses a turn of the loop to flush before reaping sockets.
    await new Promise((resolve) => setImmediate(resolve));
    server.closeIdleConnections();

    // Deliberately left ref'd: it keeps the loop alive long enough to force
    // the last sockets shut rather than letting the process drain mid-close.
    const forced = setTimeout(() => server.closeAllConnections(), graceMs);
    try {
      await closed;
    } finally {
      clearTimeout(forced);
    }
  }

  return { server, queue, registry, close };
}

async function handle(req, res, ctx) {
  const url = new URL(req.url, 'http://host.invalid');
  const segments = url.pathname.split('/').filter(Boolean);
  const { method } = req;

  if (method === 'GET' && url.pathname === '/healthz') {
    return sendJson(res, 200, { ok: true, protocolVersion: PROTOCOL_VERSION });
  }

  // Everything past /healthz is authenticated with the shared token.
  if (!tokensMatch(bearerFrom(req.headers) ?? '', ctx.token)) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  try {
    // POST /agent/register
    if (method === 'POST' && url.pathname === '/agent/register') {
      const body = await readJson(req);
      const { name, capabilities } = validateRegistration(body);
      const agent = ctx.registry.register({
        name,
        capabilities,
        remoteAddress: req.socket.remoteAddress,
      });
      return sendJson(res, 201, {
        agentId: agent.id,
        protocolVersion: PROTOCOL_VERSION,
        heartbeatIntervalMs: 20_000,
        maxPollWaitMs: MAX_POLL_WAIT_MS,
      });
    }

    if (segments[0] === 'agent' && segments.length >= 2) {
      const agentId = segments[1];
      const agent = ctx.registry.touch(agentId);
      if (!agent) {
        // Tell the agent to re-register rather than leaving it polling a
        // registration the host has already pruned.
        return sendJson(res, 410, { error: 'unknown_agent', code: 'reregister' });
      }

      // POST /agent/:id/heartbeat
      if (method === 'POST' && segments[2] === 'heartbeat' && segments.length === 3) {
        return sendJson(res, 200, { ok: true, queue: ctx.queue.stats() });
      }

      // DELETE /agent/:id
      if (method === 'DELETE' && segments.length === 2) {
        ctx.registry.deregister(agentId);
        return sendJson(res, 200, { ok: true });
      }

      // GET /agent/:id/tasks/next?wait=<ms>
      if (method === 'GET' && segments[2] === 'tasks' && segments[3] === 'next' && segments.length === 4) {
        const requested = Number.parseInt(url.searchParams.get('wait') ?? '', 10);
        const waitMs = Number.isFinite(requested) ? requested : MAX_POLL_WAIT_MS;

        const controller = new AbortController();
        const onClose = () => controller.abort();
        res.on('close', onClose);

        const task = await ctx.queue.lease({
          agentId,
          capabilities: agent.capabilities,
          waitMs,
          signal: controller.signal,
        });

        res.off('close', onClose);
        if (res.writableEnded || controller.signal.aborted) {
          // Agent hung up while parked. Release the task it never received.
          if (task) ctx.queue.fail(task.id, agentId, { message: 'agent disconnected while leasing', code: 'disconnected' });
          // Complete the response even though nobody is reading it: returning
          // here without ending leaves the request open and server.close()
          // waits on it forever.
          if (!res.writableEnded) res.end();
          return;
        }
        if (!task) return sendJson(res, 204, null);
        return sendJson(res, 200, {
          id: task.id,
          type: task.type,
          payload: task.payload,
          attempt: task.attempts,
          maxAttempts: task.maxAttempts,
          leaseMs: task.leaseMs,
        });
      }

      // POST /agent/:id/tasks/:taskId/result
      if (method === 'POST' && segments[2] === 'tasks' && segments[4] === 'result' && segments.length === 5) {
        const taskId = segments[3];
        const body = await readJson(req);
        if (!body || typeof body !== 'object') throw new ProtocolError('result body must be a JSON object');

        const succeeded = body.ok === true;
        const task = succeeded
          ? ctx.queue.complete(taskId, agentId, body.result ?? null)
          : ctx.queue.fail(taskId, agentId, body.error ?? { message: 'agent reported failure' });
        ctx.registry.recordOutcome(agentId, succeeded);
        return sendJson(res, 200, { ok: true, status: task.status });
      }
    }

    // POST /tasks
    if (method === 'POST' && url.pathname === '/tasks') {
      const body = await readJson(req);
      const input = validateTaskInput(body);
      const covered = ctx.registry.coveredCapabilities();
      const task = ctx.queue.enqueue(input);
      return sendJson(res, 202, {
        id: task.id,
        status: task.status,
        // Not an error: the task waits until a capable agent attaches. Surfaced
        // so a caller can tell "queued and running" from "queued forever".
        agentAvailable: covered.includes(task.type),
      });
    }

    // GET /tasks
    if (method === 'GET' && url.pathname === '/tasks') {
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
      return sendJson(res, 200, {
        tasks: ctx.queue.list({
          status: url.searchParams.get('status') ?? undefined,
          limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 50,
        }),
      });
    }

    if (segments[0] === 'tasks' && segments.length >= 2) {
      const taskId = segments[1];

      if (method === 'GET' && segments.length === 2) {
        const task = ctx.queue.get(taskId);
        if (!task) return sendJson(res, 404, { error: 'unknown_task' });
        return sendJson(res, 200, task);
      }

      if (method === 'POST' && segments[2] === 'cancel' && segments.length === 3) {
        const task = ctx.queue.cancel(taskId);
        if (!task) return sendJson(res, 404, { error: 'unknown_task' });
        return sendJson(res, 200, { id: task.id, status: task.status });
      }
    }

    // GET /agents
    if (method === 'GET' && url.pathname === '/agents') {
      return sendJson(res, 200, { agents: ctx.registry.list() });
    }

    // GET /stats
    if (method === 'GET' && url.pathname === '/stats') {
      return sendJson(res, 200, {
        queue: ctx.queue.stats(),
        agents: ctx.registry.list().length,
        capabilities: ctx.registry.coveredCapabilities(),
      });
    }

    return sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    if (error instanceof ProtocolError) {
      return sendJson(res, error.status, { error: error.code, message: error.message });
    }
    if (typeof error.status === 'number') {
      return sendJson(res, error.status, { error: 'conflict', message: error.message });
    }
    throw error;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      // Stop reading a body that is already too large instead of buffering it.
      if (size > MAX_BODY_BYTES) {
        reject(new ProtocolError('request body too large', { status: 413, code: 'payload_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', reject);

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ProtocolError('request body is not valid JSON'));
      }
    });
  });
}

function sendJson(res, status, body) {
  if (res.writableEnded) return;
  if (status === 204 || body === null) {
    res.writeHead(204);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

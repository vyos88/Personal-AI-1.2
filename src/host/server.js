import http from 'node:http';

import { TaskQueue } from './queue.js';
import { AgentRegistry } from './registry.js';
import { AuthService } from './auth/service.js';
import { AuthStore } from './auth/store.js';
import { SCOPES, ALL_SCOPES, SCOPE_PRESETS, hasScope } from './auth/scopes.js';
import { bearerFrom } from '../common/auth.js';
import { createLogger } from '../common/log.js';
import {
  PROTOCOL_VERSION,
  ProtocolError,
  MAX_POLL_WAIT_MS,
  validateRegistration,
  validateTaskInput,
  validateMemoryReport,
} from '../common/protocol.js';

const log = createLogger('host:server');

const MAX_BODY_BYTES = 1_000_000;

// `registry` is destructured before `queue` on purpose: the default queue is
// built with the registry as its admission controller, which is what makes
// memory-aware placement work without the caller having to wire it up.
export function createHost({
  auth,
  token,
  registry = new AgentRegistry(),
  queue = new TaskQueue({ admission: registry }),
} = {}) {
  // `token` is the convenience path: it builds an ephemeral auth service whose
  // only credential is that bootstrap token. Real deployments pass `auth` so
  // users and keys persist.
  const authService =
    auth ?? new AuthService({ bootstrapToken: token, store: new AuthStore({ path: null }) });
  if (!auth && !token) {
    throw new Error('createHost requires either an AuthService (`auth`) or a bootstrap `token`');
  }

  const ready = auth ? Promise.resolve(authService) : authService.load();

  const server = http.createServer((req, res) => {
    ready
      .then(() => handle(req, res, { auth: authService, queue, registry }))
      .catch((error) => {
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

  return { server, queue, registry, auth: authService, ready, close };
}

async function handle(req, res, ctx) {
  const url = new URL(req.url, 'http://host.invalid');
  const segments = url.pathname.split('/').filter(Boolean);
  const { method } = req;

  try {
    // ---------------------------------------------------------- public routes
    if (method === 'GET' && url.pathname === '/healthz') {
      return sendJson(res, 200, { ok: true, protocolVersion: PROTOCOL_VERSION });
    }

    // The invite token is itself the credential for these two, so they cannot
    // require a bearer token — that is the whole point of an invite.
    if (method === 'POST' && url.pathname === '/invites/preview') {
      const body = await readJson(req);
      return sendJson(res, 200, ctx.auth.peekInvite(body?.token));
    }

    if (method === 'POST' && url.pathname === '/invites/redeem') {
      const body = await readJson(req);
      const result = await ctx.auth.redeemInvite({
        token: body?.token,
        password: body?.password,
        name: body?.name,
      });
      return sendJson(res, 201, result);
    }

    if (method === 'POST' && url.pathname === '/auth/login') {
      const body = await readJson(req);
      return sendJson(res, 200, await ctx.auth.login({ email: body?.email, password: body?.password }));
    }

    // --------------------------------------------------------- authentication
    const principal = await ctx.auth.authenticate(bearerFrom(req.headers) ?? '');
    if (!principal) return sendJson(res, 401, { error: 'unauthorized' });

    const require = (scope) => {
      if (!hasScope(principal.scopes, scope)) {
        throw new ProtocolError(`this credential lacks the "${scope}" scope`, {
          status: 403,
          code: 'insufficient_scope',
        });
      }
    };

    // --------------------------------------------------------------- identity
    if (method === 'GET' && url.pathname === '/me') {
      return sendJson(res, 200, {
        kind: principal.kind,
        label: principal.label,
        userId: principal.userId,
        scopes: principal.scopes,
        user: principal.userId ? ctx.auth.getUser(principal.userId) : null,
      });
    }

    if (method === 'POST' && url.pathname === '/me/password') {
      if (!principal.userId) {
        throw new ProtocolError('the bootstrap credential has no password to change', {
          status: 400,
          code: 'not_a_user',
        });
      }
      const body = await readJson(req);
      const user = await ctx.auth.changePassword({
        userId: principal.userId,
        currentPassword: body?.currentPassword,
        newPassword: body?.newPassword,
      });
      return sendJson(res, 200, { user });
    }

    if (method === 'GET' && url.pathname === '/scopes') {
      return sendJson(res, 200, { scopes: ALL_SCOPES, presets: SCOPE_PRESETS });
    }

    // ---------------------------------------------------------------- invites
    if (url.pathname === '/invites') {
      if (method === 'POST') {
        require(SCOPES.INVITES_WRITE);
        const body = await readJson(req);
        const { invite, token } = await ctx.auth.createInvite({
          email: body?.email,
          scopes: body?.scopes,
          expiresInMs: body?.expiresInMs,
          invitedBy: principal,
        });
        return sendJson(res, 201, {
          invite,
          // Shown exactly once. It is never stored in plaintext, so it cannot
          // be retrieved again — reissue the invite if it is lost.
          token,
          redeemUrl: inviteUrl(req, token),
        });
      }
      if (method === 'GET') {
        require(SCOPES.INVITES_READ);
        return sendJson(res, 200, {
          invites: ctx.auth.listInvites({ status: url.searchParams.get('status') ?? undefined }),
        });
      }
    }

    if (method === 'DELETE' && segments[0] === 'invites' && segments.length === 2) {
      require(SCOPES.INVITES_WRITE);
      return sendJson(res, 200, { invite: await ctx.auth.revokeInvite(segments[1], principal) });
    }

    // ------------------------------------------------------------------ users
    if (method === 'GET' && url.pathname === '/users') {
      require(SCOPES.USERS_READ);
      return sendJson(res, 200, { users: ctx.auth.listUsers() });
    }

    if (segments[0] === 'users' && segments.length >= 2) {
      const userId = segments[1];

      if (method === 'GET' && segments.length === 2) {
        require(SCOPES.USERS_READ);
        const user = ctx.auth.getUser(userId);
        if (!user) return sendJson(res, 404, { error: 'unknown_user' });
        return sendJson(res, 200, { user });
      }

      if (method === 'POST' && segments[2] === 'status' && segments.length === 3) {
        require(SCOPES.USERS_WRITE);
        const body = await readJson(req);
        return sendJson(res, 200, {
          user: await ctx.auth.setUserStatus(userId, body?.status, principal),
        });
      }

      if (method === 'POST' && segments[2] === 'scopes' && segments.length === 3) {
        require(SCOPES.USERS_WRITE);
        const body = await readJson(req);
        return sendJson(res, 200, {
          user: await ctx.auth.setUserScopes(userId, body?.scopes, principal),
        });
      }
    }

    // ------------------------------------------------------------------- keys
    if (url.pathname === '/keys') {
      if (method === 'POST') {
        require(SCOPES.KEYS_WRITE);
        const body = await readJson(req);
        // Minting a key for somebody else is an administrative act; minting
        // one for yourself is routine.
        const targetUserId = body?.userId ?? principal.userId;
        if (!targetUserId) {
          throw new ProtocolError('bootstrap credential must name a userId', {
            status: 400,
            code: 'user_required',
          });
        }
        if (targetUserId !== principal.userId) require(SCOPES.USERS_WRITE);

        const { key, token } = await ctx.auth.createApiKey(
          {
            userId: targetUserId,
            name: body?.name,
            scopes: body?.scopes,
            expiresInMs: body?.expiresInMs,
          },
          principal,
        );
        return sendJson(res, 201, { key, token });
      }

      if (method === 'GET') {
        // Without users:read you can only see your own keys.
        const canSeeAll = hasScope(principal.scopes, SCOPES.USERS_READ);
        const requested = url.searchParams.get('userId') ?? undefined;
        if (requested && requested !== principal.userId && !canSeeAll) {
          require(SCOPES.USERS_READ);
        }
        return sendJson(res, 200, {
          keys: ctx.auth.listApiKeys({
            userId: requested ?? (canSeeAll ? undefined : principal.userId),
          }),
        });
      }
    }

    if (method === 'DELETE' && segments[0] === 'keys' && segments.length === 2) {
      const key = ctx.auth.listApiKeys().find((entry) => entry.id === segments[1]);
      if (!key) return sendJson(res, 404, { error: 'unknown_key' });
      // Anyone may revoke their own credential; revoking someone else's is an
      // administrative act.
      if (key.userId !== principal.userId) require(SCOPES.USERS_WRITE);
      return sendJson(res, 200, { key: await ctx.auth.revokeApiKey(segments[1], principal) });
    }

    // ------------------------------------------------------------ agent plane
    if (method === 'POST' && url.pathname === '/agent/register') {
      require(SCOPES.AGENT_CONNECT);
      const body = await readJson(req);
      const { name, capabilities, memory } = validateRegistration(body);
      const agent = ctx.registry.register({
        name,
        capabilities,
        memory,
        remoteAddress: req.socket.remoteAddress,
        principal: principal.label,
        userId: principal.userId,
      });
      return sendJson(res, 201, {
        agentId: agent.id,
        protocolVersion: PROTOCOL_VERSION,
        heartbeatIntervalMs: 20_000,
        maxPollWaitMs: MAX_POLL_WAIT_MS,
      });
    }

    if (segments[0] === 'agent' && segments.length >= 2) {
      require(SCOPES.AGENT_CONNECT);
      const agentId = segments[1];
      const agent = ctx.registry.touch(agentId);
      if (!agent) {
        // Tell the agent to re-register rather than leaving it polling a
        // registration the host has already pruned.
        return sendJson(res, 410, { error: 'unknown_agent', code: 'reregister' });
      }
      // One credential must not be able to drive another credential's agent.
      if (agent.userId && principal.userId && agent.userId !== principal.userId) {
        return sendJson(res, 403, { error: 'not_your_agent' });
      }

      if (method === 'POST' && segments[2] === 'heartbeat' && segments.length === 3) {
        // The heartbeat carries the agent's current memory reading. Free RAM
        // moves under the agent's own workload, so a report is only good
        // until the next beat — see MEMORY_REPORT_STALE_MS.
        const body = await readJson(req);
        ctx.registry.reportMemory(agentId, validateMemoryReport(body?.memory));
        return sendJson(res, 200, {
          ok: true,
          queue: ctx.queue.stats(),
          availableBytes: ctx.registry.offerableBytes(agentId),
        });
      }

      if (method === 'DELETE' && segments.length === 2) {
        ctx.registry.deregister(agentId);
        return sendJson(res, 200, { ok: true });
      }

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

    // ------------------------------------------------------------ task plane
    if (method === 'POST' && url.pathname === '/tasks') {
      require(SCOPES.TASKS_WRITE);
      const body = await readJson(req);
      const input = validateTaskInput(body);
      // Sampled before enqueueing: enqueue may place the task immediately, and
      // a task holding its own reservation would then report itself unplaceable.
      const typeCovered = ctx.registry.coveredCapabilities().includes(input.type);
      const placeable = ctx.registry.candidatesFor(input).length > 0;
      const task = ctx.queue.enqueue(input);
      return sendJson(res, 202, {
        id: task.id,
        status: task.status,
        minMemoryMB: task.minMemoryMB,
        // Not an error: the task waits until a capable agent attaches. Surfaced
        // so a caller can tell "queued and running" from "queued forever".
        agentAvailable: placeable,
        // Distinguishes the two ways a task can sit there: nobody runs this
        // type at all, or somebody does but has no RAM to spare for it.
        memoryAvailable: !typeCovered || placeable,
      });
    }

    if (method === 'GET' && url.pathname === '/tasks') {
      require(SCOPES.TASKS_READ);
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
        require(SCOPES.TASKS_READ);
        const task = ctx.queue.get(taskId);
        if (!task) return sendJson(res, 404, { error: 'unknown_task' });
        return sendJson(res, 200, task);
      }

      if (method === 'POST' && segments[2] === 'cancel' && segments.length === 3) {
        require(SCOPES.TASKS_CANCEL);
        const task = ctx.queue.cancel(taskId);
        if (!task) return sendJson(res, 404, { error: 'unknown_task' });
        return sendJson(res, 200, { id: task.id, status: task.status });
      }
    }

    if (method === 'GET' && url.pathname === '/agents') {
      require(SCOPES.AGENTS_READ);
      return sendJson(res, 200, { agents: ctx.registry.list() });
    }

    if (method === 'GET' && url.pathname === '/stats') {
      require(SCOPES.AGENTS_READ);
      return sendJson(res, 200, {
        queue: ctx.queue.stats(),
        agents: ctx.registry.list().length,
        capabilities: ctx.registry.coveredCapabilities(),
        memory: {
          offeredBytes: ctx.registry.offeredBytes(),
          blockedTasks: ctx.queue.memoryBlocked().length,
        },
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

/** Best-effort redeem URL, so an inviter has something to paste into a message. */
function inviteUrl(req, token) {
  const base = process.env.ALPHA_INVITE_BASE_URL ?? `http://${req.headers.host ?? 'localhost'}`;
  return `${base.replace(/\/+$/, '')}/invites/redeem#${encodeURIComponent(token)}`;
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

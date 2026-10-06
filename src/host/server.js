import http from 'node:http';

import { TaskQueue } from './queue.js';
import { AgentRegistry } from './registry.js';
import { AuthService } from './auth/service.js';
import { AuthStore } from './auth/store.js';
import { MessageStore, normalizeRecipient } from './messages.js';
import { DASHBOARD_HTML } from './dashboard.js';
import { cloudflareReport } from './cloudflare.js';
import { ReceiptStore } from './receipts.js';
import { TaskJournal, defaultJournalPath } from './journal.js';
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
  memoryReportFromQuery,
  validateLoadReport,
  loadReportFromQuery,
  HEARTBEAT_INTERVAL_MS,
} from '../common/protocol.js';
import { ALPHA_VERSION } from '../common/version.js';

const log = createLogger('host:server');

const MAX_BODY_BYTES = 1_000_000;

// `registry` is destructured before `queue` on purpose: the default queue is
// built with the registry as its admission controller, which is what makes
// memory-aware placement work without the caller having to wire it up.
export function createHost({
  auth,
  token,
  messages,
  registry = new AgentRegistry(),
  // The ledger of finished work. Built before the queue below, because the
  // default queue is wired to write to it as tasks finish.
  //
  // Whether it persists follows whether the *credentials* do. A host whose
  // auth store is in memory cannot outlive its process, so a durable ledger
  // for it is meaningless — and worse than meaningless, because every such
  // host writes into the one real file: defaulting this to the live path
  // regardless put several kilobytes of fabricated receipts into
  // ./data/receipts.json on every `npm test` run — both via `token`, which
  // builds an ephemeral service, and via an `auth` whose store is in memory.
  // Pass `receipts` explicitly to override.
  receipts = new ReceiptStore(auth?.store?.persistent ? {} : { path: null }),
  // The queue itself, written down so a restart is not a reset. Persists on
  // the same rule as the ledger above, and for the same reason: a test host
  // must never write its fabricated tasks into the real ./data/tasks.json,
  // where the next real coordinator would pick them up and run them. Kept
  // beside the auth store unless ALPHA_TASK_JOURNAL says otherwise.
  journal = new TaskJournal({
    path: auth?.store?.persistent ? defaultJournalPath(auth.store.path) : null,
  }),
  queue = new TaskQueue({
    admission: registry,
    // The queue forgets; this is what remembers. Resolving the agent's *name*
    // here rather than in the store is deliberate: the registration is still
    // live at this instant, and a minute later the id is unresolvable.
    onTerminal: (task) =>
      receipts.record(task, { agentName: registry.get?.(task.agentId)?.name ?? null }),
    // `queue` is this parameter's own binding; it is assigned long before the
    // first change can fire.
    onChange: () => journal.schedule(() => queue.snapshot()),
  }),
  // How often an agent is told to check in. A seam for tests, which cannot
  // otherwise reach what a heartbeat does — twenty seconds is longer than a
  // test should take.
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
} = {}) {
  // `token` is the convenience path: it builds an ephemeral auth service whose
  // only credential is that bootstrap token. Real deployments pass `auth` so
  // users and keys persist.
  const authService =
    auth ?? new AuthService({ bootstrapToken: token, store: new AuthStore({ path: null }) });
  if (!auth && !token) {
    throw new Error('createHost requires either an AuthService (`auth`) or a bootstrap `token`');
  }

  // Personal messages persist alongside credentials; a first note is seeded
  // for "jack" once so a fresh host already has something to show.
  const messageStore = messages ?? new MessageStore({ path: null });
  // Every store has to be readable before the first request is served. A
  // receipt ledger or task journal that cannot be read does not stop the host
  // — see ReceiptStore.load and TaskJournal.load — so this only ever rejects
  // on the auth store.
  //
  // The queue is restored only after the ledger has loaded: a task that was
  // leased with no attempts left fails during the restore, and its receipt
  // written into a ledger that has not loaded yet would be overwritten by it.
  // The message store loads last, alongside the "jack" seed.
  const ready = Promise.all([
    auth ? Promise.resolve(authService) : authService.load(),
    receipts.loaded ? Promise.resolve(receipts) : receipts.load(),
  ])
    .then(() => journal.load())
    .then((tasks) => queue.restore?.(tasks))
    .then(async () => {
      await messageStore.load();
      await messageStore.seedWelcome('jack');
      return authService;
    });

  /**
   * Every listener shares one queue, registry and auth service — they are the
   * same coordinator reachable at more than one address, not separate hosts.
   */
  function makeServer() {
    const created = http.createServer((req, res) => {
      ready
        .then(() =>
          handle(req, res, {
            auth: authService,
            queue,
            registry,
            receipts,
            messages: messageStore,
            heartbeatIntervalMs,
          }),
        )
        .catch((error) => {
          log.error('unhandled request error', { message: error.message, url: req.url });
          if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
          else res.end();
        });
    });

    // Long polls hold a socket open for up to MAX_POLL_WAIT_MS; the default
    // request timeout would cut them off mid-wait.
    created.requestTimeout = MAX_POLL_WAIT_MS + 15_000;
    created.headersTimeout = MAX_POLL_WAIT_MS + 20_000;
    created.keepAliveTimeout = MAX_POLL_WAIT_MS + 10_000;
    return created;
  }

  const server = makeServer();
  const servers = [server];

  const pruner = setInterval(() => registry.prune(), 15_000);
  pruner.unref?.();

  queue.start();

  /**
   * Binds the coordinator to every address in `binds`. The first uses the
   * server created up front; each additional address gets its own listener
   * sharing the same state.
   *
   * Binding to several specific addresses is how you reach the coordinator
   * over Tailscale without also putting it on 0.0.0.0: loopback keeps working
   * for an agent on this machine — including when Tailscale is down — while
   * the tailnet address serves everyone else.
   */
  async function listen({ port, binds = ['127.0.0.1'] }) {
    const addresses = Array.isArray(binds) ? binds : [binds];
    if (addresses.length === 0) throw new Error('listen requires at least one bind address');

    while (servers.length < addresses.length) servers.push(makeServer());

    await Promise.all(
      addresses.map(
        (address, index) =>
          new Promise((resolve, reject) => {
            const target = servers[index];
            target.once('error', reject);
            target.listen(port, address, () => {
              target.off('error', reject);
              resolve();
            });
          }),
      ),
    );
    return servers.map((entry) => entry.address());
  }

  /**
   * Ordered shutdown. The queue has to be stopped *before* closing the
   * listeners, not from a 'close' event: parked long polls are live requests,
   * so close() waits on them, while the thing that releases them is
   * queue.stop(). Draining from the close event deadlocks the two against each
   * other and the process hangs until every poll times out.
   */
  async function close({ graceMs = 2_000 } = {}) {
    clearInterval(pruner);

    // Hand each close() its completion callback up front. With nothing
    // connected it finishes immediately, and a 'close' listener attached
    // afterwards would miss the event and wait for one that never comes.
    const closed = Promise.all(
      servers.map((entry) => new Promise((resolve) => entry.close(() => resolve()))),
    );

    // Releases every parked waiter, so each handler resumes and answers 204.
    queue.stop();
    // Give those responses a turn of the loop to flush before reaping sockets.
    await new Promise((resolve) => setImmediate(resolve));
    for (const entry of servers) entry.closeIdleConnections();

    // Deliberately left ref'd: it keeps the loop alive long enough to force
    // the last sockets shut rather than letting the process drain mid-close.
    const forced = setTimeout(() => {
      for (const entry of servers) entry.closeAllConnections();
    }, graceMs);
    try {
      await closed;
    } finally {
      clearTimeout(forced);
    }
    // The last results reported before the listeners shut are only in memory
    // until this lands; exiting first would lose them to the restart.
    await journal.flush();
  }

  return {
    server,
    servers,
    listen,
    queue,
    registry,
    receipts,
    journal,
    messages: messageStore,
    auth: authService,
    ready,
    close,
  };
}

/** The set of names a principal reads as "their own inbox". */
function selfRecipients(principal, ctx) {
  const names = new Set();
  const add = (value) => {
    const name = normalizeRecipient(value);
    if (name) names.add(name);
  };
  add(principal.label);
  if (principal.userId) {
    add(principal.userId);
    const user = ctx.auth.getUser(principal.userId);
    if (user) add(user.name);
  }
  return names;
}

/** A human name for a principal, used as the `from` line on a note it writes. */
function principalName(principal, ctx) {
  if (principal.userId) {
    const user = ctx.auth.getUser(principal.userId);
    if (user?.name) return user.name;
  }
  return principal.label ?? null;
}

async function handle(req, res, ctx) {
  const url = new URL(req.url, 'http://host.invalid');
  const segments = url.pathname.split('/').filter(Boolean);
  const { method } = req;

  try {
    // ---------------------------------------------------------- public routes
    // The dashboard shell is static HTML with no secrets in it; every data
    // call it makes is a normal authenticated request, so serving the page
    // itself unauthenticated is safe and lets the login form live on it.
    if (method === 'GET' && (url.pathname === '/dashboard' || url.pathname === '/')) {
      if (res.writableEnded) return;
      const body = Buffer.from(DASHBOARD_HTML);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
        // No inline-script injection surface here: the page is a fixed string.
        'x-content-type-options': 'nosniff',
      });
      res.end(body);
      return;
    }

    if (method === 'GET' && url.pathname === '/healthz') {
      // `version` is what setup-agent compares against so a laptop on an older
      // checkout is told before it attaches, not after a task behaves oddly.
      return sendJson(res, 200, {
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
        version: ALPHA_VERSION,
      });
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

      // Recovery for a user who cannot supply their current password — the
      // admin-side counterpart to /me/password. Authorization is this scope,
      // not the old secret.
      if (method === 'POST' && segments[2] === 'password' && segments[3] === 'reset' && segments.length === 4) {
        require(SCOPES.USERS_WRITE);
        const body = await readJson(req);
        const { user, temporaryPassword } = await ctx.auth.adminResetPassword({
          userId,
          newPassword: body?.newPassword,
          by: principal,
        });
        return sendJson(res, 200, {
          user,
          // Present only when the caller did not supply their own — shown
          // exactly once, the same as an invite or key token.
          ...(temporaryPassword ? { temporaryPassword } : {}),
        });
      }
    }

    // --------------------------------------------------------------- messages
    // Personal notes, one inbox per named recipient. A person always reads
    // their own inbox (no scope needed); reading anyone else's needs
    // users:read, and writing a note needs users:write — which is how Alpha
    // posts to a person by their name.
    if (segments[0] === 'messages') {
      const self = selfRecipients(principal, ctx);

      if (method === 'GET' && segments.length === 1) {
        const mine = ctx.messages.data.messages
          .filter((message) => self.has(message.to))
          .sort((a, b) => b.createdAt - a.createdAt);
        return sendJson(res, 200, {
          recipient: [...self][0] ?? null,
          unread: mine.filter((message) => !message.read).length,
          messages: mine,
        });
      }

      if (method === 'POST' && segments.length === 1) {
        require(SCOPES.USERS_WRITE);
        const body = await readJson(req);
        const message = await ctx.messages.add({
          to: body?.to,
          from: body?.from ?? principalName(principal, ctx) ?? 'alpha',
          subject: body?.subject,
          body: body?.body,
        });
        return sendJson(res, 201, { message });
      }

      if (method === 'GET' && segments.length === 2) {
        const recipient = normalizeRecipient(segments[1]);
        if (!self.has(recipient)) require(SCOPES.USERS_READ);
        return sendJson(res, 200, { recipient, messages: ctx.messages.listFor(recipient) });
      }

      if (method === 'POST' && segments.length === 3 && segments[2] === 'read') {
        // markRead only touches a message addressed to the given recipient, so
        // walking the caller's own names cannot flip anyone else's flag.
        for (const recipient of self) {
          const message = await ctx.messages.markRead(segments[1], recipient);
          if (message) return sendJson(res, 200, { message });
        }
        return sendJson(res, 404, { error: 'unknown_message' });
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
      const { name, capabilities, instanceId, memory, load, version } = validateRegistration(body);
      const agent = ctx.registry.register({
        name,
        capabilities,
        // Which worker this is. A registration repeating an instance id this
        // user already has attached replaces it, so a machine that crashed
        // mid-task stops being counted twice the moment it comes back.
        instanceId,
        memory,
        load,
        version,
        remoteAddress: req.socket.remoteAddress,
        principal: principal.label,
        userId: principal.userId,
        keyId: principal.keyId ?? null,
      });
      return sendJson(res, 201, {
        agentId: agent.id,
        protocolVersion: PROTOCOL_VERSION,
        // Handed back so the agent can say, in its own log, that this machine
        // is not on the host's release.
        version: ALPHA_VERSION,
        heartbeatIntervalMs: ctx.heartbeatIntervalMs ?? 20_000,
        maxPollWaitMs: MAX_POLL_WAIT_MS,
      });
    }

    if (segments[0] === 'agent' && segments.length >= 2) {
      require(SCOPES.AGENT_CONNECT);
      const agentId = segments[1];
      const agent = ctx.registry.touch(agentId);
      if (!agent) {
        // A newer process from the same machine took this registration over,
        // so tell this one to stand down. Re-registering is what it would do
        // with `reregister`, and the two would then take turns evicting each
        // other for as long as both were running.
        const superseded = ctx.registry.supersededBy(agentId);
        if (superseded) {
          return sendJson(res, 410, {
            error: 'superseded',
            code: 'stand_down',
            message:
              'another agent process on this machine has taken over this registration',
            byAgentId: superseded.byAgentId,
          });
        }
        // Tell the agent to re-register rather than leaving it polling a
        // registration the host has already pruned.
        return sendJson(res, 410, { error: 'unknown_agent', code: 'reregister' });
      }
      // One credential must not be able to drive another credential's agent.
      if (agent.userId && principal.userId && agent.userId !== principal.userId) {
        return sendJson(res, 403, { error: 'not_your_agent' });
      }

      if (method === 'POST' && segments[2] === 'heartbeat' && segments.length === 3) {
        // The heartbeat carries the agent's current memory and CPU readings.
        // Both move under the agent's own workload, so a report is only good
        // until the next beat — see MEMORY_REPORT_STALE_MS and
        // LOAD_REPORT_STALE_MS.
        const body = await readJson(req);
        ctx.registry.reportMemory(agentId, validateMemoryReport(body?.memory));
        ctx.registry.reportLoad(agentId, validateLoadReport(body?.load));
        return sendJson(res, 200, {
          ok: true,
          queue: ctx.queue.stats(),
          availableBytes: ctx.registry.offerableBytes(agentId),
          // What this agent looks like from here: the leases it holds, and how
          // it ranks against the others. Lets a worker's own log explain why it
          // is or is not being given work.
          inFlight: agent.inFlight,
          rank: ctx.registry.rank(agentId),
        });
      }

      if (method === 'DELETE' && segments.length === 2) {
        ctx.registry.deregister(agentId);
        return sendJson(res, 200, { ok: true });
      }

      if (method === 'GET' && segments[2] === 'tasks' && segments[3] === 'next' && segments.length === 4) {
        const requested = Number.parseInt(url.searchParams.get('wait') ?? '', 10);
        const waitMs = Number.isFinite(requested) ? requested : MAX_POLL_WAIT_MS;

        // Recorded before parking, so the placement that decides where the
        // next task goes uses what this agent is like right now rather than
        // whatever it said on its last heartbeat. Memory matters here more
        // than load does: load only ranks the machines that could take the
        // task, memory decides which of them may be given it at all.
        ctx.registry.reportLoad(agentId, loadReportFromQuery(url.searchParams));
        ctx.registry.reportMemory(agentId, memoryReportFromQuery(url.searchParams));

        const controller = new AbortController();
        const onClose = () => controller.abort();
        res.on('close', onClose);
        // 'close' fires once. An agent that hung up while this request was
        // still being authenticated has already had it, and without this the
        // poll would park for a connection that no longer exists.
        if (req.destroyed || res.destroyed || req.socket?.destroyed) controller.abort();

        const task = await ctx.queue.lease({
          agentId,
          capabilities: agent.capabilities,
          waitMs,
          signal: controller.signal,
        });

        res.off('close', onClose);
        if (res.writableEnded || controller.signal.aborted) {
          // Agent hung up while parked. Hand back the task it never received,
          // without charging the attempt: nothing ran, so this is not a failure.
          if (task) ctx.queue.undelivered(task.id, agentId);
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
          // What the task needs, so the machine that is about to run it can
          // check its own RAM against it. The host places from a report, and a
          // report ages; this is the only check made by the party that knows
          // what the memory is actually doing.
          minMemoryMB: task.minMemoryMB,
        });
      }

      if (method === 'POST' && segments[2] === 'tasks' && segments[4] === 'result' && segments.length === 5) {
        const taskId = segments[3];
        const body = await readJson(req);
        if (!body || typeof body !== 'object') throw new ProtocolError('result body must be a JSON object');

        // A decline is neither a success nor a failure: the agent read what the
        // task wants, found it no longer fits, and ran nothing. Its reading is
        // recorded before the requeue so the stale figure that made this
        // placement look possible cannot immediately produce it again.
        if (body.ok !== true && body.declined === true) {
          ctx.registry.reportMemory(agentId, validateMemoryReport(body.memory));
          const declined = ctx.queue.decline(
            taskId,
            agentId,
            body.error ?? { message: 'agent declined the task', code: 'declined' },
          );
          return sendJson(res, 200, { ok: true, status: declined.status, declined: true });
        }

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
      // Cover is asked of the machine the task names, when it names one: that a
      // laptop runs `alpha.render` says nothing about a render queued for the
      // host.
      const typeCovered = ctx.registry.coversType(input.type, { agentName: input.targetAgent });
      const placeable = ctx.registry.candidatesFor(input).length > 0;
      const task = ctx.queue.enqueue(input);
      return sendJson(res, 202, {
        id: task.id,
        status: task.status,
        minMemoryMB: task.minMemoryMB,
        targetAgent: task.targetAgent,
        // Not an error: the task waits until a capable agent attaches. Surfaced
        // so a caller can tell "queued and running" from "queued forever".
        agentAvailable: placeable,
        // Distinguishes the two ways a task can sit there: nobody runs this
        // type at all, or somebody does but has no RAM to spare for it.
        memoryAvailable: !typeCovered || placeable,
        // And the third way, once a task can name a machine: that machine is
        // not attached at all. Null when the task named nobody.
        targetAttached: input.targetAgent ? ctx.registry.hasAgentNamed(input.targetAgent) : null,
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

    /**
     * The ledger of finished work, which outlives the queue that ran it.
     *
     * `/tasks` answers "what is the coordinator doing"; it is the live Map and
     * it is empty after a restart. This answers "what has this fleet actually
     * done", which is the question a person asks the morning after.
     */
    if (method === 'GET' && url.pathname === '/receipts') {
      require(SCOPES.TASKS_READ);
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10);
      const sinceRaw = Number.parseInt(url.searchParams.get('since') ?? '', 10);
      return sendJson(res, 200, {
        receipts: ctx.receipts.list({
          type: url.searchParams.get('type') ?? null,
          status: url.searchParams.get('status') ?? null,
          since: Number.isFinite(sinceRaw) ? sinceRaw : null,
          limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 1000) : 100,
        }),
        stored: ctx.receipts.size,
      });
    }

    if (method === 'GET' && url.pathname === '/receipts/summary') {
      require(SCOPES.TASKS_READ);
      const sinceRaw = Number.parseInt(url.searchParams.get('since') ?? '', 10);
      return sendJson(
        res,
        200,
        ctx.receipts.summary({ since: Number.isFinite(sinceRaw) ? sinceRaw : null }),
      );
    }

    if (method === 'GET' && url.pathname === '/agents') {
      require(SCOPES.AGENTS_READ);
      // The host's own version rides along so a reader can tell at a glance
      // which attached machines have drifted from it.
      return sendJson(res, 200, { agents: ctx.registry.list(), hostVersion: ALPHA_VERSION });
    }

    if (method === 'GET' && url.pathname === '/stats') {
      require(SCOPES.AGENTS_READ);
      return sendJson(res, 200, {
        version: ALPHA_VERSION,
        queue: ctx.queue.stats(),
        agents: ctx.registry.list().length,
        capabilities: ctx.registry.coveredCapabilities(),
        memory: {
          offeredBytes: ctx.registry.offeredBytes(),
          blockedTasks: ctx.queue.memoryBlocked().length,
        },
        load: loadSummary(ctx.registry.list()),
      });
    }

    if (method === 'GET' && url.pathname === '/cloudflare/report') {
      // Grouped with the read-only operational views; the host does not own the
      // Cloudflare side, it only surfaces a report file if one is configured.
      require(SCOPES.AGENTS_READ);
      return sendJson(res, 200, await cloudflareReport());
    }

    return sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    if (error instanceof ProtocolError) {
      if (error.closeConnection && !res.headersSent) res.setHeader('connection', 'close');
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

/**
 * The refusal for an over-cap body. It used to destroy the request on the
 * spot, which the client saw as a connection reset rather than a 413 it could
 * read. Instead the rest of the body is left unread (a paused stream stops the
 * socket once its buffer fills, so nothing more is held) and the reply goes
 * out with `Connection: close`, after which Node ends the socket itself — so
 * the unread remainder is never parsed as the next request. A client still
 * streaming megabytes at that point may see the close as a reset anyway; one
 * that waits for an answer gets the 413.
 */
function tooLarge() {
  const error = new ProtocolError('request body too large', { status: 413, code: 'payload_too_large' });
  error.closeConnection = true;
  return error;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    // A declared length already over the cap is refused before a byte of it
    // is buffered, rather than after a megabyte has been.
    const declared = Number.parseInt(req.headers['content-length'] ?? '', 10);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      reject(tooLarge());
      return;
    }

    const onData = (chunk) => {
      size += chunk.length;
      // Stop reading a body that is already too large instead of buffering it.
      if (size > MAX_BODY_BYTES) {
        req.off('data', onData);
        req.pause();
        chunks.length = 0;
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);

    // A client hanging up mid-body is the client's problem, not the host's:
    // answered as a 400 rather than surfacing as an unhandled 500 in the log.
    req.on('error', (error) =>
      reject(
        new ProtocolError(`request body could not be read: ${error.message}`, {
          code: 'incomplete_body',
        }),
      ),
    );
    // And if a hang-up ever arrives without an 'error', settle anyway so the
    // handler finishes and lets go of what it buffered. A no-op once 'end' or
    // 'error' has settled the promise.
    req.on('close', () => {
      if (!req.complete) {
        reject(new ProtocolError('request body was cut off', { status: 400, code: 'incomplete_body' }));
      }
    });

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

/**
 * Fleet-level view of how work is spread, for `alpha-admin stats`.
 *
 * `busiest` next to `idlest` is the number to look at: far apart means the
 * fleet is unbalanced, both high means everything really is saturated and more
 * machines are the only answer.
 */
function loadSummary(agents) {
  const reported = agents.map((agent) => agent.loadFactor).filter((value) => value !== null);
  return {
    reporting: reported.length,
    unknown: agents.length - reported.length,
    busiest: reported.length ? Math.max(...reported) : null,
    idlest: reported.length ? Math.min(...reported) : null,
    tasksInFlight: agents.reduce((total, agent) => total + agent.inFlight, 0),
  };
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

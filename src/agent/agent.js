import os from 'node:os';

import { HandlerRegistry } from './handlers/index.js';
import { fetchJson, HttpError } from '../common/http.js';
import { backoffDelay, sleep } from '../common/backoff.js';
import { createLogger } from '../common/log.js';
import { memorySnapshot } from './memory.js';
import { LoadSampler } from './load.js';
import {
  PROTOCOL_VERSION,
  MAX_POLL_WAIT_MS,
  DEFAULT_MEMORY_RESERVE_BYTES,
  DEFAULT_MAX_LOAD,
  DEFAULT_AGENT_CONCURRENCY,
  LOAD_BACKOFF_MS,
  LOAD_THROTTLE_MAX_MS,
  SHUTDOWN_DRAIN_MS,
  loadReportToQuery,
  MB,
} from '../common/protocol.js';
import { ALPHA_VERSION } from '../common/version.js';

const log = createLogger('agent');

/**
 * Worker that attaches to the host coordinator and runs tasks it is capable of.
 *
 * Every connection is outbound, so this side needs no open port, no public
 * hostname and no inbound firewall rule — it only needs to be able to reach
 * `hostUrl` (over Tailscale, an SSH tunnel, or a plain LAN address).
 *
 * It also tells the host how much RAM it has to spare and how busy its CPUs
 * are, on registration and on every heartbeat, so the host can send work to
 * whichever machine can actually absorb it rather than to whichever one asked
 * first.
 *
 * Load cuts both ways. The host uses the report to rank this machine against
 * its neighbours, and this machine uses it on itself: over `maxLoad` it stops
 * asking for work altogether, so the next task is picked up by the laptop with
 * cores to spare. That is a pause, never a refusal — see `#napIfOverloaded`.
 */
export class TunnelAgent {
  #agentId = null;
  #abort = new AbortController();
  #heartbeatTimer = null;
  #running = false;
  #load;
  // Tasks being run right now, and the poll loop parked waiting for one of
  // them to finish. At the default concurrency of 1 this is exactly the old
  // behaviour: poll, run it, poll again.
  #inFlight = 0;
  #slotWaiters = [];
  #throttledSince = null;

  constructor({
    hostUrl,
    token,
    name = os.hostname(),
    capabilities,
    handlers = new HandlerRegistry(),
    pollWaitMs = MAX_POLL_WAIT_MS,
    memoryReserveBytes = DEFAULT_MEMORY_RESERVE_BYTES,
    maxLoad = DEFAULT_MAX_LOAD,
    concurrency = DEFAULT_AGENT_CONCURRENCY,
    loadBackoffMs = LOAD_BACKOFF_MS,
    throttleMaxMs = LOAD_THROTTLE_MAX_MS,
    // Injectable so a test can put this machine under a load it does not
    // actually have. Anything with a snapshot() will do.
    loadSampler = new LoadSampler(),
  }) {
    if (!hostUrl) throw new Error('TunnelAgent requires hostUrl');
    if (!token) throw new Error('TunnelAgent requires token');

    this.hostUrl = hostUrl.replace(/\/+$/, '');
    this.token = token;
    this.name = name;
    this.handlers = handlers;
    this.pollWaitMs = pollWaitMs;
    // Held back for this machine's own use and never offered to the host.
    this.memoryReserveBytes = memoryReserveBytes;
    // The CPU equivalent of the memory reserve: above this share of its own
    // cores, this machine stops asking for work.
    this.maxLoad = maxLoad;
    this.concurrency = Math.max(1, concurrency);
    this.loadBackoffMs = loadBackoffMs;
    this.throttleMaxMs = throttleMaxMs;
    this.#load = loadSampler;

    // An explicit capability list may only narrow what this agent advertises;
    // claiming a type with no handler would strand every task of that type.
    const available = handlers.types();
    if (capabilities?.length) {
      const unknown = capabilities.filter((type) => !handlers.has(type));
      if (unknown.length) {
        throw new Error(`no handler registered for capability: ${unknown.join(', ')}`);
      }
      this.capabilities = [...capabilities];
    } else {
      this.capabilities = available;
    }

    if (this.capabilities.length === 0) {
      throw new Error('agent has no handlers registered, so it has nothing to offer the host');
    }
  }

  get agentId() {
    return this.#agentId;
  }

  /** What this machine is currently willing to lend, read fresh each time. */
  memory() {
    return memorySnapshot({ reserveBytes: this.memoryReserveBytes });
  }

  /** How busy this machine's CPUs are, sampled at most every couple of seconds. */
  load() {
    return this.#load.snapshot();
  }

  /** Tasks this agent is running right now. */
  get inFlight() {
    return this.#inFlight;
  }

  /** Runs until stop() is called. Reconnects on its own across host restarts. */
  async start() {
    if (this.#running) throw new Error('agent already started');
    this.#running = true;

    log.info('starting', {
      host: this.hostUrl,
      name: this.name,
      capabilities: this.capabilities,
      concurrency: this.concurrency,
      maxLoad: this.maxLoad,
    });

    let failures = 0;
    while (this.#running) {
      try {
        if (!this.#agentId) {
          await this.#register();
          failures = 0;
        }
        // Never hold more leases than this machine agreed to run at once: a
        // task the agent is not actually working on is a lease ticking down
        // towards an expiry the host will read as a dead worker.
        await this.#awaitSlot();
        if (!this.#running) break;
        // Too busy to be a good target — nap instead of asking, so the task
        // goes to the other machine.
        if (await this.#napIfOverloaded()) continue;

        await this.#pollOnce();
        failures = 0;
      } catch (error) {
        if (!this.#running) break;

        // The host no longer knows us — it restarted, or pruned us as stale.
        // Drop the id and register again on the next pass.
        if (error instanceof HttpError && error.status === 410) {
          log.warn('host does not recognise this agent, re-registering');
          this.#agentId = null;
          continue;
        }
        if (error instanceof HttpError && error.status === 401) {
          log.error('host rejected the token — check ALPHA_TUNNEL_TOKEN matches on both sides');
          this.#running = false;
          throw error;
        }

        const delay = backoffDelay(failures++);
        log.warn('reconnecting after error', { message: error.message, delayMs: delay, failures });
        try {
          await sleep(delay, { signal: this.#abort.signal });
        } catch {
          break; // aborted during backoff
        }
      }
    }

    log.info('stopped');
  }

  async stop({ drainMs = SHUTDOWN_DRAIN_MS } = {}) {
    if (!this.#running) return;
    this.#running = false;
    this.#stopHeartbeat();
    // Cancels the parked long poll, so no new task is accepted from here on.
    // It does not touch work already running or the reports it will send —
    // those use their own signals — so the drain below is unaffected.
    this.#abort.abort(new Error('agent stopping'));
    // The poll loop may be parked waiting for a task slot rather than on the
    // abort signal; release it so start() returns instead of hanging until the
    // last task finishes.
    this.#releaseSlotWaiters();

    // Let tasks that are already running report their results before we say we
    // are gone. Deregistering first turns those reports into 410s, and the host
    // then sits out the whole lease before re-running work that in fact
    // succeeded — the one thing a clean shutdown should never cause.
    await this.#drain(drainMs);

    // Best effort: let the host drop us immediately rather than waiting for the
    // stale sweep, so queued work is not offered to a process that has exited.
    if (this.#agentId) {
      try {
        await fetchJson(`${this.hostUrl}/agent/${this.#agentId}`, {
          method: 'DELETE',
          token: this.token,
          timeoutMs: 3_000,
        });
      } catch {
        // The host may already be gone; nothing useful to do here.
      }
    }
  }

  async #register() {
    const memory = this.memory();
    const load = this.load();
    const { body } = await fetchJson(`${this.hostUrl}/agent/register`, {
      method: 'POST',
      token: this.token,
      retries: 4,
      body: {
        protocolVersion: PROTOCOL_VERSION,
        name: this.name,
        capabilities: this.capabilities,
        version: ALPHA_VERSION,
        memory,
        load,
      },
    });

    this.#agentId = body.agentId;
    log.info('registered with host', {
      agentId: this.#agentId,
      capabilities: this.capabilities,
      version: ALPHA_VERSION,
      offerableMB: Math.round(memory.offerableBytes / MB),
      loadFactor: load.loadFactor,
      concurrency: this.concurrency,
    });
    // The protocol matched or we would not be here, so a different release is
    // drift rather than a fault: say so once and carry on working.
    if (body.version && body.version !== ALPHA_VERSION) {
      log.warn('this machine is not on the host\'s version of Alpha', {
        hostVersion: body.version,
        agentVersion: ALPHA_VERSION,
        hint: 'git pull on this machine so both run the same version',
      });
    }
    this.#startHeartbeat(body.heartbeatIntervalMs ?? 20_000);
  }

  /**
   * Resolves once this agent has room for another task. At the default
   * concurrency of 1 this is simply "the previous task has finished".
   */
  #awaitSlot() {
    if (!this.#running || this.#inFlight < this.concurrency) return Promise.resolve();
    // No timer here, so nothing to keep ref'd: the promise is settled by a task
    // finishing or by stop(), both of which are already pending work.
    return new Promise((resolve) => this.#slotWaiters.push(resolve));
  }

  /**
   * Waits for running tasks to report, up to `drainMs`.
   *
   * Bounded rather than open-ended: a handler part-way through a long job is
   * not going to finish inside a shutdown, and the entrypoint force-exits
   * shortly after this anyway. Whatever is still running when the budget runs
   * out is left to the host's lease sweeper, which is exactly what it is for.
   */
  async #drain(drainMs) {
    if (this.#inFlight === 0 || drainMs <= 0) return;
    log.info('waiting for running tasks to report before disconnecting', {
      inFlight: this.#inFlight,
      drainMs,
    });

    const deadline = Date.now() + drainMs;
    while (this.#inFlight > 0 && Date.now() < deadline) {
      // Ref'd on purpose: this nap is the whole of what is in flight during a
      // shutdown, and unref'ing it would let the process exit mid-report.
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    if (this.#inFlight > 0) {
      log.warn('tasks still running at shutdown; their leases will expire and be retried', {
        inFlight: this.#inFlight,
      });
    }
  }

  #releaseSlotWaiters() {
    const waiting = this.#slotWaiters;
    this.#slotWaiters = [];
    for (const resolve of waiting) resolve();
  }

  /**
   * Naps instead of asking for work when this machine is already at full tilt,
   * and reports whether it did.
   *
   * This is the half of load-aware placement that lives on the worker. The host
   * can only rank the agents that are actually asking; a laptop pinned by its
   * owner's own build has to take itself out of the running, or it stays just
   * as likely to be handed the next task as its idle neighbour.
   *
   * Backing off is bounded on purpose. If every machine in the fleet is over
   * its ceiling, nobody would ever ask and the queue would sit there — so an
   * agent that has been throttled for `throttleMaxMs` with nothing in flight
   * takes a task anyway. Late beats never.
   */
  async #napIfOverloaded() {
    const { loadFactor } = this.load();
    // Unknown load is not an excuse to stop working: a machine that cannot
    // measure itself is treated as available, exactly as it was before load
    // reporting existed.
    if (loadFactor === null || loadFactor < this.maxLoad) {
      if (this.#throttledSince !== null) {
        log.info('load back under the ceiling, taking work again', {
          loadFactor: round2(loadFactor),
          maxLoad: this.maxLoad,
        });
        this.#throttledSince = null;
      }
      return false;
    }

    const now = Date.now();
    if (this.#throttledSince === null) {
      this.#throttledSince = now;
      log.info('over the load ceiling — leaving work for the other machines', {
        loadFactor: round2(loadFactor),
        maxLoad: this.maxLoad,
        backoffMs: this.loadBackoffMs,
      });
    } else if (this.#inFlight === 0 && now - this.#throttledSince >= this.throttleMaxMs) {
      // Nothing has taken this work in a minute of us standing aside. Either
      // we are the only agent left or every machine is as busy as this one;
      // running it late is better than leaving it queued forever.
      log.warn('still loaded, but taking work anyway so the queue is not stalled', {
        loadFactor: round2(loadFactor),
        throttledForMs: now - this.#throttledSince,
      });
      this.#throttledSince = null;
      return false;
    }

    try {
      await sleep(this.loadBackoffMs, { signal: this.#abort.signal });
    } catch {
      return true; // stopping
    }
    return true;
  }

  async #pollOnce() {
    // The poll carries this machine's current load. It is the most frequent
    // thing the agent says, and it is said at the moment work is being asked
    // for — so the host ranks this machine on what it is like now, not on its
    // last heartbeat.
    const query = loadReportToQuery(
      new URLSearchParams({ wait: String(this.pollWaitMs) }),
      this.load(),
    );
    const url = `${this.hostUrl}/agent/${this.#agentId}/tasks/next?${query}`;
    const { status, body } = await fetchJson(url, {
      token: this.token,
      // Outlast the server's own long-poll ceiling so a normal empty poll
      // returns 204 rather than tripping the client timeout.
      timeoutMs: this.pollWaitMs + 10_000,
      signal: this.#abort.signal,
    });

    if (status === 204 || !body) return; // no work this round

    // Not awaited: the loop goes straight back to #awaitSlot, which parks
    // until this task frees its slot. At concurrency 1 that is the same
    // sequence as awaiting here; above 1 it is what lets a machine with cores
    // to spare actually use them. #execute never rejects — it reports failures
    // to the host itself — so nothing is lost by letting it run detached.
    this.#inFlight += 1;
    this.#execute(body).finally(() => {
      this.#inFlight -= 1;
      this.#releaseSlotWaiters();
    });
  }

  async #execute(task) {
    const taskLog = log.child(task.type);
    taskLog.info('task received', { taskId: task.id, attempt: task.attempt });

    const handler = this.handlers.get(task.type);
    if (!handler) {
      // Should not happen — we only advertise types we can run — but reporting
      // beats silently holding the lease until it expires.
      await this.#report(task.id, false, null, {
        message: `no handler for type ${task.type}`,
        code: 'no_handler',
      });
      return;
    }

    const controller = new AbortController();
    // Give up a little before the host reclaims the lease, so the failure is
    // reported by us rather than showing up as an unexplained lease expiry.
    const budgetMs = Math.max(1_000, (task.leaseMs ?? 60_000) - 2_000);
    const timer = setTimeout(() => controller.abort(new Error('task exceeded its lease')), budgetMs);

    const startedAt = Date.now();
    try {
      const result = await handler.run(task.payload ?? {}, {
        signal: controller.signal,
        taskId: task.id,
        attempt: task.attempt,
        log: taskLog,
      });
      clearTimeout(timer);

      if (controller.signal.aborted) throw controller.signal.reason;

      taskLog.info('task succeeded', { taskId: task.id, ms: Date.now() - startedAt });
      await this.#report(task.id, true, result ?? null, null);
    } catch (error) {
      clearTimeout(timer);
      taskLog.warn('task failed', { taskId: task.id, message: error.message, ms: Date.now() - startedAt });
      await this.#report(task.id, false, null, {
        message: error.message,
        code: error.code ?? 'handler_error',
        stack: error.stack,
      });
    }
  }

  async #report(taskId, ok, result, error) {
    try {
      await fetchJson(`${this.hostUrl}/agent/${this.#agentId}/tasks/${taskId}/result`, {
        method: 'POST',
        token: this.token,
        retries: 3,
        body: { ok, result, error },
      });
    } catch (reportError) {
      // The work is done but the host never heard about it. Its lease will
      // expire and the task will be retried; log loudly so that is traceable.
      log.error('could not report task result', { taskId, message: reportError.message });
    }
  }

  #startHeartbeat(intervalMs) {
    this.#stopHeartbeat();
    this.#heartbeatTimer = setInterval(async () => {
      if (!this.#agentId) return;
      try {
        await fetchJson(`${this.hostUrl}/agent/${this.#agentId}/heartbeat`, {
          method: 'POST',
          token: this.token,
          timeoutMs: 10_000,
          // Free memory and CPU both move as this machine gets on with its
          // own work, so the host's picture of it is only as good as the last
          // beat. The load report is what keeps a busy laptop from looking as
          // attractive as an idle one.
          body: { memory: this.memory(), load: this.load() },
        });
      } catch (error) {
        if (error instanceof HttpError && error.status === 410) this.#agentId = null;
        else log.debug('heartbeat failed', { message: error.message });
      }
    }, intervalMs);
    this.#heartbeatTimer.unref?.();
  }

  #stopHeartbeat() {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }
}

/** Load figures are for humans reading logs; full float precision is noise. */
function round2(value) {
  return value === null ? null : Math.round(value * 100) / 100;
}

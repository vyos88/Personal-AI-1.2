import os from 'node:os';

import { HandlerRegistry } from './handlers/index.js';
import { fetchJson, HttpError } from '../common/http.js';
import { backoffDelay, sleep } from '../common/backoff.js';
import { createLogger } from '../common/log.js';
import { memorySnapshot } from './memory.js';
import {
  PROTOCOL_VERSION,
  MAX_POLL_WAIT_MS,
  DEFAULT_MEMORY_RESERVE_BYTES,
  MB,
} from '../common/protocol.js';

const log = createLogger('agent');

/**
 * Worker that attaches to the host coordinator and runs tasks it is capable of.
 *
 * Every connection is outbound, so this side needs no open port, no public
 * hostname and no inbound firewall rule — it only needs to be able to reach
 * `hostUrl` (over Tailscale, an SSH tunnel, or a plain LAN address).
 *
 * It also tells the host how much RAM it has to spare, on registration and on
 * every heartbeat, so the host can send memory-hungry work here instead of
 * running it on itself.
 */
export class TunnelAgent {
  #agentId = null;
  #abort = new AbortController();
  #heartbeatTimer = null;
  #running = false;

  constructor({
    hostUrl,
    token,
    name = os.hostname(),
    capabilities,
    handlers = new HandlerRegistry(),
    pollWaitMs = MAX_POLL_WAIT_MS,
    memoryReserveBytes = DEFAULT_MEMORY_RESERVE_BYTES,
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

  /** Runs until stop() is called. Reconnects on its own across host restarts. */
  async start() {
    if (this.#running) throw new Error('agent already started');
    this.#running = true;

    log.info('starting', { host: this.hostUrl, name: this.name, capabilities: this.capabilities });

    let failures = 0;
    while (this.#running) {
      try {
        if (!this.#agentId) {
          await this.#register();
          failures = 0;
        }
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

  async stop() {
    if (!this.#running) return;
    this.#running = false;
    this.#abort.abort(new Error('agent stopping'));
    this.#stopHeartbeat();

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
    const { body } = await fetchJson(`${this.hostUrl}/agent/register`, {
      method: 'POST',
      token: this.token,
      retries: 4,
      body: {
        protocolVersion: PROTOCOL_VERSION,
        name: this.name,
        capabilities: this.capabilities,
        memory,
      },
    });

    this.#agentId = body.agentId;
    log.info('registered with host', {
      agentId: this.#agentId,
      capabilities: this.capabilities,
      offerableMB: Math.round(memory.offerableBytes / MB),
    });
    this.#startHeartbeat(body.heartbeatIntervalMs ?? 20_000);
  }

  async #pollOnce() {
    const url = `${this.hostUrl}/agent/${this.#agentId}/tasks/next?wait=${this.pollWaitMs}`;
    const { status, body } = await fetchJson(url, {
      token: this.token,
      // Outlast the server's own long-poll ceiling so a normal empty poll
      // returns 204 rather than tripping the client timeout.
      timeoutMs: this.pollWaitMs + 10_000,
      signal: this.#abort.signal,
    });

    if (status === 204 || !body) return; // no work this round
    await this.#execute(body);
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
          // Free memory moves as this machine gets on with its own work, so
          // the host's picture of it is only as good as the last beat.
          body: { memory: this.memory() },
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

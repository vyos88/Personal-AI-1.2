import {
  TaskStatus,
  TERMINAL_STATUSES,
  newId,
  MAX_POLL_WAIT_MS,
} from '../common/protocol.js';
import { createLogger } from '../common/log.js';

const log = createLogger('host:queue');

/**
 * In-memory task queue with capability-matched long-poll leasing.
 *
 * Work is pulled, never pushed: the agent dials out and holds a request open
 * until a task it can run appears. That is what lets the laptop sit behind NAT
 * with no inbound port and still act as a worker for the host.
 */
export class TaskQueue {
  #tasks = new Map();
  #pending = [];
  #waiters = new Set();
  #sweeper = null;

  constructor({ sweepIntervalMs = 5_000, now = () => Date.now() } = {}) {
    this.sweepIntervalMs = sweepIntervalMs;
    this.now = now;
  }

  start() {
    if (this.#sweeper) return;
    this.#sweeper = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.#sweeper.unref?.();
  }

  stop() {
    if (this.#sweeper) {
      clearInterval(this.#sweeper);
      this.#sweeper = null;
    }
    // Release every parked poll so in-flight requests finish rather than hang.
    for (const waiter of [...this.#waiters]) {
      this.#resolveWaiter(waiter, null);
    }
  }

  enqueue({ type, payload, leaseMs, maxAttempts }) {
    const task = {
      id: newId('task'),
      type,
      payload,
      leaseMs,
      maxAttempts,
      status: TaskStatus.QUEUED,
      attempts: 0,
      agentId: null,
      result: null,
      error: null,
      createdAt: this.now(),
      leasedAt: null,
      leaseExpiresAt: null,
      finishedAt: null,
    };
    this.#tasks.set(task.id, task);

    // Hand it straight to a waiting agent when one can run this type; only
    // park it in `pending` if nobody is listening for it right now.
    const waiter = this.#findWaiterFor(task.type);
    if (waiter) {
      this.#assign(task, waiter.agentId);
      this.#resolveWaiter(waiter, task);
    } else {
      this.#pending.push(task);
    }

    log.info('task enqueued', { taskId: task.id, type: task.type, dispatched: Boolean(waiter) });
    return task;
  }

  /**
   * Long-poll for the next runnable task. Resolves with a task, or with null
   * once `waitMs` elapses with nothing matching.
   */
  lease({ agentId, capabilities, waitMs, signal }) {
    const wanted = new Set(capabilities);

    const index = this.#pending.findIndex((task) => wanted.has(task.type));
    if (index !== -1) {
      const [task] = this.#pending.splice(index, 1);
      this.#assign(task, agentId);
      return Promise.resolve(task);
    }

    const cappedWait = Math.min(Math.max(waitMs, 0), MAX_POLL_WAIT_MS);
    if (cappedWait === 0) return Promise.resolve(null);

    return new Promise((resolve) => {
      const waiter = { agentId, capabilities: wanted, resolve, timer: null, signal, onAbort: null };

      // Left ref'd on purpose: a parked waiter is pending work that always
      // settles within MAX_POLL_WAIT_MS. Unref'ing it lets the event loop
      // drain mid-wait whenever the queue is driven by something other than a
      // live HTTP request holding its own socket open.
      waiter.timer = setTimeout(() => this.#resolveWaiter(waiter, null), cappedWait);

      // The agent going away (process killed, laptop lid closed) must free the
      // waiter, otherwise a task would be dispatched into a dead connection.
      if (signal) {
        waiter.onAbort = () => this.#resolveWaiter(waiter, null);
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }

      this.#waiters.add(waiter);
    });
  }

  complete(taskId, agentId, result) {
    const task = this.#requireLeasedBy(taskId, agentId);
    task.status = TaskStatus.SUCCEEDED;
    task.result = result ?? null;
    task.error = null;
    task.finishedAt = this.now();
    task.leaseExpiresAt = null;
    log.info('task succeeded', { taskId, agentId, attempts: task.attempts });
    return task;
  }

  fail(taskId, agentId, error) {
    const task = this.#requireLeasedBy(taskId, agentId);
    const normalized = normalizeError(error);

    if (task.attempts >= task.maxAttempts) {
      task.status = TaskStatus.FAILED;
      task.error = normalized;
      task.finishedAt = this.now();
      task.leaseExpiresAt = null;
      log.warn('task failed permanently', { taskId, agentId, attempts: task.attempts });
    } else {
      task.error = normalized;
      this.#requeue(task, 'agent reported failure');
    }
    return task;
  }

  cancel(taskId) {
    const task = this.#tasks.get(taskId);
    if (!task) return null;
    if (TERMINAL_STATUSES.has(task.status)) return task;

    const index = this.#pending.indexOf(task);
    if (index !== -1) this.#pending.splice(index, 1);

    task.status = TaskStatus.CANCELLED;
    task.finishedAt = this.now();
    task.leaseExpiresAt = null;
    log.info('task cancelled', { taskId });
    return task;
  }

  /** Reclaims tasks whose holder never reported back. */
  sweep() {
    const now = this.now();
    for (const task of this.#tasks.values()) {
      if (task.status !== TaskStatus.LEASED) continue;
      if (task.leaseExpiresAt === null || task.leaseExpiresAt > now) continue;

      if (task.attempts >= task.maxAttempts) {
        task.status = TaskStatus.FAILED;
        task.error = { message: 'lease expired and no attempts remain', code: 'lease_expired' };
        task.finishedAt = now;
        task.leaseExpiresAt = null;
        log.warn('task abandoned', { taskId: task.id, agentId: task.agentId });
      } else {
        this.#requeue(task, 'lease expired');
      }
    }
  }

  get(taskId) {
    return this.#tasks.get(taskId) ?? null;
  }

  list({ status, limit = 100 } = {}) {
    const all = [...this.#tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
    const filtered = status ? all.filter((task) => task.status === status) : all;
    return filtered.slice(0, limit);
  }

  stats() {
    const byStatus = {};
    for (const task of this.#tasks.values()) {
      byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
    }
    return { total: this.#tasks.size, pending: this.#pending.length, waiters: this.#waiters.size, byStatus };
  }

  #assign(task, agentId) {
    task.status = TaskStatus.LEASED;
    task.agentId = agentId;
    task.attempts += 1;
    task.leasedAt = this.now();
    task.leaseExpiresAt = task.leasedAt + task.leaseMs;
  }

  #requeue(task, reason) {
    task.status = TaskStatus.QUEUED;
    task.agentId = null;
    task.leasedAt = null;
    task.leaseExpiresAt = null;

    const waiter = this.#findWaiterFor(task.type);
    if (waiter) {
      this.#assign(task, waiter.agentId);
      this.#resolveWaiter(waiter, task);
    } else {
      this.#pending.push(task);
    }
    log.info('task requeued', { taskId: task.id, reason, attempts: task.attempts });
  }

  #findWaiterFor(type) {
    for (const waiter of this.#waiters) {
      if (waiter.capabilities.has(type)) return waiter;
    }
    return null;
  }

  #resolveWaiter(waiter, task) {
    if (!this.#waiters.delete(waiter)) return; // already settled
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    waiter.resolve(task);
  }

  #requireLeasedBy(taskId, agentId) {
    const task = this.#tasks.get(taskId);
    if (!task) {
      const error = new Error(`unknown task ${taskId}`);
      error.status = 404;
      throw error;
    }
    // A late report from a previous holder must not clobber the result of the
    // agent that currently owns the lease.
    if (task.status !== TaskStatus.LEASED || task.agentId !== agentId) {
      const error = new Error(
        `task ${taskId} is ${task.status} and held by ${task.agentId ?? 'nobody'}, not ${agentId}`,
      );
      error.status = 409;
      throw error;
    }
    return task;
  }
}

function normalizeError(error) {
  if (!error || typeof error !== 'object') {
    return { message: String(error ?? 'unknown error'), code: 'unknown' };
  }
  return {
    message: typeof error.message === 'string' ? error.message.slice(0, 2_000) : 'unknown error',
    code: typeof error.code === 'string' ? error.code.slice(0, 64) : 'unknown',
    stack: typeof error.stack === 'string' ? error.stack.slice(0, 4_000) : undefined,
  };
}

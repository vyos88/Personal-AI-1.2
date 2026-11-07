import {
  TaskStatus,
  TERMINAL_STATUSES,
  newId,
  MAX_POLL_WAIT_MS,
} from '../common/protocol.js';
import { createLogger } from '../common/log.js';

const log = createLogger('host:queue');

// What a queue with no memory accounting behind it does: take everything,
// remember nothing. Keeps the queue usable on its own, in tests and anywhere
// the registry is not in play.
const OPEN_ADMISSION = {
  canAdmit: () => true,
  admit: () => {},
  release: () => {},
  // With nothing tracking registrations, every parked poll is a live one.
  knows: () => true,
  // Every agent looks equally good, so ranking degrades to the arrival order
  // this queue used before it could rank at all.
  rank: () => 0,
};

/**
 * In-memory task queue with capability-matched long-poll leasing.
 *
 * Work is pulled, never pushed: the agent dials out and holds a request open
 * until a task it can run appears. That is what lets the laptop sit behind NAT
 * with no inbound port and still act as a worker for the host.
 *
 * Matching is by capability and, for tasks that name a `minMemoryMB`, by the
 * agent's free RAM. The queue does not track memory itself: it asks the
 * `admission` controller (the agent registry, in a live host) whether a given
 * agent can take a task, and tells it when a lease starts and ends.
 *
 * When more than one parked agent could take a task, the controller also says
 * which of them is the better target and the task goes there. Picking the
 * first waiter instead — which is what this did — meant whichever laptop
 * happened to park its long poll earliest won every dispatch, so a machine
 * already at full tilt kept being handed work while its neighbour sat idle.
 */
export class TaskQueue {
  #tasks = new Map();
  #pending = [];
  #waiters = new Set();
  #sweeper = null;

  /**
   * `store` persists tasks across restarts (see TaskStore); without one the
   * queue is memory-only, as it always was. `defaultTtlMs` is how long a task
   * may wait in the queue for an agent before it is dropped, for tasks that do
   * not name their own `expiresInMs`; null keeps them waiting forever.
   */
  constructor({
    sweepIntervalMs = 5_000,
    now = () => Date.now(),
    admission = OPEN_ADMISSION,
    store = null,
    defaultTtlMs = null,
  } = {}) {
    this.sweepIntervalMs = sweepIntervalMs;
    this.now = now;
    this.admission = admission;
    this.store = store;
    this.defaultTtlMs = defaultTtlMs;
  }

  /**
   * Loads the tasks a previous process saved. Call once, before the host
   * starts serving.
   *
   * A task that was leased when the old process died goes back in the queue:
   * the agent holding it reports to a registration that no longer exists, so
   * its result would be refused anyway. The attempt it spent stays spent, so a
   * task that takes the coordinator down with it cannot do so forever.
   */
  async restore() {
    if (!this.store) return 0;
    const saved = await this.store.load();
    for (const task of saved) {
      if (this.#tasks.has(task.id)) continue;
      this.#tasks.set(task.id, task);
      if (task.status === TaskStatus.LEASED) {
        task.status = TaskStatus.QUEUED;
        task.agentId = null;
        task.leasedAt = null;
        task.leaseExpiresAt = null;
      }
      if (task.status === TaskStatus.QUEUED) this.#pending.push(task);
    }
    this.#pending.sort((a, b) => a.createdAt - b.createdAt);
    log.info('tasks restored', { total: saved.length, pending: this.#pending.length });
    return saved.length;
  }

  /**
   * Resolves once every change made so far is on disk. The result endpoint
   * awaits it, so an agent is only told its work was received after it is.
   */
  flush() {
    if (!this.store) return Promise.resolve();
    return this.store.save(() => [...this.#tasks.values()]);
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

  enqueue({ type, payload, leaseMs, maxAttempts, minMemoryMB = 0, targetAgent = null, expiresInMs = null }) {
    const ttl = expiresInMs ?? this.defaultTtlMs;
    const createdAt = this.now();
    const task = {
      id: newId('task'),
      type,
      payload,
      leaseMs,
      maxAttempts,
      minMemoryMB,
      // The machine this task must run on, by name, or null for "wherever
      // placement decides". Narrows the candidates and nothing else: a named
      // machine still has to offer the type, have the RAM and be asking for
      // work, and a task naming a machine that is not attached waits for it
      // exactly as one naming a type nobody runs waits for a worker.
      targetAgent,
      status: TaskStatus.QUEUED,
      attempts: 0,
      // How many times an agent has handed this task straight back. Nothing
      // reads it — a decline deliberately costs no attempt, and bounding them
      // would break the case the count exists to make legible: a task waiting
      // for a machine with room is *supposed* to wait. It is here so that case
      // can be told apart from an agent refusing the same work over and over,
      // which otherwise looks identical: queued, attempts flat, nothing
      // accumulating anywhere.
      declines: 0,
      agentId: null,
      result: null,
      error: null,
      // Set when the task reaches succeeded or failed: the id an agent is
      // handed back as proof its report was stored.
      receiptId: null,
      createdAt,
      // When a still-queued task is dropped instead of waiting on. Only
      // queued tasks expire; one an agent is running is never cut off by it.
      // Without this, a reporter posting every three minutes to a host with
      // no agent built a backlog that would all run at once on reattach.
      expiresAt: ttl ? createdAt + ttl : null,
      leasedAt: null,
      leaseExpiresAt: null,
      finishedAt: null,
    };
    this.#tasks.set(task.id, task);

    // Hand it straight to a waiting agent when one can run this type and has
    // the RAM for it; only park it in `pending` if nobody is listening for it
    // right now.
    const waiter = this.#findWaiterFor(task);
    if (waiter) {
      this.#assign(task, waiter.agentId);
      this.#resolveWaiter(waiter, task);
    } else {
      this.#pending.push(task);
    }

    log.info('task enqueued', { taskId: task.id, type: task.type, dispatched: Boolean(waiter) });
    this.#changed();
    return task;
  }

  /**
   * Long-poll for the next runnable task. Resolves with a task, or with null
   * once `waitMs` elapses with nothing matching.
   */
  lease({ agentId, capabilities, waitMs, signal }) {
    const wanted = new Set(capabilities);

    // Ranking deliberately does not apply here. This branch is an agent asking
    // for work that is already queued, and there is nobody else to weigh it
    // against — the other machine is not parked, or it would have been handed
    // the task at enqueue time. An agent too loaded to be a good target
    // declines by not asking; see the agent's own load ceiling.
    const index = this.#pending.findIndex(
      (task) => wanted.has(task.type) && this.admission.canAdmit(agentId, task),
    );
    if (index !== -1) {
      const [task] = this.#pending.splice(index, 1);
      this.#assign(task, agentId);
      this.#changed();
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
    // The same agent reporting the same outcome again — its first reply was
    // lost, or the host could not store it and asked it to retry — gets the
    // receipt it was already given rather than a 409.
    const repeat = this.#repeatReport(taskId, agentId, TaskStatus.SUCCEEDED);
    if (repeat) return repeat;

    const task = this.#requireLeasedBy(taskId, agentId);
    this.admission.release(agentId, task);
    task.status = TaskStatus.SUCCEEDED;
    task.result = result ?? null;
    task.error = null;
    task.finishedAt = this.now();
    task.leaseExpiresAt = null;
    task.receiptId = newId('rcpt');
    log.info('task succeeded', { taskId, agentId, attempts: task.attempts, receiptId: task.receiptId });
    this.#changed();
    return task;
  }

  fail(taskId, agentId, error) {
    const repeat = this.#repeatReport(taskId, agentId, TaskStatus.FAILED);
    if (repeat) return repeat;

    const task = this.#requireLeasedBy(taskId, agentId);
    const normalized = normalizeError(error);
    this.admission.release(agentId, task);

    if (task.attempts >= task.maxAttempts) {
      task.status = TaskStatus.FAILED;
      task.error = normalized;
      task.finishedAt = this.now();
      task.leaseExpiresAt = null;
      task.receiptId = newId('rcpt');
      log.warn('task failed permanently', { taskId, agentId, attempts: task.attempts });
    } else {
      task.error = normalized;
      this.#requeue(task, 'agent reported failure');
    }
    this.#changed();
    return task;
  }

  /**
   * The agent looked at what the task asks for and said it cannot hold it.
   *
   * Deliberately not a failure. Nothing was attempted, so charging an attempt
   * would spend the task's retry budget on machines that never ran it, and a
   * fleet that is briefly tight everywhere would fail work outright rather than
   * waiting for room. The attempt `#assign` took at dispatch is handed back and
   * the task requeued as if it had never been placed.
   *
   * This cannot spin, for two reasons. The decline carries the agent's fresh
   * memory report and the host records it *before* this runs, so the stale
   * figure that made the placement look possible is gone by the time the task
   * is offered again. And the agent's own check is looser than the host's
   * admission test — it does not subtract the holds the host is carrying — so
   * an agent can only ever decline work a fresher reading would have kept it
   * from being offered in the first place.
   */
  decline(taskId, agentId, reason) {
    const task = this.#requireLeasedBy(taskId, agentId);
    this.admission.release(agentId, task);
    task.attempts = Math.max(0, task.attempts - 1);
    task.declines += 1;
    // Kept so `alpha-admin tasks` can show why a task is going round again
    // rather than leaving it looking like it was never picked up.
    task.error = normalizeError(reason);
    this.#requeue(task, `agent declined: ${task.error.message}`);
    this.#changed();
    return task;
  }

  cancel(taskId) {
    const task = this.#tasks.get(taskId);
    if (!task) return null;
    if (TERMINAL_STATUSES.has(task.status)) return task;

    const index = this.#pending.indexOf(task);
    if (index !== -1) this.#pending.splice(index, 1);
    if (task.status === TaskStatus.LEASED) this.admission.release(task.agentId, task);

    task.status = TaskStatus.CANCELLED;
    task.finishedAt = this.now();
    task.leaseExpiresAt = null;
    log.info('task cancelled', { taskId });
    this.#changed();
    return task;
  }

  /** Reclaims tasks whose holder never reported back, and drops expired ones. */
  sweep() {
    const now = this.now();
    let changed = false;

    // Cancelled rather than failed: nothing ran, and "failed" would read as a
    // machine having tried. The code says why, for `alpha-admin tasks`.
    for (let i = this.#pending.length - 1; i >= 0; i--) {
      const task = this.#pending[i];
      if (task.expiresAt === null || task.expiresAt === undefined || task.expiresAt > now) continue;
      this.#pending.splice(i, 1);
      task.status = TaskStatus.CANCELLED;
      task.error = { message: 'expired in the queue before any agent ran it', code: 'expired' };
      task.finishedAt = now;
      changed = true;
      log.info('task expired', { taskId: task.id, type: task.type });
    }

    for (const task of this.#tasks.values()) {
      if (task.status !== TaskStatus.LEASED) continue;
      if (task.leaseExpiresAt === null || task.leaseExpiresAt > now) continue;

      // Whatever the agent promised this task is no longer promised: it is
      // either dead or about to be handed to somebody else.
      this.admission.release(task.agentId, task);

      if (task.attempts >= task.maxAttempts) {
        task.status = TaskStatus.FAILED;
        task.error = { message: 'lease expired and no attempts remain', code: 'lease_expired' };
        task.finishedAt = now;
        task.leaseExpiresAt = null;
        log.warn('task abandoned', { taskId: task.id, agentId: task.agentId });
      } else {
        this.#requeue(task, 'lease expired');
      }
      changed = true;
    }
    if (changed) this.#changed();
  }

  get(taskId) {
    return this.#tasks.get(taskId) ?? null;
  }

  list({ status, limit = 100 } = {}) {
    const all = [...this.#tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
    const filtered = status ? all.filter((task) => task.status === status) : all;
    return filtered.slice(0, limit);
  }

  /** Queued tasks nothing can run yet because no agent has the RAM they ask for. */
  memoryBlocked() {
    return this.#pending.filter((task) => task.minMemoryMB > 0);
  }

  stats() {
    const byStatus = {};
    for (const task of this.#tasks.values()) {
      byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
    }
    return { total: this.#tasks.size, pending: this.#pending.length, waiters: this.#waiters.size, byStatus };
  }

  #assign(task, agentId) {
    this.admission.admit(agentId, task);
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

    const waiter = this.#findWaiterFor(task);
    if (waiter) {
      this.#assign(task, waiter.agentId);
      this.#resolveWaiter(waiter, task);
    } else {
      this.#pending.push(task);
    }
    log.info('task requeued', { taskId: task.id, reason, attempts: task.attempts });
  }

  /**
   * The best parked agent for this task, or null if none can take it.
   *
   * Ties keep insertion order, so with nothing to tell two agents apart this
   * behaves exactly as it did before ranking existed: first waiter wins.
   */
  #findWaiterFor(task) {
    let best = null;
    let bestRank = Number.POSITIVE_INFINITY;
    for (const waiter of this.#waiters) {
      if (!waiter.capabilities.has(task.type)) continue;
      // A poll can outlive the registration that made it: the agent was
      // pruned as stale, or a newer process on the same machine took its place
      // and it has not reached the end of this long poll yet. Handing it work
      // costs a whole lease — the reply it sends back is a 410, and the task
      // waits out the expiry before anyone else can try it.
      if (!(this.admission.knows?.(waiter.agentId) ?? true)) continue;
      if (!this.admission.canAdmit(waiter.agentId, task)) continue;
      const rank = this.admission.rank?.(waiter.agentId) ?? 0;
      if (rank < bestRank) {
        best = waiter;
        bestRank = rank;
      }
    }
    return best;
  }

  #resolveWaiter(waiter, task) {
    if (!this.#waiters.delete(waiter)) return; // already settled
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    waiter.resolve(task);
  }

  /** Saves in the background; `flush()` is for callers that must wait. */
  #changed() {
    if (!this.store) return;
    this.flush().catch((error) => log.error('could not save tasks', { message: error.message }));
  }

  #repeatReport(taskId, agentId, status) {
    const task = this.#tasks.get(taskId);
    if (task && task.status === status && task.agentId === agentId && task.receiptId) return task;
    return null;
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

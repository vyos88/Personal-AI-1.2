import { createLogger } from '../common/log.js';

const log = createLogger('host:receipts');

const DEFAULT_LIMIT = 200;
const MAX_BROADCAST_BYTES = 8_000;

/**
 * A bounded, fleet-wide feed of receipts.
 *
 * The problem this exists for: a task's result is private to whoever queued
 * it, so a receipt one agent posts (the `alpha.coordination` `Post` action,
 * say) is otherwise invisible to every other machine in the fleet. But the
 * host cannot push it to them — agents only ever dial out, and nothing here
 * may reach into one. So instead each agent *pulls* what it has missed, on
 * its own next heartbeat, exactly the way it already pulls tasks and reports
 * memory. Delivery is therefore on the order of `heartbeatIntervalMs`, not
 * instant, and that is the deliberate trade for never needing an inbound
 * connection to a worker.
 *
 * A cursor is kept per agent id, not per machine: an id is minted fresh on
 * every registration, so a machine that restarts starts its cursor at
 * whatever is current *then* rather than replaying everything that happened
 * before it existed. `attach()` is what sets that starting point, and it is
 * the registration route's job to call it — a cursor nobody ever attached
 * pulls nothing, which is the safe default for an id this log has not seen.
 */
export class ReceiptLog {
  #entries = [];
  #seq = 0;
  #cursors = new Map();

  constructor({ now = () => Date.now(), limit = DEFAULT_LIMIT } = {}) {
    this.now = now;
    this.limit = limit;
  }

  /** The current high-water mark. */
  latestSeq() {
    return this.#seq;
  }

  /** Starts this agent id caught up to now, so it is told only what happens from here on. */
  attach(agentId) {
    this.#cursors.set(agentId, this.#seq);
  }

  /** Forgets this agent id's place. Safe to call even if it was never attached. */
  detach(agentId) {
    this.#cursors.delete(agentId);
  }

  /** Appends a receipt. `broadcast` is opaque data the handler chose to share. */
  push({ agentId, agentName, type, taskId, broadcast }) {
    this.#seq += 1;
    const entry = { seq: this.#seq, agentId, agentName, type, taskId, broadcast, createdAt: this.now() };
    this.#entries.push(entry);
    if (this.#entries.length > this.limit) this.#entries.shift();
    log.info('receipt broadcast', { seq: entry.seq, agentName, type, taskId });
    return entry;
  }

  /** Entries after `seq`, oldest first. Older entries may have already fallen off the bound. */
  since(seq) {
    if (seq >= this.#seq) return [];
    return this.#entries.filter((entry) => entry.seq > seq);
  }

  /** Entries this agent has not yet been given, and marks them delivered. */
  pull(agentId) {
    const cursor = this.#cursors.get(agentId) ?? this.#seq;
    const entries = this.since(cursor);
    if (entries.length) this.#cursors.set(agentId, entries[entries.length - 1].seq);
    return entries;
  }
}

/**
 * Validates a handler's opt-in broadcast payload.
 *
 * Returns null for anything unusable rather than throwing: a receipt is a
 * courtesy that rides along with a task result, not part of the contract that
 * result is completing, so a malformed one must never fail the task itself.
 * The JSON round-trip both proves the value is serializable — a class
 * instance or anything circular is dropped rather than crashing the log — and
 * strips it down to a plain clone, so a later mutation of the caller's object
 * cannot reach into the log.
 */
export function sanitizeBroadcast(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    return null;
  }
  if (!json || Buffer.byteLength(json) > MAX_BROADCAST_BYTES) return null;
  return JSON.parse(json);
}

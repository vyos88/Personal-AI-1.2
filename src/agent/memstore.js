import { MB } from '../common/protocol.js';

/**
 * A bounded, in-process key/value store that lives in the agent's RAM.
 *
 * This is the other half of lending the host memory: rather than only running
 * memory-hungry tasks here, the host can park data here — a cache, an
 * embedding batch, an intermediate result — and keep its own RAM free. The
 * laptop holds it; the host addresses it by key over the tunnel.
 *
 * Deliberately simple and deliberately bounded:
 *
 * - values are stored as their serialized JSON, so `usedBytes` is a real byte
 *   count rather than a guess at the size of an object graph;
 * - the store never grows past `limitBytes`, evicting least-recently-used
 *   entries to make room, because an unbounded cache on the machine whose
 *   spare RAM is the whole point is a memory leak with a nicer name;
 * - entries may carry a TTL, and an expired entry is a miss even before the
 *   sweep reaches it.
 *
 * Nothing here survives a restart. It is a cache, not a database.
 */
export class MemoryStore {
  #entries = new Map(); // insertion order doubles as LRU order
  #usedBytes = 0;

  constructor({ limitBytes = 512 * MB, maxValueBytes = null, now = () => Date.now() } = {}) {
    if (!Number.isFinite(limitBytes) || limitBytes <= 0) {
      throw new Error('MemoryStore requires a positive limitBytes');
    }
    this.limitBytes = Math.floor(limitBytes);
    // No single value may take more than half the budget by default: one giant
    // entry that evicts everything else is a worse cache than no cache.
    this.maxValueBytes = maxValueBytes ?? Math.floor(this.limitBytes / 2);
    this.now = now;
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.expirations = 0;
  }

  get usedBytes() {
    return this.#usedBytes;
  }

  get size() {
    return this.#entries.size;
  }

  put(key, value, { ttlMs = null } = {}) {
    const encoded = encode(value);
    if (encoded.length > this.maxValueBytes) {
      const error = new Error(
        `value for "${key}" is ${bytesToMB(encoded.length)} MB, over the ` +
          `${bytesToMB(this.maxValueBytes)} MB per-entry limit`,
      );
      error.code = 'value_too_large';
      throw error;
    }

    // Replacing an entry frees its old bytes first, so a smaller replacement
    // never triggers an eviction it does not need.
    this.#drop(key);

    const evicted = this.#makeRoom(encoded.length);
    const at = this.now();
    this.#entries.set(key, {
      bytes: encoded,
      storedAt: at,
      touchedAt: at,
      expiresAt: ttlMs ? at + ttlMs : null,
    });
    this.#usedBytes += encoded.length;

    return { key, bytes: encoded.length, evicted, entries: this.size, usedBytes: this.#usedBytes };
  }

  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) {
      this.misses += 1;
      return { key, hit: false, value: null };
    }
    if (this.#expired(entry)) {
      this.#drop(key);
      this.expirations += 1;
      this.misses += 1;
      return { key, hit: false, value: null, expired: true };
    }

    // Re-inserting moves the key to the end of the Map, which is what makes
    // eviction least-recently-*used* rather than merely oldest.
    entry.touchedAt = this.now();
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    this.hits += 1;

    return {
      key,
      hit: true,
      value: JSON.parse(entry.bytes.toString('utf8')),
      bytes: entry.bytes.length,
      ageMs: this.now() - entry.storedAt,
    };
  }

  has(key) {
    const entry = this.#entries.get(key);
    if (!entry) return false;
    if (this.#expired(entry)) {
      this.#drop(key);
      this.expirations += 1;
      return false;
    }
    return true;
  }

  delete(key) {
    return { key, deleted: this.#drop(key) };
  }

  /** Key metadata only — values stay here, which is the point of storing them here. */
  keys({ prefix = '', limit = 100 } = {}) {
    this.sweep();
    const out = [];
    for (const [key, entry] of this.#entries) {
      if (prefix && !key.startsWith(prefix)) continue;
      out.push({
        key,
        bytes: entry.bytes.length,
        ageMs: this.now() - entry.storedAt,
        idleMs: this.now() - entry.touchedAt,
        expiresInMs: entry.expiresAt === null ? null : Math.max(0, entry.expiresAt - this.now()),
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  clear() {
    const cleared = this.size;
    this.#entries.clear();
    this.#usedBytes = 0;
    return { cleared };
  }

  /** Drops expired entries. Returns how many went. */
  sweep() {
    let removed = 0;
    for (const [key, entry] of [...this.#entries]) {
      if (this.#expired(entry)) {
        this.#drop(key);
        removed += 1;
      }
    }
    this.expirations += removed;
    return removed;
  }

  stats() {
    this.sweep();
    return {
      entries: this.size,
      usedBytes: this.#usedBytes,
      limitBytes: this.limitBytes,
      maxValueBytes: this.maxValueBytes,
      freeBytes: Math.max(0, this.limitBytes - this.#usedBytes),
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expirations: this.expirations,
    };
  }

  #expired(entry) {
    return entry.expiresAt !== null && entry.expiresAt <= this.now();
  }

  #drop(key) {
    const entry = this.#entries.get(key);
    if (!entry) return false;
    this.#entries.delete(key);
    this.#usedBytes -= entry.bytes.length;
    return true;
  }

  /** Evicts expired entries first, then the least recently used, until it fits. */
  #makeRoom(incomingBytes) {
    const evicted = [];
    if (this.#usedBytes + incomingBytes <= this.limitBytes) return evicted;

    this.sweep();

    for (const key of [...this.#entries.keys()]) {
      if (this.#usedBytes + incomingBytes <= this.limitBytes) break;
      this.#drop(key);
      this.evictions += 1;
      evicted.push(key);
    }
    return evicted;
  }
}

function encode(value) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (cause) {
    // Circular references and BigInt land here.
    throw unserializable(cause.message);
  }
  // undefined, functions and symbols stringify to undefined rather than
  // throwing, and storing them would read back as a value that was never put.
  if (json === undefined) throw unserializable(`${typeof value} has no JSON representation`);
  return Buffer.from(json, 'utf8');
}

function unserializable(detail) {
  const error = new Error(`value is not JSON-serializable: ${detail}`);
  error.code = 'unserializable_value';
  return error;
}

const bytesToMB = (bytes) => Math.round((bytes / MB) * 100) / 100;

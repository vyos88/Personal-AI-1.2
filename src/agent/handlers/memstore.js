import os from 'node:os';

import { MemoryStore } from '../memstore.js';
import { ProtocolError, MB } from '../../common/protocol.js';
import { availableBytes } from '../memory.js';

/**
 * Lends this machine's RAM to the host as addressable storage.
 *
 * The host puts data here — a cache, a batch it is about to reuse, an
 * intermediate result too big to keep resident — and gets it back by key,
 * keeping its own memory free. Everything lives in this process: nothing is
 * written to disk, and nothing survives a restart.
 *
 * It is NOT registered by default. Holding data costs the RAM it costs, so
 * turning it on is a per-machine decision:
 *
 *   ALPHA_EXTRA_HANDLERS=memstore
 *
 * Configuration:
 *   ALPHA_MEMSTORE_LIMIT_MB      Budget for stored data. Defaults to a
 *                                quarter of total RAM, capped at 1024 MB.
 *   ALPHA_MEMSTORE_MAX_VALUE_MB  Largest single value. Defaults to half the
 *                                budget. The host caps a task body at 1 MB,
 *                                so this only bites for larger transports.
 */

export const type = 'memory.store';

export const description =
  'Keeps data in this machine\'s RAM for the host: put, get, delete, keys, stats, clear.';

export const ACTIONS = Object.freeze(['put', 'get', 'delete', 'keys', 'stats', 'clear']);

// Keys end up in logs and in `alpha-admin mem keys`, so keep them legible
// rather than accepting arbitrary text.
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

let store = null;

/** Lazily built so the limit is read from the environment the agent runs with. */
export function getStore() {
  if (!store) store = new MemoryStore({ limitBytes: limitFromEnv(), maxValueBytes: maxValueFromEnv() });
  return store;
}

/** Test seam: swap in a store with a known budget, or drop the current one. */
export function setStore(next = null) {
  store = next;
  return store;
}

export function limitFromEnv(env = process.env) {
  const configured = Number(env.ALPHA_MEMSTORE_LIMIT_MB);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured * MB);
  // A quarter of the machine, capped: enough to be useful on a 4 GB laptop,
  // restrained enough not to be the reason a 64 GB one starts swapping.
  return Math.min(Math.floor(os.totalmem() / 4), 1024 * MB);
}

function maxValueFromEnv(env = process.env) {
  const configured = Number(env.ALPHA_MEMSTORE_MAX_VALUE_MB);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured * MB) : null;
}

export function validateKey(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new ProtocolError(
      `"key" must match ${KEY_PATTERN} (got ${JSON.stringify(key)})`,
    );
  }
  return key;
}

function validateTtl(ttlMs) {
  if (ttlMs === undefined || ttlMs === null) return null;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) {
    throw new ProtocolError(`"ttlMs" must be an integer between 1 and ${MAX_TTL_MS}`);
  }
  return ttlMs;
}

export async function run(payload = {}) {
  const action = payload.action ?? 'stats';
  if (!ACTIONS.includes(action)) {
    throw new ProtocolError(
      `unsupported action ${JSON.stringify(action)}; expected one of ${ACTIONS.join(', ')}`,
    );
  }

  const memory = getStore();

  switch (action) {
    case 'put': {
      const key = validateKey(payload.key);
      const result = memory.put(key, payload.value, { ttlMs: validateTtl(payload.ttlMs) });
      return { action, ...result };
    }

    case 'get': {
      // A miss is a normal answer, not a failure: the host asked whether we
      // still hold something, and "no" is an answer to that question.
      return { action, ...memory.get(validateKey(payload.key)) };
    }

    case 'delete':
      return { action, ...memory.delete(validateKey(payload.key)) };

    case 'keys':
      return {
        action,
        keys: memory.keys({
          prefix: typeof payload.prefix === 'string' ? payload.prefix : '',
          limit: clampLimit(payload.limit),
        }),
      };

    case 'clear':
      return { action, ...memory.clear() };

    case 'stats':
    default:
      // The machine's own figures, not what it offers the host: the reserve
      // the agent holds back is the agent's business, and it is already
      // visible in `alpha-admin agents`.
      return {
        action: 'stats',
        store: memory.stats(),
        machine: { totalBytes: os.totalmem(), availableBytes: availableBytes() },
      };
  }
}

function clampLimit(limit) {
  if (!Number.isInteger(limit)) return 100;
  return Math.min(Math.max(limit, 1), 1_000);
}

import os from 'node:os';
import { readFileSync } from 'node:fs';

import { DEFAULT_MEMORY_RESERVE_BYTES, MB } from '../common/protocol.js';

/**
 * How much RAM this machine can lend the host.
 *
 * `os.freemem()` is the portable answer and, on Linux, the wrong one: it
 * reports MemFree, which excludes page cache the kernel would hand back the
 * moment anything asked for it. A laptop with 6 GB of cache looks full and
 * would never be offered work. /proc/meminfo's MemAvailable is the kernel's
 * own estimate of what a new allocation could actually get, so prefer it and
 * fall back to os.freemem() everywhere else.
 */
export function availableBytes() {
  if (process.platform === 'linux') {
    const fromProc = readMemAvailable();
    if (fromProc !== null) return fromProc;
  }
  return os.freemem();
}

function readMemAvailable() {
  try {
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'));
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    // Containers and hardened kernels can hide /proc; os.freemem() still works.
    return null;
  }
}

/**
 * The report the agent sends the host on registration, every heartbeat and
 * every poll.
 *
 * Two things come off the top of what this machine will lend.
 *
 * `reserveBytes` is what it keeps for itself. Lending every last free byte is
 * how a laptop ends up swapping, which helps nobody: the host gets a worker
 * that has to page its own task back in.
 *
 * `committedBytes` is what this agent's own handlers have already promised
 * themselves — the `memory.store` budget is the one that does this. Those bytes
 * are free right now and would otherwise be offered to the host as lendable, so
 * the host would place a 4 GB task on a machine whose cache is about to grow
 * into the same gigabyte. Only headroom counts: memory a handler is already
 * holding is real heap and has left `freeBytes` on its own.
 *
 * `freeBytes` stays the machine's honest figure either way — the withholding
 * belongs in `offerableBytes`, which is the only one placement reads.
 */
export function memorySnapshot({
  reserveBytes = DEFAULT_MEMORY_RESERVE_BYTES,
  committedBytes = 0,
} = {}) {
  const totalBytes = os.totalmem();
  const freeBytes = availableBytes();
  const heldBack = Math.max(0, reserveBytes) + Math.max(0, committedBytes);
  return {
    totalBytes,
    freeBytes,
    offerableBytes: Math.max(0, freeBytes - heldBack),
  };
}

/** Reads a reserve out of the environment, in MB, falling back to the default. */
export function reserveFromEnv(value, fallback = DEFAULT_MEMORY_RESERVE_BYTES) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const mb = Number(value);
  if (!Number.isFinite(mb) || mb < 0) {
    throw new Error(`memory reserve must be a non-negative number of MB (got ${JSON.stringify(value)})`);
  }
  return Math.floor(mb * MB);
}

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
 * `reservePercent` is the same reserve said as a share of this machine's RAM,
 * and the larger of the two wins. It exists because the MB figure is the one
 * thing in `.env.agent` that cannot survive being copied: 512 MB is a tenth of
 * an 8 GB laptop and a thirty-second of a 32 GB one, so one file gives two
 * machines two different bargains. A percentage says the thing an owner
 * actually means — *this machine may be worked to 90%, that one to 20%* — and
 * means it on every machine the file lands on. The MB figure stays as the
 * floor under it: never lend the last half gigabyte, whatever the percentage
 * works out to.
 *
 * `freeBytes` stays the machine's honest figure either way — the withholding
 * belongs in `offerableBytes`, which is the only one placement reads.
 */
export function memorySnapshot({
  reserveBytes = DEFAULT_MEMORY_RESERVE_BYTES,
  reservePercent = 0,
  committedBytes = 0,
} = {}) {
  const totalBytes = os.totalmem();
  const freeBytes = availableBytes();
  // Of total, not of free: "keep a tenth of this laptop for its owner" is a
  // claim about the machine, and a share of whatever happens to be free right
  // now shrinks exactly when the owner needs it most.
  const fromPercent = Math.floor((totalBytes * clampPercent(reservePercent)) / 100);
  const reserve = Math.max(Math.max(0, reserveBytes), fromPercent);
  const heldBack = reserve + Math.max(0, committedBytes);
  return {
    totalBytes,
    freeBytes,
    reserveBytes: reserve,
    offerableBytes: Math.max(0, freeBytes - heldBack),
  };
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * Reads a reserve percentage out of the environment.
 *
 * 100 is legal and means "lend nothing" — a machine present for one pinned job
 * and nothing else, which is a real configuration here: the box with the GPU
 * takes renders by name and should not be winning general work on free RAM.
 */
export function reservePercentFromEnv(value, fallback = 0) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const percent = Number(value);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error(
      `memory reserve percent must be between 0 and 100 (got ${JSON.stringify(value)})`,
    );
  }
  return percent;
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

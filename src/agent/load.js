import os from 'node:os';

/**
 * How busy this machine's CPUs are, as a number the host can place work by.
 *
 * Free RAM says nothing about whether a laptop is already pinned: a machine
 * running a compile at 100% CPU still reports gigabytes free and, to a host
 * that only knows about memory, looks exactly as good a target as an idle one.
 * That is how both laptops end up saturated while the queue drains onto
 * whichever of them happened to ask first.
 *
 * Two signals, because neither is enough on its own:
 *
 * - **Utilisation** from `os.cpus()` tick deltas. Portable — it is the only
 *   one that works on Windows, where `os.loadavg()` is hardcoded to [0,0,0] —
 *   but it saturates at 1.0, so a machine at 100% and a machine at 400%
 *   oversubscribed look identical.
 * - **Run-queue pressure** from the 1-minute load average over core count.
 *   Unbounded, so it separates "busy" from "drowning", and on Linux it counts
 *   tasks blocked on I/O too. Unavailable on Windows.
 *
 * `loadFactor` is the larger of the two: whichever signal says this machine is
 * in trouble is believed. Below 1.0 it reads as "fraction of this machine
 * spoken for"; above 1.0 it means work is queueing behind the CPUs.
 */

// The shortest gap between two tick readings worth dividing. Below this the
// delta is a couple of ticks of quantised accounting, and the ratio it yields
// is noise — reliably 0% or 100%, never anything in between. Reporting that
// noise made an agent announce itself at 100% load the instant it started,
// which had it decline work on the very first poll of its life.
const MIN_SAMPLE_WINDOW_MS = 200;

// Ticks are cumulative since boot, so a single reading is an average over the
// machine's whole uptime and useless for scheduling. The sampler keeps the
// previous reading and reports the delta between the two.
export class LoadSampler {
  #previous = null;
  #previousAt = -Infinity;
  #last = null;
  #lastAt = -Infinity;

  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.#previous = readTicks();
    this.#previousAt = this.now();
  }

  /**
   * Utilisation since the last call, in 0..1. Null until two readings exist or
   * when no time has passed between them — an unknown figure is reported as
   * unknown rather than guessed at.
   */
  utilisation() {
    const at = this.now();
    const previous = this.#previous;

    if (!previous) {
      this.#previous = readTicks();
      this.#previousAt = at;
      return null;
    }

    // Deliberately does not advance the baseline: keeping the older reading
    // means the next call measures against a window that has had time to grow,
    // instead of resetting to another useless one.
    if (at - this.#previousAt < MIN_SAMPLE_WINDOW_MS) return null;

    const current = readTicks();
    this.#previous = current;
    this.#previousAt = at;
    if (!current) return null;

    const totalDelta = current.total - previous.total;
    const idleDelta = current.idle - previous.idle;
    if (totalDelta <= 0) return null;

    return clamp((totalDelta - idleDelta) / totalDelta, 0, 1);
  }

  /**
   * The full report the agent sends on registration and every heartbeat.
   *
   * Repeated calls inside `minIntervalMs` return the previous answer rather
   * than resampling. Two readings taken microseconds apart span no ticks at
   * all, which reads as "unknown" — and the agent asks for its own load in two
   * places (the heartbeat and the poll loop's load check) that can easily land
   * in the same instant.
   */
  snapshot({ minIntervalMs = 2_000 } = {}) {
    if (this.#last && this.now() - this.#lastAt < minIntervalMs) return this.#last;

    const cpus = Math.max(1, os.cpus().length);
    const busy = this.utilisation();
    const loadAverage1 = readLoadAverage();
    const pressure = loadAverage1 === null ? null : loadAverage1 / cpus;

    this.#last = {
      cpus,
      // Both are reported even though only loadFactor is scheduled on, so an
      // operator reading `alpha-admin agents --json` can see which signal is
      // driving a placement decision.
      busy,
      loadAverage1,
      loadFactor: combine(busy, pressure),
    };
    this.#lastAt = this.now();
    return this.#last;
  }
}

/**
 * Reads the aggregate CPU ticks across every core.
 *
 * `os.cpus()` can come back empty inside constrained containers; treat that as
 * no reading rather than dividing by zero further down.
 */
function readTicks() {
  const cpus = os.cpus();
  if (!Array.isArray(cpus) || cpus.length === 0) return null;

  let total = 0;
  let idle = 0;
  for (const cpu of cpus) {
    for (const value of Object.values(cpu.times)) total += value;
    idle += cpu.times.idle;
  }
  return { total, idle };
}

/**
 * The 1-minute load average, or null where the platform does not have one.
 *
 * Windows is the case that matters here: the Alpha host is a Windows machine
 * and `os.loadavg()` there returns [0, 0, 0] unconditionally. Reading that as
 * "completely idle" would make the busiest machine in the fleet look like the
 * most attractive one.
 */
function readLoadAverage() {
  if (process.platform === 'win32') return null;
  const [oneMinute] = os.loadavg();
  return Number.isFinite(oneMinute) ? oneMinute : null;
}

/** The pessimistic reading of the two signals, or null when neither exists. */
function combine(busy, pressure) {
  const values = [busy, pressure].filter((value) => value !== null && Number.isFinite(value));
  if (values.length === 0) return null;
  // Capped rather than unbounded: a load average spike of 40 on a stuck
  // machine should not produce a number that dominates every later comparison.
  return clamp(Math.max(...values), 0, 8);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * The ceiling above which an agent stops asking for work, read from the
 * environment in the same shape as the memory reserve.
 */
export function maxLoadFromEnv(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`max load must be a positive number (got ${JSON.stringify(value)})`);
  }
  return parsed;
}

/** How many tasks this machine will run at once, read from the environment. */
export function concurrencyFromEnv(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 64) {
    throw new Error(`concurrency must be an integer between 1 and 64 (got ${JSON.stringify(value)})`);
  }
  return parsed;
}

// Exponential backoff with full jitter, capped. Returns a delay in ms for a
// zero-based attempt number; the jitter keeps a fleet of agents from
// reconnecting to a restarted host in lockstep.
export function backoffDelay(attempt, { baseMs = 500, maxMs = 30_000 } = {}) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(Math.random() * ceiling);
}

export function sleep(ms, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    // Left ref'd on purpose. A backoff nap is the whole of the pending work
    // during a reconnect: unref'ing it lets the event loop drain while an
    // agent waits to retry, so a worker started a moment before its host
    // exits silently instead of connecting when the host comes up.
    // Cancellation is the `signal`'s job, not the timer's ref state.
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// How long a supervised child has to stay up before its next exit counts as a
// first failure again. Without a reset, a supervisor that restarts an agent or
// Alpha counted every crash it had ever seen: one a week after the last, on a
// process that had been healthy in between, still waited out the full cap as
// if it were crash-looping. Five minutes is far past any backoff delay, so a
// real crash loop never gets that far and keeps backing off.
export const HEALTHY_RUN_MS = 5 * 60 * 1_000;

/** The failure count to back off from, given how long the child just ran. */
export function failuresAfterRun(failures, ranMs, healthyMs = HEALTHY_RUN_MS) {
  return ranMs >= healthyMs ? 0 : failures;
}

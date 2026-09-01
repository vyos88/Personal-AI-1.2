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

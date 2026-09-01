// Small JSON-over-HTTP client used by the agent to talk to the host.
//
// Retries are an iterative loop with a hard attempt ceiling, never a recursive
// re-call: a recursive retry that re-enters itself on every failure has no
// bound on stack depth and turns a flapping host into a crashed agent.

import { backoffDelay, sleep } from './backoff.js';

export class HttpError extends Error {
  constructor(status, body, url) {
    super(`HTTP ${status} from ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

// 408/429 and 5xx are worth another attempt; every other 4xx is a client-side
// mistake that will fail identically no matter how many times we resend it.
function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function combineSignals(signals) {
  const present = signals.filter(Boolean);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

/**
 * @returns {Promise<{status: number, body: any}>} `body` is null for 204.
 */
export async function fetchJson(url, {
  method = 'GET',
  token,
  body,
  timeoutMs = 15_000,
  retries = 0,
  signal,
  retryOn = isRetryableStatus,
} = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await sleep(backoffDelay(attempt - 1), { signal });
    }

    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combineSignals([signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (error) {
      // A caller-driven abort is intentional; surface it instead of retrying.
      if (signal?.aborted) throw error;
      lastError = error;
      continue;
    }

    if (response.status === 204) return { status: 204, body: null };

    const text = await response.text();
    let parsed = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text.slice(0, 2_000) };
      }
    }

    if (response.ok) return { status: response.status, body: parsed };

    const httpError = new HttpError(response.status, parsed, url);
    if (!retryOn(response.status)) throw httpError;
    lastError = httpError;
  }

  throw lastError ?? new Error(`request to ${url} failed with no recorded cause`);
}

export { isRetryableStatus };

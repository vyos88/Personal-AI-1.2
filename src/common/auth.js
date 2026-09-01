import { timingSafeEqual } from 'node:crypto';

// Compares without leaking length or content through timing. Buffers of
// differing length cannot go to timingSafeEqual at all, so hash-free length
// checks happen first and deliberately return the same `false` either way.
export function tokensMatch(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Accepts "Authorization: Bearer <token>"; returns null when absent or malformed.
export function bearerFrom(headers) {
  const raw = headers?.authorization ?? headers?.Authorization;
  if (typeof raw !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(raw.trim());
  return match ? match[1] : null;
}


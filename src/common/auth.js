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

export function requireToken(envName = 'ALPHA_TUNNEL_TOKEN') {
  const token = process.env[envName];
  if (!token || token === 'replace-me') {
    throw new Error(
      `${envName} is not set. Generate one with:\n` +
        `  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"\n` +
        `and set the same value on the host and every agent.`,
    );
  }
  if (token.length < 16) {
    throw new Error(`${envName} must be at least 16 characters`);
  }
  return token;
}

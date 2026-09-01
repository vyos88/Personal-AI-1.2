import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Credential format: `alpha_<kind>_<id>.<secret>`
 *
 * The id is public and indexes the record; only the secret is sensitive. That
 * split is what lets verification be an O(1) lookup followed by one
 * constant-time compare, instead of scanning every stored credential (which
 * both scales badly and leaks position through timing).
 *
 * Secrets are stored only as a SHA-256 digest. A plain digest is right here —
 * unlike a password, the secret is 256 bits of CSPRNG output, so there is no
 * guessable input space for a slow KDF to protect.
 */

const ID_BYTES = 8;
const SECRET_BYTES = 32;

export const TokenKind = Object.freeze({
  API_KEY: 'key',
  INVITE: 'inv',
  SESSION: 'ses',
});

export function hashSecret(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * @returns {{token: string, id: string, secretHash: string}} `token` is the
 * only time the secret exists in plaintext — it is never stored or logged.
 */
export function generateToken(kind) {
  const id = randomBytes(ID_BYTES).toString('hex');
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return {
    token: `alpha_${kind}_${id}.${secret}`,
    id,
    secretHash: hashSecret(secret),
  };
}

/** Splits a presented credential without throwing on malformed input. */
export function parseToken(token) {
  if (typeof token !== 'string') return null;
  const match = /^alpha_([a-z]+)_([0-9a-f]+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!match) return null;
  return { kind: match[1], id: match[2], secret: match[3] };
}

export function secretMatches(secret, expectedHash) {
  if (typeof secret !== 'string' || typeof expectedHash !== 'string') return false;
  const presented = Buffer.from(hashSecret(secret), 'utf8');
  const expected = Buffer.from(expectedHash, 'utf8');
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

/** Safe to log or return in an API response — identifies without revealing. */
export function tokenFingerprint(kind, id) {
  return `alpha_${kind}_${id}`;
}

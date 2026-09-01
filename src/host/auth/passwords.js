import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { ProtocolError } from '../../common/protocol.js';

const scrypt = promisify(scryptCallback);

// scrypt parameters. N=2^15 with r=8 costs roughly 100ms and 32MB per hash on
// a normal machine — slow enough to make offline guessing expensive, fast
// enough for an interactive login.
const PARAMS = { N: 32_768, r: 8, p: 1, keylen: 64 };
const SALT_BYTES = 16;

// Node's default memory ceiling for scrypt is below what N=2^15 needs.
const MAXMEM = 256 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 12;

export function assertPasswordAcceptable(password) {
  if (typeof password !== 'string') {
    throw new ProtocolError('"password" must be a string');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ProtocolError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > 1_024) {
    // Bounded so a huge input cannot turn one login into a memory-hard DoS.
    throw new ProtocolError('password must be at most 1024 characters');
  }
  return password;
}

/**
 * Returns `scrypt$N$r$p$<salt-b64>$<hash-b64>`. Self-describing on purpose:
 * stored hashes stay verifiable if the cost parameters are raised later.
 */
export async function hashPassword(password) {
  assertPasswordAcceptable(password);
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, PARAMS.keylen, { ...PARAMS, maxmem: MAXMEM });
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, rawN, rawR, rawP, saltB64, hashB64] = parts;
  const N = Number.parseInt(rawN, 10);
  const r = Number.parseInt(rawR, 10);
  const p = Number.parseInt(rawP, 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const derived = await scrypt(password, salt, expected.length, { N, r, p, maxmem: MAXMEM });
    return timingSafeEqual(derived, expected);
  } catch {
    // Unreadable parameters or an oversized cost factor: treat as a failed
    // login rather than surfacing the stored record's shape to the caller.
    return false;
  }
}

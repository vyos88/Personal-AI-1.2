import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where `alpha-admin login` keeps its session between commands.
 *
 * Without this, signing in printed a token for the operator to copy into
 * ALPHA_ADMIN_TOKEN by hand. That is two chances to go wrong in one step: on
 * the Alpha host a paste landed on the wrong prompt, every following command
 * said "No credential", and the admin token ended up pasted into a chat
 * instead. A file in the operator's own profile is what `gh`, `npm` and
 * `docker` do for the same reason.
 *
 * The file holds a *session*, never a key: it expires on its own (the host's
 * session TTL), `logout` revokes it on the host as well as deleting it, and it
 * is only used for the coordinator it was issued by. Real environment
 * variables always win, so nothing that sets ALPHA_ADMIN_TOKEN changes.
 */
export function sessionFile(env = process.env) {
  return env.ALPHA_ADMIN_SESSION_FILE || join(homedir(), '.alpha-admin', 'session.json');
}

export function saveSession({ host, token, email, expiresAt }, env = process.env) {
  const path = sessionFile(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ host, token, email, expiresAt }, null, 2) + '\n', {
    mode: 0o600,
  });
  // writeFileSync's mode only applies when it creates the file; an older,
  // looser file keeps its permissions unless they are set again. A no-op on
  // Windows, where the profile directory is already private to its user.
  try {
    chmodSync(path, 0o600);
  } catch {
    // Not fatal: the token is still a session that expires.
  }
  return path;
}

/**
 * The saved session for `host`, or null. A session for another coordinator,
 * an expired one, or an unreadable file all read as "not signed in" rather than
 * as an error: the next command then says how to sign in.
 */
export function loadSession(host, { env = process.env, now = Date.now() } = {}) {
  let saved;
  try {
    saved = JSON.parse(readFileSync(sessionFile(env), 'utf8'));
  } catch {
    return null;
  }
  if (!saved || typeof saved.token !== 'string' || saved.host !== host) return null;
  // The host reports expiry as epoch ms; accept an ISO string as well.
  const expires =
    typeof saved.expiresAt === 'number' ? saved.expiresAt : Date.parse(saved.expiresAt ?? '');
  if (Number.isFinite(expires) && expires <= now) return null;
  return saved;
}

export function clearSession(env = process.env) {
  rmSync(sessionFile(env), { force: true });
}

import { randomBytes } from 'node:crypto';

import { AuthStore } from './store.js';
import { hashPassword, verifyPassword, assertPasswordAcceptable } from './passwords.js';
import {
  TokenKind,
  generateToken,
  parseToken,
  secretMatches,
  tokenFingerprint,
} from './tokens.js';
import {
  SCOPES,
  assertCanGrant,
  hasScope,
  normalizeScopes,
} from './scopes.js';
import { ProtocolError, newId } from '../../common/protocol.js';
import { tokensMatch } from '../../common/auth.js';
import { createLogger } from '../../common/log.js';

const log = createLogger('host:auth');

export const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000; // 7 days
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1_000; // 12 hours
export const MAX_TTL_MS = 365 * 24 * 60 * 60 * 1_000; // 1 year

// Login throttling. Deliberately coarse: enough to make online guessing
// impractical without needing a store round-trip per attempt.
const LOGIN_MAX_FAILURES = 8;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1_000;
// Failures are tracked per email *attempted*, not per account, and the login
// route is unauthenticated — so without a bound, anyone who can reach the port
// grows this Map by one entry per made-up address for as long as the host
// runs. Past this many, entries old enough to have unlocked are dropped, then
// the oldest.
export const LOGIN_FAILURES_TRACKED_MAX = 10_000;

// A stand-in hash with the real cost, verified against when no user matches.
// Without it, "unknown email" returns fast and "known email, wrong password"
// returns slow, which is a free user-enumeration oracle.
const DUMMY_HASH_PROMISE = hashPassword('dummy-password-for-constant-time');

export const UserStatus = Object.freeze({ ACTIVE: 'active', DISABLED: 'disabled' });

function normalizeEmail(email) {
  if (typeof email !== 'string') throw new ProtocolError('"email" must be a string');
  const trimmed = email.trim().toLowerCase();
  // Intentionally permissive: enough to catch typos and keep the value usable
  // as a key, without pretending to implement RFC 5322.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) || trimmed.length > 254) {
    throw new ProtocolError(`"${email}" is not a usable email address`);
  }
  return trimmed;
}

function ttlToExpiry(ttlMs, fallback, now) {
  if (ttlMs === undefined || ttlMs === null) return now + fallback;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new ProtocolError('"expiresInMs" must be a positive integer');
  }
  if (ttlMs > MAX_TTL_MS) {
    throw new ProtocolError(`"expiresInMs" must be at most ${MAX_TTL_MS} (one year)`);
  }
  return now + ttlMs;
}

/** Strips secret material so a record can be returned over the API. */
function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    scopes: user.scopes,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt ?? null,
    invitedBy: user.invitedBy ?? null,
  };
}

function publicInvite(invite) {
  return {
    id: invite.id,
    email: invite.email,
    scopes: invite.scopes,
    status: inviteStatus(invite, Date.now()),
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    redeemedAt: invite.redeemedAt ?? null,
    redeemedByUserId: invite.redeemedByUserId ?? null,
    revokedAt: invite.revokedAt ?? null,
    invitedBy: invite.invitedBy ?? null,
    fingerprint: tokenFingerprint(TokenKind.INVITE, invite.id),
  };
}

function publicKey(key) {
  return {
    id: key.id,
    kind: key.kind,
    name: key.name,
    userId: key.userId,
    scopes: key.scopes,
    createdAt: key.createdAt,
    expiresAt: key.expiresAt ?? null,
    lastUsedAt: key.lastUsedAt ?? null,
    revokedAt: key.revokedAt ?? null,
    fingerprint: tokenFingerprint(key.kind, key.id),
  };
}

function inviteStatus(invite, now) {
  if (invite.revokedAt) return 'revoked';
  if (invite.redeemedAt) return 'redeemed';
  if (invite.expiresAt <= now) return 'expired';
  return 'pending';
}

/**
 * Why a login failed, for the log only.
 *
 * `login()` deliberately answers all three of these with the same 401 and the
 * same message, and burns the same time on a password verification even when
 * no such user exists, so a stranger cannot use the endpoint to discover which
 * addresses have accounts. That protection is for the response. It is not for
 * the operator, who owns the machine and is the one person entitled to know
 * whether the attempts hitting it are aimed at a real account or are a scan
 * walking a username list — which is the whole difference between "ignore it"
 * and "rotate that password now".
 *
 * Exported so the classification can be tested without asserting on log text.
 */
export function loginFailureReason(user, passwordMatched) {
  if (!user) return 'no_such_user';
  if (!passwordMatched) return 'wrong_password';
  if (user.status !== UserStatus.ACTIVE) return 'user_disabled';
  return null;
}

/**
 * An attempted address, made safe to put in a line-oriented log.
 *
 * The malformed case is the reason this exists: that value never passed
 * `normalizeEmail`, so it can be any type, any length, and can contain the
 * newline that would let it forge a second log line.
 */
function previewEmail(value) {
  if (typeof value !== 'string') return `<${value === null ? 'null' : typeof value}>`;
  const flattened = value.replace(/[\r\n\t\u0000-\u001f]/g, ' ').trim();
  const clipped = flattened.length > 120 ? `${flattened.slice(0, 120)}...` : flattened;
  // Quoted, because the human log format writes string fields raw: an attempted
  // address reading `nope WARN [host:auth] login succeeded` would otherwise sit
  // in the line looking exactly like the record it is pretending to be. The
  // newline is already gone, so this is the last way it could imitate structure.
  return JSON.stringify(clipped);
}

/**
 * Drops login sessions past their expiry. Every login writes one record and
 * nothing else ever removed them, so auth.json grew by one per login for the
 * life of the host. An expired session can never authenticate again and a
 * user cannot revoke it (it is not theirs to manage the way an API key is),
 * so there is nothing it is kept for. API keys are left alone even when
 * expired: they are named, deliberately issued credentials an operator may
 * still want to see listed.
 */
function pruneExpiredSessions(data, now) {
  let pruned = 0;
  for (const [id, key] of Object.entries(data.apiKeys)) {
    if (key.kind === TokenKind.SESSION && key.expiresAt && key.expiresAt <= now) {
      delete data.apiKeys[id];
      pruned += 1;
    }
  }
  return pruned;
}

export class AuthService {
  #loginFailures = new Map();

  /**
   * @param {object} options
   * @param {string|null} options.bootstrapToken Env-provided break-glass
   *   credential with full scope. Intended to create the first real admin and
   *   then be removed.
   */
  constructor({
    store = new AuthStore(),
    bootstrapToken = null,
    now = () => Date.now(),
    maxTrackedLoginFailures = LOGIN_FAILURES_TRACKED_MAX,
  } = {}) {
    this.store = store;
    this.maxTrackedLoginFailures = maxTrackedLoginFailures;
    this.bootstrapToken = bootstrapToken || null;
    this.now = now;
  }

  async load() {
    await this.store.load();
    // A host that restarts after a quiet spell sheds what accumulated before
    // it went down, rather than waiting for the next login to do it.
    const pruned = pruneExpiredSessions(this.store.data, this.now());
    if (pruned > 0) {
      await this.store.save();
      log.info('pruned expired login sessions', { count: pruned });
    }
    if (this.bootstrapToken && this.userCount() > 0) {
      log.warn(
        'ALPHA_BOOTSTRAP_TOKEN is still set but real users exist — ' +
          'unset it so the break-glass credential is no longer accepted',
      );
    }
    return this;
  }

  userCount() {
    return Object.keys(this.store.data.users).length;
  }

  // ---------------------------------------------------------------- identity

  /**
   * Resolves a presented bearer token to a principal, or null.
   *
   * Effective scopes are the intersection of the key's scopes and its owner's,
   * recomputed on every request. Narrowing a user's scopes therefore takes
   * effect immediately across every key they already hold, instead of leaving
   * stale grants behind on long-lived credentials.
   */
  async authenticate(presented) {
    if (typeof presented !== 'string' || presented === '') return null;

    if (this.bootstrapToken && tokensMatch(presented, this.bootstrapToken)) {
      return {
        kind: 'bootstrap',
        userId: null,
        keyId: null,
        scopes: [SCOPES.ADMIN],
        label: 'bootstrap',
      };
    }

    const parsed = parseToken(presented);
    if (!parsed) return null;
    if (parsed.kind !== TokenKind.API_KEY && parsed.kind !== TokenKind.SESSION) return null;

    const record = this.store.data.apiKeys[parsed.id];
    if (!record || record.kind !== parsed.kind) return null;
    if (!secretMatches(parsed.secret, record.secretHash)) return null;

    const now = this.now();
    if (record.revokedAt) return null;
    if (record.expiresAt && record.expiresAt <= now) return null;

    const user = this.store.data.users[record.userId];
    if (!user || user.status !== UserStatus.ACTIVE) return null;

    const effective = record.scopes.filter((scope) => hasScope(user.scopes, scope));
    if (effective.length === 0) return null;

    // Best-effort usage timestamp; a failed write must not fail the request.
    record.lastUsedAt = now;
    this.store.save().catch((error) => log.warn('could not persist lastUsedAt', { message: error.message }));

    return {
      kind: 'user',
      userId: user.id,
      keyId: record.id,
      scopes: effective,
      label: user.email,
    };
  }

  // ----------------------------------------------------------------- invites

  async createInvite({ email, scopes, expiresInMs, invitedBy }) {
    const normalizedEmail = normalizeEmail(email);
    const normalizedScopes = normalizeScopes(scopes);
    assertCanGrant(invitedBy.scopes, normalizedScopes);

    const existing = this.#findUserByEmail(normalizedEmail);
    if (existing) {
      throw new ProtocolError(`a user already exists for ${normalizedEmail}`, {
        status: 409,
        code: 'user_exists',
      });
    }

    const now = this.now();
    const { token, id, secretHash } = generateToken(TokenKind.INVITE);
    const invite = {
      id,
      secretHash,
      email: normalizedEmail,
      scopes: normalizedScopes,
      invitedBy: invitedBy.userId ?? invitedBy.label,
      createdAt: now,
      expiresAt: ttlToExpiry(expiresInMs, DEFAULT_INVITE_TTL_MS, now),
      redeemedAt: null,
      redeemedByUserId: null,
      revokedAt: null,
    };

    await this.store.mutate((data) => {
      data.invites[id] = invite;
    });

    log.info('invite created', {
      inviteId: id,
      email: normalizedEmail,
      scopes: normalizedScopes,
      by: invite.invitedBy,
    });
    // `token` is returned exactly once and never stored in plaintext.
    return { invite: publicInvite(invite), token };
  }

  /** Look up an invite by its token without consuming it. */
  peekInvite(token) {
    const invite = this.#resolveInvite(token);
    return {
      email: invite.email,
      scopes: invite.scopes,
      expiresAt: invite.expiresAt,
    };
  }

  async redeemInvite({ token, password, name }) {
    const invite = this.#resolveInvite(token);
    assertPasswordAcceptable(password);

    if (this.#findUserByEmail(invite.email)) {
      throw new ProtocolError(`a user already exists for ${invite.email}`, {
        status: 409,
        code: 'user_exists',
      });
    }

    const now = this.now();
    const passwordHash = await hashPassword(password);
    const user = {
      id: newId('user'),
      email: invite.email,
      name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 128) : invite.email,
      passwordHash,
      scopes: invite.scopes,
      status: UserStatus.ACTIVE,
      invitedBy: invite.invitedBy,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
    };

    const key = this.#buildKey({
      userId: user.id,
      name: 'initial key from invite',
      scopes: invite.scopes,
      kind: TokenKind.API_KEY,
      expiresAt: null,
      now,
    });

    await this.store.mutate((data) => {
      data.users[user.id] = user;
      data.apiKeys[key.record.id] = key.record;
      // Single-use: mark redeemed in the same write that creates the user, so
      // two concurrent redemptions cannot both succeed.
      const stored = data.invites[invite.id];
      stored.redeemedAt = now;
      stored.redeemedByUserId = user.id;
    });

    log.info('invite redeemed', { inviteId: invite.id, userId: user.id, email: user.email });
    return { user: publicUser(user), token: key.token };
  }

  async revokeInvite(inviteId, by) {
    const invite = this.store.data.invites[inviteId];
    if (!invite) throw new ProtocolError('unknown invite', { status: 404, code: 'unknown_invite' });
    if (invite.redeemedAt) {
      throw new ProtocolError('invite has already been redeemed; disable the user instead', {
        status: 409,
        code: 'already_redeemed',
      });
    }
    if (invite.revokedAt) return publicInvite(invite);

    await this.store.mutate((data) => {
      data.invites[inviteId].revokedAt = this.now();
    });
    log.info('invite revoked', { inviteId, by: by?.label });
    return publicInvite(this.store.data.invites[inviteId]);
  }

  listInvites({ status } = {}) {
    const now = this.now();
    return Object.values(this.store.data.invites)
      .map(publicInvite)
      .filter((invite) => !status || invite.status === status)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  #resolveInvite(token) {
    const parsed = parseToken(token);
    const invalid = new ProtocolError('invite token is not valid', {
      status: 404,
      code: 'invalid_invite',
    });
    if (!parsed || parsed.kind !== TokenKind.INVITE) throw invalid;

    const invite = this.store.data.invites[parsed.id];
    if (!invite) throw invalid;
    if (!secretMatches(parsed.secret, invite.secretHash)) throw invalid;

    const status = inviteStatus(invite, this.now());
    if (status !== 'pending') {
      throw new ProtocolError(`invite is ${status}`, { status: 410, code: `invite_${status}` });
    }
    return invite;
  }

  // ------------------------------------------------------------------- login

  async login({ email, password, remoteAddress = null, forwardedFor = null }) {
    // Where it came from. Two fields rather than one, because they are trusted
    // differently and collapsing them would hide that: `remoteAddress` is the
    // socket and cannot be forged, but behind Cloudflare or a Vite proxy it is
    // the proxy rather than the person; `forwardedFor` is a header the client
    // sent and can say anything at all, and is the only way to see past that
    // proxy. Neither is the answer on its own.
    const origin = {
      remoteAddress: remoteAddress ?? null,
      forwardedFor: forwardedFor ? previewEmail(forwardedFor) : null,
    };

    let normalizedEmail;
    try {
      normalizedEmail = normalizeEmail(email);
    } catch (error) {
      // Refused before any credential is looked at, so without this it left no
      // trace whatsoever — and "not even an email address" is precisely the
      // shape of a scan walking `admin`, `root`, `test`. The single most
      // common thing an exposed login endpoint sees was the one thing this
      // host could not see.
      log.warn('login failed', { reason: 'malformed_email', email: previewEmail(email), ...origin });
      throw error;
    }

    try {
      this.#assertNotLockedOut(normalizedEmail);
    } catch (error) {
      // The loudest signal there is: this address already failed
      // LOGIN_MAX_FAILURES times and is still being tried.
      log.warn('login failed', {
        reason: 'locked_out',
        email: normalizedEmail,
        failures: this.#loginFailures.get(normalizedEmail)?.count ?? 0,
        ...origin,
      });
      throw error;
    }

    const user = this.#findUserByEmail(normalizedEmail);
    // Always run a real verification, even with no user, so the response time
    // does not distinguish "no such account" from "wrong password".
    const hash = user ? user.passwordHash : await DUMMY_HASH_PROMISE;
    const ok = await verifyPassword(password, hash);

    const reason = loginFailureReason(user, ok);
    if (reason) {
      this.#recordLoginFailure(normalizedEmail);
      // The password is never logged, in any form: a mistyped one is usually a
      // real password, often the right one for somewhere else.
      log.warn('login failed', {
        reason,
        email: normalizedEmail,
        failures: this.#loginFailures.get(normalizedEmail)?.count ?? 0,
        ...origin,
      });
      throw new ProtocolError('invalid email or password', {
        status: 401,
        code: 'invalid_credentials',
      });
    }

    this.#loginFailures.delete(normalizedEmail);

    const now = this.now();
    const session = this.#buildKey({
      userId: user.id,
      name: 'login session',
      scopes: user.scopes,
      kind: TokenKind.SESSION,
      expiresAt: now + DEFAULT_SESSION_TTL_MS,
      now,
    });

    await this.store.mutate((data) => {
      // Pruned at issue time because issuing is the only thing that adds one:
      // the file then holds at most the sessions of the last TTL, however
      // long the host runs.
      pruneExpiredSessions(data, now);
      data.apiKeys[session.record.id] = session.record;
      data.users[user.id].lastLoginAt = now;
    });

    log.info('login succeeded', { userId: user.id, email: user.email, ...origin });
    return {
      user: publicUser(this.store.data.users[user.id]),
      token: session.token,
      expiresAt: session.record.expiresAt,
    };
  }

  #assertNotLockedOut(email) {
    const entry = this.#loginFailures.get(email);
    if (!entry) return;
    if (entry.count < LOGIN_MAX_FAILURES) return;
    const unlocksAt = entry.lastAt + LOGIN_LOCKOUT_MS;
    if (unlocksAt > this.now()) {
      throw new ProtocolError('too many failed attempts; try again later', {
        status: 429,
        code: 'locked_out',
      });
    }
    this.#loginFailures.delete(email);
  }

  #recordLoginFailure(email) {
    const entry = this.#loginFailures.get(email) ?? { count: 0, lastAt: 0 };
    entry.count += 1;
    entry.lastAt = this.now();
    // Re-inserted so the Map's order is least-recently-failed first, which is
    // the order the bound below evicts in.
    this.#loginFailures.delete(email);
    this.#loginFailures.set(email, entry);
    if (this.#loginFailures.size > this.maxTrackedLoginFailures) this.#forgetLoginFailures();
  }

  /**
   * Forget the failures recorded against an email.
   *
   * Called when the password itself changes, because the count is a count of
   * failures against a secret that no longer exists. Without this, the one
   * user who most needs to get back in cannot: eight wrong attempts and an
   * admin reset leave a *correct* temporary password answering 429 for the
   * rest of the lockout window, and `changePassword` is worse still — it
   * revokes every session, so the user must log in again immediately with a
   * password nobody has ever failed on.
   *
   * Deliberately *not* called from `setUserStatus`. Re-enabling a user does
   * not change their password, so failures against it are still failures
   * against a live secret and still worth counting.
   */
  #clearLoginFailures(email) {
    this.#loginFailures.delete(normalizeEmail(email));
  }

  #forgetLoginFailures() {
    const cutoff = this.now() - LOGIN_LOCKOUT_MS;
    for (const [key, entry] of this.#loginFailures) {
      if (entry.lastAt <= cutoff) this.#loginFailures.delete(key);
    }
    // Still over after that means a burst inside one lockout window. Dropping
    // the least recent is what bounds it; the cost is that an address being
    // guessed slowly under cover of a flood loses its count and starts again.
    for (const key of this.#loginFailures.keys()) {
      if (this.#loginFailures.size <= this.maxTrackedLoginFailures) break;
      this.#loginFailures.delete(key);
    }
  }

  /** How many emails currently have failures on record. For tests. */
  get trackedLoginFailures() {
    return this.#loginFailures.size;
  }

  // -------------------------------------------------------------------- keys

  async createApiKey({ userId, name, scopes, expiresInMs }, by) {
    const user = this.store.data.users[userId];
    if (!user) throw new ProtocolError('unknown user', { status: 404, code: 'unknown_user' });

    // A key may never exceed its owner's scopes, nor the issuer's.
    const requested = normalizeScopes(scopes ?? user.scopes);
    assertCanGrant(user.scopes, requested);
    assertCanGrant(by.scopes, requested);

    const now = this.now();
    const key = this.#buildKey({
      userId,
      name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 128) : 'api key',
      scopes: requested,
      kind: TokenKind.API_KEY,
      expiresAt: expiresInMs === undefined ? null : ttlToExpiry(expiresInMs, MAX_TTL_MS, now),
      now,
    });

    await this.store.mutate((data) => {
      data.apiKeys[key.record.id] = key.record;
    });

    log.info('api key issued', { keyId: key.record.id, userId, scopes: requested, by: by?.label });
    return { key: publicKey(key.record), token: key.token };
  }

  async revokeApiKey(keyId, by) {
    const record = this.store.data.apiKeys[keyId];
    if (!record) throw new ProtocolError('unknown key', { status: 404, code: 'unknown_key' });
    if (record.revokedAt) return publicKey(record);

    await this.store.mutate((data) => {
      data.apiKeys[keyId].revokedAt = this.now();
    });
    log.info('api key revoked', { keyId, userId: record.userId, by: by?.label });
    return publicKey(this.store.data.apiKeys[keyId]);
  }

  listApiKeys({ userId } = {}) {
    return Object.values(this.store.data.apiKeys)
      .filter((key) => !userId || key.userId === userId)
      .map(publicKey)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  #buildKey({ userId, name, scopes, kind, expiresAt, now }) {
    const { token, id, secretHash } = generateToken(kind);
    return {
      token,
      record: {
        id,
        kind,
        secretHash,
        userId,
        name,
        scopes,
        createdAt: now,
        expiresAt,
        lastUsedAt: null,
        revokedAt: null,
      },
    };
  }

  // ------------------------------------------------------------------- users

  /** Emails are normalized on the way in, so an exact match is enough. */
  #findUserByEmail(email) {
    return Object.values(this.store.data.users).find((user) => user.email === email) ?? null;
  }

  listUsers() {
    return Object.values(this.store.data.users)
      .map(publicUser)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  getUser(userId) {
    const user = this.store.data.users[userId];
    return user ? publicUser(user) : null;
  }

  async setUserStatus(userId, status, by) {
    if (status !== UserStatus.ACTIVE && status !== UserStatus.DISABLED) {
      throw new ProtocolError(`"status" must be ${UserStatus.ACTIVE} or ${UserStatus.DISABLED}`);
    }
    const user = this.store.data.users[userId];
    if (!user) throw new ProtocolError('unknown user', { status: 404, code: 'unknown_user' });

    await this.store.mutate((data) => {
      data.users[userId].status = status;
      data.users[userId].updatedAt = this.now();
    });

    // Disabling is checked at authenticate() time, so every key this user
    // holds stops working on the very next request — no key sweep needed.
    log.info('user status changed', { userId, status, by: by?.label });
    return publicUser(this.store.data.users[userId]);
  }

  async setUserScopes(userId, scopes, by) {
    const user = this.store.data.users[userId];
    if (!user) throw new ProtocolError('unknown user', { status: 404, code: 'unknown_user' });

    const normalized = normalizeScopes(scopes);
    assertCanGrant(by.scopes, normalized);

    await this.store.mutate((data) => {
      data.users[userId].scopes = normalized;
      data.users[userId].updatedAt = this.now();
    });
    log.info('user scopes changed', { userId, scopes: normalized, by: by?.label });
    return publicUser(this.store.data.users[userId]);
  }

  /**
   * Resets a user's password without the current one — the admin-side
   * counterpart to `changePassword`, and the recovery path for an account
   * whose password is lost or forgotten. There is deliberately no other way to
   * get in: authorization for this is the caller's own scope (checked by the
   * server route, the same as `setUserStatus`/`setUserScopes`), not knowledge
   * of the old secret.
   *
   * `newPassword` is optional. Omit it and a random one is generated and
   * returned exactly once, the same way an invite or key token is — it is
   * never stored or logged in plaintext, only its hash is.
   */
  async adminResetPassword({ userId, newPassword, by }) {
    const user = this.store.data.users[userId];
    if (!user) throw new ProtocolError('unknown user', { status: 404, code: 'unknown_user' });

    const generated = newPassword === undefined || newPassword === null;
    const password = generated ? randomBytes(24).toString('base64url') : newPassword;
    assertPasswordAcceptable(password);
    const passwordHash = await hashPassword(password);
    const now = this.now();

    await this.store.mutate((data) => {
      data.users[userId].passwordHash = passwordHash;
      data.users[userId].updatedAt = now;
      // Same reasoning as changePassword: a reset is itself a response to a
      // lost or suspected-compromised credential, so every existing session
      // dies with it. Non-session API keys survive — they belong to running
      // agents and are revoked separately if that is ever the intent.
      for (const key of Object.values(data.apiKeys)) {
        if (key.userId === userId && key.kind === TokenKind.SESSION && !key.revokedAt) {
          key.revokedAt = now;
        }
      }
    });

    this.#clearLoginFailures(this.store.data.users[userId].email);

    log.info('password reset by admin', { userId, by: by?.label });
    return {
      user: publicUser(this.store.data.users[userId]),
      // Only present when this method chose the password itself — a caller
      // who supplied one already knows it.
      temporaryPassword: generated ? password : undefined,
    };
  }

  async changePassword({ userId, currentPassword, newPassword }) {
    const user = this.store.data.users[userId];
    if (!user) throw new ProtocolError('unknown user', { status: 404, code: 'unknown_user' });

    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new ProtocolError('current password is incorrect', {
        status: 403,
        code: 'invalid_credentials',
      });
    }
    assertPasswordAcceptable(newPassword);
    const passwordHash = await hashPassword(newPassword);
    const now = this.now();

    await this.store.mutate((data) => {
      data.users[userId].passwordHash = passwordHash;
      data.users[userId].updatedAt = now;
      // Changing a password is also how someone responds to a suspected
      // compromise, so every existing session dies with it. Non-session API
      // keys survive on purpose: they are separately revocable and often
      // belong to running agents.
      for (const key of Object.values(data.apiKeys)) {
        if (key.userId === userId && key.kind === TokenKind.SESSION && !key.revokedAt) {
          key.revokedAt = now;
        }
      }
    });

    this.#clearLoginFailures(this.store.data.users[userId].email);

    log.info('password changed', { userId });
    return publicUser(this.store.data.users[userId]);
  }
}

export { publicUser, publicInvite, publicKey, normalizeEmail };

import { ProtocolError } from '../../common/protocol.js';

/**
 * Every capability the API can gate on. `admin` is not a scope like the others:
 * it implies all of them, and it is the grant you hand someone who should be
 * able to do anything — including issue and revoke credentials for others.
 */
export const SCOPES = Object.freeze({
  ADMIN: 'admin',
  TASKS_READ: 'tasks:read',
  TASKS_WRITE: 'tasks:write',
  TASKS_CANCEL: 'tasks:cancel',
  AGENTS_READ: 'agents:read',
  AGENT_CONNECT: 'agent:connect',
  USERS_READ: 'users:read',
  USERS_WRITE: 'users:write',
  INVITES_READ: 'invites:read',
  INVITES_WRITE: 'invites:write',
  KEYS_WRITE: 'keys:write',
});

export const ALL_SCOPES = Object.freeze(Object.values(SCOPES));

const SCOPE_SET = new Set(ALL_SCOPES);

/** Named bundles, so a caller does not have to spell out a whole scope list. */
export const SCOPE_PRESETS = Object.freeze({
  admin: [SCOPES.ADMIN],
  operator: [
    SCOPES.TASKS_READ,
    SCOPES.TASKS_WRITE,
    SCOPES.TASKS_CANCEL,
    SCOPES.AGENTS_READ,
    SCOPES.KEYS_WRITE,
  ],
  agent: [SCOPES.AGENT_CONNECT],
  viewer: [SCOPES.TASKS_READ, SCOPES.AGENTS_READ],
});

/**
 * Accepts a scope list or a preset name and returns a validated, deduped,
 * sorted list. `*` is accepted as a spelling of `admin` because "give them
 * everything" is how people say it.
 */
export function normalizeScopes(input) {
  let requested = input;

  if (typeof requested === 'string') {
    if (SCOPE_PRESETS[requested]) requested = SCOPE_PRESETS[requested];
    else requested = requested.split(',');
  }
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new ProtocolError('"scopes" must be a non-empty array, a comma-separated string, or a preset name');
  }

  const out = new Set();
  for (const entry of requested) {
    if (typeof entry !== 'string') throw new ProtocolError('each scope must be a string');
    const scope = entry.trim();
    if (scope === '') continue;
    if (scope === '*') {
      out.add(SCOPES.ADMIN);
      continue;
    }
    if (SCOPE_PRESETS[scope]) {
      for (const preset of SCOPE_PRESETS[scope]) out.add(preset);
      continue;
    }
    if (!SCOPE_SET.has(scope)) {
      throw new ProtocolError(
        `unknown scope ${JSON.stringify(scope)}; known scopes: ${ALL_SCOPES.join(', ')}`,
      );
    }
    out.add(scope);
  }

  if (out.size === 0) throw new ProtocolError('"scopes" resolved to nothing');
  // `admin` subsumes the rest; storing the extras would only make revocation
  // look partial when it is not.
  if (out.has(SCOPES.ADMIN)) return [SCOPES.ADMIN];
  return [...out].sort();
}

export function hasScope(granted, required) {
  if (!Array.isArray(granted)) return false;
  if (granted.includes(SCOPES.ADMIN)) return true;
  return granted.includes(required);
}

/**
 * A principal may never grant a scope it does not itself hold — otherwise any
 * holder of `invites:write` could mint an admin and escalate.
 */
export function assertCanGrant(granterScopes, requestedScopes) {
  if (hasScope(granterScopes, SCOPES.ADMIN)) return;
  const excess = requestedScopes.filter((scope) => !hasScope(granterScopes, scope));
  if (excess.length > 0) {
    throw new ProtocolError(
      `cannot grant scopes you do not hold: ${excess.join(', ')}`,
      { status: 403, code: 'scope_escalation' },
    );
  }
}

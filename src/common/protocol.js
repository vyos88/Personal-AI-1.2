// Wire protocol shared by host and agent. Keep both sides in step by bumping
// PROTOCOL_VERSION whenever a field changes meaning; the host rejects a
// mismatched agent at registration rather than failing later on a task.

export const PROTOCOL_VERSION = 1;

export const TaskStatus = {
  QUEUED: 'queued',
  LEASED: 'leased',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

export const TERMINAL_STATUSES = new Set([
  TaskStatus.SUCCEEDED,
  TaskStatus.FAILED,
  TaskStatus.CANCELLED,
]);

// How long an agent may hold a task before the host reclaims it. An agent that
// dies mid-task leaves its lease to expire, and the sweeper requeues the work.
export const DEFAULT_LEASE_MS = 60_000;
export const DEFAULT_MAX_ATTEMPTS = 3;

// Long-poll ceiling. Kept under the usual 60s proxy idle timeout so an
// intermediary never closes the connection out from under us.
export const MAX_POLL_WAIT_MS = 25_000;

// An agent is considered gone once this much time passes with no heartbeat and
// no poll. Generous enough to survive a laptop sleeping through a GC pause.
export const AGENT_STALE_MS = 90_000;

export class ProtocolError extends Error {
  constructor(message, { status = 400, code = 'bad_request' } = {}) {
    super(message);
    this.name = 'ProtocolError';
    this.status = status;
    this.code = code;
  }
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function newId(prefix) {
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return prefix ? `${prefix}_${out}` : out;
}

function requireString(value, field, { max = 512 } = {}) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProtocolError(`"${field}" must be a non-empty string`);
  }
  if (value.length > max) {
    throw new ProtocolError(`"${field}" exceeds ${max} characters`);
  }
  return value;
}

// Task types double as capability names and as handler keys, so keep them to a
// conservative character set instead of accepting arbitrary strings.
export function validateTaskType(type) {
  requireString(type, 'type', { max: 64 });
  if (!/^[a-z][a-z0-9._-]*$/.test(type)) {
    throw new ProtocolError(
      `"type" must match /^[a-z][a-z0-9._-]*$/ (got ${JSON.stringify(type)})`,
    );
  }
  return type;
}

export function validateTaskInput(body) {
  if (!body || typeof body !== 'object') {
    throw new ProtocolError('task body must be a JSON object');
  }
  const type = validateTaskType(body.type);

  if (body.payload !== undefined && (typeof body.payload !== 'object' || body.payload === null)) {
    throw new ProtocolError('"payload" must be a JSON object when present');
  }

  const leaseMs = clampInt(body.leaseMs, DEFAULT_LEASE_MS, 1_000, 3_600_000, 'leaseMs');
  const maxAttempts = clampInt(body.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, 20, 'maxAttempts');

  return { type, payload: body.payload ?? {}, leaseMs, maxAttempts };
}

export function validateRegistration(body) {
  if (!body || typeof body !== 'object') {
    throw new ProtocolError('registration body must be a JSON object');
  }
  if (body.protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolError(
      `protocol version mismatch: host speaks ${PROTOCOL_VERSION}, agent sent ${body.protocolVersion}`,
      { code: 'protocol_mismatch', status: 409 },
    );
  }
  const name = requireString(body.name, 'name', { max: 128 });
  if (!Array.isArray(body.capabilities) || body.capabilities.length === 0) {
    throw new ProtocolError('"capabilities" must be a non-empty array of task types');
  }
  const capabilities = body.capabilities.map(validateTaskType);
  return { name, capabilities };
}

function clampInt(value, fallback, min, max, field) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value)) {
    throw new ProtocolError(`"${field}" must be an integer`);
  }
  if (value < min || value > max) {
    throw new ProtocolError(`"${field}" must be between ${min} and ${max}`);
  }
  return value;
}

export { requireString, clampInt };

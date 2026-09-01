// Wire protocol shared by host and agent. Keep both sides in step by bumping
// PROTOCOL_VERSION whenever a field changes meaning; the host rejects a
// mismatched agent at registration rather than failing later on a task.

export const PROTOCOL_VERSION = 1;

// Agents report how much RAM their machine can lend the host, and tasks may
// ask for a slice of it. Both are additive and optional, so an older agent
// that reports nothing still attaches — it just never wins a task that names a
// memory requirement.

// What an agent keeps for itself before offering the rest. A laptop that hands
// over every last free byte starts swapping, which is slower than not helping.
export const DEFAULT_MEMORY_RESERVE_BYTES = 512 * 1024 * 1024;

// A memory report older than this is treated as unknown rather than trusted;
// free memory moves, and a stale figure is how you overcommit a machine.
export const MEMORY_REPORT_STALE_MS = 120_000;

export const MB = 1024 * 1024;

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
  // 0 means "no memory requirement", which is what almost every task wants.
  const minMemoryMB = clampInt(body.minMemoryMB, 0, 0, 1024 * 1024, 'minMemoryMB');

  return { type, payload: body.payload ?? {}, leaseMs, maxAttempts, minMemoryMB };
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
  return { name, capabilities, memory: validateMemoryReport(body.memory) };
}

/**
 * A machine's memory situation as the agent sees it.
 *
 * `offerableBytes` is the part the agent is willing to have work placed
 * against — free memory minus whatever it holds back for itself — and is the
 * only figure scheduling decisions are made from. The other two are for
 * operators reading `alpha-admin agents`.
 */
export function validateMemoryReport(memory) {
  if (memory === undefined || memory === null) return null;
  if (typeof memory !== 'object') {
    throw new ProtocolError('"memory" must be a JSON object when present');
  }
  const totalBytes = requireBytes(memory.totalBytes, 'memory.totalBytes');
  const freeBytes = requireBytes(memory.freeBytes, 'memory.freeBytes');
  const offerable = memory.offerableBytes === undefined ? freeBytes : memory.offerableBytes;
  return {
    totalBytes,
    freeBytes,
    // An agent may not offer more than it has free, whatever it claims.
    offerableBytes: Math.min(requireBytes(offerable, 'memory.offerableBytes'), freeBytes),
  };
}

function requireBytes(value, field) {
  if (!Number.isFinite(value) || value < 0) {
    throw new ProtocolError(`"${field}" must be a non-negative number of bytes`);
  }
  return Math.floor(value);
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

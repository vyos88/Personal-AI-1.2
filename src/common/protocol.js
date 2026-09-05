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

// Agents also report how busy their CPUs are, and the host prefers the least
// loaded machine that can run a task. Additive and optional in the same way as
// the memory report: an agent that says nothing still attaches and still gets
// work, it just cannot be told apart from an idle one.

// A load report ages the same way a memory report does, and for the same
// reason: a laptop's CPU picture at 90s old is a guess, not a measurement.
export const LOAD_REPORT_STALE_MS = 120_000;

// What an agent whose load is unknown counts as when the host ranks placements.
// Deliberately mid-scale: an agent that reports nothing should not beat a
// machine known to be idle, nor lose to one known to be pinned.
export const UNKNOWN_LOAD_FACTOR = 0.5;

// Above this share of its own CPUs, an agent stops asking the host for work so
// its neighbour takes the next task instead. 0.85 rather than 1.0 because a
// machine only reaches a sustained 1.0 once it is already thrashing.
export const DEFAULT_MAX_LOAD = 0.85;

// How long a loaded agent waits before looking at its load again.
export const LOAD_BACKOFF_MS = 5_000;

// The safety valve on that backoff. If every agent is over its ceiling, work
// would sit in the queue forever; after this long an idle-but-loaded agent
// takes a task anyway, so a busy fleet runs work late rather than never.
export const LOAD_THROTTLE_MAX_MS = 60_000;

// Tasks one agent will run at once. One by default: a machine that opts into
// more is saying its cores are worth more than the isolation.
export const DEFAULT_AGENT_CONCURRENCY = 1;

// How long a stopping agent gives its running tasks to report before it tells
// the host it is gone. Kept under the entrypoint's 3s force-exit budget.
export const SHUTDOWN_DRAIN_MS = 2_000;

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
  return {
    name,
    capabilities,
    version: validateReportedVersion(body.version),
    memory: validateMemoryReport(body.memory),
    load: validateLoadReport(body.load),
  };
}

/**
 * The release string an agent reports for itself — see ALPHA_VERSION.
 *
 * Optional, and never a reason to turn an agent away: PROTOCOL_VERSION is the
 * compatibility gate, and an agent that clears it can do the work whatever
 * release it is on. The host records this so drift between the two machines
 * shows up in `alpha-admin agents` instead of staying invisible.
 */
export function validateReportedVersion(version) {
  if (version === undefined || version === null) return null;
  return requireString(version, 'version', { max: 64 });
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

/**
 * How busy a machine's CPUs are, as the agent measured them.
 *
 * `loadFactor` is the only figure placement is made from — the larger of
 * measured utilisation and run-queue pressure, so whichever signal says the
 * machine is struggling is the one believed. The other two are for operators
 * reading `alpha-admin agents`.
 *
 * Every field is optional, because a machine can legitimately fail to measure
 * one: `os.loadavg()` is always [0,0,0] on Windows, and `os.cpus()` comes back
 * empty in some containers. A missing figure is reported as null and treated
 * as unknown, never as zero — reading "no data" as "idle" would send work
 * straight at the busiest machine in the fleet.
 */
export function validateLoadReport(load) {
  if (load === undefined || load === null) return null;
  if (typeof load !== 'object') {
    throw new ProtocolError('"load" must be a JSON object when present');
  }
  return {
    cpus: optionalNumber(load.cpus, 'load.cpus', { min: 1, max: 4096 }),
    busy: optionalNumber(load.busy, 'load.busy', { min: 0, max: 1 }),
    loadAverage1: optionalNumber(load.loadAverage1, 'load.loadAverage1', { min: 0, max: 10_000 }),
    loadFactor: optionalNumber(load.loadFactor, 'load.loadFactor', { min: 0, max: 10_000 }),
  };
}

/**
 * The same report, arriving on the long poll's query string.
 *
 * The poll is by far the most frequent thing an agent says to the host — every
 * 25 seconds against the heartbeat's 20, and, more to the point, at the exact
 * moment the agent is asking to be given work. Carrying load here is what
 * makes the host's ranking current at the moment it places a task, instead of
 * up to a heartbeat out of date. A laptop that has just finished a build would
 * otherwise keep being passed over on the strength of a stale reading.
 *
 * Absent parameters are null, so a poll from an older agent carries no report
 * and simply leaves the last one standing.
 */
export function loadReportFromQuery(params) {
  const read = (name) => {
    const raw = params.get(name);
    if (raw === null || raw.trim() === '') return null;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new ProtocolError(`"${name}" must be a number`);
    return value;
  };
  const load = {
    cpus: read('cpus'),
    busy: read('busy'),
    loadAverage1: read('la1'),
    loadFactor: read('load'),
  };
  // Nothing worth recording — an older agent, or one that cannot measure
  // itself. Say so rather than storing a report of nulls, which would overwrite
  // a good reading from the last heartbeat.
  if (Object.values(load).every((value) => value === null)) return null;
  return validateLoadReport(load);
}

/** The other side of that: the query string an agent appends to its poll. */
export function loadReportToQuery(params, load) {
  if (!load) return params;
  const write = (name, value) => {
    if (value !== null && value !== undefined) params.set(name, String(value));
  };
  write('cpus', load.cpus);
  write('busy', load.busy);
  write('la1', load.loadAverage1);
  write('load', load.loadFactor);
  return params;
}

/**
 * The memory report, arriving on the long poll's query string.
 *
 * Memory rides the poll for a stronger reason than load does. Load only breaks
 * ties between agents that could all take the task; memory decides whether the
 * task may be placed on a machine at all. Leaving it to the heartbeat meant the
 * host admitted work against a reading up to a beat old — and, under
 * MEMORY_REPORT_STALE_MS, trusted for two minutes — at the exact moment it was
 * choosing where the task went. A laptop whose owner's own build had just eaten
 * 6 GB would still be handed a 4 GB task, and the agent has no memory check of
 * its own with which to refuse it. The reverse hurts too: a machine that has
 * just freed that 6 GB keeps being passed over until its next beat, while the
 * task sits in the queue reported as blocked on memory.
 *
 * Absent parameters are null, so a poll from an older agent carries no report
 * and simply leaves the last one standing.
 */
export function memoryReportFromQuery(params) {
  const read = (name) => {
    const raw = params.get(name);
    if (raw === null || raw.trim() === '') return null;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new ProtocolError(`"${name}" must be a number`);
    return value;
  };
  const totalBytes = read('mtotal');
  const freeBytes = read('mfree');
  const offerableBytes = read('moffer');
  // All three or nothing. A partial report must not overwrite a good reading,
  // and defaulting a missing offer to the whole free figure — which is what the
  // JSON body path does for an older agent — would offer memory past the
  // reserve this machine is holding back, which no agent ever asks for.
  if (totalBytes === null || freeBytes === null || offerableBytes === null) return null;
  return validateMemoryReport({ totalBytes, freeBytes, offerableBytes });
}

/** The other side of that: the query string an agent appends to its poll. */
export function memoryReportToQuery(params, memory) {
  if (!memory) return params;
  const write = (name, value) => {
    if (value !== null && value !== undefined) params.set(name, String(value));
  };
  write('mtotal', memory.totalBytes);
  write('mfree', memory.freeBytes);
  write('moffer', memory.offerableBytes);
  return params;
}

function optionalNumber(value, field, { min, max }) {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ProtocolError(`"${field}" must be a number between ${min} and ${max} when present`);
  }
  return value;
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

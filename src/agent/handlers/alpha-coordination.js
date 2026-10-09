import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { ProtocolError } from '../../common/protocol.js';
import { resolveExecutable } from '../../common/resolve-executable.js';

/**
 * Drives Alpha's coordination tunnel (`scripts/alpha_coordination_tunnel.ps1`)
 * from a task, so an agent running on the Alpha host can claim paths, post
 * receipts and release on behalf of a remote actor.
 *
 * This is the one handler that runs an external program, so it is written to
 * the rules the README sets out for exactly that case: a pinned executable, a
 * pinned script, an allowlisted action, and validated arguments passed as an
 * argv array. Nothing here is ever interpolated into a command line — execFile
 * takes an argument vector, so a message containing quotes, semicolons or
 * backticks is data, not syntax.
 *
 * It is NOT registered by default. Enable it on the host agent with
 * ALPHA_EXTRA_HANDLERS=alpha-coordination, and give that agent a key scoped to
 * `agent:connect`.
 *
 * Configuration:
 *   ALPHA_REPO_ROOT           Alpha working copy (required)
 *   ALPHA_COORDINATION_SCRIPT Script path, relative to root. Defaults to
 *                             scripts/alpha_coordination_tunnel.ps1
 *   ALPHA_POWERSHELL          Interpreter. Defaults to powershell.exe, falling
 *                             back to pwsh.
 *   ALPHA_COORDINATION_ACTIONS
 *                             Comma-separated subset of ALLOWED_ACTIONS this
 *                             agent takes. Unset means all of them. A standby
 *                             that keeps the records while the main Alpha
 *                             machine is away sets Post,Ack,Status: claims are
 *                             state, not a log, and two copies of claims.json
 *                             cannot be merged without judgment calls.
 */

export const type = 'alpha.coordination';

export const description =
  'Runs Alpha\'s coordination tunnel script (Init/Claim/Post/Release/Status/Ack) on the host.';

/**
 * Actions this handler will pass through. The first five were verified against
 * the real `alpha_coordination_tunnel.ps1` on the Alpha host: `Init` and `Post`
 * from observed usage, `Status`, `Claim` and `Release` by running a claim cycle
 * through this handler and confirming the tunnel reported the path held.
 *
 * `Ack` is how a peer on another machine answers a handoff Alpha posted (Alpha
 * PR #59): it names the handoff's event id and, optionally, how far the peer
 * has got. It was verified by running this handler against the script from
 * that PR under PowerShell 7 (see docs/HOST_SETUP.md), not yet on the host.
 *
 * An action not on this list is refused here rather than forwarded blindly,
 * so extending the script means extending this list too.
 */
export const ALLOWED_ACTIONS = Object.freeze(['Init', 'Claim', 'Post', 'Release', 'Status', 'Ack']);

/**
 * The stages the script's `-Stage` accepts on `Ack`. Mirrors its ValidateSet;
 * a stage it does not know would fail there, so it is refused here first.
 */
export const ACK_STAGES = Object.freeze(['received', 'accepted', 'applied', 'tested', 'declined', 'failed']);

// The script's own rule for -EventId: the 32 lowercase hex characters of a
// [guid]::ToString('n') event id.
const EVENT_ID_PATTERN = /^[a-f0-9]{32}$/;

const MAX_MESSAGE_LENGTH = 4_000;
const MAX_PATHS = 64;
const MAX_OUTPUT_CHARS = 16_000;
const DEFAULT_SCRIPT = 'scripts/alpha_coordination_tunnel.ps1';

/** Parse before clipping stdout: a tail of JSON cannot establish ownership. */
export function statusEvidence(stdout) {
  let status;
  try {
    status = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  } catch {
    return { status: null, statusError: 'Status output is not complete JSON; ownership is unknown.' };
  }
  if (!status || status.schema !== 'alpha.coordination.status.v1'
      || !status.claims || typeof status.claims !== 'object' || Array.isArray(status.claims)
      || !status.claims_lifecycle || typeof status.claims_lifecycle !== 'object'
      || Array.isArray(status.claims_lifecycle)) {
    return { status: null, statusError: 'Status schema or claim evidence is missing; ownership is unknown.' };
  }
  const claims = Object.entries(status.claims);
  const { details, ...lifecycle } = status.claims_lifecycle;
  const detailList = Array.isArray(details) ? details : details ? [details] : [];
  return { status: {
    schema: status.schema,
    generatedAt: status.generated_at ?? null,
    tunnelIdentity: status.tunnel_identity ?? null,
    claims: Object.fromEntries(claims.slice(0, MAX_PATHS)),
    claimEntries: claims.length,
    claimsComplete: claims.length <= MAX_PATHS,
    claimsLifecycle: { ...lifecycle, details: detailList.slice(0, MAX_PATHS) },
    lifecycleDetailsComplete: detailList.length <= MAX_PATHS,
    // No defaults for absent counts or provenance: missing evidence stays missing.
  }, statusError: null };
}

// Actor names end up in a shared log; keep them to something legible and
// unambiguous rather than accepting arbitrary text.
const ACTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateAction(action) {
  if (!ALLOWED_ACTIONS.includes(action)) {
    throw new ProtocolError(
      `unsupported action ${JSON.stringify(action)}; expected one of ${ALLOWED_ACTIONS.join(', ')}`,
    );
  }
  return action;
}

/**
 * The actions this agent takes: ALPHA_COORDINATION_ACTIONS, or all of
 * ALLOWED_ACTIONS when it is unset. A name that is not an allowed action, or a
 * setting that names none, is a configuration error rather than something to
 * skip: an agent meant to refuse claims must not quietly start taking them.
 */
export function configuredActions(value = process.env.ALPHA_COORDINATION_ACTIONS) {
  if (value === undefined || value === null || value.trim() === '') return ALLOWED_ACTIONS;
  const names = [...new Set(value.split(',').map((name) => name.trim()).filter(Boolean))];
  for (const name of names) {
    if (!ALLOWED_ACTIONS.includes(name)) {
      throw new ProtocolError(
        `ALPHA_COORDINATION_ACTIONS names ${JSON.stringify(name)}, which is not one of ${ALLOWED_ACTIONS.join(', ')}`,
        { status: 500, code: 'not_configured' },
      );
    }
  }
  if (names.length === 0) {
    throw new ProtocolError('ALPHA_COORDINATION_ACTIONS names no action', {
      status: 500,
      code: 'not_configured',
    });
  }
  return Object.freeze(names);
}

/**
 * Refuses an allowed action this agent was configured not to take. Called
 * after validateAction, so the message can assume the action is real.
 */
export function requireOffered(action, offered = configuredActions()) {
  if (!offered.includes(action)) {
    throw new ProtocolError(
      `this agent takes only ${offered.join(', ')} (ALPHA_COORDINATION_ACTIONS); ` +
        `${action} waits for the main coordination agent to be back`,
      { status: 409, code: 'action_not_offered' },
    );
  }
  return action;
}

export function validateActor(actor) {
  if (typeof actor !== 'string' || !ACTOR_PATTERN.test(actor)) {
    throw new ProtocolError(
      '"actor" must be 1-64 characters of letters, digits, dot, dash or underscore',
    );
  }
  return actor;
}

/**
 * `eventId` and `stage` belong to `Ack` alone. On any other action they are
 * refused rather than dropped: a caller who sent them believed they meant
 * something, and should be told they did not.
 */
export function validateAck(action, eventId, stage) {
  if (action !== 'Ack') {
    if (eventId !== undefined && eventId !== null) {
      throw new ProtocolError('"eventId" is only accepted with the Ack action');
    }
    if (stage !== undefined && stage !== null) {
      throw new ProtocolError('"stage" is only accepted with the Ack action');
    }
    return { eventId: null, stage: null };
  }
  if (typeof eventId !== 'string' || !EVENT_ID_PATTERN.test(eventId)) {
    throw new ProtocolError('Ack requires "eventId": the 32 lowercase hex characters of the event it answers');
  }
  if (stage === undefined || stage === null) return { eventId, stage: null };
  if (!ACK_STAGES.includes(stage)) {
    throw new ProtocolError(`unsupported stage ${JSON.stringify(stage)}; expected one of ${ACK_STAGES.join(', ')}`);
  }
  return { eventId, stage };
}

/**
 * Paths are repo-relative and must stay inside the working copy. Absolute
 * paths and `..` traversal are rejected outright: a claim on `../../etc` or on
 * `C:\Windows` is not a claim on anything this tunnel governs.
 */
export function validatePaths(paths, root) {
  if (paths === undefined || paths === null) return [];
  if (!Array.isArray(paths)) throw new ProtocolError('"paths" must be an array of strings');
  if (paths.length > MAX_PATHS) {
    throw new ProtocolError(`"paths" may name at most ${MAX_PATHS} entries`);
  }

  return paths.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ProtocolError('each path must be a non-empty string');
    }
    const path = entry.trim().replace(/\\/g, '/');

    if (isAbsolute(path) || /^[A-Za-z]:/.test(path)) {
      throw new ProtocolError(`path must be repo-relative, got ${JSON.stringify(entry)}`);
    }
    if (path.split('/').includes('..')) {
      throw new ProtocolError(`path must not traverse upward, got ${JSON.stringify(entry)}`);
    }
    // The argv joins paths on commas, so a comma inside one would silently
    // split it into two bogus claims.
    if (path.includes(',')) {
      throw new ProtocolError(`path must not contain a comma, got ${JSON.stringify(entry)}`);
    }
    // Belt and braces: resolve it and confirm it really lands inside the root.
    // Both sides have to be resolved. resolve() returns a normalized absolute
    // path, so comparing that against a raw root rejects every legitimate
    // path whenever the root is not already in exactly that form: on Windows
    // an ALPHA_REPO_ROOT of "C:/alpha" or "C:\alpha\" resolves to "C:\alpha"
    // and matched neither branch, so a valid repo-relative path was reported
    // as escaping the root.
    const base = resolve(root);
    const resolved = resolve(base, path);
    if (resolved !== base && !resolved.startsWith(base + sep)) {
      throw new ProtocolError(`path escapes the repository root: ${JSON.stringify(entry)}`);
    }
    return path;
  });
}

function requireRoot() {
  const root = process.env.ALPHA_REPO_ROOT;
  if (!root) {
    throw new ProtocolError(
      'ALPHA_REPO_ROOT is not set on this agent, so there is no Alpha working copy to coordinate on',
      { status: 500, code: 'not_configured' },
    );
  }
  const resolved = resolve(root);
  if (!existsSync(resolved)) {
    throw new ProtocolError(`ALPHA_REPO_ROOT does not exist: ${resolved}`, {
      status: 500,
      code: 'not_configured',
    });
  }
  return resolved;
}

function requireScript(root) {
  const relative = process.env.ALPHA_COORDINATION_SCRIPT ?? DEFAULT_SCRIPT;
  const script = resolve(root, relative);
  if (script !== root && !script.startsWith(root + sep)) {
    throw new ProtocolError('ALPHA_COORDINATION_SCRIPT must live inside ALPHA_REPO_ROOT', {
      status: 500,
      code: 'not_configured',
    });
  }
  if (!existsSync(script)) {
    throw new ProtocolError(`coordination script not found at ${script}`, {
      status: 500,
      code: 'not_configured',
    });
  }
  return script;
}

/** Builds the argv passed to PowerShell. Exported so tests can assert on it. */
export function buildArgs({ script, action, actor, message, paths, eventId = null, stage = null }) {
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Action',
    action,
    '-Actor',
    actor,
  ];
  if (message !== undefined && message !== null && message !== '') {
    args.push('-Message', message);
  }
  if (paths.length > 0) {
    // One comma-joined token. Invoked through `-File`, PowerShell re-parses
    // each argument, and `a,b,c` is the form it binds to a [string[]]
    // parameter — passing `a , b` as separate tokens depends on looser
    // parsing behaviour. Confirmed against the real script by claiming a path
    // and reading it back from Status. validatePaths rejects commas in a
    // path, so this join is unambiguous.
    args.push('-Paths', paths.join(','));
  }
  if (eventId) args.push('-EventId', eventId);
  // Only when asked for. A script from before Alpha PR #59 has no -Stage, and
  // being a plain (not advanced) script it does not refuse it: PowerShell puts
  // the unknown argument in $args and the Ack is recorded without a stage.
  // Verified against that script under PowerShell 7. Alpha's receipt then
  // reads the stage from the message's first word, so a peer should start the
  // message with it ("accepted: ...") until the host has the new script.
  if (stage) args.push('-Stage', stage);
  return args;
}

export async function run(payload, { signal, log } = {}) {
  const root = requireRoot();
  const script = requireScript(root);

  const action = requireOffered(validateAction(payload?.action));
  const actor = validateActor(payload?.actor ?? process.env.ALPHA_COORDINATION_ACTOR);
  const paths = validatePaths(payload?.paths, root);
  const { eventId, stage } = validateAck(action, payload?.eventId, payload?.stage);

  let message = payload?.message;
  if (message !== undefined && message !== null) {
    if (typeof message !== 'string') throw new ProtocolError('"message" must be a string');
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw new ProtocolError(`"message" must be at most ${MAX_MESSAGE_LENGTH} characters`);
    }
  }
  // Post is the action that writes a receipt; a blank one is not worth logging.
  if (action === 'Post' && (!message || message.trim() === '')) {
    throw new ProtocolError('"message" is required for the Post action');
  }

  const shell = process.env.ALPHA_POWERSHELL ?? 'powershell.exe';
  const args = buildArgs({ script, action, actor, message, paths, eventId, stage });

  log?.info?.('running coordination tunnel', { action, actor, paths: paths.length, eventId, stage });

  const { stdout, stderr, code } = await new Promise((resolvePromise, rejectPromise) => {
    execFile(
      shell,
      args,
      { cwd: root, signal, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, out, err) => {
        if (error && error.code === 'ENOENT') {
          rejectPromise(
            new ProtocolError(
              `PowerShell not found (${shell}). Set ALPHA_POWERSHELL to its path.`,
              { status: 500, code: 'no_powershell' },
            ),
          );
          return;
        }
        // A child killed by a signal reports `code: null`, so `code ?? 0`
        // read a run that blew its 120s timeout, or was aborted with its
        // lease, as a clean exit. Nothing ran to completion: fail the task.
        if (error && (error.killed || error.signal || error.code === 'ABORT_ERR')) {
          rejectPromise(
            new ProtocolError(
              `the coordination tunnel was killed before it finished (${error.signal ?? error.code})`,
              { status: 500, code: 'coordination_killed' },
            ),
          );
          return;
        }
        // A non-zero exit is a real outcome of the tunnel (e.g. a refused
        // claim), so report it as data rather than throwing.
        resolvePromise({ stdout: out ?? '', stderr: err ?? '', code: error?.code ?? 0 });
      },
    );
  });

  const result = {
    action,
    actor,
    paths,
    ...(eventId ? { eventId, stage } : {}),
    exitCode: code,
    sourceRoot: root,
    stdout: stdout.slice(-MAX_OUTPUT_CHARS),
    stderr: stderr.slice(-MAX_OUTPUT_CHARS),
    stdoutTruncated: stdout.length > MAX_OUTPUT_CHARS,
    stderrTruncated: stderr.length > MAX_OUTPUT_CHARS,
    ...(action === 'Status' && code === 0 ? statusEvidence(stdout) : {}),
  };
  if (action === 'Status') {
    // Keep the existing validated, bounded summary. A complete document is
    // separate evidence, and its encoded size includes that summary and JSON
    // escaping, leaving headroom within the unchanged 1 MB result endpoint.
    result.statusComplete = false;
    result.statusCompletenessError = code === 0 ? 'invalid_status' : 'script_failed';
    if (code === 0 && result.status) {
      const complete = { ...result, stdout: stdout.replace(/^\uFEFF/, ''),
        stdoutTruncated: false, statusComplete: true };
      delete complete.statusCompletenessError;
      if (Buffer.byteLength(JSON.stringify(complete), 'utf8') <= 750_000) return complete;
      result.statusCompletenessError = 'status_too_large';
    }
  }
  return result;
}

/**
 * Proves this machine can actually coordinate before the agent offers the
 * type.
 *
 * Opt-in is not enough on its own, which is the whole reason `available()`
 * exists: `.env.agent` is copied from the host to a laptop, and that laptop
 * then advertises `alpha.coordination`, wins the task and fails it with an
 * attempt spent and a retry free to land right back there. `alpha.render`
 * and `device.inventory` already refuse that way; this one did not, and a
 * machine with no Alpha working copy advertised the type regardless.
 *
 * It asks exactly what `run()` asks, by calling the same two functions, so a
 * machine cannot pass the check and fail the task. It executes nothing:
 * whether the tunnel script works is not knowable without running it, and
 * `run()` still reports that honestly.
 */
export function available() {
  try {
    const root = requireRoot();
    requireScript(root);
    configuredActions();
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  const shell = process.env.ALPHA_POWERSHELL ?? 'powershell.exe';
  if (!resolveExecutable(shell)) {
    return {
      ok: false,
      reason: `PowerShell not found (${shell}). The coordination tunnel is a .ps1; set ALPHA_POWERSHELL if it is installed elsewhere.`,
    };
  }
  return { ok: true };
}

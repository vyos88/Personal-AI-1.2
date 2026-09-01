import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

import { ProtocolError } from '../../common/protocol.js';

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
 */

export const type = 'alpha.coordination';

export const description =
  'Runs Alpha\'s coordination tunnel script (Init/Claim/Post/Release/Status) on the host.';

/**
 * Actions this handler will pass through, all five verified against the real
 * `alpha_coordination_tunnel.ps1` on the Alpha host: `Init` and `Post` from
 * observed usage, `Status`, `Claim` and `Release` by running a claim cycle
 * through this handler and confirming the tunnel reported the path held.
 *
 * An action not on this list is refused here rather than forwarded blindly,
 * so extending the script means extending this list too.
 */
export const ALLOWED_ACTIONS = Object.freeze(['Init', 'Claim', 'Post', 'Release', 'Status']);

const MAX_MESSAGE_LENGTH = 4_000;
const MAX_PATHS = 64;
const DEFAULT_SCRIPT = 'scripts/alpha_coordination_tunnel.ps1';

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

export function validateActor(actor) {
  if (typeof actor !== 'string' || !ACTOR_PATTERN.test(actor)) {
    throw new ProtocolError(
      '"actor" must be 1-64 characters of letters, digits, dot, dash or underscore',
    );
  }
  return actor;
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
    const resolved = resolve(root, path);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
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
export function buildArgs({ script, action, actor, message, paths }) {
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
  return args;
}

export async function run(payload, { signal, log } = {}) {
  const root = requireRoot();
  const script = requireScript(root);

  const action = validateAction(payload?.action);
  const actor = validateActor(payload?.actor ?? process.env.ALPHA_COORDINATION_ACTOR);
  const paths = validatePaths(payload?.paths, root);

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
  const args = buildArgs({ script, action, actor, message, paths });

  log?.info?.('running coordination tunnel', { action, actor, paths: paths.length });

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
        // A non-zero exit is a real outcome of the tunnel (e.g. a refused
        // claim), so report it as data rather than throwing.
        resolvePromise({ stdout: out ?? '', stderr: err ?? '', code: error?.code ?? 0 });
      },
    );
  });

  return {
    action,
    actor,
    paths,
    exitCode: code,
    stdout: stdout.slice(-16_000),
    stderr: stderr.slice(-16_000),
  };
}

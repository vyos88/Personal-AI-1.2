import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { ProtocolError } from '../../common/protocol.js';

/**
 * Reports and advances the Alpha working copy on the host, by queued task.
 *
 * This is what "update Alpha from the chat" needs on the machine end: Alpha's
 * frontend (or `alpha-admin task`) queues one of these, the agent running on the
 * Alpha host carries it out, and the answer comes back over the tunnel. Nothing
 * reaches *into* the host to do it — the agent is still dialling out, exactly as
 * every other task works.
 *
 * Like `alpha-coordination`, this runs an external program, so it follows the
 * same rules: a pinned executable, an allowlisted action, and arguments passed
 * as an argv array to execFile. There is no shell anywhere in this file, so a
 * branch name containing a semicolon is data, not syntax.
 *
 * Unlike `alpha-coordination` it drives `git` directly rather than a script on
 * the host. Git's CLI is a contract that already exists and is stable, so there
 * is nothing to keep in step with a file that would have to be written and
 * shipped to the host first — which, for an update mechanism, would be circular.
 *
 * **It deliberately cannot build or restart anything.** Those are host-specific
 * commands, and a handler that took a command from configuration and ran it
 * would be a remote shell with extra steps — the one thing `handlers/index.js`
 * says must never appear here. This moves the working copy and reports the
 * truth about it; whatever rebuild or service restart a given machine needs
 * stays a deliberate act on that machine.
 *
 * It is NOT registered by default. Enable it on the host agent with
 * ALPHA_EXTRA_HANDLERS=alpha-update.
 *
 * Configuration:
 *   ALPHA_REPO_ROOT   Alpha working copy (required)
 *   ALPHA_GIT         git executable. Defaults to `git`.
 *   ALPHA_UPDATE_REMOTE  Remote to consult. Defaults to `origin`.
 */

export const type = 'alpha.update';

export const description =
  'Reports the Alpha working copy on this host, and fast-forwards it (Status/Fetch/Pull).';

/**
 * What this handler will do, narrowest first.
 *
 * - `Status` reads and changes nothing.
 * - `Fetch` updates remote-tracking refs only; the working copy is untouched,
 *   so it answers "is there an update?" without taking it.
 * - `Pull` fast-forwards, and only fast-forwards.
 *
 * There is no action that can rewrite history, discard local work, or check out
 * a different branch. Add one only with the same care the coordination handler's
 * allowlist gets.
 */
export const ALLOWED_ACTIONS = Object.freeze(['Status', 'Fetch', 'Pull']);

const GIT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 16_000;

export function validateAction(action) {
  // Status is the harmless one, so it is what an empty payload means.
  const requested = action ?? 'Status';
  if (!ALLOWED_ACTIONS.includes(requested)) {
    throw new ProtocolError(
      `unsupported action ${JSON.stringify(action)}; expected one of ${ALLOWED_ACTIONS.join(', ')}`,
    );
  }
  return requested;
}

/**
 * The remote to consult. Constrained rather than passed through: it lands in an
 * argv slot where git would otherwise happily accept a URL, and an update
 * mechanism that can be pointed at an arbitrary remote by whoever queues the
 * task is a way to run someone else's code on the Alpha host.
 */
export function validateRemote(remote) {
  const name = remote ?? process.env.ALPHA_UPDATE_REMOTE ?? 'origin';
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new ProtocolError(
      '"remote" must be a git remote name: 1-64 characters of letters, digits, dot, dash or underscore',
    );
  }
  return name;
}

function requireRoot() {
  const root = process.env.ALPHA_REPO_ROOT;
  if (!root) {
    throw new ProtocolError(
      'ALPHA_REPO_ROOT is not set on this agent, so there is no Alpha working copy to update',
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
  if (!existsSync(resolve(resolved, '.git'))) {
    throw new ProtocolError(`ALPHA_REPO_ROOT is not a git working copy: ${resolved}`, {
      status: 500,
      code: 'not_configured',
    });
  }
  return resolved;
}

/**
 * Runs one git invocation in the working copy.
 *
 * `-C root` rather than only `cwd`, so the repository is named in the argv and
 * cannot be changed by whatever the process happens to have inherited.
 */
export function buildArgs(root, args) {
  return ['-C', root, ...args];
}

function git(root, args, { signal } = {}) {
  const exe = process.env.ALPHA_GIT ?? 'git';
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      exe,
      buildArgs(root, args),
      { cwd: root, signal, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && error.code === 'ENOENT') {
          rejectPromise(
            new ProtocolError(`git not found (${exe}). Set ALPHA_GIT to its path.`, {
              status: 500,
              code: 'no_git',
            }),
          );
          return;
        }
        // A non-zero exit is an outcome, not a fault: "already up to date",
        // "not a fast-forward" and "would be overwritten" are all answers the
        // caller asked for. Report them rather than throwing.
        resolvePromise({
          stdout: (stdout ?? '').trim(),
          stderr: (stderr ?? '').trim(),
          exitCode: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
        });
      },
    );
  });
}

/** Where the working copy is, and whether anything local is uncommitted. */
async function readState(root, remote, options) {
  const [head, branch, subject, porcelain, upstream] = await Promise.all([
    git(root, ['rev-parse', 'HEAD'], options),
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], options),
    git(root, ['log', '-1', '--pretty=%s'], options),
    git(root, ['status', '--porcelain'], options),
    git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], options),
  ]);

  const dirtyLines = porcelain.stdout ? porcelain.stdout.split('\n') : [];
  const state = {
    head: head.stdout,
    branch: branch.stdout,
    subject: subject.stdout,
    // Counted separately: a tracked change and an untracked file are different
    // problems for a pull. Untracked is the one that bites here, because Alpha's
    // own working files may not all be committed.
    dirty: dirtyLines.length > 0,
    changedFiles: dirtyLines.filter((line) => !line.startsWith('??')).length,
    untrackedFiles: dirtyLines.filter((line) => line.startsWith('??')).length,
    upstream: upstream.exitCode === 0 ? upstream.stdout : null,
    behind: null,
    ahead: null,
  };

  // Only meaningful against a configured upstream; a detached or unpublished
  // branch has nothing to be behind.
  if (state.upstream) {
    const counts = await git(root, ['rev-list', '--left-right', '--count', `HEAD...${state.upstream}`], options);
    if (counts.exitCode === 0) {
      const [ahead, behind] = counts.stdout.split(/\s+/).map((n) => Number.parseInt(n, 10));
      state.ahead = Number.isFinite(ahead) ? ahead : null;
      state.behind = Number.isFinite(behind) ? behind : null;
    }
  }

  state.remote = remote;
  return state;
}

export async function run(payload, { signal, log } = {}) {
  const root = requireRoot();
  const action = validateAction(payload?.action);
  const remote = validateRemote(payload?.remote);
  const options = { signal };

  log?.info?.('alpha update', { action, remote, root });

  if (action === 'Status') {
    return { action, ...(await readState(root, remote, options)) };
  }

  if (action === 'Fetch') {
    const fetched = await git(root, ['fetch', '--prune', remote], options);
    return {
      action,
      exitCode: fetched.exitCode,
      stderr: fetched.stderr.slice(-MAX_OUTPUT),
      ...(await readState(root, remote, options)),
    };
  }

  // Pull. Refused up front when anything is uncommitted, rather than left to
  // git: the Alpha host's working copy is where Alpha actually runs, and a
  // half-applied update to a machine someone is using is worse than no update.
  const before = await readState(root, remote, options);
  if (before.dirty) {
    return {
      action,
      pulled: false,
      refused: 'working copy has uncommitted changes',
      ...before,
    };
  }

  // --ff-only so this can only ever move the branch forward onto what the
  // remote already has. It cannot merge, cannot rebase, and cannot invent a
  // commit; if the branches have diverged, git refuses and says so.
  const pulled = await git(root, ['pull', '--ff-only', remote], options);
  const after = await readState(root, remote, options);

  return {
    action,
    pulled: pulled.exitCode === 0 && after.head !== before.head,
    exitCode: pulled.exitCode,
    previousHead: before.head,
    stdout: pulled.stdout.slice(-MAX_OUTPUT),
    stderr: pulled.stderr.slice(-MAX_OUTPUT),
    ...after,
  };
}

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join, resolve, sep } from 'node:path';

import { ProtocolError } from '../../common/protocol.js';

/**
 * Asks the Claude Code CLI on this machine a question, and returns what it
 * said. The Claude-shaped twin of `codex-exec.js` — read that handler's own
 * doc comment first, since every design choice here either mirrors it
 * deliberately or departs from it for a reason stated below.
 *
 * This is what makes a second Claude session reachable over the tunnel:
 * Alpha, a person with the CLI, or another Claude session queues a prompt,
 * the agent on the machine where `claude` is installed and logged in runs it
 * non-interactively, and the answer comes back as the task result. Neither
 * side needs an open port.
 *
 * **Same category as codex.exec, same reason it is nonetheless a handler and
 * not a remote shell with extra steps:**
 *
 *   - Opt-in; `available()` refuses a machine without the CLI, so a copied
 *     `.env.agent` never advertises `claude.exec` on a laptop that cannot run
 *     it.
 *   - The payload carries *only* a prompt — not the model, the permission
 *     mode, or any flag. Those are this machine's configuration.
 *   - `--restricted` is always passed, unconditionally, not a configuration
 *     option. codex.exec has no equivalent flag to mirror here; `--restricted`
 *     is what strips Claude Code's own Bash/PowerShell/code-execution tools
 *     and WebFetch and confines file tools to the working directory, which is
 *     the closest this CLI has to "cannot act on this machine beyond
 *     answering" — and this handler's whole purpose is a question-and-answer
 *     bridge, not a second coding agent with a shell. Widening that is not a
 *     per-task decision any more than the sandbox mode is codex.exec's.
 *   - Nothing is ever interpolated into a command line; `execFile` takes an
 *     argv array.
 *
 * It is NOT registered by default. Enable it on the machine that has Claude
 * Code installed and logged in:
 *
 *   ALPHA_EXTRA_HANDLERS=claude-exec
 *
 * Configuration:
 *   ALPHA_CLAUDE_ROOT            Directory Claude runs in (required).
 *   ALPHA_CLAUDE                 The Claude executable. Defaults to `claude`,
 *                                resolved against PATH. On Windows this must be
 *                                the native binary, not an npm `.cmd` shim —
 *                                same reasoning and same resolver as
 *                                ALPHA_CODEX in codex-exec.js.
 *   ALPHA_CLAUDE_PERMISSION_MODE Permission mode passed to the CLI. Defaults to
 *                                `plan` — Claude Code's own "propose, do not
 *                                apply" mode, the direct equivalent of
 *                                codex.exec's `read-only` sandbox default. Set
 *                                it empty to pass no flag at all, for a CLI
 *                                version whose modes differ.
 *   ALPHA_CLAUDE_MODEL           Optional model name or alias (e.g. `sonnet`,
 *                                `opus`). Unset means the CLI's own default.
 *   ALPHA_CLAUDE_MAX_BUDGET_USD  Ceiling on one call's spend, passed straight
 *                                to `--max-budget-usd`. codex.exec has no
 *                                equivalent — Claude Code's CLI does, verified
 *                                against the real binary, and a handler
 *                                reachable from a task queue should not have
 *                                an unbounded budget per call. Defaults to 1.
 *   ALPHA_CLAUDE_TIMEOUT_MS      Ceiling on one call. Defaults to 10 minutes,
 *                                same default as codex.exec.
 *
 * **Deliberately not mirrored from codex.exec:** there is no
 * `ALPHA_CLAUDE_SKIP_GIT_CHECK` and `available()` does not require a git
 * checkout. Codex is verified to refuse running outside one; nothing here
 * verified that Claude Code does the same, and copying that assumption
 * uncritically would be exactly the kind of invented constraint this
 * codebase's own handlers are written to avoid. If that turns out to be
 * false, add the check against a verified reason, not a guess.
 *
 * **Also not mirrored:** a pre-flight login check. `claude auth status`
 * exists and was verified directly against a real, authenticated CLI while
 * building this — but codex.exec's own doc comment explains why it does not
 * pre-check Codex's auth: "whether it can reach its API is not knowable
 * without asking it something, and run() reports that honestly when it
 * happens." The same applies here, so a machine with Claude installed but
 * not logged in still advertises `claude.exec`, and a call fails with the
 * real CLI's own error in the result rather than a guessed-at pre-check.
 *
 * **A Claude call outlives the default lease**, same footgun as codex.exec
 * and alpha.render: queue it with `--agent` pointed at the machine and a
 * lease longer than `DEFAULT_LEASE_MS`, or it is killed and requeued forever.
 */

export const type = 'claude.exec';

export const description =
  "Asks the Claude Code CLI on this machine a question and returns its answer, so another Claude session is reachable by task.";

const DEFAULT_PERMISSION_MODE = 'plan';
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_BUDGET_USD = 1;

// Same limits and same reasoning as codex.exec: long enough to carry a real
// question with context, well inside the host's 1 MB task-body cap; the
// answer is at the end of a transcript, so the tail is what is kept.
const MAX_PROMPT_CHARS = 16_000;
const MAX_OUTPUT_CHARS = 64_000;

const PERMISSION_MODE_PATTERN = /^[a-zA-Z][a-zA-Z0-9-]{0,31}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function configured(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw;
}

/**
 * The prompt, and the one thing a payload may carry. Identical rule to
 * codex.exec's validatePrompt, for the identical reason: a prompt that could
 * be read as a flag is the only way payload data reaches this CLI as
 * anything but a prompt, so it is refused here even though buildArgs also
 * puts it after `--`.
 */
export function validatePrompt(prompt) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new ProtocolError('"prompt" must be a non-empty string');
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new ProtocolError(
      `"prompt" exceeds ${MAX_PROMPT_CHARS} characters (got ${prompt.length}). ` +
        'Put the long part in the repository Claude is reading and point at it.',
    );
  }
  if (prompt.trimStart().startsWith('-')) {
    throw new ProtocolError(
      '"prompt" may not begin with "-", which a CLI reads as a flag rather than as a question',
    );
  }
  return prompt;
}

/**
 * Everything else is the machine's business. Same refusal, same reasoning, as
 * codex.exec's rejectUnsupportedKeys: told it meant nothing, not left
 * believing the permission mode widened.
 */
export function rejectUnsupportedKeys(payload = {}) {
  const extra = Object.keys(payload).filter((key) => key !== 'prompt');
  if (extra.length === 0) return;
  throw new ProtocolError(
    `this handler takes only "prompt"; ${extra.map((k) => JSON.stringify(k)).join(', ')} ` +
      'would not reach Claude. The model, directory and permission mode are configured on the ' +
      'machine that runs it, not chosen by the task.',
  );
}

function requireRoot() {
  const root = configured('ALPHA_CLAUDE_ROOT', null);
  if (!root) {
    throw new ProtocolError(
      'ALPHA_CLAUDE_ROOT is not set on this agent, so there is no directory for Claude to work in',
      { status: 500, code: 'not_configured' },
    );
  }
  const resolved = resolve(root);
  if (!existsSync(resolved)) {
    throw new ProtocolError(`ALPHA_CLAUDE_ROOT does not exist: ${resolved}`, {
      status: 500,
      code: 'not_configured',
    });
  }
  return resolved;
}

function permissionMode() {
  const raw = process.env.ALPHA_CLAUDE_PERMISSION_MODE;
  // Explicitly empty means "pass no permission-mode flag" — the escape hatch
  // for a CLI version whose modes differ, mirroring ALPHA_CODEX_SANDBOX.
  if (raw !== undefined && raw.trim() === '') return null;
  const mode = raw === undefined ? DEFAULT_PERMISSION_MODE : raw.trim();
  if (!PERMISSION_MODE_PATTERN.test(mode)) {
    throw new ProtocolError(
      `ALPHA_CLAUDE_PERMISSION_MODE must match ${PERMISSION_MODE_PATTERN} (got ${JSON.stringify(mode)})`,
      { status: 500, code: 'not_configured' },
    );
  }
  return mode;
}

function model() {
  const raw = configured('ALPHA_CLAUDE_MODEL', null);
  if (raw === null) return null;
  const name = raw.trim();
  if (!MODEL_PATTERN.test(name)) {
    throw new ProtocolError(
      `ALPHA_CLAUDE_MODEL must match ${MODEL_PATTERN} (got ${JSON.stringify(name)})`,
      { status: 500, code: 'not_configured' },
    );
  }
  return name;
}

function maxBudgetUsd() {
  const raw = process.env.ALPHA_CLAUDE_MAX_BUDGET_USD;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_BUDGET_USD;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ProtocolError(
      `ALPHA_CLAUDE_MAX_BUDGET_USD must be a positive number (got ${raw})`,
      { status: 500, code: 'not_configured' },
    );
  }
  return parsed;
}

function timeoutMs() {
  const raw = process.env.ALPHA_CLAUDE_TIMEOUT_MS;
  if (!raw || raw.trim() === '') return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ProtocolError(
      `ALPHA_CLAUDE_TIMEOUT_MS must be a positive whole number of milliseconds (got ${raw})`,
      { status: 500, code: 'not_configured' },
    );
  }
  return parsed;
}

/**
 * The argv handed to Claude. Exported so tests can pin it, same as
 * codex.exec's buildArgs — this is the one part of the handler that is a
 * contract with a program outside this repository.
 *
 * `-p`/`--print` makes the call non-interactive; `--restricted` is always
 * included (see the module doc comment for why it is not configurable). The
 * working directory is `cwd` on the child process, never a flag, for the
 * same reason codex.exec gives: every version of every CLI honours `cwd` and
 * no version can rename it. The prompt goes last, after `--`, so a question
 * beginning with a dash is a question — validatePrompt refuses one anyway.
 */
export function buildArgs({ prompt, permissionMode: mode = null, model: modelName = null, maxBudgetUsd: budget }) {
  const args = ['-p', '--restricted'];
  if (mode) args.push('--permission-mode', mode);
  if (modelName) args.push('--model', modelName);
  if (budget !== undefined && budget !== null) args.push('--max-budget-usd', String(budget));
  args.push('--', prompt);
  return args;
}

/**
 * Whether this machine can ask Claude anything, checked the same way
 * codex.exec's available() is: exactly what run() checks, so a machine
 * cannot pass here and fail there. Nothing is executed and auth is not
 * probed — see the module doc comment for why that mirrors codex.exec on
 * purpose.
 */
export function available() {
  try {
    requireRoot();
    permissionMode();
    model();
    maxBudgetUsd();
    timeoutMs();
  } catch (error) {
    return { ok: false, reason: error.message };
  }

  const command = configured('ALPHA_CLAUDE', 'claude');
  const resolved = resolveExecutable(command);
  if (!resolved) {
    return { ok: false, reason: `Claude CLI not found (${command}). Set ALPHA_CLAUDE to its path.` };
  }
  if (isShellScript(resolved)) {
    // Same failure codex.exec guards against, for the same reason: a .cmd or
    // .bat needs a shell to run, and a shell is exactly what must not stand
    // between a prompt and this process. An npm install of Claude Code puts a
    // shim on PATH with the native binary beside it.
    return {
      ok: false,
      reason:
        `${resolved} is a shell script, which cannot be run without a shell. Point ALPHA_CLAUDE ` +
        "at the native Claude Code binary instead — `npm root -g` finds the package, and the " +
        'executable is in its bin directory.',
    };
  }
  return { ok: true };
}

function isShellScript(path) {
  return /\.(cmd|bat)$/i.test(path);
}

/** Identical to codex-exec.js's resolver: native extensions before shims. */
function resolveExecutable(command) {
  if (command.includes('/') || command.includes(sep)) {
    return existsSync(command) ? command : null;
  }
  const extensions = process.platform === 'win32' ? windowsExtensions() : [''];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, command + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function windowsExtensions() {
  const all = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  const native = all.filter((extension) => !isShellScript(extension));
  const scripts = all.filter((extension) => isShellScript(extension));
  return [...native, ...scripts];
}

/** Keeps the tail of a transcript, which is where the answer is. */
function tail(text, limit = MAX_OUTPUT_CHARS) {
  const value = text ?? '';
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: value.slice(value.length - limit), truncated: true };
}

function claude(args, { cwd, signal, timeout }) {
  const command = configured('ALPHA_CLAUDE', 'claude');
  return new Promise((resolvePromise) => {
    const child = execFile(
      command,
      args,
      { cwd, signal, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        resolvePromise({ error, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
    // Closed defensively, same as codex.exec and for the same class of risk:
    // a child left with an open, unwritten stdin pipe can hang a CLI that
    // reads stdin to EOF before answering. Not verified against the real
    // Claude CLI specifically (its --print path takes the prompt from argv,
    // not stdin, in every call made while building this) — kept as a
    // precaution rather than removed on the strength of that alone.
    child.stdin?.end();
  });
}

export async function run(payload = {}, { signal, log } = {}) {
  rejectUnsupportedKeys(payload);
  const prompt = validatePrompt(payload.prompt);

  const root = requireRoot();
  const mode = permissionMode();
  const modelName = model();
  const budget = maxBudgetUsd();
  const timeout = timeoutMs();

  const args = buildArgs({ prompt, permissionMode: mode, model: modelName, maxBudgetUsd: budget });
  // The prompt itself is not logged, same reasoning as codex.exec: it is the
  // message, it can be long, and the agent's log is not where a conversation
  // belongs.
  log?.info?.('asking claude', { root, mode, model: modelName, budget, promptChars: prompt.length });

  const startedAt = Date.now();
  const { error, stdout, stderr } = await claude(args, { cwd: root, signal, timeout });
  const durationMs = Date.now() - startedAt;

  if (signal?.aborted) {
    throw new ProtocolError('aborted', { status: 499, code: 'aborted' });
  }

  const out = tail(stdout);
  const err = tail(stderr, 4_000);
  const timedOut = Boolean(error?.killed) || durationMs >= timeout;

  if (error || timedOut) {
    if (error?.code === 'ENOENT') {
      throw new ProtocolError(
        `Claude CLI not found (${configured('ALPHA_CLAUDE', 'claude')}) on this machine`,
        { status: 500, code: 'not_configured' },
      );
    }
    if (timedOut) {
      throw new ProtocolError(
        `Claude did not answer within ${timeout} ms. Raise ALPHA_CLAUDE_TIMEOUT_MS, and the ` +
          "task's own lease with it.",
        { status: 504, code: 'timeout' },
      );
    }
    throw new ProtocolError(
      `claude exited ${error?.code ?? 'non-zero'}: ${(err.text || out.text).trim().slice(-800) || 'no output'}`,
      { status: 502, code: 'claude_failed' },
    );
  }

  if (out.text.trim() === '') {
    throw new ProtocolError(
      'claude exited 0 but produced no output, so there is no answer to return' +
        (err.text.trim() ? `: ${err.text.trim().slice(-800)}` : ''),
      { status: 502, code: 'claude_silent' },
    );
  }

  return {
    output: out.text,
    truncated: out.truncated,
    stderr: err.text,
    exitCode: 0,
    durationMs,
    promptChars: prompt.length,
    root,
    permissionMode: mode,
    model: modelName,
    maxBudgetUsd: budget,
  };
}

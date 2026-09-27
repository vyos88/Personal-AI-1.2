import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join, resolve, sep } from 'node:path';

import { ProtocolError } from '../../common/protocol.js';

/**
 * Asks the Codex CLI on this machine a question, and returns what it said.
 *
 * This is the handler that makes another coding agent reachable over the
 * tunnel. Alpha — or a Claude session, or a person with the CLI — queues a
 * prompt, the agent on the laptop where Codex is installed runs it
 * non-interactively, and Codex's answer comes back as the task result. Neither
 * side needs an open port, and nobody has to sit on the laptop relaying
 * messages: the round trip is one `alpha-admin codex --prompt ...`.
 *
 * **Be clear-eyed about what this is.** Every other handler here narrows what a
 * payload can ask for until what is left is data. This one hands a string to an
 * agent that has a shell on this machine, which is a category the rest of the
 * repo deliberately refuses (see handlers/index.js on why there is no
 * shell-exec built-in). The reasons it is nonetheless a handler and not a
 * remote shell with extra steps:
 *
 *   - It is opt-in, and `available()` refuses a machine where Codex is not
 *     installed, so an agent started from a copied `.env.agent` never advertises
 *     `codex.exec`.
 *   - The payload carries *only* a prompt. It cannot choose the executable, the
 *     directory, the model, the sandbox mode or any flag — those are this
 *     machine's configuration, set by whoever owns the laptop.
 *   - The sandbox defaults to `read-only`. Letting Codex write here is a
 *     decision made on the machine, in the open, not one a task can make for it.
 *   - Nothing is ever interpolated into a command line. `execFile` takes an argv
 *     array, so a prompt full of quotes, semicolons and backticks is a prompt.
 *
 * What remains true even so: a task queued against this type is a request to an
 * AI agent with filesystem access on that laptop, bounded by its sandbox mode
 * and nothing else. Give `codex.exec` to a machine you would let Codex work on,
 * and keep the sandbox no wider than the work needs.
 *
 * It is NOT registered by default. Enable it on the machine that has Codex:
 *
 *   ALPHA_EXTRA_HANDLERS=codex-exec
 *
 * Configuration:
 *   ALPHA_CODEX_ROOT       Directory Codex runs in (required). Usually the
 *                          checkout you want it working on.
 *   ALPHA_CODEX            The Codex executable. Defaults to `codex`, resolved
 *                          against PATH. On Windows this must be the native
 *                          binary, not the npm `.cmd` shim — see
 *                          resolveExecutable below.
 *   ALPHA_CODEX_SANDBOX    Sandbox mode passed to the CLI. Defaults to
 *                          `read-only`. Set it empty to pass no sandbox flag at
 *                          all, for a CLI version that does not take one.
 *   ALPHA_CODEX_MODEL      Optional model name. Unset means Codex's own default.
 *   ALPHA_CODEX_SKIP_GIT_CHECK  Set to 1 when the root is not a git checkout;
 *                          Codex refuses to run outside a repo without it.
 *   ALPHA_CODEX_TIMEOUT_MS Ceiling on one call. Defaults to 10 minutes.
 *
 * **A Codex call outlives the default lease.** `DEFAULT_LEASE_MS` is 60s and
 * the agent aborts a handler shortly before the host would reclaim its task, so
 * a prompt that takes three minutes is killed and requeued forever. This is the
 * same footgun `alpha.render` documents, and it has the same two halves:
 *
 *   alpha-admin codex --agent jacks-laptop --no-wait \
 *     --prompt "Summarise what changed in src/host this week"
 *
 * `alpha-admin codex` sets a 10-minute lease for you. Queue it with `--agent`
 * pointed at the machine holding Codex, read the answer with `alpha-admin
 * tasks`, and see docs/CODEX_BRIDGE.md for the round trip in full.
 */

export const type = 'codex.exec';

export const description =
  "Asks the Codex CLI on this machine a question and returns its answer, so another agent is reachable by task.";

const DEFAULT_SANDBOX = 'read-only';
const DEFAULT_TIMEOUT_MS = 600_000;

// Long enough to carry a real question with the context that makes it
// answerable — this is how one agent talks to another, and a 4 KB ceiling would
// make every interesting prompt a truncated one. The host caps a whole task body
// at 1 MB, so this stays well inside it.
const MAX_PROMPT_CHARS = 16_000;

// What comes back. Codex is happy to produce more than anyone wants on a task
// result, and the answer is at the *end* of the transcript, so the tail is the
// part worth keeping. `truncated` says so rather than leaving the caller to
// wonder whether that was the whole reply.
const MAX_OUTPUT_CHARS = 64_000;

// Sandbox modes are a value in an argv entry, so keep them to a legible set
// rather than forwarding whatever the environment happens to hold.
const SANDBOX_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** Reads an environment variable, treating blank as unset rather than as "". */
function configured(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw;
}

/** Whether a variable is set to something meaning yes. */
function enabled(name) {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * The prompt, and the one thing a payload may carry.
 *
 * A leading dash is refused even though `buildArgs` puts the prompt after `--`.
 * Both guards are cheap, and the one that survives a future edit to the argv is
 * the one that matters: a prompt that could be read as a flag is the only way
 * payload data reaches this CLI as anything but a prompt.
 */
export function validatePrompt(prompt) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new ProtocolError('"prompt" must be a non-empty string');
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new ProtocolError(
      `"prompt" exceeds ${MAX_PROMPT_CHARS} characters (got ${prompt.length}). ` +
        'Put the long part in the repository Codex is reading and point at it.',
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
 * Everything else about this call is the machine's business, so a payload that
 * names a model, a directory, a sandbox mode or a flag is refused rather than
 * ignored.
 *
 * Refusing beats dropping for the reason `alpha-devices` refuses arguments:
 * `{ prompt: "...", sandbox: "danger-full-access" }` should be told it meant
 * nothing, not have that quietly not happen. Someone who needs a wider sandbox
 * is asking the wrong side — that is a decision made on the laptop.
 */
export function rejectUnsupportedKeys(payload = {}) {
  const extra = Object.keys(payload).filter((key) => key !== 'prompt');
  if (extra.length === 0) return;
  throw new ProtocolError(
    `this handler takes only "prompt"; ${extra.map((k) => JSON.stringify(k)).join(', ')} ` +
      'would not reach Codex. The model, directory and sandbox mode are configured on the ' +
      'machine that runs it, not chosen by the task.',
  );
}

function requireRoot() {
  const root = configured('ALPHA_CODEX_ROOT', null);
  if (!root) {
    throw new ProtocolError(
      'ALPHA_CODEX_ROOT is not set on this agent, so there is no directory for Codex to work in',
      { status: 500, code: 'not_configured' },
    );
  }
  const resolved = resolve(root);
  if (!existsSync(resolved)) {
    throw new ProtocolError(`ALPHA_CODEX_ROOT does not exist: ${resolved}`, {
      status: 500,
      code: 'not_configured',
    });
  }
  return resolved;
}

function sandboxMode() {
  const raw = process.env.ALPHA_CODEX_SANDBOX;
  // Explicitly empty means "this CLI takes no sandbox flag" — an escape hatch
  // for a version whose flags differ, since a wrong flag fails every task.
  if (raw !== undefined && raw.trim() === '') return null;
  const mode = raw === undefined ? DEFAULT_SANDBOX : raw.trim();
  if (!SANDBOX_PATTERN.test(mode)) {
    throw new ProtocolError(
      `ALPHA_CODEX_SANDBOX must match ${SANDBOX_PATTERN} (got ${JSON.stringify(mode)})`,
      { status: 500, code: 'not_configured' },
    );
  }
  return mode;
}

function model() {
  const raw = configured('ALPHA_CODEX_MODEL', null);
  if (raw === null) return null;
  const name = raw.trim();
  if (!MODEL_PATTERN.test(name)) {
    throw new ProtocolError(
      `ALPHA_CODEX_MODEL must match ${MODEL_PATTERN} (got ${JSON.stringify(name)})`,
      { status: 500, code: 'not_configured' },
    );
  }
  return name;
}

function timeoutMs() {
  const raw = process.env.ALPHA_CODEX_TIMEOUT_MS;
  if (!raw || raw.trim() === '') return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ProtocolError(
      `ALPHA_CODEX_TIMEOUT_MS must be a positive whole number of milliseconds (got ${raw})`,
      { status: 500, code: 'not_configured' },
    );
  }
  return parsed;
}

/**
 * The argv handed to Codex. Exported so the tests can pin it.
 *
 * This is the one part of the handler that is a contract with a program that
 * lives outside this repository, so it is written the way `alpha-coordination`
 * writes its own: one function, pinned by tests, updated together with them if
 * the CLI changes. `exec` is Codex's non-interactive subcommand — the only one
 * that can answer a task, since anything interactive would sit waiting for a
 * keypress nobody is there to give it.
 *
 * Two things deliberately absent:
 *
 *   - No flag naming the working directory. `execFile` is given `cwd` instead,
 *     which every version of every CLI honours and no version can rename.
 *   - No `--json`. Parsing an event stream would be a second contract to keep
 *     in step, and for a handler whose job is to carry an answer back, the
 *     transcript *is* the answer.
 *
 * The prompt goes last, after `--`, so a question beginning with a dash is a
 * question. `validatePrompt` refuses one anyway.
 */
export function buildArgs({ prompt, sandbox = null, model: modelName = null, skipGitCheck = false }) {
  const args = ['exec'];
  if (sandbox) args.push('--sandbox', sandbox);
  if (modelName) args.push('--model', modelName);
  if (skipGitCheck) args.push('--skip-git-repo-check');
  args.push('--', prompt);
  return args;
}

/**
 * Whether this machine can actually ask Codex anything, asked before the agent
 * offers to.
 *
 * Same rule as `alpha-render`: it checks exactly what `run()` checks, in the
 * same way, so a machine cannot pass here and fail there. `.env.agent` gets
 * copied from one machine to the next, and a laptop without Codex that
 * advertises `codex.exec` wins the task on free RAM and fails it with an
 * attempt spent and a retry free to land right back on it.
 *
 * Nothing is executed. Codex is looked up, not run — whether it can reach its
 * API, and whether the account behind it is in good standing, is not knowable
 * without asking it something, and `run()` reports that honestly when it
 * happens.
 */
export function available() {
  let root;
  try {
    root = requireRoot();
    sandboxMode();
    model();
    timeoutMs();
  } catch (error) {
    return { ok: false, reason: error.message };
  }

  // Codex refuses to run outside a git checkout unless told to, so a root
  // without one means every task fails. Checked here because it is exactly the
  // kind of misconfiguration that looks like a broken handler from the far end.
  if (!enabled('ALPHA_CODEX_SKIP_GIT_CHECK') && !existsSync(join(root, '.git'))) {
    return {
      ok: false,
      reason:
        `ALPHA_CODEX_ROOT is not a git checkout (${root}). Point it at one, or set ` +
        'ALPHA_CODEX_SKIP_GIT_CHECK=1 to let Codex run there anyway.',
    };
  }

  const command = configured('ALPHA_CODEX', 'codex');
  const resolved = resolveExecutable(command);
  if (!resolved) {
    return { ok: false, reason: `Codex CLI not found (${command}). Set ALPHA_CODEX to its path.` };
  }
  if (isShellScript(resolved)) {
    // A .cmd or .bat cannot be spawned without a shell, and a shell is the one
    // thing that must not stand between a payload and this process: it is what
    // turns a prompt containing `&` or `|` from data into syntax. The npm
    // install of Codex puts a .cmd shim on PATH and the real binary beside it,
    // so this is a configuration fix, not a dead end.
    return {
      ok: false,
      reason:
        `${resolved} is a shell script, which cannot be run without a shell. Point ALPHA_CODEX ` +
        "at the native Codex binary instead — `npm root -g` finds the package, and the " +
        'executable is in its bin directory.',
    };
  }
  return { ok: true };
}

function isShellScript(path) {
  return /\.(cmd|bat)$/i.test(path);
}

/**
 * Where a command would be found, or null.
 *
 * `execFile` resolves a bare name against PATH, so this has to as well, or the
 * default `codex` would look missing on every machine that has it installed
 * normally. Windows needs PATHEXT too — and needs it in an order of its own:
 * native executables are tried before `.cmd`/`.bat`, because Codex installed
 * from npm puts both on PATH and only one of them can be spawned without a
 * shell. Taking whichever came first would refuse a machine that is perfectly
 * capable, on the evidence of a shim sitting next to the binary.
 */
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

function codex(args, { cwd, signal, timeout }) {
  const command = configured('ALPHA_CODEX', 'codex');
  return new Promise((resolvePromise) => {
    execFile(
      command,
      args,
      // maxBuffer generously above the output ceiling: hitting it kills the
      // process and loses the answer, where the tail above merely shortens it.
      { cwd, signal, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        resolvePromise({
          error,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        });
      },
    );
  });
}

export async function run(payload = {}, { signal, log } = {}) {
  rejectUnsupportedKeys(payload);
  const prompt = validatePrompt(payload.prompt);

  const root = requireRoot();
  const sandbox = sandboxMode();
  const modelName = model();
  const skipGitCheck = enabled('ALPHA_CODEX_SKIP_GIT_CHECK');
  const timeout = timeoutMs();

  const args = buildArgs({ prompt, sandbox, model: modelName, skipGitCheck });
  // The prompt itself is not logged: it is the message, it can be long, and the
  // agent's log is not where a conversation belongs.
  log?.info?.('asking codex', { root, sandbox, model: modelName, promptChars: prompt.length });

  const startedAt = Date.now();
  const { error, stdout, stderr } = await codex(args, { cwd: root, signal, timeout });
  const durationMs = Date.now() - startedAt;

  if (signal?.aborted) {
    throw new ProtocolError('aborted', { status: 499, code: 'aborted' });
  }

  const out = tail(stdout);
  const err = tail(stderr, 4_000);

  if (error) {
    if (error.code === 'ENOENT') {
      throw new ProtocolError(
        `Codex CLI not found (${configured('ALPHA_CODEX', 'codex')}) on this machine`,
        { status: 500, code: 'not_configured' },
      );
    }
    if (error.killed) {
      throw new ProtocolError(
        `Codex did not answer within ${timeout} ms. Raise ALPHA_CODEX_TIMEOUT_MS, and the ` +
          "task's own lease with it.",
        { status: 504, code: 'timeout' },
      );
    }
    // A non-zero exit means Codex did not answer. Unlike the coordination
    // tunnel, where a non-zero exit still carries a usable receipt, there is
    // nothing here to report as success.
    throw new ProtocolError(
      `codex exited ${error.code ?? 'non-zero'}: ${(err.text || out.text).trim().slice(-800) || 'no output'}`,
      { status: 502, code: 'codex_failed' },
    );
  }

  if (out.text.trim() === '') {
    // A clean exit that said nothing, which would otherwise be reported as a
    // successful conversation with an empty answer in it — the same failure
    // `alpha.render` refuses when Blender exits 0 having written no image.
    throw new ProtocolError(
      'codex exited 0 but produced no output, so there is no answer to return' +
        (err.text.trim() ? `: ${err.text.trim().slice(-800)}` : ''),
      { status: 502, code: 'codex_silent' },
    );
  }

  return {
    output: out.text,
    truncated: out.truncated,
    // Codex writes progress here, so it is worth carrying, but shortened: it is
    // context for an answer, not the answer.
    stderr: err.text,
    exitCode: 0,
    durationMs,
    promptChars: prompt.length,
    root,
    sandbox,
    model: modelName,
  };
}

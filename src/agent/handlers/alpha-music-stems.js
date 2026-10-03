import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { delimiter, extname, join, resolve, sep } from 'node:path';

import { ProtocolError } from '../../common/protocol.js';
import { findGenre } from '../../common/musicGenres.js';
import { genreFolder, resolveMusicOutputDir } from './alpha-music.js';

/**
 * Removes the vocals from a track `alpha.music` already made, by stem-
 * separating it and keeping everything but the vocal stem. The track never
 * leaves the machine that holds it — same split as `alpha.music.audio` — so
 * the instrumental this writes comes back through that same slice pipeline
 * once it lands in the genre folder; nothing new has to be taught to serve it.
 *
 * The payload names an existing track exactly the way `alpha.music.audio`
 * does, never a path: a genre and the file name `alpha.music` wrote, looked
 * for at exactly `<output>/<genre folder>/<name>`.
 *
 *   { genre, name }
 *
 * The generator contract, defined here because no generator existed before
 * it:
 *
 *   <python> <script> --input PATH --output-dir DIR
 *
 * It must write exactly one file into DIR — the input with its vocals
 * removed, named by the script itself — and exit non-zero on any failure.
 * `scripts/remove_vocals.py` implements it with Demucs; `ALPHA_MUSIC_DRY_RUN=1`
 * copies the input unchanged, which proves the pipeline end to end without the
 * model. (There is no way to prove separation itself without a real voice to
 * remove — the same honesty `generate_music.py`'s click track has about BPM
 * and key, not musicality.)
 *
 * Opt-in, same as `alpha.music`: ALPHA_EXTRA_HANDLERS=alpha-music,alpha-music-stems.
 * It shares ALPHA_MUSIC_ROOT/ALPHA_MUSIC_OUTPUT/ALPHA_MUSIC_PYTHON with it,
 * since it works on tracks that generator made, in the same output tree.
 *
 * Configuration:
 *   ALPHA_MUSIC_STEMS_SCRIPT      Script, relative to ALPHA_MUSIC_ROOT.
 *                                 Defaults to scripts/remove_vocals.py
 *   ALPHA_MUSIC_STEMS_TIMEOUT_MS  Hard ceiling on one track. Defaults to 10
 *                                 minutes, the same as alpha.music.
 */

export const type = 'alpha.music.stems';

export const description =
  'Removes the vocals from a track alpha.music made and returns the instrumental.';

const DEFAULT_SCRIPT = 'scripts/remove_vocals.py';
const DEFAULT_TIMEOUT_MS = 600_000;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.(wav|mp3|flac|ogg)$/;
const KNOWN_KEYS = new Set(['genre', 'name']);

export const STAGING_PREFIX = '.stems-';

function configured(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw;
}

function notConfigured(message) {
  return new ProtocolError(message, { status: 500, code: 'not_configured' });
}

/**
 * Turns a bridge request into the pair of names a run needs, or refuses it.
 * Exported so tests can pin every refusal without a generator.
 */
export function validateRequest(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProtocolError('payload must be { genre, name }');
  }
  const unknown = Object.keys(payload).filter((key) => !KNOWN_KEYS.has(key));
  if (unknown.length > 0) {
    throw new ProtocolError(
      `unknown key(s) ${unknown.map((key) => JSON.stringify(key)).join(', ')}; this takes genre, name`,
    );
  }
  if (!findGenre(payload.genre)) {
    throw new ProtocolError(`unknown genre ${JSON.stringify(payload.genre)}`);
  }
  const { name } = payload;
  if (typeof name !== 'string' || !NAME_PATTERN.test(name) || name.includes('..')) {
    throw new ProtocolError(`"name" must be a track file name alpha.music wrote (got ${JSON.stringify(name)})`);
  }
  return { genre: payload.genre, name };
}

export function buildArgs({ script, input, outputDir }) {
  return [script, '--input', input, '--output-dir', outputDir];
}

function requireRoot() {
  const root = process.env.ALPHA_MUSIC_ROOT;
  if (!root) throw notConfigured('ALPHA_MUSIC_ROOT is not set on this agent, so there is no generator tree to work in');
  const resolved = resolve(root);
  if (!existsSync(resolved)) throw notConfigured(`ALPHA_MUSIC_ROOT does not exist: ${resolved}`);
  return resolved;
}

function insideRoot(root, relative, label) {
  const resolved = resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw notConfigured(`${label} must live inside ALPHA_MUSIC_ROOT`);
  }
  return resolved;
}

function requireScript(root) {
  const script = insideRoot(root, configured('ALPHA_MUSIC_STEMS_SCRIPT', DEFAULT_SCRIPT), 'ALPHA_MUSIC_STEMS_SCRIPT');
  if (!existsSync(script)) throw notConfigured(`vocal remover not found at ${script}`);
  return script;
}

function python() {
  return configured('ALPHA_MUSIC_PYTHON', process.platform === 'win32' ? 'python' : 'python3');
}

function timeoutMs() {
  const raw = configured('ALPHA_MUSIC_STEMS_TIMEOUT_MS', null);
  if (raw === null) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw notConfigured(`ALPHA_MUSIC_STEMS_TIMEOUT_MS must be a positive whole number of milliseconds (got ${raw})`);
  }
  return parsed;
}

/** Same lookup execFile does: PATH, plus PATHEXT on Windows. */
function resolveExecutable(command) {
  if (command.includes('/') || command.includes(sep)) return existsSync(command) ? command : null;
  const extensions =
    process.platform === 'win32' && !extname(command)
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, command + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Whether this machine can remove vocals, asked the same way `run()` asks, so
 * a laptop holding a copied `.env.agent` does not advertise `alpha.music.stems`
 * and fail it. Nothing is executed, and no particular track is checked — that
 * is `run()`'s question, not this one's.
 */
export function available() {
  let root;
  try {
    root = requireRoot();
    requireScript(root);
    resolveMusicOutputDir();
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  const interpreter = python();
  if (!resolveExecutable(interpreter)) {
    return { ok: false, reason: `Python not found (${interpreter}). Set ALPHA_MUSIC_PYTHON to its path.` };
  }
  return { ok: true };
}

export async function run(payload, { signal, log } = {}) {
  const root = requireRoot();
  const script = requireScript(root);
  const outputDir = resolveMusicOutputDir();
  const { genre, name } = validateRequest(payload);

  const dir = join(outputDir, genreFolder(genre));
  const input = resolve(dir, name);
  // Belt and braces: the name pattern already rules out separators.
  if (!input.startsWith(dir + sep)) throw new ProtocolError('track name resolves outside the output directory');
  if (!existsSync(input)) {
    throw new ProtocolError(`no track ${JSON.stringify(name)} on this machine`, { status: 404, code: 'no_track' });
  }

  mkdirSync(dir, { recursive: true });
  // One directory per run, so a concurrent separation's file is never
  // reported as this one's.
  const stagingDir = mkdtempSync(resolve(dir, STAGING_PREFIX));
  const interpreter = python();
  const args = buildArgs({ script, input, outputDir: stagingDir });

  log?.info?.('removing vocals', { genre, name });

  const startedAt = Date.now();
  let outcome;
  try {
    outcome = await new Promise((resolvePromise, rejectPromise) => {
      execFile(
        interpreter,
        args,
        { cwd: root, signal, timeout: timeoutMs(), maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (error, out, err) => {
          if (error && error.code === 'ENOENT') {
            rejectPromise(
              new ProtocolError(`Python not found (${interpreter}). Set ALPHA_MUSIC_PYTHON to its path.`, {
                status: 500,
                code: 'no_python',
              }),
            );
            return;
          }
          // Killed by a signal reports code null, which must not read as 0.
          if (error && (error.killed || error.signal || error.code === 'ABORT_ERR')) {
            rejectPromise(
              new ProtocolError(
                `the vocal remover was killed before it finished (${error.signal ?? error.code}). ` +
                  'Either it outran ALPHA_MUSIC_STEMS_TIMEOUT_MS, or the lease expired — queue it with a larger --lease-ms.',
                { status: 500, code: 'stems_killed' },
              ),
            );
            return;
          }
          resolvePromise({ stdout: out ?? '', stderr: err ?? '', code: error?.code ?? 0 });
        },
      );
    });
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }

  const { stdout, stderr, code } = outcome;
  if (code !== 0) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw new ProtocolError(
      `the vocal remover exited ${code} for ${name}: ${stderr.trim().slice(-1_000)}`,
      { status: 500, code: 'stems_failed' },
    );
  }

  const outputs = [];
  for (const entry of readdirSync(stagingDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const to = resolve(dir, entry.name);
    renameSync(resolve(stagingDir, entry.name), to);
    outputs.push({ name: entry.name, path: to, bytes: statSync(to).size });
  }
  rmSync(stagingDir, { recursive: true, force: true });
  // A clean exit with no audio would otherwise be a recipe reproducing nothing.
  if (outputs.length === 0) {
    throw new ProtocolError(
      'the vocal remover exited 0 but wrote nothing; it should write the instrumental to --output-dir',
      { status: 500, code: 'no_audio' },
    );
  }
  outputs.sort((a, b) => a.name.localeCompare(b.name));

  return {
    sourceName: name,
    genre,
    outputs,
    generatedInMs: Date.now() - startedAt,
    stdout: stdout.slice(-8_000),
    stderr: stderr.slice(-8_000),
  };
}

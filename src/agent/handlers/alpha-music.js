import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { delimiter, join, resolve, sep } from 'node:path';

import { ProtocolError } from '../../common/protocol.js';
import { findGenre, findSubgenre, isBpmTypical, isValidKey } from '../../common/musicGenres.js';

/**
 * Generates a track from the Music Creator panel's settings by driving a
 * Python generator, so the machine with the model does the work and only the
 * *recipe* comes back — the same split `alpha.render` makes, for the same
 * reason. A few minutes of WAV is tens of megabytes; the settings and seed
 * that produced it are a few dozen bytes.
 *
 * The payload is exactly what the panel collects:
 *
 *   { genre, subgenre, bpm?, key, vocals, seed, durationSec? }
 *
 * Genre and subgenre are checked against `src/common/musicGenres.js`, the
 * vocabulary the panel's own `musicGenres.ts` mirrors, so a name the panel
 * would never send is a refusal rather than whatever the model makes of it.
 * `bpm` is optional and falls back to the subgenre's `defaultBpm`; when it is
 * given it always wins, typical for the style or not — a genre suggests, it
 * never pins. The result says whether it was typical, and nothing reads that.
 *
 * **Vocals are refused unless the machine says its generator can sing.** The
 * obvious local generator (MusicGen) is instrumental-only, and returning a
 * recipe that says `vocals: true` for audio with no voice in it is the one
 * thing a recipe must never do. `ALPHA_MUSIC_VOCALS=1` is the machine's claim
 * that its generator honours `--vocals`.
 *
 * The generator contract, which this file defines because no generator
 * existed before it:
 *
 *   <python> <script> --genre G --subgenre S --bpm N --key "A minor"
 *                     (--vocals | --instrumental) --seed N --duration N
 *                     --output-dir DIR
 *
 * It must write its audio into DIR, name the file itself, and exit non-zero
 * on failure. The handler reports what landed there.
 *
 * `scripts/generate_music.py` in this repository implements it with MusicGen,
 * so ALPHA_MUSIC_ROOT can simply be this checkout (its dependencies are in
 * `scripts/requirements-music.txt`, installed on the generating machine only).
 * `ALPHA_MUSIC_DRY_RUN=1` makes it write a click track at the requested BPM
 * on the key's tonic, with no model, which is how the tests drive it.
 *
 * External-program rules, as for every handler of this kind: pinned
 * interpreter, pinned script that must resolve inside ALPHA_MUSIC_ROOT,
 * validated values, argv array. It is NOT registered by default — enable it on
 * the machine that generates with ALPHA_EXTRA_HANDLERS=alpha-music.
 *
 * Configuration:
 *   ALPHA_MUSIC_ROOT        Directory holding the generator (required)
 *   ALPHA_MUSIC_SCRIPT      Script, relative to root. Defaults to
 *                           scripts/generate_music.py
 *   ALPHA_MUSIC_PYTHON      Interpreter. Defaults to `python` on Windows and
 *                           `python3` elsewhere
 *   ALPHA_MUSIC_OUTPUT      Output directory, relative to root. Defaults to
 *                           `output`; tracks are filed under `<genre>/`
 *   ALPHA_MUSIC_VOCALS      `1` if the generator can sing; anything else means
 *                           instrumental only
 *   ALPHA_MUSIC_TIMEOUT_MS  Hard ceiling on one track. Defaults to 10 minutes
 *
 * Generation outlives the default 60s lease, so queue it the way renders are:
 *
 *   alpha-admin task --type alpha.music --agent <machine> --lease-ms 600000 \
 *     --no-wait --payload '{"genre":"Electronic","subgenre":"Rollers",
 *     "key":"F minor","vocals":false,"seed":7}'
 */

export const type = 'alpha.music';

export const description =
  'Generates a track from the Music Creator settings (genre, BPM, key, vocals) and returns the recipe.';

const DEFAULT_SCRIPT = 'scripts/generate_music.py';
const DEFAULT_OUTPUT = 'output';
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_DURATION_SEC = 30;
const MAX_DURATION_SEC = 300;
// Wide enough for Doom Metal and Bebop both; outside it is a typo, not a style.
const MIN_BPM = 30;
const MAX_BPM = 300;
const MAX_SEED = Number.MAX_SAFE_INTEGER;
const KNOWN_KEYS = new Set(['genre', 'subgenre', 'bpm', 'key', 'vocals', 'seed', 'durationSec']);

export const STAGING_PREFIX = '.music-';

function configured(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw;
}

function notConfigured(message) {
  return new ProtocolError(message, { status: 500, code: 'not_configured' });
}

export function canSing() {
  return configured('ALPHA_MUSIC_VOCALS', '') === '1';
}

/**
 * Turns a panel payload into a recipe, or refuses it. Exported so tests can
 * pin every refusal without a generator, and so `src/bridge/music.js` refuses
 * the same things before queueing. The bridge passes `allowVocals: true`: it
 * does not know which machine will run the task, so whether that machine can
 * sing is the agent's question, asked here with the default.
 */
export function validateSettings(payload, { allowVocals = canSing() } = {}) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProtocolError('payload must be an object of music settings');
  }
  // An unknown key would be dropped on the floor and then missing from the
  // audio while the caller believes it was applied.
  const unknown = Object.keys(payload).filter((key) => !KNOWN_KEYS.has(key));
  if (unknown.length > 0) {
    throw new ProtocolError(
      `unknown setting(s) ${unknown.map((key) => JSON.stringify(key)).join(', ')}; ` +
        `this generator takes ${[...KNOWN_KEYS].join(', ')}`,
    );
  }

  const { genre, subgenre } = payload;
  if (!findGenre(genre)) {
    throw new ProtocolError(`unknown genre ${JSON.stringify(genre)}`);
  }
  const style = findSubgenre(genre, subgenre);
  if (!style) {
    throw new ProtocolError(
      `unknown subgenre ${JSON.stringify(subgenre)} for ${genre}`,
    );
  }

  const bpm = payload.bpm ?? style.defaultBpm;
  if (!Number.isInteger(bpm) || bpm < MIN_BPM || bpm > MAX_BPM) {
    throw new ProtocolError(
      `"bpm" must be a whole number from ${MIN_BPM} to ${MAX_BPM} (got ${JSON.stringify(payload.bpm)})`,
    );
  }

  if (!isValidKey(payload.key)) {
    throw new ProtocolError(
      `"key" must be a root and mode such as "A minor" or "F# major" (got ${JSON.stringify(payload.key)})`,
    );
  }

  if (typeof payload.vocals !== 'boolean') {
    throw new ProtocolError('"vocals" must be true or false, so the recipe says which it is');
  }
  if (payload.vocals && !allowVocals) {
    throw new ProtocolError(
      'this machine\'s generator is instrumental only; ask for "vocals": false, or set ' +
        'ALPHA_MUSIC_VOCALS=1 on a machine whose generator can sing',
    );
  }

  const { seed } = payload;
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
    throw new ProtocolError(
      `"seed" must be a non-negative integer no larger than ${MAX_SEED} (got ${JSON.stringify(seed)})`,
    );
  }

  const durationSec = payload.durationSec ?? DEFAULT_DURATION_SEC;
  if (!Number.isInteger(durationSec) || durationSec < 1 || durationSec > MAX_DURATION_SEC) {
    throw new ProtocolError(
      `"durationSec" must be a whole number from 1 to ${MAX_DURATION_SEC} (got ${JSON.stringify(payload.durationSec)})`,
    );
  }

  return { genre, subgenre, bpm, key: payload.key, vocals: payload.vocals, seed, durationSec };
}

export function buildArgs({ script, recipe, outputDir }) {
  return [
    script,
    '--genre',
    recipe.genre,
    '--subgenre',
    recipe.subgenre,
    '--bpm',
    String(recipe.bpm),
    '--key',
    recipe.key,
    recipe.vocals ? '--vocals' : '--instrumental',
    '--seed',
    String(recipe.seed),
    '--duration',
    String(recipe.durationSec),
    '--output-dir',
    outputDir,
  ];
}

function requireRoot() {
  const root = process.env.ALPHA_MUSIC_ROOT;
  if (!root) throw notConfigured('ALPHA_MUSIC_ROOT is not set on this agent, so there is no generator to run');
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
  const script = insideRoot(root, configured('ALPHA_MUSIC_SCRIPT', DEFAULT_SCRIPT), 'ALPHA_MUSIC_SCRIPT');
  if (!existsSync(script)) throw notConfigured(`music generator not found at ${script}`);
  return script;
}

/**
 * The directory finished tracks are filed under, resolved and bounds-checked.
 * Exported so `alpha-music-audio.js` reads exactly where `run()` writes; a
 * second copy of the rule that drifted would report every track missing.
 */
export function resolveMusicOutputDir() {
  return outputDirOf(requireRoot());
}

function outputDirOf(root) {
  return insideRoot(root, configured('ALPHA_MUSIC_OUTPUT', DEFAULT_OUTPUT), 'ALPHA_MUSIC_OUTPUT');
}

function python() {
  return configured('ALPHA_MUSIC_PYTHON', process.platform === 'win32' ? 'python' : 'python3');
}

function timeoutMs() {
  const raw = configured('ALPHA_MUSIC_TIMEOUT_MS', null);
  if (raw === null) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw notConfigured(`ALPHA_MUSIC_TIMEOUT_MS must be a positive whole number of milliseconds (got ${raw})`);
  }
  return parsed;
}

/** Same lookup execFile does: PATH, plus PATHEXT on Windows. */
function resolveExecutable(command) {
  if (command.includes('/') || command.includes(sep)) return existsSync(command) ? command : null;
  const extensions =
    process.platform === 'win32'
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
 * Whether this machine can generate, asked the same way `run()` asks, so a
 * laptop holding a copied `.env.agent` does not advertise `alpha.music` and
 * fail it. Nothing is executed.
 */
export function available() {
  try {
    const root = requireRoot();
    requireScript(root);
    outputDirOf(root);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  const interpreter = python();
  if (!resolveExecutable(interpreter)) {
    return { ok: false, reason: `Python not found (${interpreter}). Set ALPHA_MUSIC_PYTHON to its path.` };
  }
  return { ok: true };
}

/** Genre names carry spaces, `&` and `/`; the directory gets a safe slug. */
export function genreFolder(genre) {
  return genre.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export async function run(payload, { signal, log } = {}) {
  const root = requireRoot();
  const script = requireScript(root);
  const outputDir = outputDirOf(root);
  const recipe = validateSettings(payload);

  mkdirSync(outputDir, { recursive: true });
  // One directory per track, so a concurrent generation's file is never
  // reported as this one's.
  const stagingDir = mkdtempSync(resolve(outputDir, STAGING_PREFIX));
  const interpreter = python();
  const args = buildArgs({ script, recipe, outputDir: stagingDir });

  log?.info?.('generating music', { genre: recipe.genre, subgenre: recipe.subgenre, bpm: recipe.bpm });

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
                `the generator was killed before it finished (${error.signal ?? error.code}). ` +
                  'Either it outran ALPHA_MUSIC_TIMEOUT_MS, or the lease expired — queue it with a larger --lease-ms.',
                { status: 500, code: 'music_killed' },
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
      `the generator exited ${code} for ${recipe.genre}/${recipe.subgenre}: ${stderr.trim().slice(-1_000)}`,
      { status: 500, code: 'music_failed' },
    );
  }

  const destination = join(outputDir, genreFolder(recipe.genre));
  mkdirSync(destination, { recursive: true });
  const outputs = [];
  for (const entry of readdirSync(stagingDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const to = resolve(destination, entry.name);
    renameSync(resolve(stagingDir, entry.name), to);
    outputs.push({ name: entry.name, path: to, bytes: statSync(to).size });
  }
  rmSync(stagingDir, { recursive: true, force: true });
  // A clean exit with no audio would otherwise be a recipe reproducing nothing.
  if (outputs.length === 0) {
    throw new ProtocolError(
      'the generator exited 0 but wrote nothing; it should write its audio to --output-dir',
      { status: 500, code: 'no_audio' },
    );
  }
  outputs.sort((a, b) => a.name.localeCompare(b.name));

  return {
    recipe,
    bpmTypical: isBpmTypical(recipe.genre, recipe.subgenre, recipe.bpm),
    outputs,
    generatedInMs: Date.now() - startedAt,
    stdout: stdout.slice(-8_000),
    stderr: stderr.slice(-8_000),
  };
}

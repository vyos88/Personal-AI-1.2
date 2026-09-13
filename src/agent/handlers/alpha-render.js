import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { ProtocolError } from '../../common/protocol.js';

/**
 * Generates a 3D creature or plant by driving Blender's Python API, so the
 * machine with the GPU does the rendering and only the *recipe* comes back.
 *
 * That split is the point. An educational image is tens or hundreds of
 * megabytes and has no business travelling over a task result; the species and
 * seed that produced it are a few dozen bytes and are the only part anyone
 * needs in order to ask for that exact image again. So the image stays on the
 * machine that made it and the result carries the recipe, plus what landed and
 * how big it is.
 *
 * The generator takes `--species --seed --output-dir` and names the file
 * itself, so the handler reports what appeared rather than predicting a path.
 *
 * This is the second handler that runs an external program, so it follows the
 * rules `alpha-coordination.js` set for that case: a pinned executable, a
 * pinned script that must resolve inside a configured root, validated
 * arguments, and an argv array rather than a command line. A species name full
 * of semicolons is data here, not syntax.
 *
 * It is NOT registered by default. Enable it on the machine that renders with
 * ALPHA_EXTRA_HANDLERS=alpha-render.
 *
 * Configuration:
 *   ALPHA_RENDER_ROOT     Directory holding the generator script (required)
 *   ALPHA_RENDER_SCRIPT   Python script, relative to root. Defaults to
 *                         scripts/generate.py
 *   ALPHA_BLENDER         Blender executable. Defaults to `blender`
 *   ALPHA_RENDER_OUTPUT   Where images are written, relative to root.
 *                         Defaults to `output`
 *   ALPHA_RENDER_SPECIES  Optional comma-separated allowlist of species. Unset
 *                         means any well-formed name is passed through
 *   ALPHA_RENDER_TIMEOUT_MS  Hard ceiling on one render. Defaults to 10
 *                         minutes — but the task's own lease usually bites
 *                         first, see below
 *
 * **Renders outlive the default lease.** `DEFAULT_LEASE_MS` is 60s and the
 * agent aborts a handler shortly before the host would reclaim its task, so a
 * five-minute render queued with the default lease is killed and requeued
 * forever. Queue these with a lease that covers the work, and with the memory
 * the machine will actually need:
 *
 *   alpha-admin task --type alpha.render --lease-ms 600000 --min-memory-mb 4096 \
 *     --no-wait --payload '{"species":"beetle","seed":1234}'
 *
 * `--no-wait` matters as much as the lease: the CLI's own poll gives up long
 * before a render of this length finishes, and would report a task that is
 * running perfectly well as having timed out. Read the result with
 * `alpha-admin tasks` instead.
 */

export const type = 'alpha.render';

export const description =
  'Generates a 3D creature or plant in Blender and returns the recipe that reproduces it.';

const DEFAULT_SCRIPT = 'scripts/generate.py';
const DEFAULT_OUTPUT = 'output';
const DEFAULT_TIMEOUT_MS = 600_000;
// A species lands in an argv entry the generator parses. Keeping it to this
// set means a typo is a refusal rather than whatever the generator falls back
// to, and leaves nothing that could be read as an option rather than a value.
const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

// Seeds are what make a recipe reproducible, so they must survive a JSON round
// trip exactly. Beyond 2^53 they would not.
const MAX_SEED = Number.MAX_SAFE_INTEGER;

export function validateSpecies(species) {
  if (typeof species !== 'string' || !NAME_PATTERN.test(species)) {
    throw new ProtocolError(
      '"species" must be 1-64 characters, lowercase letters, digits, dash or underscore, ' +
        `starting with a letter (got ${JSON.stringify(species)})`,
    );
  }
  const allowed = allowedSpecies();
  if (allowed && !allowed.includes(species)) {
    // Configured on the machine that owns the script, so an unknown species is
    // refused here rather than becoming whatever the generator falls back to.
    throw new ProtocolError(
      `unknown species ${JSON.stringify(species)}; this machine generates ${allowed.join(', ')}`,
    );
  }
  return species;
}

/** Reads an environment variable, treating blank as unset rather than as "". */
function configured(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw;
}

function allowedSpecies() {
  const raw = process.env.ALPHA_RENDER_SPECIES;
  if (!raw || raw.trim() === '') return null;
  const list = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  return list.length > 0 ? list : null;
}

export function validateSeed(seed) {
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
    throw new ProtocolError(
      `"seed" must be a non-negative integer no larger than ${MAX_SEED} (got ${JSON.stringify(seed)})`,
    );
  }
  return seed;
}

/**
 * This generator takes a species and a seed and nothing else.
 *
 * A payload carrying `params` is refused rather than quietly dropped: the
 * script has no per-parameter flag, so accepting them would mean returning a
 * recipe naming values that had no effect on the image it describes — the one
 * thing a recipe must never do.
 */
export function rejectUnsupportedParams(payload) {
  if (payload?.params === undefined || payload?.params === null) return;
  throw new ProtocolError(
    'this generator takes only "species" and "seed"; it has no --param flag, so ' +
      '"params" would not reach it and the recipe would name values the image does not have',
  );
}

function requireRoot() {
  const root = process.env.ALPHA_RENDER_ROOT;
  if (!root) {
    throw new ProtocolError(
      'ALPHA_RENDER_ROOT is not set on this agent, so there is no generator to run',
      { status: 500, code: 'not_configured' },
    );
  }
  const resolved = resolve(root);
  if (!existsSync(resolved)) {
    throw new ProtocolError(`ALPHA_RENDER_ROOT does not exist: ${resolved}`, {
      status: 500,
      code: 'not_configured',
    });
  }
  return resolved;
}

/** Resolves a configured path and refuses anything that leaves the root. */
function insideRoot(root, relative, label) {
  const resolved = resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new ProtocolError(`${label} must live inside ALPHA_RENDER_ROOT`, {
      status: 500,
      code: 'not_configured',
    });
  }
  return resolved;
}

function requireScript(root) {
  const script = insideRoot(
    root,
    configured('ALPHA_RENDER_SCRIPT', DEFAULT_SCRIPT),
    'ALPHA_RENDER_SCRIPT',
  );
  if (!existsSync(script)) {
    throw new ProtocolError(`generator script not found at ${script}`, {
      status: 500,
      code: 'not_configured',
    });
  }
  return script;
}

/**
 * What one render produced.
 *
 * The generator names its own file, so the handler cannot predict the path.
 * The first version of this compared mtimes against the render's start, which
 * was wrong in two ways that both report someone else's work as this task's:
 * a second render running concurrently (ALPHA_AGENT_CONCURRENCY is a thing)
 * writes into the same directory inside the same window, and a back-to-back
 * render lands within the clock tolerance.
 *
 * So each render gets its own directory to write into and everything in it is
 * unambiguously its own — no timestamps, no heuristics. The files are then
 * moved into the shared output directory, which is what anyone looking for
 * images actually browses.
 */
function collectOutputs(stagingDir, outputDir) {
  const produced = [];
  for (const entry of readdirSync(stagingDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const from = resolve(stagingDir, entry.name);
    const to = resolve(outputDir, entry.name);
    // Same recipe, same name: a re-run replaces its own output rather than
    // accumulating copies.
    renameSync(from, to);
    produced.push({ name: entry.name, path: to, bytes: statSync(to).size });
  }
  return produced.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Builds the argv passed to Blender. Exported so tests can assert on it.
 *
 * `--species --seed --output-dir` is the real generator's interface, confirmed
 * against the script on Jack's laptop rather than assumed. It takes no
 * per-parameter flag, which is why `run` refuses a payload carrying `params`
 * instead of quietly dropping them.
 */
export function buildArgs({ script, species, seed, outputDir }) {
  const args = [
    '--background',
    // No user preferences, add-ons or startup file: a render that depends on
    // whatever this machine's Blender was last configured with is not
    // reproducible from a recipe, which is the only thing this returns.
    '--factory-startup',
    // Without this Blender exits 0 when the generator raises — verified: a
    // script whose first line throws still exits 0, and with this it exits 1.
    // That is the likeliest failure there is, and the exit-code guard below
    // would never have seen it.
    '--python-exit-code',
    '1',
    '--python',
    script,
    // Everything after `--` is handed to the script rather than eaten by
    // Blender's own argument parser.
    '--',
    '--species',
    species,
    '--seed',
    String(seed),
    '--output-dir',
    outputDir,
  ];

  return args;
}

function timeoutMs() {
  const raw = process.env.ALPHA_RENDER_TIMEOUT_MS;
  if (!raw || raw.trim() === '') return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ProtocolError(
      `ALPHA_RENDER_TIMEOUT_MS must be a positive whole number of milliseconds (got ${raw})`,
      { status: 500, code: 'not_configured' },
    );
  }
  return parsed;
}

export async function run(payload, { signal, log } = {}) {
  const root = requireRoot();
  const script = requireScript(root);
  const outputDir = insideRoot(
    root,
    configured('ALPHA_RENDER_OUTPUT', DEFAULT_OUTPUT),
    'ALPHA_RENDER_OUTPUT',
  );

  rejectUnsupportedParams(payload);
  const species = validateSpecies(payload?.species);
  const seed = validateSeed(payload?.seed);

  // The generator writes here and names the file itself, so the directory has
  // to exist before it runs. It is inside the validated root either way.
  mkdirSync(outputDir, { recursive: true });

  // Its own directory per render, so what it writes is unambiguously its own
  // even with another render running beside it.
  const stagingDir = mkdtempSync(resolve(outputDir, '.render-'));

  const blender = configured('ALPHA_BLENDER', 'blender');
  const args = buildArgs({ script, species, seed, outputDir: stagingDir });

  log?.info?.('rendering', { species, seed });

  const startedAt = Date.now();
  const { stdout, stderr, code } = await new Promise((resolvePromise, rejectPromise) => {
    execFile(
      blender,
      args,
      {
        cwd: root,
        signal,
        timeout: timeoutMs(),
        // A ten-minute render is far chattier than the coordination script this
        // was copied from, and overflowing the buffer kills the child and then
        // fails identically on every retry.
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, out, err) => {
        if (error && error.code === 'ENOENT') {
          rejectPromise(
            new ProtocolError(`Blender not found (${blender}). Set ALPHA_BLENDER to its path.`, {
              status: 500,
              code: 'no_blender',
            }),
          );
          return;
        }
        // A child killed by a signal reports `code: null`, not a number —
        // verified: a timeout gives code null, killed true, signal SIGTERM. So
        // `code ?? 0` read a render that blew its timeout or was aborted
        // mid-frame as a clean exit, and the guard below never fired.
        if (error && (error.killed || error.signal || error.code === 'ABORT_ERR')) {
          rejectPromise(
            new ProtocolError(
              `Blender was killed before it finished (${error.signal ?? error.code}). ` +
                'Either the render outran ALPHA_RENDER_TIMEOUT_MS, or the task lease expired ' +
                '— queue it with a larger --lease-ms.',
              { status: 500, code: 'render_killed' },
            ),
          );
          return;
        }
        resolvePromise({ stdout: out ?? '', stderr: err ?? '', code: error?.code ?? 0 });
      },
    );
  });

  // Unlike the coordination tunnel, where a non-zero exit is the script
  // answering "no" and therefore a result, a generator that exits non-zero
  // simply did not generate anything. That is a failed task, so it throws and
  // the queue decides whether to retry it.
  if (code !== 0) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw new ProtocolError(
      `Blender exited ${code} generating ${species}/${seed}: ${stderr.trim().slice(-1_000)}`,
      { status: 500, code: 'render_failed' },
    );
  }

  // A zero exit with no image is the worse failure, because it would otherwise
  // be reported as a success carrying a recipe that reproduces nothing.
  const outputs = collectOutputs(stagingDir, outputDir);
  rmSync(stagingDir, { recursive: true, force: true });
  if (outputs.length === 0) {
    throw new ProtocolError(
      'Blender exited 0 but wrote nothing. The generator script should write its ' +
        'image to the directory given by --output-dir.',
      { status: 500, code: 'no_image' },
    );
  }

  return {
    // The recipe: everything needed to ask for this exact image again, and
    // nothing that is only true of this run.
    recipe: { species, seed },
    // Everything this render wrote, and proof it is really there. Named
    // `outputs` rather than `images` because a generator may also leave a
    // .blend or a sidecar, and calling those images would be a lie.
    outputs,
    renderedInMs: Date.now() - startedAt,
    stdout: stdout.slice(-8_000),
    stderr: stderr.slice(-8_000),
  };
}

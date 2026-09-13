import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { ProtocolError } from '../../common/protocol.js';

/**
 * Generates a 3D creature or plant by driving Blender's Python API, so the
 * machine with the GPU does the rendering and only the *recipe* comes back.
 *
 * That split is the point. An educational image is tens or hundreds of
 * megabytes and has no business travelling over a task result; the seed and
 * the species parameters that produced it are a few hundred bytes and are the
 * only part anyone needs in order to ask for that exact image again. So the
 * image stays on the machine that made it and the result carries the recipe,
 * plus where the file landed and how big it is.
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
 *     --payload '{"species":"fern","seed":1234}'
 */

export const type = 'alpha.render';

export const description =
  'Generates a 3D creature or plant in Blender and returns the recipe that reproduces it.';

const DEFAULT_SCRIPT = 'scripts/generate.py';
const DEFAULT_OUTPUT = 'output';
const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_PARAMS = 32;
const MAX_PARAM_LENGTH = 128;

// Species and parameter names land in a filename and in an argv entry. Keeping
// them to this set means the recipe maps onto a file name without escaping,
// and a typo is a refusal rather than a surprising path.
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
 * Species parameters, as flat scalars only.
 *
 * Flat because each one becomes a single `--param key=value` argv entry, and a
 * nested object has no unambiguous rendering there. A generator that needs
 * structure should take a species name that means it, rather than having the
 * shape smuggled through a parameter.
 */
export function validateParams(params) {
  if (params === undefined || params === null) return {};
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new ProtocolError('"params" must be a JSON object of scalar values');
  }

  const entries = Object.entries(params);
  if (entries.length > MAX_PARAMS) {
    throw new ProtocolError(`"params" may carry at most ${MAX_PARAMS} entries`);
  }

  const validated = {};
  for (const [key, value] of entries) {
    if (!NAME_PATTERN.test(key)) {
      throw new ProtocolError(
        `parameter name must be 1-64 characters of lowercase letters, digits, dash or ` +
          `underscore, starting with a letter (got ${JSON.stringify(key)})`,
      );
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new ProtocolError(`parameter ${JSON.stringify(key)} must be a finite number`);
      }
    } else if (typeof value !== 'boolean' && typeof value !== 'string') {
      throw new ProtocolError(
        `parameter ${JSON.stringify(key)} must be a number, boolean or string, ` +
          `not ${Array.isArray(value) ? 'an array' : typeof value}`,
      );
    } else if (typeof value === 'string') {
      if (value.length > MAX_PARAM_LENGTH) {
        throw new ProtocolError(
          `parameter ${JSON.stringify(key)} must be at most ${MAX_PARAM_LENGTH} characters`,
        );
      }
      // `key=value` is split on the first `=` by the generator, so a newline
      // or an embedded `=` would make the pair ambiguous to read back.
      if (/[\r\n]/.test(value)) {
        throw new ProtocolError(`parameter ${JSON.stringify(key)} must not contain a newline`);
      }
    }
    validated[key] = value;
  }
  return validated;
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
    process.env.ALPHA_RENDER_SCRIPT ?? DEFAULT_SCRIPT,
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
 * Where this recipe's image belongs.
 *
 * Derived from the recipe rather than chosen by the caller, so the same seed
 * and species always name the same file — asking twice overwrites rather than
 * littering, and a recipe is enough to find the image it produced. It is also
 * why a caller cannot pass an output path: that would be a task deciding where
 * on this machine to write.
 */
export function imageNameFor({ species, seed }) {
  return `${species}-${seed}.png`;
}

/** Builds the argv passed to Blender. Exported so tests can assert on it. */
export function buildArgs({ script, species, seed, params, outputPath }) {
  const args = [
    '--background',
    // No user preferences, add-ons or startup file: a render that depends on
    // whatever this machine's Blender was last configured with is not
    // reproducible from a recipe, which is the only thing this returns.
    '--factory-startup',
    '--python',
    script,
    // Everything after `--` is handed to the script rather than eaten by
    // Blender's own argument parser.
    '--',
    '--species',
    species,
    '--seed',
    String(seed),
    '--out',
    outputPath,
  ];
  for (const [key, value] of Object.entries(params)) {
    args.push('--param', `${key}=${value}`);
  }
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
    process.env.ALPHA_RENDER_OUTPUT ?? DEFAULT_OUTPUT,
    'ALPHA_RENDER_OUTPUT',
  );

  const species = validateSpecies(payload?.species);
  const seed = validateSeed(payload?.seed);
  const params = validateParams(payload?.params);

  const imageName = imageNameFor({ species, seed });
  const outputPath = resolve(outputDir, imageName);
  const blender = process.env.ALPHA_BLENDER ?? 'blender';
  const args = buildArgs({ script, species, seed, params, outputPath });

  log?.info?.('rendering', { species, seed, params: Object.keys(params).length });

  const startedAt = Date.now();
  const { stdout, stderr, code } = await new Promise((resolvePromise, rejectPromise) => {
    execFile(
      blender,
      args,
      { cwd: root, signal, timeout: timeoutMs(), maxBuffer: 4 * 1024 * 1024, windowsHide: true },
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
        resolvePromise({ stdout: out ?? '', stderr: err ?? '', code: error?.code ?? 0 });
      },
    );
  });

  // Unlike the coordination tunnel, where a non-zero exit is the script
  // answering "no" and therefore a result, a generator that exits non-zero
  // simply did not generate anything. That is a failed task, so it throws and
  // the queue decides whether to retry it.
  if (code !== 0) {
    throw new ProtocolError(
      `Blender exited ${code} generating ${species}/${seed}: ${stderr.trim().slice(-1_000)}`,
      { status: 500, code: 'render_failed' },
    );
  }

  // A zero exit with no image is the worse failure, because it would otherwise
  // be reported as a success carrying a recipe that reproduces nothing.
  if (!existsSync(outputPath)) {
    throw new ProtocolError(
      `Blender exited 0 but wrote no image at ${outputPath}. The generator script ` +
        'should write to the path given by --out.',
      { status: 500, code: 'no_image' },
    );
  }

  return {
    // The recipe: everything needed to ask for this exact image again, and
    // nothing that is only true of this run.
    recipe: { species, seed, params },
    // Where it landed on this machine, and proof it is really there. The image
    // itself deliberately does not travel.
    image: {
      path: outputPath,
      name: imageName,
      bytes: statSync(outputPath).size,
    },
    renderedInMs: Date.now() - startedAt,
    stdout: stdout.slice(-8_000),
    stderr: stderr.slice(-8_000),
  };
}

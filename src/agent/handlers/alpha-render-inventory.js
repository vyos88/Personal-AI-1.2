import { readdirSync, statSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

import { ProtocolError } from '../../common/protocol.js';
import { resolveOutputDir, STAGING_PREFIX } from './alpha-render.js';

/**
 * Says what this machine has actually rendered, by reading the images.
 *
 * The receipt ledger on the host records renders from the moment it started
 * keeping one, and nothing before. That is most of them: the queue was in
 * memory for the whole life of this project, so every render that finished
 * before the ledger existed left exactly one durable trace — the file itself,
 * on the machine that made it.
 *
 * This reads that trace. It is the only way to answer "how many have we
 * rendered" for work that predates the ledger, and it stays the ground truth
 * afterwards: the ledger says what the *host* was told, the output directory
 * says what is really on disk, and the two disagreeing is worth knowing about.
 *
 * Three things it deliberately does not do:
 *
 * - **It does not parse seeds out of filenames.** The generator names its own
 *   file, which is why `run()` reports what appeared rather than predicting a
 *   path. Reconstructing `fern_7.png` → seed 7 would reintroduce exactly the
 *   assumption that handler refuses to make, and would be wrong the first time
 *   the generator changed its naming. Counts, bytes and times are what a file
 *   can honestly tell you; the seed lives in the recipe.
 * - **It does not skip a render in flight quietly.** A running render holds a
 *   private `.render-XXXXXX/` staging directory inside the output directory.
 *   Those are excluded from the totals — a half-written image is not output —
 *   but the count of them is reported, because "3 renders are running right
 *   now" is the other half of reading a directory mid-flight.
 * - **It does not delete, move or tidy anything.** Read-only, so it is safe to
 *   run on a schedule and safe to run while renders are happening.
 *
 * NOT registered by default: it reads the filesystem, which is the line
 * `handlers/index.js` draws around BUILTIN. Enable it on machines that render:
 *   ALPHA_EXTRA_HANDLERS=alpha-render,alpha-render-inventory
 */

export const type = 'alpha.render.inventory';

export const description =
  'Reports the 3D renders already on this machine — how many, which species, how much disk. '
  + 'Read-only, and the only record of renders that predate the host ledger.';

/** A render that has not been touched in this long is not in flight. */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.exr', '.webp', '.tif', '.tiff']);

/**
 * Only `species` is accepted, and only as a filter.
 *
 * Nothing here takes a path from the payload. The directory is the configured
 * one or nothing — a payload that could name where to look is a directory
 * lister with a task queue in front of it, which is the same objection
 * `handlers/index.js` raises against a shell handler.
 */
export function validatePayload(payload) {
  const keys = Object.keys(payload ?? {});
  const unknown = keys.filter((key) => key !== 'species');
  if (unknown.length > 0) {
    throw new ProtocolError(
      `alpha.render.inventory takes only "species" (got ${unknown.join(', ')}). `
        + 'It reads the configured output directory and never a path from the payload.',
    );
  }
  const species = payload?.species;
  if (species === undefined || species === null) return null;
  if (typeof species !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(species)) {
    throw new ProtocolError(
      `"species" must be a well-formed species name (got ${JSON.stringify(species)})`,
    );
  }
  return species;
}

function isImage(name) {
  const dot = name.lastIndexOf('.');
  return dot !== -1 && IMAGE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

/**
 * Walks the output directory one level of species deep, plus the day level
 * that ALPHA_RENDER_FILE_BY=species-day adds.
 *
 * Files sitting directly in the output directory are counted under
 * `(unfiled)` rather than ignored: that is where every render landed before
 * filing by species existed, which is precisely the back catalogue this exists
 * to find.
 */
export function scanOutputs(outputDir, { speciesFilter = null } = {}) {
  const species = {};
  let staging = 0;

  const addFile = (bucket, path, stats) => {
    const row = (species[bucket] ??= { count: 0, bytes: 0, newest: null, oldest: null });
    row.count += 1;
    row.bytes += stats.size;
    const at = stats.mtimeMs;
    if (row.newest === null || at > row.newest) row.newest = at;
    if (row.oldest === null || at < row.oldest) row.oldest = at;
  };

  const walk = (dir, bucket, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // A directory that vanished between listing and reading is a render
      // tidying up after itself, not a failure of the inventory.
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(STAGING_PREFIX)) {
          staging += 1;
          continue;
        }
        // Depth 0 is the species level; anything below it (the day level) rolls
        // up into the same species rather than becoming its own bucket.
        walk(full, depth === 0 ? entry.name : bucket, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isImage(entry.name)) continue;
      const target = depth === 0 ? '(unfiled)' : bucket;
      if (speciesFilter && target !== speciesFilter) continue;
      try {
        addFile(target, full, statSync(full));
      } catch {
        // Same race as above: the file is gone, so it is not output.
      }
    }
  };

  walk(outputDir, null, 0);
  return { species, staging };
}

/**
 * Whether this machine can answer the question.
 *
 * Deliberately weaker than `alpha-render`'s check: it wants the root and the
 * output directory, and says nothing about Blender. A machine whose Blender
 * broke, or was uninstalled, still holds every render it ever made — and that
 * is exactly the machine somebody needs an inventory from.
 */
export function available() {
  try {
    const { outputDir } = resolveOutputDir();
    if (!existsSync(outputDir)) {
      return { ok: false, reason: `no render output directory yet at ${outputDir}` };
    }
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  return { ok: true };
}

export async function run(payload, { log } = {}) {
  const speciesFilter = validatePayload(payload);
  const { root, outputDir } = resolveOutputDir();

  const { species, staging } = scanOutputs(outputDir, { speciesFilter });

  const names = Object.keys(species).sort();
  const total = names.reduce((sum, name) => sum + species[name].count, 0);
  const bytes = names.reduce((sum, name) => sum + species[name].bytes, 0);
  const newest = names.reduce(
    (latest, name) => (species[name].newest > latest ? species[name].newest : latest),
    0,
  );

  log?.info?.('render inventory', { total, species: names.length, staging });

  return {
    // Relative to the root, so a result is readable without knowing this
    // machine's directory layout — and does not leak an absolute home path.
    outputDir: relative(root, outputDir) || '.',
    total,
    bytes,
    species,
    speciesCount: names.length,
    newest: newest || null,
    // Renders happening right now. Their images are not counted above.
    rendersInFlight: staging,
  };
}

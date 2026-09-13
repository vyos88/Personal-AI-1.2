import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildArgs,
  imagesWrittenSince,
  rejectUnsupportedParams,
  run,
  validateSeed,
  validateSpecies,
} from '../src/agent/handlers/alpha-render.js';

const isWindows = process.platform === 'win32';

/**
 * A throwaway render root whose "Blender" records the argv it was handed and
 * writes the image it was told to write.
 *
 * Recording the argv is the point: argument construction is exactly the part
 * that cannot be guessed at, because the generator script on the other side
 * parses it. `writeImage: false` stands in for a generator that exits cleanly
 * having produced nothing, which is the failure worth catching.
 */
async function fixture({ exitCode = 0, stderr = '', writeImage = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'alpha-render-'));
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'output'), { recursive: true });
  await writeFile(join(root, 'scripts', 'generate.py'), '# stub generator\n');

  const argvLog = join(root, 'argv.json');
  const blender = join(root, isWindows ? 'blender.cmd' : 'blender.sh');

  if (isWindows) {
    // Node refuses to execFile a .cmd without shell:true, which would re-parse
    // the argument boundaries these tests exist to pin. So the recorder is
    // node itself, invoked through a small .js shim.
    const shim = join(root, 'blender-shim.js');
    await writeFile(
      shim,
      [
        "const { writeFileSync, copyFileSync } = require('node:fs');",
        `writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));`,
        // Mirror the POSIX branch: honour --out the way a generator would.
        'const i = process.argv.indexOf("--output-dir");',
        'const sp = process.argv[process.argv.indexOf("--species") + 1];',
        'const sd = process.argv[process.argv.indexOf("--seed") + 1];',
        `if (i !== -1 && ${writeImage}) writeFileSync(require('node:path').join(process.argv[i + 1], sp + "-" + sd + ".png"), "png");`,
        `if (${JSON.stringify(stderr)}) process.stderr.write(${JSON.stringify(stderr)});`,
        `process.exit(${exitCode});`,
      ].join('\n'),
    );
    return { root, argvLog, blender: process.execPath, blenderArgs: [shim] };
  }

  await writeFile(
    blender,
    [
      '#!/usr/bin/env bash',
      // "$@" keeps every argument exactly as received, one JSON string each.
      `printf '%s\\n' "$@" | node -e "` +
        `const fs=require('node:fs');` +
        `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>` +
        `fs.writeFileSync(process.argv[1],JSON.stringify(d.split('\\n').slice(0,-1))))` +
        `" ${argvLog}`,
      // Honour --out, the way the real generator is expected to.
      'dir=""; sp=""; sd=""; prev=""',
      'for a in "$@"; do',
      '  case "$prev" in --output-dir) dir="$a";; --species) sp="$a";; --seed) sd="$a";; esac',
      '  prev="$a"',
      'done',
      // The generator names its own file, which is why the handler has to
      // discover what appeared rather than predict a path.
      writeImage
        ? '[ -n "$dir" ] && printf png > "$dir/$sp-$sd.png"'
        : ': # deliberately writes nothing',
      stderr ? `printf %s ${JSON.stringify(stderr)} >&2` : ':',
      `exit ${exitCode}`,
    ].join('\n'),
  );
  await chmod(blender, 0o755);
  return { root, argvLog, blender, blenderArgs: [] };
}

/**
 * Points the handler at a fixture for the duration of one test.
 *
 * On Windows the recorder needs node plus a shim argument, which ALPHA_BLENDER
 * alone cannot express — so that branch asserts on buildArgs and the
 * validation rather than on a live run.
 */
function useFixture(t, f) {
  const previous = { ...process.env };
  process.env.ALPHA_RENDER_ROOT = f.root;
  process.env.ALPHA_BLENDER = f.blender;
  delete process.env.ALPHA_RENDER_SCRIPT;
  delete process.env.ALPHA_RENDER_OUTPUT;
  delete process.env.ALPHA_RENDER_SPECIES;
  delete process.env.ALPHA_RENDER_TIMEOUT_MS;
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  });
}

const recordedArgv = async (argvLog) => JSON.parse(await readFile(argvLog, 'utf8'));

// ---------------------------------------------------------------- validation

test('a species must be a well-formed name', () => {
  assert.equal(validateSpecies('fern'), 'fern');
  assert.equal(validateSpecies('tree-fern_2'), 'tree-fern_2');

  for (const bad of ['', 'Fern', '2fern', 'fern fern', 'fern;rm -rf /', '../etc', 'f'.repeat(65)]) {
    assert.throws(() => validateSpecies(bad), /species/, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('a machine may declare which species it generates', (t) => {
  t.after(() => delete process.env.ALPHA_RENDER_SPECIES);
  process.env.ALPHA_RENDER_SPECIES = 'fern, oak ,beetle';

  assert.equal(validateSpecies('oak'), 'oak');
  // Well-formed but not something this machine makes: refused here rather than
  // handed to a generator that would fall back to something else.
  assert.throws(() => validateSpecies('dragon'), /this machine generates fern, oak, beetle/);
});

test('a seed must survive a JSON round trip exactly', () => {
  assert.equal(validateSeed(0), 0);
  assert.equal(validateSeed(1234), 1234);
  assert.equal(validateSeed(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);

  // A recipe is only reproducible if the seed comes back the same number.
  for (const bad of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 2, '1234', null, undefined]) {
    assert.throws(() => validateSeed(bad), /seed/, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('a payload carrying params is refused, not quietly dropped', () => {
  // The generator has no --param flag. Accepting them would return a recipe
  // naming values that had no effect on the image it describes, which is the
  // one thing a recipe must never do.
  assert.equal(rejectUnsupportedParams({ species: 'beetle', seed: 1 }), undefined);
  assert.equal(rejectUnsupportedParams({ species: 'beetle', seed: 1, params: null }), undefined);

  assert.throws(
    () => rejectUnsupportedParams({ species: 'beetle', seed: 1, params: { height: 2 } }),
    /only "species" and "seed"/,
  );
});

// ------------------------------------------------------------------- the argv

test('the argv hands Blender the script and the generator its arguments', () => {
  const args = buildArgs({
    script: '/r/scripts/generate.py',
    species: 'beetle',
    seed: 1234,
    outputDir: '/r/output',
  });

  // The generator's real interface: --species --seed --output-dir, and it
  // names the file itself.
  assert.deepEqual(args, [
    '--background',
    '--factory-startup',
    '--python',
    '/r/scripts/generate.py',
    '--',
    '--species',
    'beetle',
    '--seed',
    '1234',
    '--output-dir',
    '/r/output',
  ]);

  // Everything the generator reads sits after the bare `--`, or Blender's own
  // parser would consume it.
  assert.ok(args.indexOf('--') < args.indexOf('--species'));
  // --factory-startup is not decoration: a render that depends on this
  // machine's saved preferences is not reproducible from the recipe.
  assert.ok(args.includes('--factory-startup'));
});

test('a re-run that overwrites its own output still counts as produced', async () => {
  // The generator names its file, so a repeat of the same recipe writes the
  // same name. A before/after diff of the directory would see nothing new and
  // report a successful render as having produced no image; mtime moves either
  // way, which is why the cutoff is a timestamp.
  const dir = await mkdtemp(join(tmpdir(), 'alpha-render-out-'));
  const image = join(dir, 'beetle-1234.png');
  await writeFile(image, 'first');

  const secondRunStartedAt = Date.now();
  await new Promise((r) => setTimeout(r, 20));
  await writeFile(image, 'second');

  const found = imagesWrittenSince(dir, secondRunStartedAt);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'beetle-1234.png');
  assert.equal(found[0].bytes, 6);

  // And something written well before the render is not claimed as its output.
  assert.equal(imagesWrittenSince(dir, Date.now() + 60_000).length, 0);
});

// --------------------------------------------------------------- running it

test('a render returns the recipe and leaves the image on the machine', async (t) => {
  if (isWindows) return; // see useFixture
  const f = await fixture();
  useFixture(t, f);

  const result = await run({ species: 'beetle', seed: 1234 });

  // The recipe is the whole payload anyone needs to ask again.
  assert.deepEqual(result.recipe, { species: 'beetle', seed: 1234 });
  // The image did not travel; what landed and how big it is did.
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].name, 'beetle-1234.png');
  assert.equal(result.images[0].bytes, 3);
  assert.match(result.images[0].path, /output[\\/]beetle-1234\.png$/);
  assert.ok(typeof result.renderedInMs === 'number');

  // And the arguments really reached the generator in the shape buildArgs
  // promises, through a real process boundary.
  const argv = await recordedArgv(f.argvLog);
  assert.ok(argv.includes('--factory-startup'));
  assert.deepEqual(argv.slice(argv.indexOf('--') + 1), [
    '--species',
    'beetle',
    '--seed',
    '1234',
    '--output-dir',
    f.root + '/output',
  ]);
});

test('shell metacharacters in a parameter are data, not syntax', async (t) => {
  if (isWindows) return;
  const f = await fixture();
  useFixture(t, f);

  // The species is the only caller-supplied string that reaches the argv, and
  // validateSpecies already refuses anything like this — so the belt-and-braces
  // check is that the output directory, which comes from configuration, also
  // survives intact through execFile rather than being re-parsed by a shell.
  const nasty = "a dir; rm -rf / && echo $(whoami) `id`";
  await mkdir(join(f.root, nasty), { recursive: true });
  process.env.ALPHA_RENDER_OUTPUT = nasty;

  await run({ species: 'beetle', seed: 1 });

  const argv = await recordedArgv(f.argvLog);
  // One argv entry, intact. execFile takes a vector, so there is no shell to
  // reinterpret any of this.
  assert.ok(argv.includes(join(f.root, nasty)), 'the directory arrived as one argument');
});

test('a generator that fails is a failed task, not a result', async (t) => {
  if (isWindows) return;
  const f = await fixture({ exitCode: 1, stderr: 'no such species', writeImage: false });
  useFixture(t, f);

  // Unlike the coordination tunnel, where a non-zero exit is the script
  // answering "no", a generator that exits non-zero generated nothing.
  await assert.rejects(run({ species: 'beetle', seed: 1 }), /exited 1.*no such species/s);
});

test('a clean exit that produced no image is still a failure', async (t) => {
  if (isWindows) return;
  // The worse case: reported as a success, it would hand back a recipe that
  // reproduces nothing and an image path pointing at nothing.
  const f = await fixture({ exitCode: 0, writeImage: false });
  useFixture(t, f);

  await assert.rejects(run({ species: 'beetle', seed: 1 }), /wrote nothing into/);
});

test('the handler refuses to run unconfigured, rather than guessing', async (t) => {
  const previous = process.env.ALPHA_RENDER_ROOT;
  t.after(() => {
    if (previous === undefined) delete process.env.ALPHA_RENDER_ROOT;
    else process.env.ALPHA_RENDER_ROOT = previous;
  });

  delete process.env.ALPHA_RENDER_ROOT;
  await assert.rejects(run({ species: 'beetle', seed: 1 }), /ALPHA_RENDER_ROOT is not set/);

  process.env.ALPHA_RENDER_ROOT = join(tmpdir(), 'alpha-render-does-not-exist');
  await assert.rejects(run({ species: 'beetle', seed: 1 }), /does not exist/);
});

test('a script or output directory outside the root is refused', async (t) => {
  if (isWindows) return;
  const f = await fixture();
  useFixture(t, f);

  process.env.ALPHA_RENDER_SCRIPT = '../escape.py';
  await assert.rejects(run({ species: 'beetle', seed: 1 }), /must live inside ALPHA_RENDER_ROOT/);

  delete process.env.ALPHA_RENDER_SCRIPT;
  process.env.ALPHA_RENDER_OUTPUT = '../elsewhere';
  await assert.rejects(run({ species: 'beetle', seed: 1 }), /must live inside ALPHA_RENDER_ROOT/);
});

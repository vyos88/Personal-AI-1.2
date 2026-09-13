import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildArgs,
  imageNameFor,
  run,
  validateParams,
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
        'const i = process.argv.indexOf("--out");',
        `if (i !== -1 && ${writeImage}) writeFileSync(process.argv[i + 1], "png");`,
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
      'out=""; prev=""',
      'for a in "$@"; do if [ "$prev" = "--out" ]; then out="$a"; fi; prev="$a"; done',
      writeImage ? '[ -n "$out" ] && printf png > "$out"' : ': # deliberately writes nothing',
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

test('params are flat scalars, because each becomes one argv entry', () => {
  assert.deepEqual(validateParams(undefined), {});
  assert.deepEqual(validateParams({ height: 2.5, dense: true, style: 'wild' }), {
    height: 2.5,
    dense: true,
    style: 'wild',
  });

  assert.throws(() => validateParams({ nested: { a: 1 } }), /must be a number, boolean or string/);
  assert.throws(() => validateParams({ list: [1, 2] }), /must be a number, boolean or string/);
  assert.throws(() => validateParams({ 'Bad Key': 1 }), /parameter name/);
  assert.throws(() => validateParams({ height: Infinity }), /finite number/);
  assert.throws(() => validateParams({ note: 'a\nb' }), /newline/);
  assert.throws(() => validateParams([1, 2]), /JSON object/);
});

// ------------------------------------------------------------------- the argv

test('the argv hands Blender the script and the generator its arguments', () => {
  const args = buildArgs({
    script: '/r/scripts/generate.py',
    species: 'fern',
    seed: 1234,
    params: { height: 2.5, dense: true },
    outputPath: '/r/output/fern-1234.png',
  });

  assert.deepEqual(args, [
    '--background',
    '--factory-startup',
    '--python',
    '/r/scripts/generate.py',
    '--',
    '--species',
    'fern',
    '--seed',
    '1234',
    '--out',
    '/r/output/fern-1234.png',
    '--param',
    'height=2.5',
    '--param',
    'dense=true',
  ]);

  // Everything the generator reads sits after the bare `--`, or Blender's own
  // parser would consume it.
  assert.ok(args.indexOf('--') < args.indexOf('--species'));
  // --factory-startup is not decoration: a render that depends on this
  // machine's saved preferences is not reproducible from the recipe.
  assert.ok(args.includes('--factory-startup'));
});

test('the image is named by the recipe, not by the caller', () => {
  assert.equal(imageNameFor({ species: 'fern', seed: 1234 }), 'fern-1234.png');
  // Same recipe, same file: asking twice overwrites rather than littering, and
  // a recipe is enough to find the image it produced.
  assert.equal(
    imageNameFor({ species: 'fern', seed: 1234 }),
    imageNameFor({ species: 'fern', seed: 1234 }),
  );
});

// --------------------------------------------------------------- running it

test('a render returns the recipe and leaves the image on the machine', async (t) => {
  if (isWindows) return; // see useFixture
  const f = await fixture();
  useFixture(t, f);

  const result = await run({ species: 'fern', seed: 1234, params: { height: 2.5 } });

  // The recipe is the whole payload anyone needs to ask again.
  assert.deepEqual(result.recipe, { species: 'fern', seed: 1234, params: { height: 2.5 } });
  // The image did not travel; its location and size did.
  assert.match(result.image.path, /output[\\/]fern-1234\.png$/);
  assert.equal(result.image.name, 'fern-1234.png');
  assert.equal(result.image.bytes, 3);
  assert.ok(typeof result.renderedInMs === 'number');

  // And the arguments really reached the generator in the shape buildArgs
  // promises, through a real process boundary.
  const argv = await recordedArgv(f.argvLog);
  assert.ok(argv.includes('--factory-startup'));
  assert.deepEqual(argv.slice(argv.indexOf('--') + 1, argv.indexOf('--param')), [
    '--species',
    'fern',
    '--seed',
    '1234',
    '--out',
    result.image.path,
  ]);
});

test('shell metacharacters in a parameter are data, not syntax', async (t) => {
  if (isWindows) return;
  const f = await fixture();
  useFixture(t, f);

  const nasty = 'a; rm -rf / && echo $(whoami) `id` | tee /tmp/x';
  await run({ species: 'fern', seed: 1, params: { style: nasty } });

  const argv = await recordedArgv(f.argvLog);
  // One argv entry, intact. execFile takes a vector, so there is no shell to
  // reinterpret any of this.
  assert.ok(argv.includes(`style=${nasty}`));
});

test('a generator that fails is a failed task, not a result', async (t) => {
  if (isWindows) return;
  const f = await fixture({ exitCode: 1, stderr: 'no such species', writeImage: false });
  useFixture(t, f);

  // Unlike the coordination tunnel, where a non-zero exit is the script
  // answering "no", a generator that exits non-zero generated nothing.
  await assert.rejects(run({ species: 'fern', seed: 1 }), /exited 1.*no such species/s);
});

test('a clean exit that produced no image is still a failure', async (t) => {
  if (isWindows) return;
  // The worse case: reported as a success, it would hand back a recipe that
  // reproduces nothing and an image path pointing at nothing.
  const f = await fixture({ exitCode: 0, writeImage: false });
  useFixture(t, f);

  await assert.rejects(run({ species: 'fern', seed: 1 }), /wrote no image/);
});

test('the handler refuses to run unconfigured, rather than guessing', async (t) => {
  const previous = process.env.ALPHA_RENDER_ROOT;
  t.after(() => {
    if (previous === undefined) delete process.env.ALPHA_RENDER_ROOT;
    else process.env.ALPHA_RENDER_ROOT = previous;
  });

  delete process.env.ALPHA_RENDER_ROOT;
  await assert.rejects(run({ species: 'fern', seed: 1 }), /ALPHA_RENDER_ROOT is not set/);

  process.env.ALPHA_RENDER_ROOT = join(tmpdir(), 'alpha-render-does-not-exist');
  await assert.rejects(run({ species: 'fern', seed: 1 }), /does not exist/);
});

test('a script or output directory outside the root is refused', async (t) => {
  if (isWindows) return;
  const f = await fixture();
  useFixture(t, f);

  process.env.ALPHA_RENDER_SCRIPT = '../escape.py';
  await assert.rejects(run({ species: 'fern', seed: 1 }), /must live inside ALPHA_RENDER_ROOT/);

  delete process.env.ALPHA_RENDER_SCRIPT;
  process.env.ALPHA_RENDER_OUTPUT = '../elsewhere';
  await assert.rejects(run({ species: 'fern', seed: 1 }), /must live inside ALPHA_RENDER_ROOT/);
});

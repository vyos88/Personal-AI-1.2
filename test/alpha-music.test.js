import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as music from '../src/agent/handlers/alpha-music.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';

const { available, buildArgs, genreFolder, run, validateSettings } = music;

const BASE = { genre: 'Electronic', subgenre: 'Rollers', key: 'F minor', vocals: false, seed: 7 };

const ENV = [
  'ALPHA_MUSIC_ROOT',
  'ALPHA_MUSIC_SCRIPT',
  'ALPHA_MUSIC_PYTHON',
  'ALPHA_MUSIC_OUTPUT',
  'ALPHA_MUSIC_VOCALS',
  'ALPHA_MUSIC_TIMEOUT_MS',
];

function isolateEnv(t) {
  const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  for (const name of ENV) delete process.env[name];
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

/**
 * A root whose "generator" is a Node script run by `node` standing in for
 * Python: it records its argv and writes the file it was told to, so the
 * argv is pinned exactly and nothing depends on a shell.
 */
async function fixture(t, { exitCode = 0, writeAudio = true, stderr = '' } = {}) {
  isolateEnv(t);
  const root = await mkdtemp(join(tmpdir(), 'alpha-music-'));
  await mkdir(join(root, 'scripts'), { recursive: true });
  const argvLog = join(root, 'argv.json');
  await writeFile(
    join(root, 'scripts', 'generate_music.py'),
    [
      "const { writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      'const argv = process.argv.slice(2);',
      `writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv));`,
      'const dir = argv[argv.indexOf("--output-dir") + 1];',
      'const seed = argv[argv.indexOf("--seed") + 1];',
      `if (${writeAudio}) writeFileSync(join(dir, "track-" + seed + ".wav"), "RIFF");`,
      `if (${JSON.stringify(stderr)}) process.stderr.write(${JSON.stringify(stderr)});`,
      `process.exit(${exitCode});`,
    ].join('\n'),
  );
  process.env.ALPHA_MUSIC_ROOT = root;
  process.env.ALPHA_MUSIC_PYTHON = process.execPath;
  return { root, argvLog };
}

test('panel settings become a recipe, and a missing bpm takes the subgenre default', () => {
  assert.deepEqual(validateSettings(BASE), { ...BASE, bpm: 174, durationSec: 30 });
});

test("the user's bpm always wins, typical for the style or not", () => {
  assert.equal(validateSettings({ ...BASE, bpm: 90 }).bpm, 90);
});

test('names outside the shared vocabulary are refused', () => {
  assert.throws(() => validateSettings({ ...BASE, genre: 'Polka' }), /unknown genre/);
  assert.throws(() => validateSettings({ ...BASE, subgenre: 'Trap' }), /unknown subgenre/);
  assert.throws(() => validateSettings({ ...BASE, key: 'H minor' }), /"key"/);
});

test('bpm, seed and duration must be sane whole numbers', () => {
  for (const bpm of [0, 29, 301, 120.5, '120']) {
    assert.throws(() => validateSettings({ ...BASE, bpm }), /"bpm"/, `bpm ${bpm}`);
  }
  for (const seed of [-1, 1.5, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateSettings({ ...BASE, seed }), /"seed"/, `seed ${seed}`);
  }
  assert.throws(() => validateSettings({ ...BASE, durationSec: 301 }), /"durationSec"/);
});

test('an unknown setting is refused, not silently dropped', () => {
  assert.throws(() => validateSettings({ ...BASE, temperature: 1.2 }), /unknown setting.*temperature/);
});

test('vocals must be stated, and are refused unless the machine can sing', (t) => {
  isolateEnv(t);
  assert.throws(() => validateSettings({ ...BASE, vocals: undefined }), /"vocals"/);
  assert.throws(() => validateSettings({ ...BASE, vocals: true }), /instrumental only/);
  process.env.ALPHA_MUSIC_VOCALS = '1';
  assert.equal(validateSettings({ ...BASE, vocals: true }).vocals, true);
});

test('the argv pins the generator contract', () => {
  const recipe = validateSettings({ ...BASE, genre: 'R&B / Soul', subgenre: 'Neo-Soul', bpm: 85 });
  assert.deepEqual(buildArgs({ script: 'gen.py', recipe, outputDir: 'out' }), [
    'gen.py',
    '--genre', 'R&B / Soul',
    '--subgenre', 'Neo-Soul',
    '--bpm', '85',
    '--key', 'F minor',
    '--instrumental',
    '--seed', '7',
    '--duration', '30',
    '--output-dir', 'out',
  ]);
});

test('genre folders are safe slugs', () => {
  assert.equal(genreFolder('R&B / Soul'), 'r-b-soul');
  assert.equal(genreFolder('Hip-Hop'), 'hip-hop');
});

test('a track returns the recipe and leaves the audio on the machine', async (t) => {
  const { root, argvLog } = await fixture(t);
  const result = await run({ ...BASE, genre: 'R&B / Soul', subgenre: 'Neo-Soul' });
  assert.deepEqual(result.recipe, {
    genre: 'R&B / Soul', subgenre: 'Neo-Soul', bpm: 85, key: 'F minor', vocals: false, seed: 7, durationSec: 30,
  });
  assert.equal(result.bpmTypical, true);
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0].name, 'track-7.wav');
  assert.equal(await readFile(join(root, 'output', 'r-b-soul', 'track-7.wav'), 'utf8'), 'RIFF');
  // Metacharacters in a genre name arrived as one argv entry.
  assert.ok(JSON.parse(await readFile(argvLog, 'utf8')).includes('R&B / Soul'));
  // No staging directory is left behind.
  assert.deepEqual(await readdir(join(root, 'output')), ['r-b-soul']);
});

test('a generator that fails is a failed task', async (t) => {
  const { root } = await fixture(t, { exitCode: 3, stderr: 'CUDA out of memory' });
  await assert.rejects(run(BASE), /exited 3.*CUDA out of memory/);
  assert.deepEqual(await readdir(join(root, 'output')), []);
});

test('a clean exit that wrote no audio is still a failure', async (t) => {
  await fixture(t, { writeAudio: false });
  await assert.rejects(run(BASE), /wrote nothing/);
});

test('an invalid payload is refused before anything runs', async (t) => {
  const { argvLog } = await fixture(t);
  await assert.rejects(run({ ...BASE, vocals: true }), /instrumental only/);
  await assert.rejects(readFile(argvLog), { code: 'ENOENT' });
});

test('a machine with the generator and an interpreter offers the type', async (t) => {
  await fixture(t);
  assert.deepEqual(available(), { ok: true });
  const registry = new HandlerRegistry([]);
  assert.equal(registry.add(music).registered, true);
  assert.ok(registry.has('alpha.music'));
});

test('a machine missing part of the setup says which part and is not registered', async (t) => {
  isolateEnv(t);
  assert.match(available().reason, /ALPHA_MUSIC_ROOT is not set/);

  const { root } = await fixture(t);
  process.env.ALPHA_MUSIC_SCRIPT = 'missing.py';
  assert.match(available().reason, /not found/);
  process.env.ALPHA_MUSIC_SCRIPT = '../outside.py';
  assert.match(available().reason, /inside ALPHA_MUSIC_ROOT/);
  delete process.env.ALPHA_MUSIC_SCRIPT;
  process.env.ALPHA_MUSIC_PYTHON = join(root, 'no-python-here');
  assert.match(available().reason, /Python not found/);
  assert.equal(new HandlerRegistry([]).add(music).registered, false);
});

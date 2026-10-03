import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as music from '../src/agent/handlers/alpha-music.js';
import * as stems from '../src/agent/handlers/alpha-music-stems.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';

const { available, buildArgs, run, validateRequest } = stems;

const ENV = [
  'ALPHA_MUSIC_ROOT',
  'ALPHA_MUSIC_OUTPUT',
  'ALPHA_MUSIC_PYTHON',
  'ALPHA_MUSIC_STEMS_SCRIPT',
  'ALPHA_MUSIC_STEMS_TIMEOUT_MS',
  'ALPHA_MUSIC_DRY_RUN',
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
async function fixture(t, { exitCode = 0, writeOutput = true, stderr = '' } = {}) {
  isolateEnv(t);
  const root = await mkdtemp(join(tmpdir(), 'alpha-stems-'));
  await mkdir(join(root, 'scripts'), { recursive: true });
  const argvLog = join(root, 'argv.json');
  await writeFile(
    join(root, 'scripts', 'remove_vocals.py'),
    [
      "const { writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      'const argv = process.argv.slice(2);',
      `writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv));`,
      'const dir = argv[argv.indexOf("--output-dir") + 1];',
      `if (${writeOutput}) writeFileSync(join(dir, "track.novocals.wav"), "RIFF");`,
      `if (${JSON.stringify(stderr)}) process.stderr.write(${JSON.stringify(stderr)});`,
      `process.exit(${exitCode});`,
    ].join('\n'),
  );
  process.env.ALPHA_MUSIC_ROOT = root;
  process.env.ALPHA_MUSIC_PYTHON = process.execPath;
  await mkdir(join(root, 'output', 'electronic'), { recursive: true });
  await writeFile(join(root, 'output', 'electronic', 'track.wav'), 'RIFF-source');
  return { root, argvLog };
}

test('the payload names a genre and a file, never a path', () => {
  assert.deepEqual(validateRequest({ genre: 'Electronic', name: 'a.wav' }), { genre: 'Electronic', name: 'a.wav' });
  for (const name of ['../auth.json', 'x/../../y.wav', '..wav.wav', '/etc/passwd', 'C:\\\\x.wav', 'track.exe', '.hidden.wav', 'a..b.wav']) {
    assert.throws(() => validateRequest({ genre: 'Electronic', name }), /"name"/, name);
  }
  assert.throws(() => validateRequest({ genre: 'Polka', name: 'a.wav' }), /unknown genre/);
  assert.throws(() => validateRequest({ genre: 'Electronic', name: 'a.wav', offset: 0 }), /unknown key.*offset/);
});

test('the argv pins the generator contract', () => {
  assert.deepEqual(buildArgs({ script: 'remove_vocals.py', input: 'in.wav', outputDir: 'out' }), [
    'remove_vocals.py',
    '--input', 'in.wav',
    '--output-dir', 'out',
  ]);
});

test('a track loses its vocals and leaves the instrumental on the machine', async (t) => {
  const { root, argvLog } = await fixture(t);
  const result = await run({ genre: 'Electronic', name: 'track.wav' });
  assert.equal(result.sourceName, 'track.wav');
  assert.equal(result.genre, 'Electronic');
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0].name, 'track.novocals.wav');
  assert.equal(await readFile(join(root, 'output', 'electronic', 'track.novocals.wav'), 'utf8'), 'RIFF');
  // The original track is untouched.
  assert.equal(await readFile(join(root, 'output', 'electronic', 'track.wav'), 'utf8'), 'RIFF-source');
  const argv = JSON.parse(await readFile(argvLog, 'utf8'));
  assert.equal(argv[0], '--input');
  assert.ok(argv[1].endsWith(join('electronic', 'track.wav')));
  // No staging directory is left behind.
  assert.deepEqual(
    (await readdir(join(root, 'output', 'electronic'))).sort(),
    ['track.novocals.wav', 'track.wav'],
  );
});

test('a missing track is refused before anything runs', async (t) => {
  const { argvLog } = await fixture(t);
  await assert.rejects(run({ genre: 'Electronic', name: 'nope.wav' }), /no track/);
  await assert.rejects(readFile(argvLog), { code: 'ENOENT' });
});

test('a remover that fails is a failed task', async (t) => {
  const { root } = await fixture(t, { exitCode: 3, stderr: 'model not installed' });
  await assert.rejects(run({ genre: 'Electronic', name: 'track.wav' }), /exited 3.*model not installed/);
  assert.deepEqual(await readdir(join(root, 'output', 'electronic')), ['track.wav']);
});

test('a clean exit that wrote nothing is still a failure', async (t) => {
  await fixture(t, { writeOutput: false });
  await assert.rejects(run({ genre: 'Electronic', name: 'track.wav' }), /wrote nothing/);
});

test('a machine with the remover and an interpreter offers the type', async (t) => {
  await fixture(t);
  assert.deepEqual(available(), { ok: true });
  const registry = new HandlerRegistry([]);
  assert.equal(registry.add(stems).registered, true);
  assert.ok(registry.has('alpha.music.stems'));
});

test('a machine missing part of the setup says which part and is not registered', async (t) => {
  isolateEnv(t);
  assert.match(available().reason, /ALPHA_MUSIC_ROOT is not set/);

  const { root } = await fixture(t);
  process.env.ALPHA_MUSIC_STEMS_SCRIPT = 'missing.py';
  assert.match(available().reason, /not found/);
  process.env.ALPHA_MUSIC_STEMS_SCRIPT = '../outside.py';
  assert.match(available().reason, /inside ALPHA_MUSIC_ROOT/);
  delete process.env.ALPHA_MUSIC_STEMS_SCRIPT;
  process.env.ALPHA_MUSIC_PYTHON = join(root, 'no-python-here');
  assert.match(available().reason, /Python not found/);
  assert.equal(new HandlerRegistry([]).add(stems).registered, false);
});

// The real remover, in its dry-run mode: the handler's argv against the
// script's argparse is the contract, and this is the only test that has both
// sides of it in the room. Skipped where there is no Python.
const REPO = join(import.meta.dirname, '..');
const pythonCommand = ['python3', 'python'].find((name) => {
  const probe = spawnSync(name, ['--version'], { encoding: 'utf8' });
  return probe.status === 0 && /Python 3/.test(probe.stdout + probe.stderr);
});

async function realRemover(t) {
  if (!pythonCommand) {
    t.skip('no Python 3 on this machine');
    return null;
  }
  isolateEnv(t);
  const root = await mkdtemp(join(tmpdir(), 'alpha-stems-real-'));
  await mkdir(join(root, 'scripts'));
  await copyFile(join(REPO, 'scripts', 'remove_vocals.py'), join(root, 'scripts', 'remove_vocals.py'));
  await mkdir(join(root, 'output', 'electronic'), { recursive: true });
  await writeFile(join(root, 'output', 'electronic', 'track.wav'), 'RIFF-source');
  process.env.ALPHA_MUSIC_ROOT = root;
  process.env.ALPHA_MUSIC_PYTHON = pythonCommand;
  process.env.ALPHA_MUSIC_DRY_RUN = '1';
  return root;
}

test("the real remover accepts the handler's argv and writes the instrumental", async (t) => {
  const root = await realRemover(t);
  if (!root) return;
  const result = await run({ genre: 'Electronic', name: 'track.wav' });
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0].name, 'track.novocals.wav');
  assert.equal(await readFile(result.outputs[0].path, 'utf8'), 'RIFF-source');
});

test('the real remover fails loudly without its model dependencies', async (t) => {
  const root = await realRemover(t);
  if (!root) return;
  delete process.env.ALPHA_MUSIC_DRY_RUN;
  const probe = spawnSync(pythonCommand, ['-c', 'import torch, demucs'], { encoding: 'utf8' });
  if (probe.status === 0) {
    t.skip('torch and demucs are installed here; this checks the machine without them');
    return;
  }
  await assert.rejects(run({ genre: 'Electronic', name: 'track.wav' }), /exited 1.*requirements-stems\.txt/);
});

test('music and stems share one output tree without colliding', async (t) => {
  // The point of sharing resolveMusicOutputDir/genreFolder with alpha-music
  // rather than keeping a second copy: a track the generator wrote is found
  // by the remover with no translation in between.
  const { root } = await fixture(t);
  process.env.ALPHA_MUSIC_SCRIPT = 'scripts/generate_music.py'; // not used, just proves no clash
  const result = await run({ genre: 'Electronic', name: 'track.wav' });
  assert.equal(music.genreFolder('Electronic'), 'electronic');
  assert.equal(result.genre, 'Electronic');
});

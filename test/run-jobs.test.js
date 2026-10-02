// scripts/run-jobs.mjs, driven as a subprocess against a real host and agent.
//
// The script's whole output is the recipe book — which seeds ran, what came
// back, and which jobs never did — so these tests read what it printed and
// what it saved, not its internals. The handlers are stand-ins with the real
// recipe shapes: `alpha.music` builds its recipe with the real handler's
// validateSettings, so a payload the real one would refuse is refused here too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHost } from '../src/host/server.js';
import { TunnelAgent } from '../src/agent/agent.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';
import { validateSettings } from '../src/agent/handlers/alpha-music.js';

const TOKEN = 'test-token-that-is-long-enough';
const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const RUN_JOBS = join(ROOT, 'scripts', 'run-jobs.mjs');

// See targeting.test.js: the real load figure makes a busy test box stand
// aside for longer than these batches are given.
const IDLE_LOAD = { snapshot: () => ({ cpus: 1, busy: 0, loadAverage1: 0, loadFactor: 0 }) };

const music = {
  type: 'alpha.music',
  run: async (payload) => ({ recipe: validateSettings(payload, { allowVocals: true }), outputs: [] }),
};
const render = {
  type: 'alpha.render',
  run: async (payload) => ({
    recipe: { species: payload.species, seed: payload.seed },
    outputs: [{ name: `${payload.species}-${payload.seed}.png`, bytes: 2048 }],
  }),
};

const MUSIC = { genre: 'Electronic', subgenre: 'Techno', bpm: 128, key: 'F minor', vocals: false, seed: 7 };

async function startFleet(t) {
  const host = createHost({ token: TOKEN });
  await new Promise((r) => host.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${host.server.address().port}`;
  const agent = new TunnelAgent({
    hostUrl: url,
    token: TOKEN,
    name: 'laptop',
    instanceId: 'inst_run_jobs_test',
    handlers: new HandlerRegistry([music, render]),
    loadSampler: IDLE_LOAD,
    pollWaitMs: 250,
  });
  const running = agent.start();
  t.after(async () => {
    await agent.stop({ drainMs: 0 });
    await running;
    await host.close();
  });
  return url;
}

function runJobs(url, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [RUN_JOBS, ...args], {
      cwd: ROOT,
      env: { ...process.env, ALPHA_HOST_URL: url, ALPHA_ADMIN_TOKEN: TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'run-jobs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('a music batch prints its recipes rather than undefined/<seed>', async (t) => {
  // The validateSettings guard is real, so a genre the catalogue does not know
  // fails here as it would on the machine — check the fixture first.
  validateSettings(MUSIC, { allowVocals: true });
  const url = await startFleet(t);

  const { code, stdout, stderr } = await runJobs(url, [
    '--type', 'alpha.music', '--count', '2', '--payload', JSON.stringify(MUSIC), '--timeout', '20',
  ]);
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stdout, /undefined/);
  assert.match(stdout, /Electronic\/Techno 128 BPM F minor instrumental seed 7/);
  assert.match(stdout, /Electronic\/Techno 128 BPM F minor instrumental seed 8/);
});

test('renders still print as species/seed', async (t) => {
  const url = await startFleet(t);
  const { code, stdout, stderr } = await runJobs(url, [
    '--type', 'alpha.render', '--count', '2', '--species', 'fox,fern', '--seed', '3', '--timeout', '20',
  ]);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /fox\/3 → fox-3\.png \(2 KB\)/);
  assert.match(stdout, /fern\/4 → fern-4\.png/);
});

test('a seeded payload gets a distinct seed per job without --species', async (t) => {
  const url = await startFleet(t);
  const dir = await scratch(t);

  // From the payload's own seed.
  const fromPayload = join(dir, 'from-payload.json');
  let run = await runJobs(url, [
    '--type', 'alpha.music', '--count', '5', '--payload', JSON.stringify(MUSIC),
    '--save', fromPayload, '--timeout', '20',
  ]);
  assert.equal(run.code, 0, run.stderr);
  let book = JSON.parse(await readFile(fromPayload, 'utf8'));
  assert.deepEqual(book.map((entry) => entry.recipe.seed), [7, 8, 9, 10, 11]);

  // And --seed overrides it, for any payload that is seeded at all.
  const fromFlag = join(dir, 'from-flag.json');
  run = await runJobs(url, [
    '--type', 'alpha.music', '--count', '3', '--payload', JSON.stringify(MUSIC), '--seed', '100',
    '--save', fromFlag, '--timeout', '20',
  ]);
  assert.equal(run.code, 0, run.stderr);
  book = JSON.parse(await readFile(fromFlag, 'utf8'));
  assert.deepEqual(book.map((entry) => entry.recipe.seed), [100, 101, 102]);
  // Every other setting is the batch's, unchanged.
  for (const entry of book) assert.equal(entry.recipe.genre, 'Electronic');
});

test('--json and --save work together, and stdout is only the JSON', async (t) => {
  const url = await startFleet(t);
  const dir = await scratch(t);
  const file = join(dir, 'recipes.json');

  const { code, stdout, stderr } = await runJobs(url, [
    '--type', 'alpha.music', '--count', '2', '--payload', JSON.stringify(MUSIC),
    '--json', '--save', file, '--timeout', '20',
  ]);
  assert.equal(code, 0, stderr);

  const printed = JSON.parse(stdout);
  assert.equal(printed.length, 2);
  assert.ok(printed.every((task) => task.status === 'succeeded'));

  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved.map((entry) => entry.recipe.seed), [7, 8]);
  assert.match(stderr, /Wrote 2 result\(s\)/);
});

test('jobs that never finish stay in the saved book, with their status', async (t) => {
  const url = await startFleet(t);
  const dir = await scratch(t);
  const file = join(dir, 'book.json');

  // Nothing attached offers this type, so the batch can only time out.
  const { code, stdout } = await runJobs(url, [
    '--type', 'nobody.runs.this', '--count', '2', '--payload', '{"seed":1}',
    '--save', file, '--timeout', '1',
  ]);
  assert.equal(code, 1);
  assert.match(stdout, /2 unfinished/);

  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.length, 2);
  for (const entry of saved) {
    assert.equal(entry.finished, false);
    assert.equal(entry.status, 'queued');
    assert.equal(entry.recipe, null);
  }
  assert.deepEqual(saved.map((entry) => entry.payload.seed), [1, 2]);
});

// The back catalogue.
//
// The host's ledger records renders from the moment it started keeping one,
// and nothing before — which is most of them, because the queue was in memory
// for the whole life of this project. Every render that finished before then
// left exactly one durable trace: the file itself, on the machine that made
// it. This reads that trace.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  available,
  run,
  scanOutputs,
  validatePayload,
} from '../src/agent/handlers/alpha-render-inventory.js';

const dirs = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'alpha-inventory-'));
  dirs.push(root);
  await mkdir(join(root, 'output'), { recursive: true });
  return root;
}

const image = async (path, bytes = 3) => {
  await mkdir(join(path, '..'), { recursive: true }).catch(() => {});
  await writeFile(path, 'x'.repeat(bytes));
};

function useEnv(t, root) {
  const before = { ...process.env };
  process.env.ALPHA_RENDER_ROOT = root;
  delete process.env.ALPHA_RENDER_OUTPUT;
  t.after(() => {
    process.env = before;
  });
}

test.after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

test('renders filed by species are counted per species', async (t) => {
  const root = await fixture();
  useEnv(t, root);
  const out = join(root, 'output');

  await mkdir(join(out, 'fern'), { recursive: true });
  await mkdir(join(out, 'beetle'), { recursive: true });
  await image(join(out, 'fern', 'fern_0.png'), 10);
  await image(join(out, 'fern', 'fern_1.png'), 20);
  await image(join(out, 'beetle', 'beetle_0.png'), 5);

  const result = await run({});
  assert.equal(result.total, 3);
  assert.equal(result.bytes, 35);
  assert.equal(result.species.fern.count, 2);
  assert.equal(result.species.fern.bytes, 30);
  assert.equal(result.species.beetle.count, 1);
  assert.equal(result.speciesCount, 2);
});

// This is the back catalogue: everything rendered before filing by species
// existed sits directly in output/. Ignoring it would report the one machine
// holding the history as empty.
test('renders from before filing existed are found, not ignored', async (t) => {
  const root = await fixture();
  useEnv(t, root);
  const out = join(root, 'output');

  await image(join(out, 'fern_0.png'), 7);
  await image(join(out, 'old-render.png'), 3);

  const result = await run({});
  assert.equal(result.total, 2);
  assert.equal(result.species['(unfiled)'].count, 2);
  assert.equal(result.species['(unfiled)'].bytes, 10);
});

test('the day level rolls up into its species rather than becoming one', async (t) => {
  const root = await fixture();
  useEnv(t, root);
  const out = join(root, 'output');

  await mkdir(join(out, 'kelp', '2026-09-14'), { recursive: true });
  await mkdir(join(out, 'kelp', '2026-09-15'), { recursive: true });
  await image(join(out, 'kelp', '2026-09-14', 'a.png'));
  await image(join(out, 'kelp', '2026-09-15', 'b.png'));

  const result = await run({});
  assert.equal(result.speciesCount, 1);
  assert.equal(result.species.kelp.count, 2);
});

// A running render holds a private .render-XXXXXX/ inside output. Its
// half-written image is not output — but "3 renders are running right now" is
// the other half of reading a directory mid-flight.
test('a render in flight is excluded from the totals and reported separately', async (t) => {
  const root = await fixture();
  useEnv(t, root);
  const out = join(root, 'output');

  await mkdir(join(out, 'fern'), { recursive: true });
  await image(join(out, 'fern', 'done.png'));
  await mkdir(join(out, '.render-abc123'), { recursive: true });
  await image(join(out, '.render-abc123', 'half-written.png'));

  const result = await run({});
  assert.equal(result.total, 1, 'the half-written image must not count as output');
  assert.equal(result.rendersInFlight, 1);
});

test('non-images are not renders', async (t) => {
  const root = await fixture();
  useEnv(t, root);
  const out = join(root, 'output');

  await mkdir(join(out, 'fern'), { recursive: true });
  await image(join(out, 'fern', 'fern_0.png'));
  await image(join(out, 'fern', 'notes.txt'));
  await image(join(out, 'fern', 'scene.blend'));

  const result = await run({});
  assert.equal(result.total, 1);
});

test('a species filter narrows to that species', async (t) => {
  const root = await fixture();
  useEnv(t, root);
  const out = join(root, 'output');

  await mkdir(join(out, 'fern'), { recursive: true });
  await mkdir(join(out, 'beetle'), { recursive: true });
  await image(join(out, 'fern', 'a.png'));
  await image(join(out, 'beetle', 'b.png'));

  const result = await run({ species: 'fern' });
  assert.equal(result.total, 1);
  assert.deepEqual(Object.keys(result.species), ['fern']);
});

// Nothing here may take a path from the payload. A handler that could be told
// where to look is a directory lister with a task queue in front of it.
test('a payload naming anything but a species is refused', async () => {
  assert.throws(() => validatePayload({ path: '/etc' }), /takes only "species"/);
  assert.throws(() => validatePayload({ dir: '../..' }), /takes only "species"/);
  assert.throws(() => validatePayload({ species: 'fern', limit: 10 }), /takes only "species"/);
});

test('a malformed species is refused rather than matched loosely', () => {
  assert.throws(() => validatePayload({ species: '../escape' }), /well-formed species/);
  assert.throws(() => validatePayload({ species: 'Fern' }), /well-formed species/);
  assert.equal(validatePayload({}), null);
  assert.equal(validatePayload({ species: 'fern' }), 'fern');
});

test('an empty output directory reports zero rather than failing', async (t) => {
  const root = await fixture();
  useEnv(t, root);

  const result = await run({});
  assert.equal(result.total, 0);
  assert.equal(result.speciesCount, 0);
  assert.equal(result.newest, null);
});

test('the reported path is relative to the root, not this machine\'s layout', async (t) => {
  const root = await fixture();
  useEnv(t, root);

  const result = await run({});
  assert.equal(result.outputDir, 'output');
  assert.doesNotMatch(result.outputDir, /^\//);
});

// Deliberately weaker than alpha-render's check: a machine whose Blender broke
// still holds every render it made, and that is exactly when you want to ask.
test('available() wants the output directory, and says nothing about Blender', async (t) => {
  const root = await fixture();
  useEnv(t, root);
  process.env.ALPHA_BLENDER = '/definitely/not/a/real/blender';

  assert.deepEqual(available(), { ok: true });
});

test('available() refuses a machine that has never rendered', async (t) => {
  const root = await fixture();
  useEnv(t, root);
  process.env.ALPHA_RENDER_OUTPUT = 'never-used';

  const verdict = available();
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no render output directory yet/);
});

test('available() refuses a machine with no render root configured', async (t) => {
  const before = { ...process.env };
  t.after(() => {
    process.env = before;
  });
  delete process.env.ALPHA_RENDER_ROOT;

  const verdict = available();
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /ALPHA_RENDER_ROOT/);
});

test('scanOutputs is pure enough to call on a directory directly', async () => {
  const root = await fixture();
  const out = join(root, 'output');
  await mkdir(join(out, 'fern'), { recursive: true });
  await image(join(out, 'fern', 'a.png'), 4);

  const { species, staging } = scanOutputs(out);
  assert.equal(species.fern.count, 1);
  assert.equal(species.fern.bytes, 4);
  assert.equal(staging, 0);
});

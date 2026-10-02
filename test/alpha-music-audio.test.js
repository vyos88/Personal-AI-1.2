import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as audio from '../src/agent/handlers/alpha-music-audio.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';

const { CHUNK_BYTES, available, run, validateRequest } = audio;

async function root(t) {
  const saved = { root: process.env.ALPHA_MUSIC_ROOT, out: process.env.ALPHA_MUSIC_OUTPUT };
  t.after(() => {
    for (const [name, value] of [['ALPHA_MUSIC_ROOT', saved.root], ['ALPHA_MUSIC_OUTPUT', saved.out]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  delete process.env.ALPHA_MUSIC_OUTPUT;
  const dir = await mkdtemp(join(tmpdir(), 'music-audio-'));
  process.env.ALPHA_MUSIC_ROOT = dir;
  return dir;
}

test('the payload names a genre and a file, never a path', () => {
  assert.deepEqual(validateRequest({ genre: 'Electronic', name: 'a.wav' }), { genre: 'Electronic', name: 'a.wav', offset: 0 });
  for (const name of ['../auth.json', 'x/../../y.wav', '..wav.wav', '/etc/passwd', 'C:\\\\x.wav', 'track.exe', '.hidden.wav', 'a..b.wav']) {
    assert.throws(() => validateRequest({ genre: 'Electronic', name }), /"name"/, name);
  }
  assert.throws(() => validateRequest({ genre: 'Polka', name: 'a.wav' }), /unknown genre/);
  assert.throws(() => validateRequest({ genre: 'Electronic', name: 'a.wav', path: '/' }), /unknown key.*path/);
  assert.throws(() => validateRequest({ genre: 'Electronic', name: 'a.wav', offset: -1 }), /"offset"/);
});

test('a track comes back in slices that reassemble to the file', async (t) => {
  const dir = await root(t);
  await mkdir(join(dir, 'output', 'r-b-soul'), { recursive: true });
  const bytes = Buffer.alloc(CHUNK_BYTES * 2 + 123);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
  await writeFile(join(dir, 'output', 'r-b-soul', 'neo.wav'), bytes);

  const parts = [];
  let offset = 0;
  for (;;) {
    const slice = await run({ genre: 'R&B / Soul', name: 'neo.wav', offset });
    assert.equal(slice.totalBytes, bytes.length);
    assert.ok(slice.bytes <= CHUNK_BYTES);
    // Base64 of a slice must fit in the coordinator's 1 MB body cap.
    assert.ok(JSON.stringify(slice).length < 1_000_000);
    parts.push(Buffer.from(slice.data, 'base64'));
    offset += slice.bytes;
    if (offset >= slice.totalBytes) break;
  }
  assert.equal(parts.length, 3);
  assert.ok(Buffer.concat(parts).equals(bytes));
});

test('a missing track or an offset past the end is refused', async (t) => {
  const dir = await root(t);
  await mkdir(join(dir, 'output', 'electronic'), { recursive: true });
  await writeFile(join(dir, 'output', 'electronic', 'x.wav'), 'RIFF');
  await assert.rejects(run({ genre: 'Electronic', name: 'nope.wav' }), /no track/);
  await assert.rejects(run({ genre: 'Electronic', name: 'x.wav', offset: 5 }), /past the end/);
});

test('it is offered wherever tracks are kept, generator or not', async (t) => {
  const dir = await root(t);
  assert.match(available().reason, /no music output directory/);
  await mkdir(join(dir, 'output'));
  assert.deepEqual(available(), { ok: true });
  assert.equal(new HandlerRegistry([]).add(audio).registered, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as audio from '../src/agent/handlers/alpha-music-audio.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';

const { CHUNK_BYTES, available, run, validateRequest } = audio;
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

async function root(t) {
  const names = ['ALPHA_MUSIC_ROOT', 'ALPHA_MUSIC_OUTPUT', 'ALPHA_MUSIC_FFMPEG'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  delete process.env.ALPHA_MUSIC_FFMPEG;
  delete process.env.ALPHA_MUSIC_OUTPUT;
  const dir = await mkdtemp(join(tmpdir(), 'music-audio-'));
  process.env.ALPHA_MUSIC_ROOT = dir;
  return dir;
}

test('the payload names a genre and a file, never a path', () => {
  assert.deepEqual(validateRequest({ genre: 'Electronic', name: 'a.wav' }), { genre: 'Electronic', name: 'a.wav', offset: 0, format: 'original' });
  assert.equal(validateRequest({ genre: 'Electronic', name: 'a.wav', format: 'mp3' }).format, 'mp3');
  assert.throws(() => validateRequest({ genre: 'Electronic', name: 'a.wav', format: 'exe' }), /"format"/);
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

/** A second of 16-bit mono 32 kHz WAV: a tone, so the encoder has something to encode. */
function toneWav(seconds) {
  const rate = 32_000;
  const samples = rate * seconds;
  const out = Buffer.alloc(44 + samples * 2);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + samples * 2, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) out.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 440) / rate) * 12_000), 44 + i * 2);
  return out;
}

async function reassemble(payload) {
  const parts = [];
  let offset = 0;
  let last;
  for (;;) {
    last = await run({ ...payload, offset });
    parts.push(Buffer.from(last.data, 'base64'));
    offset += last.bytes;
    if (offset >= last.totalBytes) break;
  }
  return { bytes: Buffer.concat(parts), last };
}

test('asked for MP3, a WAV is encoded once and sent much smaller', { skip: !ffmpeg && 'no ffmpeg' }, async (t) => {
  const dir = await root(t);
  await mkdir(join(dir, 'output', 'electronic'), { recursive: true });
  const wavPath = join(dir, 'output', 'electronic', 'tone.wav');
  const wav = toneWav(20);
  await writeFile(wavPath, wav);

  const { bytes, last } = await reassemble({ genre: 'Electronic', name: 'tone.wav', format: 'mp3' });
  assert.equal(last.format, 'mp3');
  assert.equal(last.name, 'tone.mp3');
  assert.equal(last.source, 'tone.wav');
  assert.ok(bytes.length < wav.length / 3, `${bytes.length} bytes of MP3 for ${wav.length} of WAV`);
  // An MP3 starts with an ID3 tag or a frame sync.
  assert.ok(bytes.subarray(0, 3).toString() === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));
  const copy = join(dir, 'output', '.compressed', 'electronic', 'tone.mp3');
  assert.ok(bytes.equals(await readFile(copy)));
  assert.ok((await readFile(wavPath)).equals(wav), 'the original is left as the generator wrote it');

  // Not re-encoded while the WAV is unchanged; re-encoded once it is newer.
  const encodedAt = (await stat(copy)).mtimeMs;
  await run({ genre: 'Electronic', name: 'tone.wav', format: 'mp3' });
  assert.equal((await stat(copy)).mtimeMs, encodedAt);
  const later = new Date(encodedAt + 60_000);
  await utimes(wavPath, later, later);
  await run({ genre: 'Electronic', name: 'tone.wav', format: 'mp3' });
  assert.ok((await stat(copy)).mtimeMs > encodedAt);
});

test('with no encoder, or one that fails, the original is sent', async (t) => {
  const dir = await root(t);
  await mkdir(join(dir, 'output', 'electronic'), { recursive: true });
  const wav = toneWav(1);
  await writeFile(join(dir, 'output', 'electronic', 'tone.wav'), wav);

  for (const setting of ['off', join(dir, 'no-such-ffmpeg'), process.execPath]) {
    // node itself stands in for an ffmpeg that exits with an error.
    process.env.ALPHA_MUSIC_FFMPEG = setting;
    const { bytes, last } = await reassemble({ genre: 'Electronic', name: 'tone.wav', format: 'mp3' });
    assert.equal(last.format, 'original', setting);
    assert.equal(last.name, 'tone.wav');
    assert.ok(bytes.equals(wav), setting);
  }
  // A track that is already compressed is sent as it is.
  await writeFile(join(dir, 'output', 'electronic', 'song.mp3'), 'ID3fake');
  delete process.env.ALPHA_MUSIC_FFMPEG;
  const { last } = await reassemble({ genre: 'Electronic', name: 'song.mp3', format: 'mp3' });
  assert.equal(last.format, 'original');
});

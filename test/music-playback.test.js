// Playing a track back: the paths that made "a lot of songs" in the playlist
// unplayable on 2026-10-06. A track the queue had forgotten, a machine busy
// making another song, a download longer than the request that asked for it,
// and WAVs ten times the size they needed to cross the tunnel at.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHost } from '../src/host/server.js';
import { fetchJson } from '../src/common/http.js';
import { PROTOCOL_VERSION, ProtocolError } from '../src/common/protocol.js';
import { TunnelAgent } from '../src/agent/agent.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';
import * as musicAudio from '../src/agent/handlers/alpha-music-audio.js';
import { createMusicBridge } from '../src/bridge/music.js';

const TOKEN = 'test-token-that-is-long-enough';
const SETTINGS = { genre: 'Electronic', subgenre: 'Rollers', bpm: 174, key: 'F minor', vocals: false, seed: 7, durationSec: 20 };
const { CHUNK_BYTES } = musicAudio;
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A music output folder for the agent, and the environment pointing at it. */
async function musicRoot(t) {
  const names = ['ALPHA_MUSIC_ROOT', 'ALPHA_MUSIC_OUTPUT', 'ALPHA_MUSIC_FFMPEG'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  for (const name of names) delete process.env[name];
  const root = await mkdtemp(join(tmpdir(), 'music-playback-'));
  await mkdir(join(root, 'output', 'electronic'), { recursive: true });
  process.env.ALPHA_MUSIC_ROOT = root;
  return root;
}

async function startHost(t) {
  const host = createHost({ token: TOKEN });
  const url = await listen(host.server);
  t.after(() => host.close());
  return { ...host, url };
}

async function startBridge(t, hostUrl, options = {}) {
  const cacheDir = options.cacheDir ?? (await mkdtemp(join(tmpdir(), 'music-cache-')));
  const { server } = createMusicBridge({ hostUrl, token: TOKEN, pollMs: 20, compress: false, ...options, cacheDir });
  const url = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url, cacheDir };
}

async function startAgent(t, hostUrl, extraHandlers = [], options = {}) {
  const handlers = new HandlerRegistry([]);
  for (const handler of [musicAudio, ...extraHandlers]) assert.equal(handlers.add(handler).registered, true);
  const agent = new TunnelAgent({ hostUrl, token: TOKEN, name: 'music-box', handlers, pollWaitMs: 500, ...options });
  const running = agent.start();
  t.after(async () => {
    await agent.stop({ drainMs: 0 });
    await running;
  });
  return agent;
}

/** A track as alpha.music leaves it on the machine that made it. */
async function writeTrack(root, name, bytes) {
  const path = join(root, 'output', 'electronic', name);
  await writeFile(path, bytes);
  return path;
}

function patterned(length) {
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
  return bytes;
}

/** Seconds of a 16-bit mono 32 kHz WAV tone, MusicGen's own format. */
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

/** A finished generation the queue no longer holds: only its receipt is left. */
function recordReceipt(host, { id = 'task_gone', name = 'gone.wav', bytes = 1, agentName = 'music-box' } = {}) {
  host.receipts.record(
    {
      id,
      type: 'alpha.music',
      status: 'succeeded',
      attempts: 1,
      createdAt: 1_000,
      finishedAt: 2_000,
      result: { recipe: SETTINGS, outputs: [{ name: name.replace(/\.\w+$/, '.json'), bytes: 100 }, { name, path: `C:\\music\\${name}`, bytes }] },
    },
    { agentName },
  );
  return id;
}

const sliceTasks = (host) => host.queue.list({}).filter((task) => task.type === 'alpha.music.audio');

async function play(bridge, id, init) {
  const response = await fetch(`${bridge}/music/tasks/${id}/audio`, init);
  const body = Buffer.from(await response.arrayBuffer());
  return { status: response.status, type: response.headers.get('content-type'), body };
}

test('a track the queue has forgotten still plays, from its receipt', async (t) => {
  const root = await musicRoot(t);
  const track = patterned(CHUNK_BYTES + 99);
  await writeTrack(root, 'gone.wav', track);
  const host = await startHost(t);
  const { url: bridge } = await startBridge(t, host.url);
  await startAgent(t, host.url);
  const id = recordReceipt(host, { bytes: track.length });
  assert.equal(host.queue.get(id), null, 'the queue has let it go');

  const view = await (await fetch(`${bridge}/music/tasks/${id}`)).json();
  assert.equal(view.status, 'succeeded');
  assert.equal(view.playback, 'ready');
  assert.equal(view.agent, 'music-box');
  assert.deepEqual(view.recipe, SETTINGS);
  assert.doesNotMatch(JSON.stringify(view), /C:\\\\music/);

  const played = await play(bridge, id);
  assert.equal(played.status, 200);
  assert.ok(played.body.equals(track));
  assert.ok(sliceTasks(host).every((task) => task.targetAgent === 'music-box'));

  // Not a way round the music-only rule: a receipt of another type stays unknown.
  host.receipts.record({ id: 'task_codex', type: 'codex.exec', status: 'succeeded', result: { outputs: [{ name: 'x.wav' }] } }, { agentName: 'music-box' });
  assert.equal((await fetch(`${bridge}/music/tasks/task_codex/audio`)).status, 404);
  assert.equal((await fetch(`${bridge}/music/tasks/task_never`)).status, 404);
});

test('a track queued without a machine is played from the machine its receipt names', async (t) => {
  const root = await musicRoot(t);
  const track = patterned(4_000);
  await writeTrack(root, 'loose.wav', track);
  const host = await startHost(t);
  const { url: bridge } = await startBridge(t, host.url);
  await startAgent(t, host.url);

  const task = host.queue.enqueue({ type: 'alpha.music', payload: SETTINGS, leaseMs: 60_000, maxAttempts: 1, minMemoryMB: 0, targetAgent: null });
  Object.assign(task, { status: 'succeeded', result: { recipe: SETTINGS, outputs: [{ name: 'loose.wav', bytes: track.length }] } });
  recordReceipt(host, { id: task.id, name: 'loose.wav', bytes: track.length });

  const view = await (await fetch(`${bridge}/music/tasks/${task.id}`)).json();
  assert.equal(view.playback, 'ready');
  assert.equal(view.agent, 'music-box');
  const played = await play(bridge, task.id);
  assert.equal(played.status, 200);
  assert.ok(played.body.equals(track));
});

test('a machine busy making a song still sends the slices of one it made before', async (t) => {
  const root = await musicRoot(t);
  const track = patterned(CHUNK_BYTES * 2 + 5);
  await writeTrack(root, 'earlier.wav', track);
  const host = await startHost(t);
  const { url: bridge } = await startBridge(t, host.url);

  // A song that takes as long as the test needs it to.
  let finish;
  const generating = new Promise((resolve) => {
    finish = resolve;
  });
  t.after(() => finish());
  const slowMusic = { type: 'alpha.music', run: async () => { await generating; return { recipe: SETTINGS, outputs: [] }; } };
  await startAgent(t, host.url, [slowMusic]);

  const song = host.queue.enqueue({ type: 'alpha.music', payload: SETTINGS, leaseMs: 600_000, maxAttempts: 1, minMemoryMB: 0, targetAgent: 'music-box' });
  const second = host.queue.enqueue({ type: 'alpha.music', payload: SETTINGS, leaseMs: 600_000, maxAttempts: 1, minMemoryMB: 0, targetAgent: 'music-box' });
  for (let i = 0; i < 100 && host.queue.get(song.id).status !== 'leased'; i++) await sleep(20);
  assert.equal(host.queue.get(song.id).status, 'leased');

  const id = recordReceipt(host, { id: 'task_earlier', name: 'earlier.wav', bytes: track.length });
  const played = await play(bridge, id);
  assert.equal(played.status, 200);
  assert.ok(played.body.equals(track));
  assert.equal(sliceTasks(host).length, 3);
  assert.equal(host.queue.get(song.id).status, 'leased', 'the song was still being made the whole time');
  assert.equal(host.queue.get(second.id).status, 'queued', 'the express lane takes slices only, never a second song');
});

test('a slow download answers still_fetching, goes on, and the next play gets the track', async (t) => {
  const root = await musicRoot(t);
  const track = patterned(CHUNK_BYTES * 2 + 5);
  await writeTrack(root, 'long.wav', track);
  const host = await startHost(t);
  const { url: bridge } = await startBridge(t, host.url, { holdMs: 50 });
  // A machine that takes its time over every slice.
  const slowSlices = { ...musicAudio, run: async (payload) => { await sleep(150); return musicAudio.run(payload); } };
  const handlers = new HandlerRegistry([]);
  handlers.register(slowSlices);
  const slow = new TunnelAgent({ hostUrl: host.url, token: TOKEN, name: 'slow-box', handlers, pollWaitMs: 500 });
  const running = slow.start();
  t.after(async () => {
    await slow.stop({ drainMs: 0 });
    await running;
  });
  const id = recordReceipt(host, { id: 'task_long', name: 'long.wav', bytes: track.length, agentName: 'slow-box' });

  const first = await fetch(`${bridge}/music/tasks/${id}/audio`);
  assert.equal(first.status, 503);
  assert.equal(first.headers.get('retry-after'), '5');
  const said = await first.json();
  assert.equal(said.error, 'still_fetching');
  assert.match(said.message, /slow-box/);

  let played;
  for (let i = 0; i < 100; i++) {
    played = await play(bridge, id);
    if (played.status === 200) break;
    await sleep(50);
  }
  assert.equal(played.status, 200);
  assert.ok(played.body.equals(track));
  assert.equal(sliceTasks(host).length, 3, 'asking again joined the download rather than starting another');
});

test('a download cut short carries on from where it stopped', async (t) => {
  const root = await musicRoot(t);
  const track = patterned(CHUNK_BYTES * 2 + 5);
  const path = await writeTrack(root, 'resumed.wav', track);
  const host = await startHost(t);
  const { url: bridge, cacheDir } = await startBridge(t, host.url);
  await startAgent(t, host.url);
  const id = recordReceipt(host, { id: 'task_resumed', name: 'resumed.wav', bytes: track.length });

  // What an earlier, interrupted play left: the first slice and what it is part of.
  const { mtimeMs } = await stat(path);
  await writeFile(join(cacheDir, `${id}-resumed.wav.part`), track.subarray(0, CHUNK_BYTES));
  await writeFile(
    join(cacheDir, `${id}-resumed.wav.part.json`),
    JSON.stringify({ identity: `resumed.wav:${track.length}:${Math.trunc(mtimeMs)}`, compressed: false }),
  );

  const played = await play(bridge, id);
  assert.equal(played.status, 200);
  assert.ok(played.body.equals(track));
  assert.deepEqual(sliceTasks(host).map((task) => task.payload.offset).sort((a, b) => a - b), [CHUNK_BYTES, CHUNK_BYTES * 2]);
});

test('a part left by a different version of the file is thrown away, not stitched', async (t) => {
  const root = await musicRoot(t);
  const track = patterned(CHUNK_BYTES + 5);
  await writeTrack(root, 'changed.wav', track);
  const host = await startHost(t);
  const { url: bridge, cacheDir } = await startBridge(t, host.url);
  await startAgent(t, host.url);
  const id = recordReceipt(host, { id: 'task_changed', name: 'changed.wav', bytes: track.length });
  await writeFile(join(cacheDir, `${id}-changed.wav.part`), Buffer.alloc(CHUNK_BYTES, 1));
  await writeFile(join(cacheDir, `${id}-changed.wav.part.json`), JSON.stringify({ identity: 'changed.wav:1:1', compressed: false }));

  const played = await play(bridge, id);
  assert.equal(played.status, 200);
  assert.ok(played.body.equals(track));
});

test('tracks cross the tunnel as MP3 when the machine has ffmpeg', { skip: !ffmpeg && 'no ffmpeg' }, async (t) => {
  const root = await musicRoot(t);
  const wav = toneWav(20);
  await writeTrack(root, 'tone.wav', wav);
  const host = await startHost(t);
  const { url: bridge, cacheDir } = await startBridge(t, host.url, { compress: true });
  await startAgent(t, host.url);
  const id = recordReceipt(host, { id: 'task_tone', name: 'tone.wav', bytes: wav.length });

  const played = await play(bridge, id);
  assert.equal(played.status, 200);
  assert.equal(played.type, 'audio/mpeg');
  assert.ok(played.body.equals(await readFile(join(root, 'output', '.compressed', 'electronic', 'tone.mp3'))));
  assert.ok(played.body.length < wav.length / 3);
  assert.equal(sliceTasks(host).length, 1, `a ${wav.length}-byte WAV took one slice as MP3, not ${Math.ceil(wav.length / CHUNK_BYTES)}`);
  assert.ok(sliceTasks(host).every((task) => task.payload.format === 'mp3'));

  // The next play comes from the bridge's cache, under the MP3's name.
  assert.equal((await play(bridge, id)).type, 'audio/mpeg');
  assert.equal(sliceTasks(host).length, 1);
  assert.ok((await stat(join(cacheDir, `${id}-tone.mp3`))).size > 0);
});

test('a machine from before MP3 is asked again for the original', async (t) => {
  const root = await musicRoot(t);
  const track = patterned(3_000);
  await writeTrack(root, 'old.wav', track);
  const host = await startHost(t);
  const { url: bridge } = await startBridge(t, host.url, { compress: true });
  // What an agent from before `format` answers.
  const oldSlices = {
    ...musicAudio,
    run: (payload) => {
      if ('format' in payload) throw new ProtocolError('unknown key(s) "format"; this takes genre, name, offset');
      return musicAudio.run(payload);
    },
  };
  const handlers = new HandlerRegistry([]);
  handlers.register(oldSlices);
  const agent = new TunnelAgent({ hostUrl: host.url, token: TOKEN, name: 'music-box', handlers, pollWaitMs: 500 });
  const running = agent.start();
  t.after(async () => {
    await agent.stop({ drainMs: 0 });
    await running;
  });
  const id = recordReceipt(host, { id: 'task_old', name: 'old.wav', bytes: track.length });

  const played = await play(bridge, id);
  assert.equal(played.status, 200);
  assert.equal(played.type, 'audio/wav');
  assert.ok(played.body.equals(track));
});

test('a poll may narrow itself to some of its capabilities, never widen past them', async (t) => {
  const host = await startHost(t);
  const { body: registered } = await fetchJson(`${host.url}/agent/register`, {
    method: 'POST',
    token: TOKEN,
    body: { protocolVersion: PROTOCOL_VERSION, name: 'narrow', capabilities: ['echo', 'alpha.music.audio'] },
  });
  assert.ok(registered.features.includes('poll-types'));
  const echo = host.queue.enqueue({ type: 'echo', payload: {}, leaseMs: 60_000, maxAttempts: 1, minMemoryMB: 0, targetAgent: null });
  host.queue.enqueue({ type: 'codex.exec', payload: {}, leaseMs: 60_000, maxAttempts: 1, minMemoryMB: 0, targetAgent: null });

  const next = (query) => fetchJson(`${host.url}/agent/${registered.agentId}/tasks/next?wait=0${query}`, { token: TOKEN });
  assert.equal((await next('&types=alpha.music.audio')).status, 204, 'echo is not what this poll asked for');
  assert.equal((await next('&types=codex.exec')).status, 204, 'a type the agent never registered stays out of reach');
  const { body } = await next('');
  assert.equal(body.id, echo.id);
});

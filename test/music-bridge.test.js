// The Generate button's backend, against a real coordinator and a real agent
// running the real generator in its dry-run mode: click to WAV, with nothing
// mocked but the model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHost } from '../src/host/server.js';
import { TunnelAgent } from '../src/agent/agent.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';
import * as music from '../src/agent/handlers/alpha-music.js';
import * as musicAudio from '../src/agent/handlers/alpha-music-audio.js';
import { createMusicBridge, describeTask } from '../src/bridge/music.js';

const TOKEN = 'test-token-that-is-long-enough';
const REPO = join(import.meta.dirname, '..');
const SETTINGS = { genre: 'Electronic', subgenre: 'Rollers', key: 'F minor', vocals: false, seed: 7, durationSec: 2 };

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

async function startHost(t) {
  const host = createHost({ token: TOKEN });
  const url = await listen(host.server);
  t.after(() => host.close());
  return { ...host, url };
}

async function startBridge(t, hostUrl, options = {}) {
  const { server } = createMusicBridge({ hostUrl, token: TOKEN, ...options });
  const url = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return url;
}

async function post(url, body) {
  const response = await fetch(`${url}/music/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function get(url, path) {
  const response = await fetch(`${url}${path}`);
  return { status: response.status, body: await response.json() };
}

test('a click queues alpha.music with the lease and machine from the bridge, not the request', async (t) => {
  const host = await startHost(t);
  const bridge = await startBridge(t, host.url, { targetAgent: 'laptop41', leaseMs: 123_000 });

  const { status, body } = await post(bridge, { ...SETTINGS, bpm: 172 });
  assert.equal(status, 202);
  assert.deepEqual(body.recipe, { ...SETTINGS, bpm: 172 });
  assert.equal(body.agentAvailable, false);
  assert.equal(body.targetAgent, 'laptop41');
  assert.equal(body.targetAttached, false);

  const task = host.queue.get(body.taskId);
  assert.equal(task.type, 'alpha.music');
  assert.equal(task.leaseMs, 123_000);
  assert.equal(task.targetAgent, 'laptop41');
  assert.deepEqual(task.payload, { ...SETTINGS, bpm: 172 });
});

test('bad settings are refused with the reason, and nothing is queued', async (t) => {
  const host = await startHost(t);
  const bridge = await startBridge(t, host.url);

  for (const [body, reason] of [
    [{ ...SETTINGS, genre: 'Polka' }, /unknown genre/],
    [{ ...SETTINGS, type: 'codex.exec' }, /unknown setting.*type/],
    [{ ...SETTINGS, leaseMs: 1 }, /unknown setting.*leaseMs/],
    ['{not json', /not valid JSON/],
  ]) {
    const response = await post(bridge, body);
    assert.equal(response.status, 400);
    assert.match(response.body.message, reason);
  }
  assert.equal(host.queue.stats().total, 0);
});

test('vocals are left for the generating machine to accept or refuse', async (t) => {
  const host = await startHost(t);
  const bridge = await startBridge(t, host.url);
  const { status, body } = await post(bridge, { ...SETTINGS, vocals: true });
  assert.equal(status, 202);
  assert.equal(body.recipe.vocals, true);
});

test('the bridge reads back music tasks only', async (t) => {
  const host = await startHost(t);
  const bridge = await startBridge(t, host.url);
  const other = host.queue.enqueue({ type: 'codex.exec', payload: { prompt: 'secret' }, leaseMs: 60_000, maxAttempts: 1, minMemoryMB: 0, targetAgent: null });

  assert.equal((await get(bridge, `/music/tasks/${other.id}`)).status, 404);
  assert.equal((await get(bridge, '/music/tasks/nope')).status, 404);
  assert.equal((await get(bridge, '/music/tasks/..%2Fagents')).status, 400);
  assert.equal((await get(bridge, '/tasks')).status, 404);
});

test('a refused bridge key is reported as the bridge\'s problem', async (t) => {
  const host = await startHost(t);
  const bridge = await startBridge(t, host.url, { token: 'wrong-token-that-is-long-enough' });
  const { status, body } = await post(bridge, SETTINGS);
  assert.equal(status, 502);
  assert.equal(body.error, 'bridge_key_rejected');
});

test('an unreachable coordinator is a 502, not a hang or a crash', async (t) => {
  const bridge = await startBridge(t, 'http://127.0.0.1:1');
  const { status, body } = await post(bridge, SETTINGS);
  assert.equal(status, 502);
  assert.equal(body.error, 'coordinator_unreachable');
});

test('no CORS header: another origin cannot queue work through the bridge', async (t) => {
  const host = await startHost(t);
  const bridge = await startBridge(t, host.url);
  const { headers } = await post(bridge, SETTINGS);
  assert.equal(headers.get('access-control-allow-origin'), null);
});

test('playback is refused with the reason before a track exists, or with no music machine', async (t) => {
  const host = await startHost(t);
  const untargeted = await startBridge(t, host.url);
  const { body } = await post(untargeted, SETTINGS);
  let response = await get(untargeted, `/music/tasks/${body.taskId}/audio`);
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'not_ready');

  const task = host.queue.get(body.taskId);
  Object.assign(task, { status: 'succeeded', result: { recipe: SETTINGS, outputs: [{ name: 'x.wav', bytes: 4 }] } });
  response = await get(untargeted, `/music/tasks/${body.taskId}/audio`);
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'no_music_machine');
  assert.equal((await get(untargeted, `/music/tasks/${body.taskId}`)).body.playback, 'no_music_machine');

  Object.assign(task, { result: { recipe: SETTINGS, outputs: [{ name: '../../auth.json', bytes: 4 }] } });
  assert.equal((await get(untargeted, `/music/tasks/${body.taskId}/audio`)).body.error, 'no_audio');
});

test('task status names outputs but not paths on the generating machine', () => {
  const view = describeTask({
    id: 't1',
    status: 'succeeded',
    attempts: 1,
    agentId: 'a1',
    payload: SETTINGS,
    result: { recipe: SETTINGS, bpmTypical: true, outputs: [{ name: 'x.wav', path: 'C:\\Users\\me\\x.wav', bytes: 10 }], generatedInMs: 5 },
    error: null,
  });
  assert.equal(view.done, true);
  assert.deepEqual(view.outputs, [{ name: 'x.wav', bytes: 10 }]);
  assert.equal(view.agent, null, 'an untargeted task names no machine rather than a registration id');
  assert.equal(describeTask({ id: 't2', status: 'leased', attempts: 1, agentId: 'agent_x', targetAgent: 'laptop41' }).agent, 'laptop41');
});

const python = ['python3', 'python'].find((name) => spawnSync(name, ['--version']).status === 0);

test('click to WAV to playback: bridge, coordinator, agent and the real generator', { skip: !python && 'no Python 3' }, async (t) => {
  const saved = Object.fromEntries(
    ['ALPHA_MUSIC_ROOT', 'ALPHA_MUSIC_PYTHON', 'ALPHA_MUSIC_DRY_RUN', 'ALPHA_MUSIC_SCRIPT', 'ALPHA_MUSIC_OUTPUT', 'ALPHA_MUSIC_VOCALS'].map((name) => [name, process.env[name]]),
  );
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const root = await mkdtemp(join(tmpdir(), 'music-bridge-'));
  await mkdir(join(root, 'scripts'));
  await copyFile(join(REPO, 'scripts', 'generate_music.py'), join(root, 'scripts', 'generate_music.py'));
  for (const name of ['ALPHA_MUSIC_SCRIPT', 'ALPHA_MUSIC_OUTPUT', 'ALPHA_MUSIC_VOCALS']) delete process.env[name];
  process.env.ALPHA_MUSIC_ROOT = root;
  process.env.ALPHA_MUSIC_PYTHON = python;
  process.env.ALPHA_MUSIC_DRY_RUN = '1';

  const host = await startHost(t);
  const cacheDir = await mkdtemp(join(tmpdir(), 'music-cache-'));
  const bridge = await startBridge(t, host.url, { targetAgent: 'music-box', cacheDir, pollMs: 20 });
  await mkdir(join(root, 'output'));
  const handlers = new HandlerRegistry([]);
  assert.equal(handlers.add(music).registered, true);
  assert.equal(handlers.add(musicAudio).registered, true);
  const agent = new TunnelAgent({ hostUrl: host.url, token: TOKEN, name: 'music-box', handlers, pollWaitMs: 500 });
  const running = agent.start();
  t.after(async () => {
    await agent.stop({ drainMs: 0 });
    await running;
  });

  // 20 s of dry-run audio is 640 KB: more than one slice.
  const { body: queued } = await post(bridge, { ...SETTINGS, durationSec: 20 });
  let view;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    view = (await get(bridge, `/music/tasks/${queued.taskId}`)).body;
    if (view.done) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(view.status, 'succeeded', JSON.stringify(view.error));
  assert.deepEqual(view.recipe, { ...SETTINGS, durationSec: 20, bpm: 174 });
  assert.deepEqual(
    view.outputs.map((output) => output.name),
    ['rollers_174bpm_f-minor_seed7_20s.json', 'rollers_174bpm_f-minor_seed7_20s.wav'],
  );
  assert.equal(view.playback, 'ready');

  // Playback: the bridge brings the track across in slices and serves it.
  const original = await readFile(join(root, 'output', 'electronic', 'rollers_174bpm_f-minor_seed7_20s.wav'));
  const played = await fetch(`${bridge}/music/tasks/${queued.taskId}/audio`);
  assert.equal(played.status, 200);
  assert.equal(played.headers.get('content-type'), 'audio/wav');
  assert.equal(played.headers.get('accept-ranges'), 'bytes');
  assert.ok(Buffer.from(await played.arrayBuffer()).equals(original), 'served track differs from the one on the machine');
  const slices = host.queue.list({}).filter((task) => task.type === 'alpha.music.audio');
  assert.equal(slices.length, 2);
  assert.ok(slices.every((task) => task.targetAgent === 'music-box' && task.status === 'succeeded'));

  // Seeking asks for a range; a second play comes from the cache, not the tunnel.
  const ranged = await fetch(`${bridge}/music/tasks/${queued.taskId}/audio`, { headers: { range: 'bytes=100-199' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 100-199/${original.length}`);
  assert.ok(Buffer.from(await ranged.arrayBuffer()).equals(original.subarray(100, 200)));
  assert.equal(host.queue.list({}).filter((task) => task.type === 'alpha.music.audio').length, 2, 'a replay re-fetched over the tunnel');
  assert.deepEqual(await readdir(cacheDir), [`${queued.taskId}-rollers_174bpm_f-minor_seed7_20s.wav`]);
});

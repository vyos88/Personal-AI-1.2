// The Generate button's backend, against a real coordinator and a real agent
// running the real generator in its dry-run mode: click to WAV, with nothing
// mocked but the model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHost } from '../src/host/server.js';
import { AuthService } from '../src/host/auth/service.js';
import { AuthStore } from '../src/host/auth/store.js';
import { fetchJson } from '../src/common/http.js';
import { TunnelAgent } from '../src/agent/agent.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';
import * as music from '../src/agent/handlers/alpha-music.js';
import * as musicAudio from '../src/agent/handlers/alpha-music-audio.js';
import {
  createMusicBridge, describeReceipt, describeTask, musicPool, pickMusicMachine,
} from '../src/bridge/music.js';

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

const finishedMusic = (over = {}) => ({
  id: 'task_music',
  type: 'alpha.music',
  status: 'succeeded',
  agentId: 'agent_secret',
  attempts: 1,
  declines: 0,
  createdAt: 1_000,
  finishedAt: 5_000,
  error: null,
  result: {
    recipe: SETTINGS,
    outputs: [{ name: 'track.wav', path: 'C:\\Users\\someone\\music\\track.wav', bytes: 4_096 }],
    stats: { engine: 'facebook/musicgen-small on cpu', generatedInMs: 4_000 },
    stdout: 'generator chatter',
  },
  ...over,
});

test('the recipe book is the ledger\'s music receipts, and only what the panel needs', async (t) => {
  const host = await startHost(t);
  const bridge = await startBridge(t, host.url);
  host.receipts.record(finishedMusic({ id: 'task_old' }), { agentName: 'laptop41' });
  host.receipts.record(
    { ...finishedMusic(), id: 'task_codex', type: 'codex.exec', result: { recipe: { prompt: 'secret' } } },
    { agentName: 'laptop41' },
  );
  host.receipts.record(
    finishedMusic({ id: 'task_new', status: 'failed', result: null, error: { message: 'boom', code: 'x' } }),
    { agentName: 'alpha-host' },
  );

  const { status, body } = await get(bridge, '/music/recipes');
  assert.equal(status, 200);
  assert.deepEqual(body.recipes, [
    { taskId: 'task_new', status: 'failed', recipe: null, agent: 'alpha-host', outputs: [], engine: null, createdAt: 1_000, finishedAt: 5_000, durationMs: 4_000 },
    {
      taskId: 'task_old',
      status: 'succeeded',
      recipe: SETTINGS,
      agent: 'laptop41',
      outputs: [{ name: 'track.wav', bytes: 4_096 }],
      // What ran it: a machine on cpu and one on cuda are twenty minutes apart.
      engine: 'facebook/musicgen-small on cpu',
      createdAt: 1_000,
      finishedAt: 5_000,
      durationMs: 4_000,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(body), /someone|agent_secret|secret|chatter/);

  assert.equal((await get(bridge, '/music/recipes?limit=1')).body.recipes.length, 1);
  for (const bad of ['0', '201', 'abc', '1.5']) {
    const refused = await get(bridge, `/music/recipes?limit=${bad}`);
    assert.equal(refused.status, 400, bad);
    assert.equal(refused.body.error, 'bad_limit');
  }
});

test('the fleet line lists music machines only, by name, idle time and work in hand', async (t) => {
  const host = await startHost(t);
  const bridge = await startBridge(t, host.url);
  const laptop = host.registry.register({ name: 'laptop41', capabilities: ['alpha.music', 'alpha.music.audio'], remoteAddress: '100.64.0.9', userId: 'user_x' });
  host.registry.register({ name: 'render-box', capabilities: ['alpha.render', 'echo'], remoteAddress: '100.64.0.10' });
  host.registry.admit(laptop.id, { type: 'alpha.music', minMemoryMB: 0 });

  const { status, body } = await get(bridge, '/music/fleet');
  assert.equal(status, 200);
  assert.equal(body.machines.length, 1);
  const [machine] = body.machines;
  assert.equal(machine.name, 'laptop41');
  assert.equal(machine.inFlight, 1);
  assert.ok(Number.isFinite(machine.idleMs) && machine.idleMs >= 0);
  // Whatever else the registry reports, only these fields cross the bridge
  // (`stale` once the registry reports one).
  for (const key of Object.keys(machine)) assert.ok(['name', 'idleMs', 'inFlight', 'stale'].includes(key), key);
  assert.doesNotMatch(JSON.stringify(body), /100\.64|user_x|agent_|render-box|alpha\.render/);
});

test('a bridge key without agents:read loses the fleet line, and only that', async (t) => {
  const BOOTSTRAP = 'bootstrap-token-long-enough-for-tests';
  const auth = new AuthService({ store: new AuthStore({ path: null }), bootstrapToken: BOOTSTRAP });
  await auth.load();
  const host = createHost({ auth });
  const url = await listen(host.server);
  t.after(() => host.close());

  const { body: invite } = await fetchJson(`${url}/invites`, { method: 'POST', token: BOOTSTRAP, body: { email: 'o@example.test', scopes: 'admin' } });
  await fetchJson(`${url}/invites/redeem`, { method: 'POST', body: { token: invite.token, password: 'a-perfectly-fine-password' } });
  const { body: users } = await fetchJson(`${url}/users`, { token: BOOTSTRAP });
  const { body: key } = await fetchJson(`${url}/keys`, {
    method: 'POST',
    token: BOOTSTRAP,
    body: { userId: users.users[0].id, scopes: ['tasks:read', 'tasks:write'], name: 'music-bridge' },
  });
  host.receipts.record(finishedMusic(), { agentName: 'laptop41' });

  const bridge = await startBridge(t, url, { token: key.token });
  const fleet = await get(bridge, '/music/fleet');
  assert.equal(fleet.status, 502);
  assert.equal(fleet.body.error, 'bridge_key_rejected');
  assert.match(fleet.body.message, /agents:read/);

  const recipes = await get(bridge, '/music/recipes');
  assert.equal(recipes.status, 200);
  assert.equal(recipes.body.recipes.length, 1);
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

// Worker1 timed out at 721s twice on 2026-10-06 while the Host made a track in
// 38s, and nothing the bridge passed on said what either of them ran it on.
test('both views say what made the track, and nothing if the result does not', () => {
  const result = {
    recipe: SETTINGS,
    outputs: [{ name: 'x.wav', path: 'C:\\Users\\me\\x.wav', bytes: 10 }],
    generatedInMs: 5,
    stats: { engine: 'facebook/musicgen-small on cuda', generatedInMs: 5 },
  };
  const view = describeTask({ id: 't3', status: 'succeeded', attempts: 1, payload: SETTINGS, result });
  assert.equal(view.engine, 'facebook/musicgen-small on cuda');
  assert.equal(describeTask({ id: 't4', status: 'queued', attempts: 0, payload: SETTINGS }).engine, null);

  // The receipt is the half that survives a restart, and a trimmed result
  // keeps `stats` while dropping the stdout the engine used to travel in.
  assert.equal(describeReceipt({ id: 't3', status: 'succeeded', stats: result.stats }).engine,
    'facebook/musicgen-small on cuda');
  assert.equal(describeReceipt({ id: 't5', status: 'failed' }).engine, null);
});

async function post2(url, path, body) {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('removing vocals is refused before a track exists, with no music machine, or on someone else\'s task', async (t) => {
  const host = await startHost(t);
  const bridge = await startBridge(t, host.url);

  const { body: queued } = await post(bridge, SETTINGS);
  let response = await post2(bridge, `/music/tasks/${queued.taskId}/remove-vocals`);
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'not_ready');

  const task = host.queue.get(queued.taskId);
  Object.assign(task, { status: 'succeeded', result: { recipe: SETTINGS, outputs: [{ name: 'x.wav', bytes: 4 }] } });
  response = await post2(bridge, `/music/tasks/${queued.taskId}/remove-vocals`);
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'no_music_machine');

  const other = host.queue.enqueue({ type: 'codex.exec', payload: { prompt: 'secret' }, leaseMs: 60_000, maxAttempts: 1, minMemoryMB: 0, targetAgent: null });
  assert.equal((await post2(bridge, `/music/tasks/${other.id}/remove-vocals`)).status, 404);
  assert.equal((await post2(bridge, '/music/tasks/nope/remove-vocals')).status, 404);
});

test('removing vocals queues alpha.music.stems on the same machine that holds the track', async (t) => {
  const host = await startHost(t);
  const bridge = await startBridge(t, host.url, { leaseMs: 300_000 });

  const { body: queued } = await post(bridge, SETTINGS);
  const task = host.queue.get(queued.taskId);
  Object.assign(task, {
    status: 'succeeded',
    targetAgent: 'music-box',
    result: { recipe: SETTINGS, outputs: [{ name: 'track.wav', bytes: 4 }] },
  });

  const { status, body } = await post2(bridge, `/music/tasks/${queued.taskId}/remove-vocals`);
  assert.equal(status, 202);
  assert.equal(body.targetAgent, 'music-box');

  const stemsTask = host.queue.get(body.taskId);
  assert.equal(stemsTask.type, 'alpha.music.stems');
  assert.equal(stemsTask.targetAgent, 'music-box');
  assert.equal(stemsTask.leaseMs, 300_000);
  assert.deepEqual(stemsTask.payload, { genre: 'Electronic', name: 'track.wav' });

  // The bridge now reads the stems task back too, through the same GET route.
  assert.equal((await get(bridge, `/music/tasks/${body.taskId}`)).status, 200);
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
  // An older cached track, to be evicted when the cache is full.
  const stale = join(cacheDir, 'task_old-older.wav');
  await writeFile(stale, 'RIFF');
  await utimes(stale, new Date(0), new Date(0));
  const bridge = await startBridge(t, host.url, { targetAgent: 'music-box', cacheDir, pollMs: 20, cacheMaxTracks: 1 });
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
  assert.deepEqual(await readdir(cacheDir), [`${queued.taskId}-rollers_174bpm_f-minor_seed7_20s.wav`], 'the full cache kept the new track and evicted the old one');
});

// Both laptops make music: each track goes to the least busy one, and is
// pinned there, because playback fetches the file from the machine that made it.
test('a pool spreads tracks over the music machines and pins each one', async (t) => {
  const host = await startHost(t);
  const bridge = await startBridge(t, host.url, { targetAgent: 'auto' });
  const worker = host.registry.register({ name: 'worker1', capabilities: ['alpha.music', 'alpha.music.audio'], remoteAddress: '100.64.0.9' });
  host.registry.register({ name: 'host', capabilities: ['alpha.music', 'alpha.music.audio'], remoteAddress: '100.64.0.10' });
  host.registry.register({ name: 'render-box', capabilities: ['alpha.render'], remoteAddress: '100.64.0.11' });
  host.registry.admit(worker.id, { type: 'alpha.music', minMemoryMB: 0 });

  const first = await post(bridge, SETTINGS);
  assert.equal(first.status, 202);
  assert.equal(host.queue.get(first.body.taskId).targetAgent, 'host', 'worker1 is busy, so host gets it');
  assert.equal(first.body.targetAgent, 'host');
});

test('a named pool is kept to, and a pool with nobody attached still queues', async (t) => {
  const host = await startHost(t);
  host.registry.register({ name: 'stranger', capabilities: ['alpha.music'], remoteAddress: '100.64.0.12' });
  const named = await startBridge(t, host.url, { targetAgent: 'worker1, host' });
  const r = await post(named, SETTINGS);
  assert.equal(r.status, 202);
  assert.equal(host.queue.get(r.body.taskId).targetAgent, 'worker1', 'nobody named is attached: the first name, never a stranger');
});

test('choosing a music machine', () => {
  assert.equal(musicPool('auto'), 'auto');
  assert.equal(musicPool('AUTO'), 'auto');
  assert.deepEqual(musicPool('worker1, host'), ['worker1', 'host']);
  assert.equal(musicPool('worker1'), null);
  assert.equal(musicPool(null), null);
  const agents = [
    { name: 'a', capabilities: ['alpha.music'], inFlight: 1, idleMs: 9 },
    { name: 'b', capabilities: ['alpha.music'], inFlight: 0, idleMs: 1 },
    { name: 'c', capabilities: ['alpha.music'], inFlight: 0, idleMs: 5 },
    { name: 'd', capabilities: ['alpha.music'], inFlight: 0, idleMs: 99, stale: true },
    { name: 'e', capabilities: ['echo'], inFlight: 0, idleMs: 99 },
  ];
  assert.equal(pickMusicMachine(agents, 'auto'), 'c', 'least busy, then idle longest; never stale or non-music');
  assert.equal(pickMusicMachine(agents, ['a', 'b']), 'b');
  assert.equal(pickMusicMachine(agents, ['e']), null);
  assert.equal(pickMusicMachine(undefined, 'auto'), null);
});

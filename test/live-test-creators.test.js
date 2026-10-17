import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'live-test-creators.mjs');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]).toString('base64');
// A real 16-bit mono WAV: `seconds` long, a tone unless `silent`.
function wav({ seconds = 5, silent = false, rate = 8000 } = {}) {
  const n = Math.round(rate * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  if (!silent) for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(12000 * Math.sin(i / 5)), 44 + i * 2);
  return b;
}

// As the music handler reports them: sorted by name, so the sidecar first.
const OUTPUTS = [{ name: 'rollers_seed1000_5s.json', bytes: 511 }, { name: 'rollers_seed1000_5s.wav', bytes: 80044 }];

// Stand-ins for the two bridges: two machines, and each new job goes to the
// one with less in hand, the way the real bridges pick.
function fakeBridges({ failImage = false, stuckMusic = false, track = wav(), playlist = true } = {}) {
  const tasks = new Map();
  const load = { worker1: 0, host: 0 };
  const pick = () => (load.worker1 <= load.host ? 'worker1' : 'host');
  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (req.url === '/music/healthz') return send(res, 200, { ok: true });
      if (req.url === '/music/fleet') return send(res, 200, { machines: [{ name: 'worker1' }, { name: 'host' }] });
      if (req.url === '/music/generate') {
        const id = `t${tasks.size + 1}`; const machine = pick(); load[machine]++;
        tasks.set(id, { machine, polls: 0 });
        return send(res, 202, { taskId: id, status: 'queued', targetAgent: machine });
      }
      const audio = /^\/music\/tasks\/(t\d+)\/audio$/.exec(req.url);
      if (audio) { res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(track); }
      if (req.url.startsWith('/music/recipes')) {
        const recipes = playlist ? [...tasks.keys()].map((id) => ({ taskId: id, status: 'succeeded', outputs: OUTPUTS })) : [];
        return send(res, 200, { recipes });
      }
      const task = /^\/music\/tasks\/(t\d+)$/.exec(req.url);
      if (task) {
        const t = tasks.get(task[1]); t.polls++;
        const done = !stuckMusic && t.polls > 1;
        return send(res, 200, {
          taskId: task[1], status: done ? 'succeeded' : 'running', done, agent: t.machine, outputs: OUTPUTS,
          // The real bridge passes this on from the result's `stats`.
          engine: `facebook/musicgen-small on ${t.machine === 'host' ? 'cuda' : 'cpu'}`,
        });
      }
      if (req.url === '/sdapi/v1/sd-models') return send(res, 200, [{ title: 'alpha-tunnel (worker1, host)' }]);
      if (req.url === '/sdapi/v1/txt2img') {
        if (failImage) return send(res, 503, { error: 'no_image_machine' });
        const machine = pick(); load[machine]++;
        // Longer than the live test's 4 s stagger, as a real render is.
        return setTimeout(() => { load[machine]--; send(res, 200, { images: [PNG], info: JSON.stringify({ machine, backend: machine === 'host' ? 'comfyui' : 'a1111' }) }); }, 6000);
      }
      send(res, 404, { detail: 'Not Found' });
    });
  });
  return server;
}

// A stand-in for Alpha's renderer (alpha_video_creator.py): writes an MP4
// header to --output and prints its JSON line, as the real one does.
function fakeRenderer({ fail = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-renderer-'));
  const file = join(dir, 'render.mjs');
  writeFileSync(file, fail
    ? "console.error('ffmpeg not found'); process.exit(2);\n"
    : "import { writeFileSync } from 'node:fs';\nconst a = process.argv; const out = a[a.indexOf('--output') + 1];\n" +
      "if (!a.includes('--audio')) { console.error('no audio'); process.exit(3); }\n" +
      "writeFileSync(out, Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from('ftypisom'), Buffer.alloc(64)]));\n" +
      "console.log(JSON.stringify({ output: out, frames: 144 }));\n");
  return file;
}

async function runAgainst(server, extra = []) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, '--music', url, '--image', url, '--site', url, '--count', '2', ...extra]);
    let text = '';
    p.stdout.on('data', (d) => { text += d; });
    p.stderr.on('data', (d) => { text += d; });
    p.on('close', (code) => resolve({ code, text }));
  });
  server.close();
  return out;
}

test('the live test makes tracks and images and says which machine made each', { timeout: 120_000 }, async () => {
  const { code, text } = await runAgainst(fakeBridges());
  assert.equal(code, 0, text);
  assert.match(text, /ok: the site .* routes \/music to the music bridge/);
  assert.match(text, /ok: track 1 made by worker1 \(facebook\/musicgen-small on cpu\) in \d+s, rollers_seed1000_5s\.wav 80044 bytes, plays \(WAV, 5\.0s, 8000 Hz mono, peak -\d+ dBFS\)/);
  assert.doesNotMatch(text, /511 bytes/);
  assert.match(text, /ok: track t1 is in the playlist \(\/music\/recipes\), rollers_seed1000_5s\.wav/);
  assert.match(text, /playlist: 1\/1 worked/);
  assert.match(text, /ok: track 2 made by host \(facebook\/musicgen-small on cuda\) in \d+s/);
  // Worker1 timed out at 721s twice on 2026-10-06 while the Host made one in
  // 38s, and the report gave the seconds with nothing to read them against.
  assert.match(text, /ok: track 1 made by worker1 \(facebook\/musicgen-small on cpu\) in \d+s/);
  assert.match(text, /ok: image 1 made by worker1 \(a1111\) .* PNG/);
  assert.match(text, /ok: image 2 made by host \(comfyui\)/);
  assert.match(text, /music: 2\/2 worked; by machine: worker1 x1, host x1 \(work was shared\)/);
  assert.match(text, /image: 2\/2 worked; by machine: worker1 x1, host x1 \(work was shared\)/);
  assert.match(text, /video: skipped/);
});

test('the reel is made from the generated images and track, by Alpha\'s renderer', { timeout: 120_000 }, async () => {
  const { code, text } = await runAgainst(fakeBridges(), ['--video-python', process.execPath, '--video-script', fakeRenderer()]);
  assert.equal(code, 0, text);
  assert.match(text, /ok: reel made in \d+s from 2 image\(s\) with the generated track, \d+ bytes, MP4/);
  assert.match(text, /video: 1\/1 worked/);
});

test('a renderer that fails fails the live test, with its last line', { timeout: 120_000 }, async () => {
  const { code, text } = await runAgainst(fakeBridges(), ['--video-python', process.execPath, '--video-script', fakeRenderer({ fail: true })]);
  assert.equal(code, 1);
  assert.match(text, /PROBLEM: reel made in \d+s .*: ffmpeg not found/);
});

test('a failed creator fails the live test, with the reason', { timeout: 120_000 }, async () => {
  const { code, text } = await runAgainst(fakeBridges({ failImage: true }), ['--only', 'image']);
  assert.equal(code, 1);
  assert.match(text, /PROBLEM: image 1: HTTP 503 no_image_machine/);
});

// 2026-10-06, Worker1: one track that never finished was waited on for 25 min,
// and the run's 45-minute limit stopped it before images or the reel.
test('stuck tracks share one deadline, and images are still tested', { timeout: 120_000 }, async () => {
  const { code, text } = await runAgainst(fakeBridges({ stuckMusic: true }), ['--music-timeout-min', '0.1']);
  assert.equal(code, 1);
  assert.equal((text.match(/PROBLEM: track \d on \w+: timed out while running/g) || []).length, 2, text);
  assert.match(text, /ok: image 1 made by/);
  assert.match(text, /ok: image 2 made by/);
});

// 2026-10-06: every track was reported as "511 bytes, plays (WAV)" from a
// 12-byte header check. Silence and a cut-short file must now fail.
test('a silent track fails the live test', { timeout: 120_000 }, async () => {
  const { code, text } = await runAgainst(fakeBridges({ track: wav({ silent: true }) }), ['--only', 'music']);
  assert.equal(code, 1);
  assert.match(text, /PROBLEM: track 1 made by \w+ \(facebook\/musicgen-small on cpu\) in \d+s, rollers_seed1000_5s\.wav \d+ bytes, the audio is silent/);
});

test('a track much shorter than asked for fails the live test', { timeout: 120_000 }, async () => {
  const { code, text } = await runAgainst(fakeBridges({ track: wav({ seconds: 1 }) }), ['--only', 'music']);
  assert.equal(code, 1);
  assert.match(text, /only 1\.0s of audio \(asked for 5s\)/);
});

test('a track missing from the playlist fails the live test', { timeout: 120_000 }, async () => {
  const { code, text } = await runAgainst(fakeBridges({ playlist: false }), ['--only', 'music', '--count', '1']);
  assert.equal(code, 1);
  assert.match(text, /ok: track 1 made by .* plays \(WAV/);
  assert.match(text, /PROBLEM: track t1 plays but is not in the playlist/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'promo-reel.mjs');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]).toString('base64');
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(4000)]);

// Both bridges in one: images fail for the scenes listed in failScenes (both
// attempts), music succeeds unless noMusic.
function fakeBridges({ failScenes = [], noMusic = false } = {}) {
  const seen = { prompts: [], music: null };
  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (req.url === '/music/generate') {
        if (noMusic) return send(res, 503, { message: 'no music machine' });
        seen.music = JSON.parse(raw);
        return send(res, 202, { taskId: 't1', targetAgent: 'host' });
      }
      if (req.url === '/music/tasks/t1') return send(res, 200, { done: true, status: 'succeeded', agent: 'host' });
      if (req.url === '/music/tasks/t1/audio') { res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(WAV); }
      if (req.url === '/sdapi/v1/txt2img') {
        const body = JSON.parse(raw);
        seen.prompts.push(body);
        const scene = new Set(seen.prompts.map((p) => p.prompt)).size; // 1-based, retries share a prompt
        if (failScenes.includes(scene)) return send(res, 503, { error: 'no_image_machine' });
        return send(res, 200, { images: [PNG], info: JSON.stringify({ machine: 'host', backend: 'comfyui' }) });
      }
      send(res, 404, { detail: 'Not Found' });
    });
  });
  return { server, seen };
}

// Stands in for alpha_video_creator.py: records its arguments, writes an MP4 header.
function fakeRenderer({ fail = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-renderer-'));
  const file = join(dir, 'render.mjs');
  writeFileSync(file, fail
    ? "console.error('ffmpeg not found'); process.exit(2);\n"
    : "import { writeFileSync } from 'node:fs';\nconst a = process.argv; const out = a[a.indexOf('--output') + 1];\n" +
      "writeFileSync(out + '.args.json', JSON.stringify(a.slice(2)));\n" +
      "writeFileSync(out, Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from('ftypisom'), Buffer.alloc(2048)]));\n");
  return file;
}

async function run(server, extra = []) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, '--music', url, '--image', url, ...extra]);
    let text = '';
    p.stdout.on('data', (d) => { text += d; });
    p.stderr.on('data', (d) => { text += d; });
    p.on('close', (code) => resolve({ code, text }));
  });
  server.close();
  return out;
}

test('the reel is made from six scenes and its own track, captioned, high quality, into Alpha\'s video folder', { timeout: 60_000 }, async () => {
  const outDir = join(mkdtempSync(join(tmpdir(), 'videos-')), 'generated', 'videos');
  const { server, seen } = fakeBridges();
  const { code, text } = await run(server, ['--video-python', process.execPath, '--video-script', fakeRenderer(), '--out-dir', outDir, '--name', 'alpha-promo-reel-test']);
  assert.equal(code, 0, text);
  assert.equal(seen.prompts.length, 6);
  assert.ok(seen.prompts.every((p) => p.width === 512 && p.height === 768 && /text/.test(p.negative_prompt)));
  assert.deepEqual({ ...seen.music, seed: undefined }, { genre: 'Electronic', subgenre: 'Synthwave', bpm: 110, key: 'A minor', vocals: false, seed: undefined, durationSec: 25 });
  const file = join(outDir, 'alpha-promo-reel-test.mp4');
  assert.ok(existsSync(file));
  const args = JSON.parse(readFileSync(`${file}.args.json`, 'utf8'));
  assert.equal(args[args.indexOf('--quality') + 1], 'high');
  assert.equal(args[args.indexOf('--duration') + 1], '25');
  assert.ok(args.includes('--audio'));
  const captions = JSON.parse(args[args.indexOf('--captions-json') + 1]);
  assert.equal(captions.length, 6);
  assert.match(captions[0], /Meet Alpha/);
  assert.match(text, /ok: reel rendered in \d+s from 6 scenes with its own track/);
  assert.match(text, /done: in Alpha, open the Video Creator, "Open a saved Alpha video", type alpha-promo-reel-test\.mp4/);
});

test('a failed scene is left out with its caption, and no track means a silent reel, said so', { timeout: 60_000 }, async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'videos-'));
  const { server } = fakeBridges({ failScenes: [2], noMusic: true });
  const { code, text } = await run(server, ['--video-python', process.execPath, '--video-script', fakeRenderer(), '--out-dir', outDir, '--name', 'r']);
  assert.equal(code, 0, text);
  assert.match(text, /PROBLEM: scene 2 attempt 2: HTTP 503 no_image_machine/);
  assert.match(text, /note: no track, so the reel is silent/);
  const args = JSON.parse(readFileSync(join(outDir, 'r.mp4.args.json'), 'utf8'));
  const captions = JSON.parse(args[args.indexOf('--captions-json') + 1]);
  assert.equal(captions.length, 5);
  assert.ok(!captions.some((c) => /Runs on your own machines/.test(c)));
  assert.ok(!args.includes('--audio'));
});

test('too few scenes, or a failing renderer, is a failure with the reason', { timeout: 60_000 }, async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'videos-'));
  let r = await run(fakeBridges({ failScenes: [1, 2, 3] }).server, ['--video-python', process.execPath, '--video-script', fakeRenderer(), '--out-dir', outDir]);
  assert.equal(r.code, 1);
  assert.match(r.text, /PROBLEM: only 3 of 6 scenes made, too few for a reel/);
  r = await run(fakeBridges().server, ['--video-python', process.execPath, '--video-script', fakeRenderer({ fail: true }), '--out-dir', outDir]);
  assert.equal(r.code, 1);
  assert.match(r.text, /PROBLEM: the renderer did not make the reel .*: ffmpeg not found/);
});

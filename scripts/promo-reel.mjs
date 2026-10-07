#!/usr/bin/env node
/**
 * promo-reel.mjs - make a short vertical reel about Alpha, with Alpha's own
 * creators, and save it where Alpha's Video Creator can open it.
 *
 * The owner asked (2026-10-07) for "a reel about Alpha so I can post it, where
 * you show the best qualities of Alpha AI". This makes it on the machine that
 * serves Alpha, the way the live test makes its reel:
 *   1. one image per scene through the image bridge (least busy machine),
 *   2. one instrumental track through the music bridge,
 *   3. Alpha's renderer (alpha_video_creator.py, with the backend's Python)
 *      puts them together at high quality, one caption per scene,
 *   4. the MP4 goes into Alpha's generated-videos folder, the one
 *      /video/chat-artifact/<name> serves, so Video Creator > "Open a saved
 *      Alpha video" plays it and "Download MP4" gives the file to post.
 *
 * A scene whose image fails is left out; under 4 scenes there is no reel. A
 * track that fails leaves the reel silent (said so) rather than no reel.
 * Exit 0 only when a playable MP4 is saved.
 *
 *   node scripts/promo-reel.mjs --video-python PY --video-script SCRIPT --out-dir DIR
 *        [--seconds 25] [--image-width 512] [--image-height 768] [--image-steps 28]
 *        [--music URL] [--image URL] [--music-timeout-min 20] [--name alpha-promo-reel-<stamp>]
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const num = (name, fallback, lo, hi) => { const v = Number(arg(name, fallback)); return Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : fallback)); };

const seconds = Math.round(num('seconds', 25, 6, 30));
const imageWidth = num('image-width', 512, 256, 1024) & ~7;
const imageHeight = num('image-height', 768, 256, 1024) & ~7;
const imageSteps = Math.round(num('image-steps', 28, 4, 50));
const musicTimeoutMs = num('music-timeout-min', 20, 0.05, 60) * 60_000;
// 2026-10-07: the first run lost 4 of 6 scenes in a few minutes while the
// Host's ComfyUI was coming back (a 504, then the bridge refusing): more
// tries, spaced out, ride over a restart instead of giving up.
const imageAttempts = Math.round(num('image-attempts', 4, 1, 8));
const retryWaitMs = num('retry-wait-s', 30, 0, 300) * 1000;
const musicUrl = arg('music', 'http://127.0.0.1:8790').replace(/\/+$/, '');
const imageUrl = arg('image', 'http://127.0.0.1:7861').replace(/\/+$/, '');
const videoPython = arg('video-python', '');
const videoScript = arg('video-script', '');
const outDir = arg('out-dir', '');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
const name = String(arg('name', `alpha-promo-reel-${stamp}`)).replace(/[^A-Za-z0-9._-]/g, '-').replace(/\.mp4$/i, '') + '.mp4';

// Each caption says something Alpha really does on the owner's laptops. The
// pictures carry no text: Stable Diffusion cannot spell, the captions do it.
const STYLE = 'cinematic, sleek dark tech aesthetic, deep navy and electric cyan, soft volumetric glow, ultra detailed, sharp focus, vertical composition';
const SCENES = [
  { prompt: 'a glowing spherical AI core awakening in a dark room, light rays, particles', caption: 'Meet Alpha - your own AI.' },
  { prompt: 'two laptops side by side on a desk at night, streams of light flowing between their screens', caption: 'Runs on your own machines. Your data stays home.' },
  { prompt: 'a music waveform transforming into colorful abstract album art, neon light trails', caption: 'Makes music, images and video.' },
  { prompt: 'a holographic neural network map with pulsing glowing connections, futuristic control room', caption: 'Live decks show everything it is doing.' },
  { prompt: 'a glowing shield with a spark of light repairing a broken circuit line, digital energy', caption: 'Watches itself and fixes itself, day and night.' },
  { prompt: 'a futuristic city skyline at night under a huge glowing abstract emblem in the sky', caption: 'Alpha AI - alpha-ai.uk' },
];
const NEGATIVE = 'text, letters, words, watermark, logo text, signature, blurry, lowres, jpeg artifacts, deformed, ugly, people, faces';

const say = (line) => console.log(line);
const work = mkdtempSync(join(tmpdir(), 'alpha-promo-reel-'));

async function json(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body, text };
}

async function waitFor(check, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await check(); if (v) return v; } catch { /* retry */ }
    await sleep(3000);
  }
  return null;
}

async function makeImage(scene, i) {
  for (let attempt = 1; attempt <= imageAttempts; attempt++) {
    if (attempt > 1 && retryWaitMs) await sleep(retryWaitMs * (attempt - 1));
    const t0 = Date.now();
    const body = { prompt: `${scene.prompt}, ${STYLE}`, negative_prompt: NEGATIVE, width: imageWidth, height: imageHeight, steps: imageSteps, seed: 7100 + i * 13 + attempt, cfg_scale: 7 };
    let r;
    try { r = await json(`${imageUrl}/sdapi/v1/txt2img`, { method: 'POST', body: JSON.stringify(body) }); } catch (e) { r = { status: 0, body: null, text: e.message }; }
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    if (r.status === 200) {
      let info = {};
      try { info = JSON.parse(r.body.info || '{}'); } catch { /* keep {} */ }
      const png = Buffer.from(r.body.images?.[0] || '', 'base64');
      if (png.length > 8 && png.subarray(1, 4).toString() === 'PNG') {
        const file = join(work, `scene-${i + 1}.png`);
        writeFileSync(file, png);
        say(`ok: scene ${i + 1} image made by ${info.machine || '?'} (${info.backend || '?'}) in ${secs}s, ${png.length} bytes`);
        return file;
      }
      say(`PROBLEM: scene ${i + 1} attempt ${attempt}: not a PNG`);
    } else {
      say(`PROBLEM: scene ${i + 1} attempt ${attempt}: HTTP ${r.status} ${r.body?.error || ''} ${r.body?.message || String(r.text || '').slice(0, 120)}`);
    }
  }
  return null;
}

async function makeTrack() {
  const settings = { genre: 'Electronic', subgenre: 'Synthwave', bpm: 110, key: 'A minor', vocals: false, seed: 7007, durationSec: seconds };
  const t0 = Date.now();
  let q;
  try { q = await json(`${musicUrl}/music/generate`, { method: 'POST', body: JSON.stringify(settings) }); } catch (e) { say(`PROBLEM: music bridge does not answer at ${musicUrl}: ${e.message}`); return null; }
  if (q.status !== 202) { say(`PROBLEM: track not queued: HTTP ${q.status} ${q.body?.message || q.text.slice(0, 120)}`); return null; }
  const id = q.body.taskId;
  const done = await waitFor(async () => { const s = await json(`${musicUrl}/music/tasks/${id}`); return s.body?.done ? s.body : null; }, musicTimeoutMs);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (!done || done.status !== 'succeeded') { say(`PROBLEM: track ${done ? `${done.status}: ${done.error?.message || done.error || ''}` : 'timed out'} (${secs}s)`); return null; }
  const full = await fetch(`${musicUrl}/music/tasks/${id}/audio`);
  const bytes = full.ok ? Buffer.from(await full.arrayBuffer()) : Buffer.alloc(0);
  const format = bytes.subarray(0, 4).toString() === 'RIFF' ? 'wav' : (bytes.subarray(0, 3).toString() === 'ID3' || bytes[0] === 0xff) ? 'mp3' : '';
  if (!format || bytes.length < 1024) { say(`PROBLEM: track ${id} could not be fetched as audio (HTTP ${full.status}, ${bytes.length} bytes)`); return null; }
  const file = join(work, `track.${format}`);
  writeFileSync(file, bytes);
  say(`ok: ${seconds}s synthwave track made by ${done.agent || q.body.targetAgent || '?'} in ${secs}s, ${bytes.length} bytes (${format.toUpperCase()})`);
  return file;
}

function render(images, captions, track, out) {
  const args = [videoScript, '--images', ...images, '--output', out, '--duration', String(seconds), '--fps', '30', '--width', '608', '--height', '1080',
    '--captions-json', JSON.stringify(captions), '--engine', 'fast', '--quality', 'high', '--transition', 'fade', '--camera', 'auto',
    ...(track ? ['--audio', track] : [])];
  return new Promise((resolveRun) => {
    const p = spawn(videoPython, args);
    let text = '';
    p.stdout.on('data', (d) => { text += d; });
    p.stderr.on('data', (d) => { text += d; });
    const kill = setTimeout(() => p.kill(), 20 * 60_000);
    p.on('close', (code) => { clearTimeout(kill); resolveRun({ code, text }); });
    p.on('error', (e) => { clearTimeout(kill); resolveRun({ code: -1, text: e.message }); });
  });
}

function isMp4(file) {
  if (!existsSync(file) || statSync(file).size < 1024) return false;
  const head = Buffer.alloc(12);
  const fd = openSync(file, 'r'); readSync(fd, head, 0, 12, 0); closeSync(fd);
  return head.subarray(4, 8).toString() === 'ftyp';
}

async function main() {
  if (!videoPython || !videoScript || !outDir) { say('PROBLEM: needs --video-python, --video-script and --out-dir (run it through the autopilot on the machine that serves Alpha)'); return 1; }
  if (!existsSync(videoScript)) { say(`PROBLEM: Alpha's video renderer is not at ${videoScript}`); return 1; }
  say(`making ${name}: ${SCENES.length} scenes, ${seconds}s, 608x1080, high quality`);

  // The track takes longest; it runs while the images are made.
  const trackJob = makeTrack();
  const images = [];
  const captions = [];
  for (const [i, scene] of SCENES.entries()) {
    const file = await makeImage(scene, i);
    if (file) { images.push(file); captions.push(scene.caption); }
  }
  const track = await trackJob;
  if (images.length < 4) { say(`PROBLEM: only ${images.length} of ${SCENES.length} scenes made, too few for a reel`); return 1; }
  if (!track) say('note: no track, so the reel is silent; add music when you post it');

  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, name);
  const t0 = Date.now();
  const r = await render(images, captions, track, out);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (r.code !== 0 || !isMp4(out)) {
    say(`PROBLEM: the renderer did not make the reel (${secs}s): ${r.text.trim().split('\n').slice(-1)[0] || `exit ${r.code}`}`);
    return 1;
  }
  say(`ok: reel rendered in ${secs}s from ${images.length} scenes${track ? ' with its own track' : ' (silent)'}, ${statSync(out).size} bytes, MP4`);
  say(`saved: ${out}`);
  say(`done: in Alpha, open the Video Creator, "Open a saved Alpha video", type ${name}, then "Download MP4" to post it`);
  return 0;
}

process.exit(await main());

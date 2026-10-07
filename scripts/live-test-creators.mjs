#!/usr/bin/env node
/**
 * Live test of Alpha's Music Creator and image creator, on the machine that
 * serves Alpha: real tracks and real images, through the same bridges Alpha
 * uses, and which laptop made each one.
 *
 * The owner asked for both creators to give each job to the least busy
 * machine, and for that to be tested live, not only in unit tests. So this:
 *   1. checks the site routes /music to the music bridge (what the Generate
 *      button needs), and lists the machines each bridge can use;
 *   2. queues --count tracks one after another, a few seconds apart, so the
 *      second sees the first one in hand and goes to the other machine;
 *      waits for each, and reads its audio (a real WAV, or MP3 from #159);
 *   3. does the same for --count images through the image bridge's
 *      AUTOMATIC1111 API, and checks each answer is a PNG;
 *   4. makes a short reel (1080x1920-shaped, 6 s) from those images with the
 *      first track as its soundtrack, through Alpha's own renderer
 *      (--video-script, run by --video-python, the backend's Python), and
 *      checks the result is an MP4. Video is not shared between machines:
 *      Alpha renders one at a time on the machine that serves it.
 * It prints one line per job: machine, seconds, size. Exit 0 only when every
 * job worked; the last line says whether the work was shared.
 *
 *   node scripts/live-test-creators.mjs [--count 2] [--music-seconds 5]
 *        [--image-size 256] [--image-steps 12] [--timeout-min 25] [--music-timeout-min 12]
 *        [--music URL] [--image URL] [--site URL] [--only music|image|video]
 *        [--video-python PATH --video-script PATH]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, openSync, readSync, closeSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { audioOutput, describeAudio, inspectAudio, judgeTrack } from './wav-check.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const count = Math.max(1, Math.min(6, Number(arg('count', 2)) || 2));
const musicSeconds = Math.max(1, Math.min(30, Number(arg('music-seconds', 5)) || 5));
const imageSize = Math.max(64, Math.min(1024, Number(arg('image-size', 256)) || 256)) & ~7;
const imageSteps = Math.max(1, Math.min(40, Number(arg('image-steps', 12)) || 12));
const timeoutMs = Math.max(1, Number(arg('timeout-min', 25)) || 25) * 60_000;
// All tracks share one deadline. A track can never take longer than the
// handler's own 10-minute limit plus fetching it, and on 2026-10-06 one stuck
// track on Worker1 (waited on for 25 min) used up the whole 45-minute run, so
// images and the reel were never tested.
const musicTimeoutMs = Math.max(0.05, Number(arg('music-timeout-min', 12)) || 12) * 60_000;
const musicUrl = arg('music', 'http://127.0.0.1:8790').replace(/\/+$/, '');
const imageUrl = arg('image', 'http://127.0.0.1:7861').replace(/\/+$/, '');
const siteUrl = arg('site', '').replace(/\/+$/, '');
const only = arg('only', '');
const videoPython = arg('video-python', '');
const videoScript = arg('video-script', '');
const work = mkdtempSync(join(tmpdir(), 'alpha-live-test-'));
const made = { images: [], track: null, tracks: [] };

const results = [];
const say = (line) => console.log(line);

async function json(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body, text };
}

async function siteRoutesMusic() {
  // The live site may serve plain HTTP or its own HTTPS; accept either.
  const candidates = siteUrl ? [siteUrl] : ['http://127.0.0.1:4173', 'https://127.0.0.1:4173'];
  for (const base of candidates) {
    try {
      if (base.startsWith('https:')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      const r = await json(`${base}/music/healthz`);
      if (r.body?.ok === true) return `ok: the site (${base}) routes /music to the music bridge`;
      if (r.body?.detail) return `PROBLEM: the site (${base}) sends /music to Alpha's backend, not the bridge (${r.status})`;
      if (r.body?.error) return `PROBLEM: the site (${base}) reaches the bridge route, but: ${r.body.message || r.body.error}`;
    } catch { /* try the next */ }
  }
  return 'note: the site did not answer on port 4173';
}

async function testMusic() {
  let fleet;
  try { fleet = await json(`${musicUrl}/music/fleet`); } catch (e) { say(`PROBLEM: music bridge does not answer at ${musicUrl}: ${e.message}`); results.push({ kind: 'music', ok: false }); return; }
  const names = (fleet.body?.machines || []).map((m) => m.name);
  say(`music machines: ${names.length ? names.join(', ') : 'none attached'}`);
  const jobs = [];
  for (let i = 0; i < count; i++) {
    const settings = { genre: 'Electronic', subgenre: 'Rollers', key: 'F minor', vocals: false, seed: 1000 + i, durationSec: musicSeconds };
    const t0 = Date.now();
    const q = await json(`${musicUrl}/music/generate`, { method: 'POST', body: JSON.stringify(settings) });
    if (q.status !== 202) { say(`PROBLEM: track ${i + 1} not queued: HTTP ${q.status} ${q.body?.message || q.text.slice(0, 120)}`); results.push({ kind: 'music', ok: false }); continue; }
    jobs.push({ i, t0, id: q.body.taskId, machine: q.body.targetAgent });
    // Let it be claimed, so the next pick sees this machine busy.
    if (i < count - 1) await waitFor(async () => (await json(`${musicUrl}/music/tasks/${q.body.taskId}`)).body?.status !== 'queued', 20_000);
  }
  const musicDeadline = Date.now() + musicTimeoutMs;
  for (const job of jobs) {
    const done = await waitFor(async () => {
      const s = await json(`${musicUrl}/music/tasks/${job.id}`);
      return s.body?.done ? s.body : null;
    }, Math.max(1_000, musicDeadline - Date.now()));
    const secs = ((Date.now() - job.t0) / 1000).toFixed(0);
    if (!done || done.status !== 'succeeded') {
      // Where it got stuck: "queued" means the machine never picked it up
      // (its agent was down or restarting), "running" that it was too slow.
      let last = '';
      if (!done) {
        try { last = (await json(`${musicUrl}/music/tasks/${job.id}`)).body?.status || ''; } catch { /* the reason stays "timed out" */ }
      }
      say(`PROBLEM: track ${job.i + 1} on ${job.machine || '?'}: ${done ? `${done.status}: ${done.error?.message || done.error || ''}` : `timed out${last ? ` while ${last}` : ''}`} (${secs}s)`);
      results.push({ kind: 'music', ok: false, machine: job.machine });
      continue;
    }
    // The whole track, judged by its bytes: the size printed before 2026-10-06
    // was the JSON sidecar's (outputs sort by name), and a 12-byte header
    // check passed silence and truncated files alike.
    const machine = done.agent || job.machine;
    const track = audioOutput(done.outputs);
    const full = await fetch(`${musicUrl}/music/tasks/${job.id}/audio`);
    const bytes = full.ok ? Buffer.from(await full.arrayBuffer()) : Buffer.alloc(0);
    // WAV, or MP3 when the music machine has ffmpeg (alpha-tunnel #159).
    const info = inspectAudio(bytes);
    const verdict = full.ok ? judgeTrack(info, musicSeconds) : { ok: false, reason: `the bridge would not play it (HTTP ${full.status})` };
    say(`${verdict.ok ? 'ok' : 'PROBLEM'}: track ${job.i + 1} made by ${machine} in ${secs}s, ${track?.name ?? 'no audio file listed'} ${bytes.length || track?.bytes || '?'} bytes, ` +
      (verdict.ok ? `plays (${describeAudio(info)})` : verdict.reason));
    if (verdict.ok && !made.track) { made.track = join(work, `track-${job.id}.${info.format}`); writeFileSync(made.track, bytes); }
    if (verdict.ok) made.tracks.push(job.id);
    results.push({ kind: 'music', ok: verdict.ok, machine });
  }
  if (made.tracks.length) await checkPlaylist();
}

// The panel's recipe book (Alpha's playlist of made tracks) reads
// /music/recipes: a track that plays but is missing there cannot be found
// again once the page is reloaded.
async function checkPlaylist() {
  let listed = [];
  const ok = await waitFor(async () => {
    const r = await json(`${musicUrl}/music/recipes?limit=50`);
    listed = Array.isArray(r.body?.recipes) ? r.body.recipes : [];
    return made.tracks.every((id) => listed.some((row) => row.taskId === id && audioOutput(row.outputs)));
  }, 30_000);
  for (const id of made.tracks) {
    const row = listed.find((x) => x.taskId === id);
    if (row && audioOutput(row.outputs)) say(`ok: track ${id} is in the playlist (/music/recipes), ${audioOutput(row.outputs).name}`);
    else say(`PROBLEM: track ${id} plays but is not in the playlist (/music/recipes${row ? ' lists it without an audio file' : ''})`);
  }
  results.push({ kind: 'playlist', ok: Boolean(ok), machine: 'music bridge' });
}

async function testImages() {
  let models;
  try { models = await json(`${imageUrl}/sdapi/v1/sd-models`); } catch (e) { say(`PROBLEM: image bridge does not answer at ${imageUrl}: ${e.message}`); results.push({ kind: 'image', ok: false }); return; }
  say(`image machines: ${models.status === 200 ? (models.body?.[0]?.title || 'some') : `none (${models.body?.error || models.status})`}`);
  const pending = [];
  for (let i = 0; i < count; i++) {
    const t0 = Date.now();
    const body = { prompt: 'a lighthouse on a cliff at sunset, oil painting', negative_prompt: 'blurry', width: imageSize, height: imageSize, steps: imageSteps, seed: 2000 + i, cfg_scale: 7 };
    pending.push(json(`${imageUrl}/sdapi/v1/txt2img`, { method: 'POST', body: JSON.stringify(body) }).then((r) => ({ i, t0, r })));
    // Two at once on purpose, a few seconds apart: the second should go to the other machine.
    if (i < count - 1) await sleep(4000);
  }
  for (const { i, t0, r } of await Promise.all(pending)) {
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    if (r.status !== 200) { say(`PROBLEM: image ${i + 1}: HTTP ${r.status} ${r.body?.error || ''} ${r.body?.message || r.text.slice(0, 120)}`); results.push({ kind: 'image', ok: false }); continue; }
    let info = {};
    try { info = JSON.parse(r.body.info || '{}'); } catch { /* keep {} */ }
    const png = Buffer.from(r.body.images?.[0] || '', 'base64');
    const ok = png.length > 8 && png.subarray(1, 4).toString() === 'PNG';
    say(`${ok ? 'ok' : 'PROBLEM'}: image ${i + 1} made by ${info.machine || '?'} (${info.backend || '?'}) in ${secs}s, ${png.length} bytes${ok ? ', PNG' : ', not a PNG'}`);
    if (ok) { const file = join(work, `image-${i + 1}.png`); writeFileSync(file, png); made.images.push(file); }
    results.push({ kind: 'image', ok, machine: info.machine });
  }
}

async function testVideo() {
  if (!videoPython || !videoScript) { say('video: skipped (no --video-python and --video-script: run on the machine that serves Alpha)'); return; }
  if (!existsSync(videoScript)) { say(`PROBLEM: Alpha's video renderer is not at ${videoScript}`); results.push({ kind: 'video', ok: false }); return; }
  if (!made.images.length) { say('PROBLEM: no images to make a reel from (the image test made none)'); results.push({ kind: 'video', ok: false }); return; }
  const out = join(work, 'reel.mp4');
  const args = [videoScript, '--images', ...made.images, '--output', out, '--duration', '6', '--fps', '24', '--width', '608', '--height', '1080',
    '--captions-json', JSON.stringify(['Alpha live test']), '--engine', 'fast', '--quality', 'draft', '--transition', 'fade', '--camera', 'auto',
    ...(made.track ? ['--audio', made.track] : [])];
  const t0 = Date.now();
  const r = await new Promise((resolveRun) => {
    const p = spawn(videoPython, args);
    let text = '';
    p.stdout.on('data', (d) => { text += d; });
    p.stderr.on('data', (d) => { text += d; });
    const kill = setTimeout(() => p.kill(), 10 * 60_000);
    p.on('close', (code) => { clearTimeout(kill); resolveRun({ code, text }); });
    p.on('error', (e) => { clearTimeout(kill); resolveRun({ code: -1, text: e.message }); });
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  let mp4 = false;
  let size = 0;
  if (existsSync(out)) {
    size = statSync(out).size;
    const head = Buffer.alloc(12);
    const fd = openSync(out, 'r'); readSync(fd, head, 0, 12, 0); closeSync(fd);
    mp4 = head.subarray(4, 8).toString() === 'ftyp';
  }
  const ok = r.code === 0 && mp4;
  say(`${ok ? 'ok' : 'PROBLEM'}: reel made in ${secs}s from ${made.images.length} image(s)${made.track ? ' with the generated track' : ' (no track)'}, ${size} bytes${ok ? ', MP4' : `: ${r.text.trim().split('\n').slice(-1)[0] || `exit ${r.code}`}`}`);
  results.push({ kind: 'video', ok, machine: 'this machine' });
}

async function waitFor(check, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await check(); if (v) return v; } catch { /* retry */ }
    await sleep(3000);
  }
  return null;
}

say(await siteRoutesMusic());
if (only !== 'image') await testMusic();
if (only !== 'music') await testImages();
if (!only || only === 'video') await testVideo();

for (const kind of ['music', 'playlist', 'image', 'video']) {
  const mine = results.filter((r) => r.kind === kind);
  if (!mine.length) continue;
  const by = {};
  for (const r of mine.filter((x) => x.ok)) by[r.machine || '?'] = (by[r.machine || '?'] || 0) + 1;
  const shared = Object.keys(by).length > 1;
  say(`${kind}: ${mine.filter((r) => r.ok).length}/${mine.length} worked; by machine: ${Object.entries(by).map(([m, n]) => `${m} x${n}`).join(', ') || 'none'}${shared ? ' (work was shared)' : ''}`);
}
process.exit(results.length && results.every((r) => r.ok) ? 0 : 1);

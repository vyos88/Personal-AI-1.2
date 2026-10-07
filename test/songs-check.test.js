import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// scripts/songs-check.ps1 needs PowerShell. Set PWSH to its path, or have
// pwsh on PATH; without it these tests are skipped, not failed.
const PWSH = process.env.PWSH || 'pwsh';
const hasPwsh = !spawnSync(PWSH, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).error;
const skip = hasPwsh ? false : 'PowerShell not found (set PWSH)';
const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'songs-check.ps1');

test('every song gets a line and a verdict, and the totals add up', { skip, timeout: 60_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'songs-check-'));
  const jobs = join(root, 'memory', 'local', 'music-singing');
  const audio = join(root, 'artifacts', 'generated', 'singing');
  mkdirSync(jobs, { recursive: true }); mkdirSync(audio, { recursive: true });
  const song = (n, status, extra = {}) => {
    const id = `00000000-0000-0000-0000-00000000000${n}`;
    writeFileSync(join(jobs, `${id}.json`), JSON.stringify({ id, owner: 'VyoS', status, title: `Song ${n}`, created_at: `2026-10-0${n}T10:00:00`, audio: { duration_sec: 180 }, lyrics: 'never printed', ...extra }));
    return id;
  };
  const a = song(1, 'completed'); writeFileSync(join(audio, `${a}.wav`), 'RIFF'); writeFileSync(join(audio, `${a}.mp3`), 'ID3');
  const b = song(2, 'completed', { hidden: true }); writeFileSync(join(audio, `${b}.wav`), 'RIFF');
  song(3, 'completed');
  const e = song(5, 'completed'); writeFileSync(join(audio, `${e}.mp3`), 'ID3');
  song(4, 'failed');
  writeFileSync(join(jobs, 'broken.json'), '{');
  writeFileSync(join(audio, 'mp3-backfill.json'), JSON.stringify({ at: 'now', ffmpeg: true, converted: 1, failed: 0, waiting: 1, already: 0, total: 2, failures: [] }));

  const r = spawnSync(PWSH, ['-NoProfile', '-File', SCRIPT, '-AlphaRoot', join(root, 'software')], { encoding: 'utf8' });
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 1, 'a finished song without its MP3 is not done yet\n' + out);
  assert.match(out, /2026-10-01 +180s Song 1 .*plays \(MP3\)/);
  assert.match(out, /Song 2 .*plays \(WAV only: MP3 still to be made\) \[hidden\]/);
  assert.match(out, /Song 3 .*cannot play: WAV and MP3 missing/);
  assert.match(out, /Song 5 .*wav none +mp3 .*plays \(MP3\)/, 'a song whose WAV was deleted after its MP3 plays');
  assert.match(out, /Song 4 .*cannot play: failed/);
  assert.match(out, /unreadable receipt/);
  assert.match(out, /TOTAL: 6 song\(s\): 3 can play, 2 of them as MP3, 1 still WAV only; 1 finished but no audio; 1 not finished or failed; 1 unreadable/);
  assert.match(out, /backend MP3 backfill, last pass now: ffmpeg True, made 1/);
  assert.match(out, /memory: 6 files/);
  assert.match(out, /MISSING: .*\.env\.local \(contents not read\)/);
  assert.doesNotMatch(out, /never printed|VyoS/);
});

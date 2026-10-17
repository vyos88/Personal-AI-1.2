import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// scripts/alpha-data-in.ps1 needs PowerShell. Set PWSH to its path, or have
// pwsh on PATH; without it these tests are skipped, not failed.
const PWSH = process.env.PWSH || 'pwsh';
const hasPwsh = !spawnSync(PWSH, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).error;
const skip = hasPwsh ? false : 'PowerShell not found (set PWSH)';
const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'alpha-data-in.ps1');

function put(path, text) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); }
function run(drive, target) {
  const r = spawnSync(PWSH, ['-NoProfile', '-File', SCRIPT, '-Drives', drive, '-Target', target, '-Port', '1'], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}

test('the newest alpha-move folder is copied in, adding only, never a .env file', { skip, timeout: 60_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), 'alpha-data-in-'));
  const drive = join(base, 'D');
  const target = join(base, 'Alpha-Full');
  const src = join(drive, 'alpha-move-20261007');
  put(join(src, 'memory', 'local', 'music-singing', 'a.json'), '{"id":"a"}');
  put(join(src, 'memory', 'knowledge.db'), 'from the drive');
  put(join(src, 'memory', 'kept.txt'), 'older on the drive');
  put(join(src, 'memory', '.env.local'), 'SECRET=never-copied');
  put(join(src, 'artifacts', 'generated', 'singing', 'a.mp3'), 'ID3');
  put(join(drive, 'alpha-move-20260901', 'memory', 'old.txt'), 'older move');
  mkdirSync(join(target, 'software'), { recursive: true });
  put(join(target, 'memory', 'only-here.txt'), 'stays');
  put(join(target, 'memory', 'kept.txt'), 'newer here');
  utimesSync(join(src, 'memory', 'kept.txt'), new Date('2026-01-01'), new Date('2026-01-01'));

  const r = run(drive, target);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /source: .*alpha-move-20261007/);
  assert.match(r.out, /also found \(not used\): .*alpha-move-20260901/);
  assert.equal(readFileSync(join(target, 'memory', 'knowledge.db'), 'utf8'), 'from the drive');
  assert.ok(existsSync(join(target, 'memory', 'local', 'music-singing', 'a.json')));
  assert.ok(existsSync(join(target, 'artifacts', 'generated', 'singing', 'a.mp3')));
  assert.equal(readFileSync(join(target, 'memory', 'only-here.txt'), 'utf8'), 'stays', 'nothing here is deleted');
  assert.equal(readFileSync(join(target, 'memory', 'kept.txt'), 'utf8'), 'newer here', 'a newer file here is not overwritten');
  assert.ok(!existsSync(join(target, 'memory', '.env.local')), '.env files move by hand only');
  assert.ok(!existsSync(join(target, 'memory', 'old.txt')), 'only the newest move is used');
  assert.match(r.out, /memory here now: .* 0 from the drive missing/);
  assert.match(r.out, /MISSING: .*\.env\.local \(contents not read; copied by hand only\)/);
  assert.doesNotMatch(r.out, /never-copied/);
});

test('no drive folder or no clone means nothing is copied', { skip, timeout: 60_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), 'alpha-data-in-'));
  const drive = join(base, 'D');
  mkdirSync(join(drive, 'photos'), { recursive: true });
  const target = join(base, 'Alpha-Full');
  mkdirSync(join(target, 'software'), { recursive: true });
  let r = run(drive, target);
  assert.equal(r.status, 1);
  assert.match(r.out, /no alpha-move-\* folder/);

  put(join(drive, 'alpha-move-20261007', 'memory', 'x.txt'), 'x');
  r = run(drive, join(base, 'not-cloned'));
  assert.equal(r.status, 1);
  assert.match(r.out, /run prepare-alpha-here first/);
  assert.ok(!existsSync(join(base, 'not-cloned', 'memory')));
});

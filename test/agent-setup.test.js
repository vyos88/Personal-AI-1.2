import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// scripts/agent-setup.ps1 needs PowerShell. Set PWSH to its path, or have
// pwsh on PATH; without it these tests are skipped, not failed.
const PWSH = process.env.PWSH || 'pwsh';
const hasPwsh = !spawnSync(PWSH, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).error;
const skip = hasPwsh ? false : 'PowerShell not found (set PWSH)';
const LIB = join(import.meta.dirname, '..', 'scripts', 'agent-setup.ps1');
const ps = (code) => spawnSync(PWSH, ['-NoProfile', '-Command', `. '${LIB}'; ${code}`], { encoding: 'utf8' });

// A service's ALPHA_EXTRA_HANDLERS replaces the file's, so it must carry the
// whole list: the agent's own handlers plus the new ones, never only the new.
test('the handler list is a union, wherever it lives', { skip, timeout: 60_000 }, () => {
  const r = ps(`
    $file = New-Object System.Collections.ArrayList; [void]$file.Add('ALPHA_EXTRA_HANDLERS=alpha-coordination'); [void]$file.Add('ALPHA_AGENT_KEY=k')
    $m = Merge-HandlerLines $file @('alpha-music','alpha-music-audio') @{ ALPHA_MUSIC_ROOT = 'C:\\t' } @()
    $svc = New-Object System.Collections.ArrayList; [void]$svc.Add('ALPHA_HOST_URL=http://h:8787')
    $m2 = Merge-HandlerLines $svc $m @{} @()
    ($file -join '|'); ($svc -join '|')`);
  assert.equal(r.status, 0, r.stderr);
  const [file, svc] = r.stdout.trim().split(/\r?\n/);
  assert.equal(file, 'ALPHA_EXTRA_HANDLERS=alpha-coordination,alpha-music,alpha-music-audio|ALPHA_AGENT_KEY=k|ALPHA_MUSIC_ROOT=C:\\t');
  assert.equal(svc, 'ALPHA_HOST_URL=http://h:8787|ALPHA_EXTRA_HANDLERS=alpha-coordination,alpha-music,alpha-music-audio');
});

// Worker1, 2026-10-06: installing MusicGen into Alpha's own Python lifted
// anyio past FastAPI's pin. The repair reads `pip check` and puts it back.
test('a pin an install broke is put back from pip check', { skip, timeout: 60_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pip-repair-'));
  const log = join(dir, 'calls.log');
  const state = join(dir, 'fixed');
  const fake = join(dir, 'python');
  writeFileSync(fake, `#!/bin/sh
echo "$@" >> '${log}'
if [ "$3" = "check" ]; then
  if [ -f '${state}' ]; then echo "No broken requirements found."; else echo "fastapi 0.104.1 requires anyio<4.0.0,>=3.7.1, but you have anyio 4.15.1."; exit 1; fi
fi
if [ "$3" = "install" ]; then touch '${state}'; fi
exit 0
`);
  chmodSync(fake, 0o755);
  const r = ps(`Repair-PipConflicts '${fake}'`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /putting back 1 requirement\(s\) .*: anyio<4\.0\.0,>=3\.7\.1/);
  assert.match(r.stdout, /requirements are consistent again/);
  assert.match(readFileSync(log, 'utf8'), /-m pip install .*anyio<4\.0\.0,>=3\.7\.1/);
});

test('nothing broken, nothing installed', { skip, timeout: 60_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pip-repair-'));
  const log = join(dir, 'calls.log');
  const fake = join(dir, 'python');
  writeFileSync(fake, `#!/bin/sh\necho "$@" >> '${log}'\necho "No broken requirements found."\n`);
  chmodSync(fake, 0o755);
  const r = ps(`Repair-PipConflicts '${fake}'`);
  assert.match(r.stdout, /has no broken requirements/);
  assert.doesNotMatch(readFileSync(log, 'utf8'), /install/);
});

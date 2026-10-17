import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dirname, '..', 'scripts');
const PWSH = process.env.PWSH || 'pwsh';
const hasPwsh = !spawnSync(PWSH, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).error;

// Windows PowerShell 5.1 drops double quotes inside an argument on its way to
// a native program: `python -c '... "cuda" ...'` reached python as `cuda`, a
// NameError (Host job h02, 2026-10-06). Python one-liners in single-quoted
// PowerShell strings use doubled single quotes instead.
test('no python -c one-liner carries a double quote', () => {
  const bad = [];
  for (const f of readdirSync(DIR).filter((n) => n.endsWith('.ps1'))) {
    readFileSync(join(DIR, f), 'utf8').split(/\r?\n/).forEach((line, i) => {
      for (const m of line.matchAll(/\s-c\s+'((?:[^']|'')*)'/g)) if (m[1].includes('"')) bad.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});

test('the ComfyUI launcher parses and logs its output', { skip: hasPwsh ? false : 'PowerShell not found (set PWSH)' }, () => {
  const r = spawnSync(PWSH, ['-NoProfile', '-Command',
    `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${join(DIR, 'start-comfyui.ps1')}', [ref]$null, [ref]$e); $e.Count`], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '0', r.stderr);
  const text = readFileSync(join(DIR, 'start-comfyui.ps1'), 'utf8');
  assert.match(text, /Add-Content -LiteralPath \$Log/);
  assert.match(readFileSync(join(DIR, 'enable-image.ps1'), 'utf8'), /start-comfyui\.ps1/);
});

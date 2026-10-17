import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// scripts/enable-image.ps1 needs PowerShell. Set PWSH to its path, or have
// pwsh on PATH; without it these tests are skipped, not failed.
const PWSH = process.env.PWSH || 'pwsh';
const hasPwsh = !spawnSync(PWSH, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).error;
const skip = hasPwsh ? false : 'PowerShell not found (set PWSH)';
const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'enable-image.ps1');
const SECRET = 'alpha_key_fedcba9876543210fedcba9876543210';

const run = (repo, ...extra) => spawnSync(PWSH, ['-NoProfile', '-File', SCRIPT, '-Repo', repo, '-SkipInstall', '-NoRestart', ...extra], { encoding: 'utf8' });

test('image handlers join the music ones, with the backend this machine has', { skip, timeout: 120_000 }, () => {
  const repo = mkdtempSync(join(tmpdir(), 'enable-image-'));
  const envFile = join(repo, '.env.agent');
  writeFileSync(envFile, `ALPHA_AGENT_KEY=${SECRET}\nALPHA_EXTRA_HANDLERS=alpha-coordination,alpha-music,alpha-music-audio\n`);

  const a = run(repo, '-Backend', 'a1111');
  assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.doesNotMatch(a.stdout + a.stderr, new RegExp(SECRET.slice(10)));
  let text = readFileSync(envFile, 'utf8');
  assert.match(text, /^ALPHA_EXTRA_HANDLERS=alpha-coordination,alpha-music,alpha-music-audio,alpha-image,alpha-image-file$/m);
  assert.match(text, /^ALPHA_IMAGE_BACKEND=a1111$/m);
  assert.match(text, /^ALPHA_IMAGE_URL=http:\/\/127\.0\.0\.1:7860\/sdapi\/v1\/txt2img$/m);
  assert.match(text, new RegExp(`^ALPHA_AGENT_KEY=${SECRET}$`, 'm'));

  // The Host: ComfyUI instead, and still no duplicate handlers.
  const c = run(repo, '-Backend', 'comfyui');
  assert.equal(c.status, 0, c.stdout + c.stderr);
  text = readFileSync(envFile, 'utf8');
  assert.match(text, /^ALPHA_IMAGE_BACKEND=comfyui$/m);
  assert.match(text, /^ALPHA_COMFYUI_URL=http:\/\/127\.0\.0\.1:8188$/m);
  assert.match(text, /^ALPHA_COMFYUI_CHECKPOINT=v1-5-pruned-emaonly\.safetensors$/m);
  assert.equal((text.match(/alpha-image-file/g) || []).length, 1);
});

test('an unknown backend is refused before anything changes', { skip, timeout: 60_000 }, () => {
  const repo = mkdtempSync(join(tmpdir(), 'enable-image-'));
  const r = run(repo, '-Backend', 'dalle');
  assert.notEqual(r.status, 0);
});

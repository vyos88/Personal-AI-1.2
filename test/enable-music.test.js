import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// scripts/enable-music.ps1 needs PowerShell. Set PWSH to its path, or have
// pwsh on PATH; without it these tests are skipped, not failed.
const PWSH = process.env.PWSH || 'pwsh';
const hasPwsh = !spawnSync(PWSH, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).error;
const skip = hasPwsh ? false : 'PowerShell not found (set PWSH)';
const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'enable-music.ps1');
const SECRET = 'alpha_key_abcdef0123456789abcdef0123456789';

const run = (repo, ...extra) => spawnSync(PWSH, ['-NoProfile', '-File', SCRIPT, '-Repo', repo, '-Python', process.execPath, '-SkipInstall', '-NoRestart', ...extra], { encoding: 'utf8', env: { ...process.env, HF_HOME: '' } });

test('music handlers are added to .env.agent, everything else kept, nothing secret printed', { skip, timeout: 120_000 }, () => {
  const repo = mkdtempSync(join(tmpdir(), 'enable-music-'));
  const envFile = join(repo, '.env.agent');
  writeFileSync(envFile, `ALPHA_HOST_URL=http://100.93.104.24:8787\nALPHA_AGENT_KEY=${SECRET}\nALPHA_EXTRA_HANDLERS=alpha-coordination, memstore\n`);

  const first = run(repo);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.doesNotMatch(first.stdout + first.stderr, new RegExp(SECRET.slice(10)));
  assert.match(first.stdout, /handlers: alpha-coordination, memstore, alpha-music, alpha-music-audio/);
  const text = readFileSync(envFile, 'utf8');
  assert.match(text, new RegExp(`^ALPHA_AGENT_KEY=${SECRET}$`, 'm'), 'the agent key is kept as it was');
  assert.match(text, /^ALPHA_HOST_URL=http:\/\/100\.93\.104\.24:8787$/m);
  assert.match(text, /^ALPHA_EXTRA_HANDLERS=alpha-coordination,memstore,alpha-music,alpha-music-audio$/m);
  assert.match(text, new RegExp(`^ALPHA_MUSIC_ROOT=${repo.replace(/[\\/.]/g, '\\$&')}$`, 'm'));
  assert.match(text, /^ALPHA_MUSIC_PYTHON=.+$/m);
  assert.ok(readdirSync(repo).some((f) => f.startsWith('.env.agent.bak-')), 'backed up first');

  // Again, as a dry run, then for real: no duplicates, and the dry-run flag comes and goes.
  assert.equal(run(repo, '-DryRun').status, 0);
  assert.match(readFileSync(envFile, 'utf8'), /^ALPHA_MUSIC_DRY_RUN=1$/m);
  assert.equal(run(repo).status, 0);
  const after = readFileSync(envFile, 'utf8');
  assert.doesNotMatch(after, /ALPHA_MUSIC_DRY_RUN/);
  assert.equal((after.match(/alpha-music-audio/g) || []).length, 1);
  assert.equal((after.match(/^ALPHA_MUSIC_ROOT=/gm) || []).length, 1);
});

test('a machine without .env.agent gets one with the music settings', { skip, timeout: 60_000 }, () => {
  const repo = mkdtempSync(join(tmpdir(), 'enable-music-'));
  const r = run(repo);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(join(repo, '.env.agent')));
  assert.match(readFileSync(join(repo, '.env.agent'), 'utf8'), /^ALPHA_EXTRA_HANDLERS=alpha-music,alpha-music-audio$/m);
});

// Worker1, 2026-10-06: its agent is a service running as another account, so
// it never saw the model cache enable-music filled, and every track timed out.
test('the agent is pointed at the model cache this run filled', { skip, timeout: 60_000 }, () => {
  const repo = mkdtempSync(join(tmpdir(), 'enable-music-'));
  const cache = mkdtempSync(join(tmpdir(), 'hf-cache-'));
  const r = spawnSync(PWSH, ['-NoProfile', '-File', SCRIPT, '-Repo', repo, '-Python', process.execPath, '-SkipInstall', '-NoRestart'],
    { encoding: 'utf8', env: { ...process.env, HF_HOME: cache } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(readFileSync(join(repo, '.env.agent'), 'utf8'), new RegExp(`^HF_HOME=${cache.replace(/[\\/.]/g, '\\$&')}$`, 'm'));
  const none = mkdtempSync(join(tmpdir(), 'enable-music-'));
  spawnSync(PWSH, ['-NoProfile', '-File', SCRIPT, '-Repo', none, '-Python', process.execPath, '-SkipInstall', '-NoRestart'],
    { encoding: 'utf8', env: { ...process.env, HF_HOME: join(cache, 'missing') } });
  assert.doesNotMatch(readFileSync(join(none, '.env.agent'), 'utf8'), /HF_HOME/, 'no cache folder, no setting');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

// scripts/autopilot.ps1 needs PowerShell. Set PWSH to its path, or have pwsh
// on PATH; without it these tests are skipped, not failed.
const PWSH = process.env.PWSH || 'pwsh';
const hasPwsh = !spawnSync(PWSH, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).error;
const skip = hasPwsh ? false : 'PowerShell not found (set PWSH)';
const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'autopilot.ps1');

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const pwsh = (args, env = {}) => spawnSync(PWSH, ['-NoProfile', '-File', ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('only actions on the menu, with checked arguments, are planned', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-plan-'));
  const file = join(dir, 'actions.json');
  writeFileSync(file, JSON.stringify({ actions: [
    { id: 'a1', do: 'doctor' },
    { id: 'a2', do: 'ollama-pull', model: 'llama3.2:3b' },
    { id: 'a3', do: 'ollama-pull', model: 'x; rm -rf /' },
    { id: 'a4', do: 'snapshot', allow: 'software/a.jsx:111, scripts/b.ps1:2' },
    { id: 'a5', do: 'snapshot', allow: 'a.js:1;calc' },
    { id: 'a6', do: 'Invoke-Expression' },
    { id: 'a7', do: 'start-task', task: 'Alpha' },
    { id: 'a8', do: 'start-task', task: 'Something Else' },
    { id: 'bad id!', do: 'doctor' },
    { id: 'a9', do: 'apply-update', skipScripts: true },
    { id: 'b1', do: 'apply-update', branch: 'claude/x-alpha-live', from: '030195d38c9b7faae0c8176de498bc0695b6a017' },
    { id: 'b2', do: 'apply-update', branch: '../x' },
    { id: 'b3', do: 'apply-update', branch: 'ok', from: 'abc123' },
    { id: 'c1', do: 'ollama-keepalive' },
    { id: 'c2', do: 'ollama-keepalive', keepAlive: '-1', model: 'llama3.2:3b' },
    { id: 'c3', do: 'ollama-keepalive', keepAlive: '24h; calc' },
    { id: 'd1', do: 'enable-music', bridge: true },
    { id: 'd2', do: 'enable-music', bridge: 'yes; calc', dryRun: true },
    { id: 'e1', do: 'enable-image', bridge: true, machines: 'host,worker1' },
    { id: 'e4', do: 'enable-music', machines: 'host;calc' },
    { id: 'e2', do: 'enable-image', installComfy: true, backend: 'comfyui' },
    { id: 'e3', do: 'enable-image', backend: 'comfyui; calc' },
    { id: 'f1', do: 'live-test', count: 2, only: 'image' },
    { id: 'f2', do: 'live-test', count: 99 },
  ] }));
  const r = pwsh([SCRIPT, '-Plan', file, '-AlphaRoot', 'C:\\A\\software']);
  assert.equal(r.status, 0, r.stderr);
  const plan = Object.fromEntries(JSON.parse(r.stdout).map((p) => [p.id, p]));
  assert.deepEqual(Object.values(plan).filter((p) => p.ok).map((p) => p.id), ['a1', 'a2', 'a4', 'a7', 'a9', 'b1', 'c1', 'c2', 'd1', 'd2', 'e1', 'e2', 'f1']);
  assert.ok(plan.e1.args.includes('-Bridge') && plan.e1.args.includes('-AlphaRoot'));
  assert.equal(plan.e1.args[plan.e1.args.indexOf('-Machines') + 1], 'host,worker1');
  assert.match(plan.e4.reason, /machines must be/);
  assert.deepEqual(plan.e2.args.slice(plan.e2.args.indexOf('-InstallComfy'), plan.e2.args.indexOf('-InstallComfy') + 3), ['-InstallComfy', '-Backend', 'comfyui']);
  assert.match(plan.e3.reason, /backend must be/);
  assert.deepEqual(plan.f1.args.slice(plan.f1.args.indexOf('--count'), plan.f1.args.indexOf('--count') + 4), ['--count', '2', '--only', 'image']);
  assert.match(plan.f1.args[plan.f1.args.indexOf('--video-script') + 1], /scripts[\\/]alpha_video_creator\.py$/);
  assert.match(plan.f2.reason, /count must be 1 to 6/);
  assert.equal(plan.d1.args.at(-1), '-Bridge');
  assert.match(plan.d1.args.at(-2), /enable-music\.ps1$/);
  assert.equal(plan.d2.args.at(-1), '-DryRun', 'only a real true turns a switch on');
  assert.ok(!plan.d2.args.includes('-Bridge'));
  assert.match(plan.c1.args.join(' '), /ollama-keepalive\.ps1$/);
  assert.deepEqual(plan.c2.args.slice(-4), ['-KeepAlive', '-1', '-Model', 'llama3.2:3b']);
  assert.match(plan.c3.reason, /keepAlive must be/);
  assert.deepEqual(plan.b1.args.slice(-4), ['--branch', 'claude/x-alpha-live', '--from', '030195d38c9b7faae0c8176de498bc0695b6a017']);
  assert.match(plan.b2.reason, /plain branch name/);
  assert.match(plan.b3.reason, /40-character/);
  assert.deepEqual(plan.a2.args, ['pull', 'llama3.2:3b']);
  assert.deepEqual(plan.a4.args.slice(-2), ['--allow', 'software/a.jsx:111,scripts/b.ps1:2']);
  assert.ok(plan.a9.args.includes('--skip-scripts'));
  assert.match(plan.a6.reason, /not on the menu/);
  assert.match(plan.a8.reason, /task must be one of/);
});

test('a pass runs each queued id once, refuses the rest, and reports without secrets', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-run-'));
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  git(dir, 'init', '-q', '--bare', remote);
  git(dir, 'clone', '-q', remote, work);
  git(work, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(work, 'scripts'));
  for (const f of ['autopilot.ps1', 'self-update.mjs']) copyFileSync(join(import.meta.dirname, '..', 'scripts', f), join(work, 'scripts', f));
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'init');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-q', '--orphan', 'control/laptop41');
  git(work, 'rm', '-rq', '--cached', '.');
  writeFileSync(join(work, 'actions.json'), JSON.stringify({ actions: [
    { id: 'p1', do: 'ollama-pull', model: 'llama3.2:3b' },
    { id: 'p2', do: 'rm' },
  ] }));
  git(work, 'add', 'actions.json');
  git(work, 'commit', '-qm', 'queue');
  git(work, 'push', '-q', 'origin', 'control/laptop41');
  git(work, 'checkout', '-q', '-f', 'main');
  git(work, 'clean', '-qfd');

  // A stand-in ollama that prints things that must not leave the machine.
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'ollama'), '#!/bin/sh\necho "pulling $2"\necho "token=abcd1234efgh5678ijkl9012mnop"\necho "Authorization: Bearer sk1234567890abcdefghijklmn"\necho "alpha_key_live_secret_value"\nprintf "pulling 10%%\\r\\033[1Gpulling 50%%\\r\\033[Kpulling 100%%\\n"\nprintf "verifying\\nverifying\\nverifying\\nsuccess\\n"\n');
  chmodSync(join(bin, 'ollama'), 0o755);
  const env = { PATH: `${bin}${delimiter}${process.env.PATH}`, COMPUTERNAME: '' };
  const args = [join(work, 'scripts', 'autopilot.ps1'), '-OpsDir', join(dir, 'ops'), '-AlphaRoot', join(dir, 'sw')];

  const first = pwsh(args, env);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /p1 ollama-pull: 0/);
  assert.match(first.stdout, /p2 rm: refused/);
  const second = pwsh(args, env);
  assert.match(second.stdout, /nothing new to run/);

  const report = git(remote, 'show', 'status/laptop41-autopilot:reports/autopilot.md');
  assert.match(report, /pulling llama3\.2:3b/);
  assert.match(report, /not on the menu: 'rm'/);
  assert.doesNotMatch(report, /abcd1234efgh|sk1234567890|live_secret/);
  // The exit code reaches the report, and a progress bar collapses to its last state.
  assert.match(report, /p1 {2}ollama-pull {2}-> {2}0 /);
  // (PowerShell on Linux already splits redirected output at a carriage
  // return, so only Windows hands the bar's redraws over as one line; what is
  // checkable everywhere is that the escape codes are gone.)
  assert.doesNotMatch(report, /\x1b|\[K|\[1G/);
  assert.match(report, /pulling 100%/);
  assert.equal(report.match(/^verifying$/gm)?.length, 1, 'repeated lines are kept once');
});

test('it does nothing on the wrong machine', { skip }, () => {
  const r = pwsh([SCRIPT, '-ExpectHost', 'DESKTOP-41HPLCN'], { COMPUTERNAME: 'LAPTOP-GJ8DFMLK' });
  assert.equal(r.status, 3);
  assert.match(r.stdout, /does nothing here/);
});

test('a checkout that cannot update says why in the report', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-dirty-'));
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  git(dir, 'init', '-q', '--bare', remote);
  git(dir, 'clone', '-q', remote, work);
  git(work, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(work, 'scripts'));
  for (const f of ['autopilot.ps1', 'self-update.mjs']) copyFileSync(join(import.meta.dirname, '..', 'scripts', f), join(work, 'scripts', f));
  writeFileSync(join(work, 'notes.txt'), 'tracked\n');
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'init');
  git(work, 'push', '-q', 'origin', 'main');
  // Someone edited a tracked file on the machine: self-update must refuse.
  writeFileSync(join(work, 'notes.txt'), 'edited here\n');
  const env = { COMPUTERNAME: '' };
  const args = [join(work, 'scripts', 'autopilot.ps1'), '-OpsDir', join(dir, 'ops'), '-AlphaRoot', join(dir, 'sw')];
  const first = pwsh(args, env);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const report = git(remote, 'show', 'status/laptop41-autopilot:reports/autopilot.md');
  assert.match(report, /did NOT update/);
  assert.match(report, /notes\.txt/);
  // Said once: the same refusal on the next pass pushes nothing new.
  const before = git(remote, 'rev-parse', 'status/laptop41-autopilot');
  pwsh(args, env);
  assert.equal(git(remote, 'rev-parse', 'status/laptop41-autopilot'), before);
});

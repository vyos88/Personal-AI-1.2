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
  ] }));
  const r = pwsh([SCRIPT, '-Plan', file, '-AlphaRoot', 'C:\\A\\software']);
  assert.equal(r.status, 0, r.stderr);
  const plan = Object.fromEntries(JSON.parse(r.stdout).map((p) => [p.id, p]));
  assert.deepEqual(Object.values(plan).filter((p) => p.ok).map((p) => p.id), ['a1', 'a2', 'a4', 'a7', 'a9']);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
    { id: 'g1', do: 'brain-topology' },
    { id: 'g2', do: 'brain-topology', fix: true, branch: 'claude/x-route-b' },
    { id: 'g3', do: 'brain-topology', fix: true, branch: '../x' },
    { id: 'g4', do: 'brain-topology', fix: true },
    { id: 'h1', do: 'restart-site' },
    { id: 'h2', do: 'restart-coordinator', task: 'anything else' },
    { id: 'i1', do: 'fleet-inventory', stop: 'everything' },
    { id: 'i2', do: 'alpha-move-check', copy: 'C:\\Users' },
    { id: 'i3', do: 'prepare-alpha-here', target: 'C:\\Windows', branch: 'evil' },
    { id: 'i4', do: 'receive-alpha-data', inbox: 'C:\\Windows' },
    { id: 'j1', do: 'chat-task', task: 'evil' },
    { id: 'j2', do: 'coord-post', message: 'Phase 2 "done"; $(x)', actor: 'cloud-claude' },
    { id: 'j3', do: 'coord-post', message: '   ' },
    { id: 'j4', do: 'coord-post', message: 'hi', actor: 'a b' },
    { id: 'j5', do: 'coord-post', message: 'hi', via: 'records-standby' },
    { id: 'j6', do: 'coord-post', message: 'hi', via: 'C:\\evil\\.env' },
    { id: 'p1', do: 'panel-endpoint', url: 'http://evil:1' },
    { id: 'p2', do: 'panel-identify', port: 'COM3' },
    { id: 'r1', do: 'alpha-runtime', root: 'C:\\Windows' },
    { id: 's1', do: 'stop-stray-site', pid: 12448, port: 8001 },
    { id: 's2', do: 'comfyui-off', pid: 4, dir: 'C:\\Windows' },
    { id: 's3', do: 'songs-check', root: 'C:\\Windows' },
    { id: 's4', do: 'alpha-data-in', from: 'C:\\Windows', to: 'C:\\' },
  ] }));
  const r = pwsh([SCRIPT, '-Plan', file, '-AlphaRoot', 'C:\\A\\software']);
  assert.equal(r.status, 0, r.stderr);
  const plan = Object.fromEntries(JSON.parse(r.stdout).map((p) => [p.id, p]));
  assert.deepEqual(Object.values(plan).filter((p) => p.ok).map((p) => p.id), ['a1', 'a2', 'a4', 'a7', 'a9', 'b1', 'c1', 'c2', 'd1', 'd2', 'e1', 'e2', 'f1', 'g1', 'g2', 'h1', 'h2', 'i1', 'i2', 'i3', 'i4', 'j1', 'j2', 'j5', 'p1', 'p2', 'r1', 's1', 's2', 's3', 's4']);
  assert.match(plan.s1.args.at(-1), /stop-stray-site\.ps1$/, 'no pid or port from the payload: the live tree is read off the machine');
  assert.match(plan.s2.args.at(-1), /comfyui-off\.ps1$/, 'nothing from the payload: what is ComfyUI is read off the machine');
  assert.deepEqual(plan.s3.args.slice(-3).map(String), [plan.s3.args.at(-3), '-AlphaRoot', 'C:\\A\\software'], 'only the autopilot\'s own AlphaRoot, nothing from the payload');
  // Identification asks every port and takes no port from the payload: a
  // payload that could name one is a payload that could aim a write at a board
  // nobody identified, which is the whole point of asking.
  assert.deepEqual(plan.p2.args.slice(1), ['--identify']);
  // Alpha's root comes from the autopilot's own -AlphaRoot (its parent, where
  // memory\ lives), never a path from the payload.
  assert.deepEqual(plan.r1.args.slice(1), ['--alpha-root', 'C:\\A']);
  assert.match(plan.r1.args[0], /alpha-runtime\.mjs$/);
  assert.match(plan.p2.args[0], /panel-up\.mjs$/);
  assert.ok(plan.e1.args.includes('-Bridge') && plan.e1.args.includes('-AlphaRoot'));
  assert.equal(plan.e1.args[plan.e1.args.indexOf('-Machines') + 1], 'host,worker1');
  assert.match(plan.e4.reason, /machines must be/);
  assert.deepEqual(plan.e2.args.slice(plan.e2.args.indexOf('-InstallComfy'), plan.e2.args.indexOf('-InstallComfy') + 3), ['-InstallComfy', '-Backend', 'comfyui']);
  assert.match(plan.e3.reason, /backend must be/);
  assert.deepEqual(plan.f1.args.slice(plan.f1.args.indexOf('--count'), plan.f1.args.indexOf('--count') + 4), ['--count', '2', '--only', 'image']);
  assert.match(plan.f1.args[plan.f1.args.indexOf('--video-script') + 1], /scripts[\\/]alpha_video_creator\.py$/);
  assert.match(plan.f2.reason, /count must be 1 to 6/);
  assert.match(plan.g1.args[0], /brain-topology-check\.mjs$/);
  assert.ok(!plan.g1.args.includes('--fix'), 'without fix it only checks');
  assert.deepEqual(plan.g2.args.slice(-5), ['--fix', '--branch', 'claude/x-route-b', '--retry-hours', '0']);
  assert.match(plan.g3.reason, /plain branch name/);
  assert.match(plan.g4.reason, /fix needs branch/);
  assert.equal(plan.h1.internal, 'restart-site');
  assert.equal(plan.h2.internal, 'restart-coordinator');
  assert.deepEqual(plan.h2.args, [], 'it restarts alpha-coordinator and nothing a payload names');
  assert.match(plan.i1.args.join(' '), /fleet-inventory\.ps1 -AlphaRoot C:\\A\\software$/, 'read-only: nothing from the payload reaches it');
  assert.match(plan.i2.args.join(' '), /alpha-move-check\.ps1 -AlphaRoot C:\\A\\software$/, 'read-only: nothing from the payload reaches it');
  assert.match(plan.s4.args.at(-1), /alpha-data-in\.ps1$/, 'no source or target from the payload');
  assert.equal(plan.s4.timeoutMin, 60);
  assert.match(plan.i3.args.at(-1), /prepare-alpha-here\.ps1$/, 'no target, branch or anything else from the payload');
  assert.equal(plan.i3.timeoutMin, 90);
  assert.match(plan.i4.args.at(-1), /receive-alpha-data\.ps1$/, 'no inbox or target from the payload');
  assert.deepEqual(plan.j1.args.slice(-2), ['-OpsDir', plan.j1.args.at(-1)], 'only the autopilot\'s own OpsDir');
  assert.match(plan.j1.args.at(-3), /chat-task\.ps1$/);
  const b64 = plan.j2.args[plan.j2.args.indexOf('--message-b64') + 1];
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), 'Phase 2 "done"; $(x)', 'the message travels whole, encoded');
  assert.match(b64, /^[A-Za-z0-9+/=]+$/, 'nothing in the argument can be split by quoting');
  assert.deepEqual(plan.j2.args.slice(-2), ['--actor', 'cloud-claude']);
  assert.match(plan.j3.reason, /message must be 1 to 2000/);
  assert.match(plan.j4.reason, /actor must be/);
  assert.deepEqual(plan.j5.args.slice(-2), ['--env', 'C:\\services\\alpha-records-standby\\.env.agent'], 'a name from a fixed list');
  assert.match(plan.j6.reason, /via must be one of: records-standby/, 'never a path from the payload');
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

test('the standing brain check fixes the deck by itself and reports only a change', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-brain-'));
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  git(dir, 'init', '-q', '--bare', remote);
  git(dir, 'clone', '-q', remote, work);
  git(work, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(work, 'scripts'));
  for (const f of ['autopilot.ps1', 'self-update.mjs', 'brain-topology-check.mjs']) copyFileSync(join(import.meta.dirname, '..', 'scripts', f), join(work, 'scripts', f));
  // A stand-in for apply-alpha-update.mjs that brings in the fixed deck.
  writeFileSync(join(work, 'scripts', 'apply-alpha-update.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const a = process.argv.slice(2); const root = a[a.indexOf('--alpha-root') + 1];",
    "console.log('applying ' + a[a.indexOf('--branch') + 1]);",
    "writeFileSync(join(root, 'frontend', 'src', 'components', 'BrainNeuralModel.jsx'), 'topologyEdges(state.anatomy, regions) topologyCheck(state.anatomy, regions)');",
    "writeFileSync(join(root, 'frontend', 'dist', 'assets', 'i.js'), '\"alpha-brain-synapses\" \"Region links\"');",
  ].join('\n'));
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'init');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-q', '--orphan', 'control/laptop41');
  git(work, 'rm', '-rq', '--cached', '.');
  writeFileSync(join(work, 'actions.json'), JSON.stringify({ actions: [], autofix: { brainTopology: { branch: 'claude/x-route-b' } } }));
  git(work, 'add', 'actions.json');
  git(work, 'commit', '-qm', 'queue');
  git(work, 'push', '-q', 'origin', 'control/laptop41');
  git(work, 'checkout', '-q', '-f', 'main');
  git(work, 'clean', '-qfd');

  const sw = join(dir, 'software');
  mkdirSync(join(sw, 'frontend', 'src', 'components'), { recursive: true });
  mkdirSync(join(sw, 'frontend', 'dist', 'assets'), { recursive: true });
  writeFileSync(join(sw, 'frontend', 'package.json'), '{}');
  writeFileSync(join(sw, 'frontend', 'src', 'components', 'BrainNeuralModel.jsx'), '<line x1="50" y1="47" />');
  writeFileSync(join(sw, 'frontend', 'dist', 'assets', 'i.js'), '"alpha-brain-synapses" {x1:"50",y1:"47"}');
  const args = [join(work, 'scripts', 'autopilot.ps1'), '-OpsDir', join(dir, 'ops'), '-AlphaRoot', sw];
  const env = { COMPUTERNAME: '' };

  const first = pwsh(args, env);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /brain topology: 0 \(fixed\)/);
  const report = git(remote, 'show', 'status/laptop41-autopilot:reports/autopilot.md');
  assert.match(report, /auto-brain-topology-\S+ {2}brain-topology \(standing\) {2}-> {2}0 \(fixed\)/);
  assert.match(report, /applying claude\/x-route-b/);
  assert.match(report, /AFTER FIX: the deck is fixed/);
  // Fixed is a new state once (deck ok), then nothing to say.
  assert.match(pwsh(args, env).stdout, /brain topology: 0 \(deck ok\)/);
  assert.match(pwsh(args, env).stdout, /nothing new to run/);
});

test('a pass defers what will not fit, and a stopped pass loses nothing', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-budget-'));
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
    { id: 'q1', do: 'ollama-pull', model: 'a:1' },
    { id: 'q2', do: 'ollama-pull', model: 'b:1' },
  ] }));
  git(work, 'add', 'actions.json');
  git(work, 'commit', '-qm', 'queue');
  git(work, 'push', '-q', 'origin', 'control/laptop41');
  git(work, 'checkout', '-q', '-f', 'main');
  git(work, 'clean', '-qfd');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'ollama'), '#!/bin/sh\necho "pulled $2"\n');
  chmodSync(join(bin, 'ollama'), 0o755);
  const env = { PATH: `${bin}${delimiter}${process.env.PATH}`, COMPUTERNAME: '' };
  const ops = join(dir, 'ops');
  // ollama-pull may take 60 minutes: with a 1-minute plan, only the first runs.
  const args = [join(work, 'scripts', 'autopilot.ps1'), '-OpsDir', ops, '-AlphaRoot', join(dir, 'sw'), '-PassMinutes', '1'];

  const first = pwsh(args, env);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /q1 ollama-pull: 0/);
  assert.match(first.stdout, /q2 ollama-pull: deferred to the next pass/);
  const second = pwsh(args, env);
  assert.match(second.stdout, /q2 ollama-pull: 0/);
  assert.doesNotMatch(second.stdout, /q1 ollama-pull/);

  // A pass the task's time limit stopped after an action: its state says the
  // action is done and still to be reported. The next pass reports it and
  // does not run it again.
  const statePath = join(ops, 'autopilot', 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8').replace(/^﻿/, ''));
  state.done.q3 = { result: '0', at: '2026-10-06T19:00:00' };
  state.pending = [{ id: 'q3', do: 'ollama-pull', result: '0', at: '2026-10-06T19:00:00', seconds: 5, tail: 'pulled c:1 before the stop' }];
  writeFileSync(statePath, JSON.stringify(state));
  const third = pwsh(args, env);
  assert.equal(third.status, 0, third.stdout + third.stderr);
  const report = git(remote, 'show', 'status/laptop41-autopilot:reports/autopilot.md');
  assert.match(report, /## q3 {2}ollama-pull {2}-> {2}0/);
  assert.match(report, /pulled c:1 before the stop/);
  assert.match(pwsh(args, env).stdout, /nothing new to run/);
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

// 2026-10-06: Worker1's music and image bridges were found down together,
// with chat images routed through the image bridge. The autopilot starts a
// registered bridge task whose port is empty, before any queued action runs.
// (Get-ScheduledTask and Get-NetTCPConnection are Windows-only, so this checks
// the code's shape; the full passes above show it stays out of the way.)
test('down bridges are restarted before queued actions, and do not hold back the queue', () => {
  const text = readFileSync(SCRIPT, 'utf8');
  const bridges = text.indexOf('# 2b. The bridges come back by themselves.');
  const queue = text.indexOf('# 3. Run what has not run.');
  assert.ok(bridges > 0 && bridges < queue, 'the bridge check runs before the queue');
  for (const [task, port] of [['alpha-music bridge', 8790], ['alpha-image bridge', 7861]]) {
    assert.ok(text.includes(`task = '${task}'; port = ${port}`), `${task} on ${port}`);
  }
  assert.match(text, /if \(\$queuedRan -and \$p\.ok/, 'a restarted bridge never counts as a queued action for the time plan');
  // Why they keep going down: the task's state and last result, and the end of each log.
  for (const log of ['alpha-music-bridge.log', 'alpha-image-bridge.log']) assert.ok(text.includes(`log = '${log}'`), log);
  assert.match(text, /Get-ScheduledTaskInfo -TaskName \$b\.task/);
  assert.match(text, /-replace '\(alpha_key_\|sk-\|ghp_\|github_pat_\)\\S\+', '\$1\*\*\*'/, 'keys in a log line are masked');
});

test('panel-endpoint takes nothing from the action, and reads the deck STATUS line', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-panel-'));
  const file = join(dir, 'actions.json');
  writeFileSync(file, JSON.stringify({ actions: [{ id: 'p1', do: 'panel-endpoint', url: 'http://evil:1', port: 'COM9' }] }));
  const r = pwsh([SCRIPT, '-Plan', file, '-AlphaRoot', 'C:\\A\\software']);
  assert.equal(r.status, 0, r.stderr);
  const [p] = JSON.parse(r.stdout);
  assert.equal(p.ok, true);
  assert.ok(p.args.some((a) => a.endsWith('panel-endpoint.ps1')));
  assert.ok(!p.args.join(' ').includes('evil') && !p.args.join(' ').includes('COM9'), 'nothing from the action reaches the script');

  const panel = join(import.meta.dirname, '..', 'scripts', 'panel-endpoint.ps1');
  const line = '[crowpanel] fw=1.4 wifi_ssid=Starlink wifi_set=yes alpha_base=http://192.168.1.250:8001 alpha_set=no touch=ok events=3 alive=false';
  const parsed = JSON.parse(pwsh([panel, '-ParseStatus', line]).stdout);
  assert.equal(parsed.alpha_base, 'http://192.168.1.250:8001');
  assert.equal(parsed.wifi_set, 'yes');
  assert.equal(JSON.parse(pwsh([panel, '-ParseStatus', 'rst:0x1 (POWERON_RESET)']).stdout), null);
});

test('panel-endpoint says what a port that never answered STATUS did send', { skip }, () => {
  const panel = join(import.meta.dirname, '..', 'scripts', 'panel-endpoint.ps1');
  const heard = (text) => pwsh([panel, '-DescribeHeard', text]).stdout.trim();
  assert.match(heard(''), /^nothing at all came back: the board is silent on this port/);
  assert.match(heard('abc'), /^3 byte\(s\) came back but never a whole line/);
  const other = heard('rst:0x1 (POWERON_RESET)\\n{"ok":true,"wifi":"Home","pass":"hunter2"}\\nwifi password=hunter2 key: abc\\n');
  assert.match(other, /^it is talking, but not as Alpha's deck firmware\. It said: 'rst:0x1 \(POWERON_RESET\)'/);
  assert.ok(!other.includes('hunter2') && !other.includes('abc'), `nothing credential-shaped is repeated: ${other}`);
  assert.match(heard('boot\\n[crowpanel] fw=1.4 wifi_ssid=Starlink alpha_base=http://192.168.1.151:8001\\n'), /^status: \[crowpanel\] fw=1\.4/);
});

test('panel-host edits the env file beside Alpha, and takes nothing from the action', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-panel-host-'));
  const file = join(dir, 'actions.json');
  writeFileSync(file, JSON.stringify({ actions: [{ id: 'q1', do: 'panel-host', address: '10.9.9.9', env: 'C:\\evil\\.env', task: 'calc' }] }));
  const r = pwsh([SCRIPT, '-Plan', file, '-AlphaRoot', 'C:\\A\\software']);
  assert.equal(r.status, 0, r.stderr);
  const [p] = JSON.parse(r.stdout);
  assert.equal(p.ok, true);
  assert.match(p.args[0], /fix-panel-host\.mjs$/);
  assert.deepEqual(p.args.slice(1), ['--env', 'C:\\A\\.env.local', '--require-host'], "run_server.py's own file, and only if it sets HOST");
  assert.ok(!/10\.9\.9\.9|evil|calc/.test(p.args.join(' ')), 'nothing from the action reaches the script');
});

test('promo-reel renders into the folder Alpha serves videos from, and takes nothing from the action', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-promo-reel-'));
  const file = join(dir, 'actions.json');
  writeFileSync(file, JSON.stringify({ actions: [{ id: 'q1', do: 'promo-reel', name: '..\\evil', outDir: 'C:\\evil' }] }));
  const r = pwsh([SCRIPT, '-Plan', file, '-AlphaRoot', 'C:\\A\\software']);
  assert.equal(r.status, 0, r.stderr);
  const [p] = JSON.parse(r.stdout);
  assert.equal(p.ok, true);
  assert.match(p.args[0], /promo-reel\.mjs$/);
  assert.deepEqual(p.args.slice(1, 5), ['--video-script', 'C:\\A\\scripts\\alpha_video_creator.py', '--out-dir', 'C:\\A\\artifacts\\generated\\videos']);
  assert.ok(!/evil/.test(p.args.join(' ')), 'nothing from the action reaches the script');
});

test('interactive-first-off edits the env file beside Alpha, and takes nothing from the action', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-ifo-'));
  const file = join(dir, 'actions.json');
  writeFileSync(file, JSON.stringify({ actions: [{ id: 'q1', do: 'interactive-first-off', env: 'C:\\evil\\.env', value: 'true' }] }));
  const r = pwsh([SCRIPT, '-Plan', file, '-AlphaRoot', 'C:\\A\\software']);
  assert.equal(r.status, 0, r.stderr);
  const [p] = JSON.parse(r.stdout);
  assert.equal(p.ok, true);
  assert.match(p.args[0], /interactive-first-off\.mjs$/);
  assert.deepEqual(p.args.slice(1), ['--env', 'C:\\A\\.env.local']);
  assert.ok(!/evil|true/.test(p.args.join(' ')), 'nothing from the action reaches the script');
});

test('standing Alpha down needs V\'s word in the action, or is a rehearsal; a standby refuses what would start Alpha', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-standdown-'));
  const ops = join(dir, 'ops');
  mkdirSync(ops);
  const file = join(dir, 'actions.json');
  const plan = (actions) => {
    writeFileSync(file, JSON.stringify({ actions }));
    const r = pwsh([SCRIPT, '-Plan', file, '-AlphaRoot', 'C:\\A\\software', '-OpsDir', ops]);
    assert.equal(r.status, 0, r.stderr);
    return Object.fromEntries(JSON.parse(r.stdout).map((p) => [p.id, p]));
  };
  let p = plan([
    { id: 'd1', do: 'alpha-standdown' },
    { id: 'd2', do: 'alpha-standdown', confirm: 'yes' },
    { id: 'd3', do: 'alpha-standdown', reportOnly: true },
    { id: 'd4', do: 'alpha-standdown', confirm: 'hand-over', primary: 'laptop-gj8dfmlk' },
    { id: 'd5', do: 'alpha-standdown', confirm: 'hand-over', primary: 'x; calc' },
    { id: 'u1', do: 'alpha-standup', force: true, reportOnly: true },
    { id: 'b1', do: 'restart-backend' },
    { id: 'i1', do: 'standby-install' },
    { id: 'i2', do: 'standby-install', primary: 'alpha-server', primaryUrl: 'http://100.70.1.2:8001/health' },
    { id: 'i3', do: 'standby-install', primaryUrl: 'http://x/health; calc' },
    { id: 'i4', do: 'standby-uninstall', task: 'evil' },
    { id: 's1', do: 'data-sync' },
    { id: 's2', do: 'data-sync', peer: 'laptop-gj8dfmlk', since: '2026-10-07T21:00:00Z' },
    { id: 's3', do: 'data-sync', since: '2026-10-07T21:00:00Z' },
    { id: 's4', do: 'data-sync', peer: 'laptop-gj8dfmlk', since: 'yesterday' },
    { id: 's5', do: 'data-apply', from: 'C:\\evil' },
    { id: 's6', do: 'data-sync', peer: 'alpha-serv-01', since: '2000-01-01T00:00:00Z', resend: true },
    { id: 's7', do: 'data-sync', peer: 'alpha-serv-01', resend: true },
    { id: 's8', do: 'data-sync-install', peer: 'alpha-serv-01', everyMin: 10 },
    { id: 's9', do: 'data-sync-install', peer: 'x; calc' },
    { id: 's10', do: 'data-sync-install', peer: 'alpha-serv-01', everyMin: 1 },
    { id: 's11', do: 'data-sync-uninstall', peer: 'evil' },
    { id: 't1', do: 'tailnet-peers', name: 'evil' },
  ]);
  assert.equal(p.d1.ok, false);
  assert.match(p.d1.reason, /"confirm": "hand-over"/);
  assert.equal(p.d2.ok, false);
  assert.deepEqual(p.d3.args.slice(-3), ['-OpsDir', ops, '-ReportOnly']);
  assert.match(p.d3.args.at(-4), /alpha-standdown\.ps1$/);
  assert.deepEqual(p.d4.args.slice(-4), ['-OpsDir', ops, '-Primary', 'laptop-gj8dfmlk']);
  assert.equal(p.d5.ok, false);
  assert.deepEqual(p.u1.args.slice(-6), ['-OpsDir', ops, '-Undo', '-StartConnector', '-ReportOnly', '-Force']);
  assert.equal(p.b1.ok, true, 'a machine that serves Alpha may restart it');
  assert.match(p.i1.args.at(-5), /install-alpha-standby\.ps1$/);
  assert.deepEqual(p.i1.args.slice(-4), ['-OpsDir', ops, '-AlphaRoot', 'C:\\A\\software']);
  assert.deepEqual(p.i2.args.slice(-4), ['-Primary', 'alpha-server', '-PrimaryUrl', 'http://100.70.1.2:8001/health']);
  assert.equal(p.i3.ok, false);
  assert.deepEqual(p.i4.args.slice(-3), ['-OpsDir', ops, '-Uninstall']);
  assert.ok(p.s1.args.some((a) => /alpha-data-sync\.ps1$/.test(a)));
  assert.deepEqual(p.s1.args.slice(-2), ['-MaxBytes', '104857600'], 'every data-sync job is capped');
  assert.deepEqual(p.s2.args.slice(-6), ['-Peer', 'laptop-gj8dfmlk', '-Since', '2026-10-07T21:00:00Z', '-MaxBytes', '104857600'], 'a full copy goes a part at a time');
  assert.equal(p.s3.ok, false, 'a baseline is only for a machine that sends');
  assert.equal(p.s4.ok, false);
  assert.deepEqual(p.s5.args.slice(-2), ['-ApplyHeld', '-NoSend']);
  assert.deepEqual(p.s6.args.slice(-7), ['-Peer', 'alpha-serv-01', '-Since', '2000-01-01T00:00:00Z', '-Resend', '-MaxBytes', '104857600'], 'a resend goes again from "since", a part at a time');
  assert.equal(p.s7.ok, false, 'a resend needs a since');
  assert.match(p.s7.reason, /resend needs a since/);
  assert.match(p.s8.args.at(-9), /install-alpha-data-sync\.ps1$/);
  assert.deepEqual(p.s8.args.slice(-8), ['-OpsDir', ops, '-AlphaRoot', 'C:\\A\\software', '-Peer', 'alpha-serv-01', '-EveryMin', '10']);
  assert.equal(p.s9.ok, false);
  assert.equal(p.s10.ok, false, 'not more often than every 5 minutes');
  assert.deepEqual(p.s11.args.slice(-3), ['-OpsDir', ops, '-Uninstall']);
  assert.ok(!/evil/.test(p.s5.args.join(' ')));
  assert.match(p.t1.args.at(-1), /tailnet-peers\.ps1$/, 'takes nothing from the action');

  // Once it stood down, nothing queued may start Alpha here again but alpha-standup.
  writeFileSync(join(ops, 'role.json'), JSON.stringify({ role: 'standby', primary: 'laptop-gj8dfmlk' }));
  p = plan([
    { id: 'r1', do: 'restart-backend' },
    { id: 'r2', do: 'restart-site' },
    { id: 'r3', do: 'repair-host' },
    { id: 'r4', do: 'panel-host' },
    { id: 'r5', do: 'start-task', task: 'Alpha Backend' },
    { id: 'r6', do: 'start-task', task: 'Alpha Self-Heal' },
    { id: 'k1', do: 'start-task', task: 'Alpha Doctor' },
    { id: 'k2', do: 'doctor' },
    { id: 'k3', do: 'alpha-standup' },
  ]);
  for (const id of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']) {
    assert.equal(p[id].ok, false, id);
    assert.match(p[id].reason, /standby \(role\.json\): Alpha serves from laptop-gj8dfmlk\. Queue alpha-standup first/, id);
  }
  for (const id of ['k1', 'k2', 'k3']) assert.equal(p[id].ok, true, id);
});

test('home Wi-Fi: rejoins the home network only while it is visible, and restarts the backend only for an address it was told to bind', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-wifi-'));
  let n = 0;
  const decide = (facts) => {
    const file = join(dir, `facts-${n++}.json`);
    writeFileSync(file, JSON.stringify({ home: 'Starlink V', now: '2026-10-07T23:30:00', listeners: [], hostList: [], ...facts }));
    const r = pwsh([SCRIPT, '-HomeWifiDecide', file]);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  // Off the home network: what Worker1 did at 04:54 on 2026-10-07.
  assert.equal(decide({ connected: 'STARLINK', homeVisible: true }).action, 'rejoin');
  assert.equal(decide({ connected: '', homeVisible: true }).action, 'rejoin');
  const away = decide({ connected: 'STARLINK', homeVisible: false });
  assert.equal(away.action, 'none');
  assert.match(away.why, /'Starlink V' is not visible, so this network stays for the internet/);
  assert.equal(decide({ connected: 'STARLINK', homeVisible: true, lastJoin: '2026-10-07T23:25:00' }).action, 'none', 'at most every 10 minutes');
  assert.equal(decide({ connected: 'STARLINK', homeVisible: true, lastJoin: '2026-10-07T23:15:00' }).action, 'rejoin');

  // On it: the backend has to listen on this address for the panel to reach it.
  const hosts = ['127.0.0.1', '100.69.243.25', '192.168.2.151', '192.168.1.151'];
  const on = { connected: 'Starlink V', wifiIp: '192.168.2.151', hostList: hosts };
  assert.equal(decide({ ...on, listeners: ['127.0.0.1', '192.168.2.151'] }).action, 'none');
  assert.equal(decide({ ...on, listeners: ['0.0.0.0'] }).action, 'none');
  const stale = decide({ ...on, listeners: ['127.0.0.1', '100.69.243.25', '192.168.1.151'] });
  assert.equal(stale.action, 'restart');
  assert.match(stale.why, /the backend does not listen on 192\.168\.2\.151: restarting it/);
  assert.equal(decide({ ...on, listeners: ['127.0.0.1'], lastRestart: '2026-10-07T23:10:00' }).action, 'none', 'at most every 30 minutes');
  assert.equal(decide({ ...on, listeners: [] }).action, 'none', "a backend that is down is self-heal's to restart");
  const unlisted = decide({ ...on, listeners: ['127.0.0.1'], hostList: ['127.0.0.1'] });
  assert.equal(unlisted.action, 'report');
  assert.match(unlisted.why, /192\.168\.2\.151 is not in the backend's address list: queue panel-host/);
  assert.equal(decide({ connected: 'Starlink V', wifiIp: '' }).action, 'none');
  // A standby keeps its backend off on purpose: the Wi-Fi is still joined.
  const standby = decide({ ...on, listeners: ['127.0.0.1'], standby: true });
  assert.equal(standby.action, 'none');
  assert.match(standby.why, /standby: Alpha serves from the primary, so the backend here stays off/);
  assert.equal(decide({ connected: 'STARLINK', homeVisible: true, standby: true }).action, 'rejoin');

  // It joins with the profile Windows saved and changes no Wi-Fi setting.
  const text = readFileSync(SCRIPT, 'utf8');
  const code = text.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join('\n');
  assert.ok(!/netsh/i.test(code), 'netsh can change profiles; this script must not run it');
  assert.ok(!/PasswordCredential|ConnectAsync\([^)]*,[^)]*,/.test(text), 'no passphrase is ever passed');
  assert.match(text, /ConnectAsync\(\$net, \[Windows\.Devices\.WiFi\.WiFiReconnectionKind\]::Automatic\)/);
});

test('the standing live sync passes its settings on and reports only a change', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-sync-'));
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  git(dir, 'init', '-q', '--bare', remote);
  git(dir, 'clone', '-q', remote, work);
  git(work, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(work, 'scripts'));
  for (const f of ['autopilot.ps1', 'self-update.mjs']) copyFileSync(join(import.meta.dirname, '..', 'scripts', f), join(work, 'scripts', f));
  // A stand-in for live-sync.mjs: says what it was asked, then a state that
  // changes once (delivered) and then holds (in sync).
  writeFileSync(join(work, 'scripts', 'live-sync.mjs'), [
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const a = process.argv.slice(2); const ops = a[a.indexOf('--ops') + 1];",
    "const paths = new Set(['--alpha-root', '--ops'].map((o) => a[a.indexOf(o) + 1]));",
    "console.log('args: ' + a.filter((x) => !paths.has(x)).join(' '));",
    "const seen = join(ops, 'sync-seen');",
    "if (existsSync(seen)) console.log('IN SYNC: this machine runs abc1234 of claude/x-route-b');",
    "else { writeFileSync(seen, '1'); console.log('    token=abcd1234efgh5678ijkl9012mnop'); console.log('DELIVERED: 0000000..abc1234 of claude/x-route-b'); }",
  ].join('\n'));
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'init');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-q', '--orphan', 'control/laptop41');
  git(work, 'rm', '-rq', '--cached', '.');
  writeFileSync(join(work, 'actions.json'), JSON.stringify({ actions: [], autofix: { liveSync: { branch: 'claude/x-route-b', capture: true } } }));
  git(work, 'add', 'actions.json');
  git(work, 'commit', '-qm', 'queue');
  git(work, 'push', '-q', 'origin', 'control/laptop41');
  git(work, 'checkout', '-q', '-f', 'main');
  git(work, 'clean', '-qfd');

  const sw = join(dir, 'software');
  mkdirSync(sw);
  const args = [join(work, 'scripts', 'autopilot.ps1'), '-OpsDir', join(dir, 'ops'), '-AlphaRoot', sw];
  const env = { COMPUTERNAME: 'DESKTOP-41HPLCN' };

  const first = pwsh(args, env);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /live sync: 0 \(in sync\)/);
  const report = git(remote, 'show', 'status/laptop41-autopilot:reports/autopilot.md');
  assert.match(report, /auto-live-sync-\S+ {2}live-sync \(standing\) {2}-> {2}0 \(in sync\)/);
  assert.match(report, /args: --alpha-root --ops --branch claude\/x-route-b --machine DESKTOP-41HPLCN --capture/);
  assert.match(report, /DELIVERED: 0000000\.\.abc1234/);
  assert.doesNotMatch(report, /abcd1234efgh/, 'the report is redacted');
  // A new state is reported once, then nothing more to say.
  assert.match(pwsh(args, env).stdout, /live sync: 0 \(in sync\)/);
  assert.match(pwsh(args, env).stdout, /nothing new to run/);
});

test('the owner\'s live-sync allow list is passed on exactly, and the line to copy is never masked', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-allow-'));
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  const ctl = join(dir, 'ctl');
  git(dir, 'init', '-q', '--bare', remote);
  git(dir, 'clone', '-q', remote, work);
  git(work, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(work, 'scripts'));
  for (const f of ['autopilot.ps1', 'self-update.mjs']) copyFileSync(join(import.meta.dirname, '..', 'scripts', f), join(work, 'scripts', f));
  // A stand-in for live-sync.mjs: without --allow it holds a file back and
  // names the line; with it, it captures.
  const held = 'software/backend/crowpanel_alpha_display_v2_test.py:3';
  writeFileSync(join(work, 'scripts', 'live-sync.mjs'), [
    "const a = process.argv.slice(2); const i = a.indexOf('--allow');",
    "if (i < 0) { console.log('HELD BACK: 1 file(s) with credential-looking lines, not pushed');",
    `  console.log('    ${held}  token  abcd...'); console.log('ALLOW WITH: ${held}'); process.exit(2); }`,
    "console.log('CAPTURED: abc1234..def5678 of claude/x-route-b; allowed ' + a[i + 1]);",
  ].join('\n'));
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'init');
  git(work, 'push', '-q', 'origin', 'main');

  git(dir, 'clone', '-q', remote, ctl);
  git(ctl, 'checkout', '-q', '--orphan', 'control/laptop41');
  const control = (liveSync) => {
    writeFileSync(join(ctl, 'actions.json'), JSON.stringify({ actions: [], autofix: { liveSync: { branch: 'claude/x-route-b', ...liveSync } } }));
    git(ctl, 'add', 'actions.json');
    git(ctl, 'commit', '-qm', 'control');
    git(ctl, 'push', '-q', 'origin', 'control/laptop41');
  };
  const sw = join(dir, 'software');
  mkdirSync(sw);
  const args = [join(work, 'scripts', 'autopilot.ps1'), '-OpsDir', join(dir, 'ops'), '-AlphaRoot', sw];
  const env = { COMPUTERNAME: 'DESKTOP-41HPLCN' };
  const report = () => git(remote, 'show', 'status/laptop41-autopilot:reports/autopilot.md');

  control({});
  let r = pwsh(args, env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /live sync: 2 \(needs a person\)/);
  // A long file name with a digit is what Redact masks; on this line it stays whole.
  assert.ok(report().includes(`ALLOW WITH: ${held}`), report());

  // A string or a list, trimmed and joined: exactly what the owner wrote.
  control({ allow: ' software/a.py:3, software/b.py:9 ' });
  r = pwsh(args, env);
  assert.match(r.stdout, /live sync: 0 \(in sync\)/);
  assert.match(report(), /allowed software\/a\.py:3,software\/b\.py:9$/m);
  control({ allow: ['software/c.py:1', 'software/d.py:2'] });
  r = pwsh(args, env);
  assert.match(report(), /allowed software\/c\.py:1,software\/d\.py:2$/m);

  // One bad entry and none of the list is used: the files stay held back.
  control({ allow: ['software/c.py:1', 'software/d.py; calc'] });
  r = pwsh(args, env);
  assert.match(r.stdout, /autofix\.liveSync\.allow entries must be path:line \(1 are not\): none used/);
  assert.match(r.stdout, /live sync: 2 \(needs a person\)/);
});

test('the standing deck check runs with the backend\'s Python, at most every everyMin, and reports only a change', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-deck-'));
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  const ctl = join(dir, 'ctl');
  git(dir, 'init', '-q', '--bare', remote);
  git(dir, 'clone', '-q', remote, work);
  git(work, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(work, 'scripts'));
  for (const f of ['autopilot.ps1', 'self-update.mjs']) copyFileSync(join(import.meta.dirname, '..', 'scripts', f), join(work, 'scripts', f));
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'init');
  git(work, 'push', '-q', 'origin', 'main');
  git(dir, 'clone', '-q', remote, ctl);
  git(ctl, 'checkout', '-q', '--orphan', 'control/laptop41');
  const control = (autofix) => {
    writeFileSync(join(ctl, 'actions.json'), JSON.stringify({ actions: [], autofix }));
    git(ctl, 'add', 'actions.json');
    git(ctl, 'commit', '-qm', 'control');
    git(ctl, 'push', '-q', 'origin', 'control/laptop41');
  };

  // Alpha's root: software\ and, once live sync has delivered it, the check.
  const alpha = join(dir, 'alpha');
  mkdirSync(join(alpha, 'software'), { recursive: true });
  const runs = join(dir, 'runs');
  const deckScript = join(alpha, 'scripts', 'alpha_deck_liveness.py');
  const writeDeck = (verdict) => {
    mkdirSync(join(alpha, 'scripts'), { recursive: true });
    writeFileSync(deckScript, [
      'import sys, time',
      `open(${JSON.stringify(runs)}, 'a').write('run ' + ' '.join(sys.argv[1:]) + '\\n')`,
      `print('DECKS: 1 ${verdict.toLowerCase()}')`,
      `print('DECK ${verdict}: deck evidence (/hubs/pulse) -> x  [decks: alpha]')`,
      "print('    report ' + str(time.time()) + ' s old')",
      `sys.exit(${verdict === 'LIVE' ? 0 : 2})`,
    ].join('\n'));
  };
  const statePath = join(dir, 'ops', 'autopilot', 'state.json');
  const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();
  // Something listens on 8001, and it runs this Python.
  const backendUp = `function Get-NetTCPConnection { [pscustomobject]@{ OwningProcess = 4242 } }; function Get-Process { [pscustomobject]@{ Path = '${python}' } }; `;
  const run = (prefix = backendUp) => spawnSync(PWSH, ['-NoProfile', '-Command',
    `${prefix}& '${join(work, 'scripts', 'autopilot.ps1')}' -OpsDir '${join(dir, 'ops')}' -AlphaRoot '${join(alpha, 'software')}'; exit $LASTEXITCODE`],
  { encoding: 'utf8', env: { ...process.env, COMPUTERNAME: 'DESKTOP-41HPLCN' } });
  const report = () => git(remote, 'show', 'status/laptop41-autopilot:reports/autopilot.md');
  const backdate = () => {
    const s = JSON.parse(readFileSync(statePath, 'utf8').replace(/^﻿/, ''));
    s.deckAt = '2026-01-01T00:00:00';
    writeFileSync(statePath, JSON.stringify(s));
  };

  // Not delivered yet: said once, plainly.
  control({ deckLiveness: true });
  let r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /deck liveness: 1 \(could not run\)/);
  assert.match(report(), /alpha_deck_liveness\.py is not on this machine yet/);

  // Delivered: runs with the backend's Python and Alpha's root.
  writeDeck('STALE');
  backdate();
  r = run();
  assert.match(r.stdout, /deck liveness: 2 \(not every deck is live\)/, r.stdout + r.stderr);
  assert.match(readFileSync(runs, 'utf8'), new RegExp(`run --root ${join(dir, 'alpha').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(report(), /DECK STALE: deck evidence/);

  // Inside its window it does not run again; past it, the same verdict is not news.
  r = run();
  assert.equal(readFileSync(runs, 'utf8').trim().split('\n').length, 1, 'not due yet');
  backdate();
  r = run();
  assert.equal(readFileSync(runs, 'utf8').trim().split('\n').length, 2);
  assert.doesNotMatch(r.stdout, /deck liveness:/, 'the ages moved, the verdict did not');

  // A changed verdict is reported; everyMin from the object form is honoured.
  writeDeck('LIVE');
  control({ deckLiveness: { everyMin: 30 } });
  backdate();
  r = run();
  assert.match(r.stdout, /deck liveness: 0 \(every deck live\)/);

  // No backend on 8001: down, without running anything.
  backdate();
  const before = readFileSync(runs, 'utf8');
  r = run('function Get-NetTCPConnection { } ; ');
  assert.match(r.stdout, /deck liveness: 2 \(not every deck is live\)/);
  assert.equal(readFileSync(runs, 'utf8'), before);
  assert.match(report(), /DECK DOWN: backend \(\/health\) -> nothing listens on 8001/);
});

test('the fleet inventory runs read-only and fits the report', { skip }, () => {
  const r = pwsh([join(import.meta.dirname, '..', 'scripts', 'fleet-inventory.ps1'), '-AlphaRoot', mkdtempSync(join(tmpdir(), 'inv-'))]);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim().split(/\r?\n/);
  assert.ok(out.length <= 60, `${out.length} lines; the autopilot keeps 60`);
  for (const section of ['FLEET INVENTORY', 'TASKS', 'SERVICES', 'PROCESSES', 'DUPLICATES', 'PORTS', 'AGENT MANAGER']) {
    assert.ok(out.some((line) => line.startsWith(section)), section);
  }
});

test('the Alpha move check runs read-only, fits the report and names what is missing', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'move-'));
  const r = pwsh([join(import.meta.dirname, '..', 'scripts', 'alpha-move-check.ps1'), '-AlphaRoot', join(root, 'software')]);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim().split(/\r?\n/);
  assert.ok(out.length <= 60, `${out.length} lines; the autopilot keeps 60`);
  for (const section of ['ALPHA MOVE CHECK', 'MACHINE', 'ALPHA COPY', 'TOOLS', 'PORTS', 'AGENT MANAGER', 'MISSING TO RUN ALPHA HERE']) {
    assert.ok(out.some((line) => line.startsWith(section)), section);
  }
  assert.match(r.stdout, /no Alpha copy with backend\\main\.py/);
  assert.match(r.stdout, /PORTS: 8001 backend=-/, 'a port nobody listens on is not up');
  assert.deepEqual(readdirSync(root), [], 'it writes nothing');
});

test('preparing Alpha refuses a folder that is not a checkout, and a dry run changes nothing', { skip }, () => {
  const script = join(import.meta.dirname, '..', 'scripts', 'prepare-alpha-here.ps1');
  const base = mkdtempSync(join(tmpdir(), 'prep-'));
  let r = pwsh([script, '-Target', join(base, 'Alpha'), '-DryRun']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /would clone https:\/\/github\.com\/vyos88\/Alpha\.git \(claude\/friendly-wright-jw4ep6-route-b\)/);
  assert.match(r.stdout, /RESULT: dry run/);
  assert.deepEqual(readdirSync(base), [], 'a dry run writes nothing');

  mkdirSync(join(base, 'Alpha'));
  writeFileSync(join(base, 'Alpha', 'keep.txt'), 'mine');
  r = pwsh([script, '-Target', join(base, 'Alpha')]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /REFUSED: .* is not a git checkout/);
  assert.deepEqual(readdirSync(join(base, 'Alpha')), ['keep.txt'], 'nothing was changed');
});

test('the Alpha move check finds the backend configuration beside software, and never reads it', { skip }, () => {
  const top = mkdtempSync(join(tmpdir(), 'move-top-'));
  mkdirSync(join(top, 'software', 'backend'), { recursive: true });
  writeFileSync(join(top, 'software', 'backend', 'main.py'), '');
  writeFileSync(join(top, '.env.local'), 'SECRET_VALUE=do-not-print\n');
  const r = pwsh([join(import.meta.dirname, '..', 'scripts', 'alpha-move-check.ps1'), '-AlphaRoot', join(top, 'software')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\.env\.local: present, 26 bytes \(contents not read\)/);
  assert.doesNotMatch(r.stdout, /the backend's \.env\.local/, 'present beside software\\ is present');
  assert.doesNotMatch(r.stdout, /SECRET_VALUE|do-not-print/);
});

test('receiving Alpha data checks every file, puts it in place and never shows the configuration', { skip }, () => {
  const script = join(import.meta.dirname, '..', 'scripts', 'prepare-alpha-here.ps1').replace('prepare-alpha-here', 'receive-alpha-data');
  const base = mkdtempSync(join(tmpdir(), 'recv-'));
  const home = join(base, 'Alpha', 'BuildArtifacts', 'installers', 'Alpha-Full');
  mkdirSync(join(home, 'software', 'backend'), { recursive: true });
  writeFileSync(join(home, 'software', 'backend', 'main.py'), '');
  mkdirSync(join(home, 'memory'));
  writeFileSync(join(home, 'memory', 'from-git.txt'), 'old');
  const src = join(base, 'src');
  mkdirSync(join(src, 'memory', 'local'), { recursive: true });
  writeFileSync(join(src, 'memory', 'local', 'state.json'), '{"ok":true}');
  const inbox = join(base, 'inbox');
  mkdirSync(inbox);
  execFileSync('tar', ['-cf', join(inbox, 'memory-1.tar'), '-C', src, 'memory']);
  writeFileSync(join(inbox, 'env.local'), 'API_TOKEN=do-not-print\n');
  const sha = (f) => createHash('sha256').update(readFileSync(join(inbox, f))).digest('hex');
  const size = (f) => readFileSync(join(inbox, f)).length;
  const manifest = (files) => writeFileSync(join(inbox, 'alpha-move-manifest.json'), JSON.stringify({ files }));
  const good = [
    { name: 'memory-1.tar', kind: 'memory', sha256: sha('memory-1.tar'), bytes: size('memory-1.tar') },
    { name: 'env.local', kind: 'env-local', sha256: sha('env.local'), bytes: size('env.local') },
  ];
  const run = () => pwsh([script, '-Target', join(base, 'Alpha'), '-Inbox', inbox, '-NoFetch']);

  // One wrong hash: nothing changes.
  manifest([good[0], { ...good[1], sha256: '0'.repeat(64) }]);
  let r = run();
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /MISMATCH: env\.local/);
  assert.deepEqual(readdirSync(join(home, 'memory')), ['from-git.txt']);
  assert.ok(!readdirSync(home).includes('.env.local'));

  manifest(good);
  r = run();
  assert.equal(r.status, 0, r.stdout);
  assert.equal(readFileSync(join(home, 'memory', 'local', 'state.json'), 'utf8'), '{"ok":true}');
  assert.ok(readdirSync(home).some((n) => n.startsWith('memory.prev-')), 'the old memory is kept, not deleted');
  assert.equal(readFileSync(join(home, '.env.local'), 'utf8'), 'API_TOKEN=do-not-print\n');
  assert.doesNotMatch(r.stdout, /do-not-print/);
  assert.deepEqual(readdirSync(inbox), [], 'no second copy of a secret left behind');
});

test('receiving Alpha data refuses an archive that reaches outside memory', { skip }, () => {
  const script = join(import.meta.dirname, '..', 'scripts', 'receive-alpha-data.ps1');
  const base = mkdtempSync(join(tmpdir(), 'recv-bad-'));
  const home = join(base, 'Alpha');
  mkdirSync(join(home, 'software', 'backend'), { recursive: true });
  writeFileSync(join(home, 'software', 'backend', 'main.py'), '');
  const src = join(base, 'src');
  mkdirSync(join(src, 'software'), { recursive: true });
  writeFileSync(join(src, 'software', 'evil.py'), 'x');
  const inbox = join(base, 'inbox');
  mkdirSync(inbox);
  execFileSync('tar', ['-cf', join(inbox, 'memory-1.tar'), '-C', src, 'software']);
  const buf = readFileSync(join(inbox, 'memory-1.tar'));
  writeFileSync(join(inbox, 'alpha-move-manifest.json'), JSON.stringify({ files: [{ name: 'memory-1.tar', kind: 'memory', bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') }] }));
  const r = pwsh([script, '-Target', home, '-Inbox', inbox, '-NoFetch']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /holds paths outside memory/);
  assert.ok(!readdirSync(join(home, 'software')).includes('evil.py'));
});

test('preparing Alpha finds the software folder where the live branch keeps it, under Alpha-Full', { skip }, () => {
  const base = mkdtempSync(join(tmpdir(), 'prep-clone-'));
  const src = join(base, 'src');
  const app = join(src, 'BuildArtifacts', 'installers', 'Alpha-Full', 'software');
  mkdirSync(join(app, 'backend'), { recursive: true });
  mkdirSync(join(app, 'frontend'), { recursive: true });
  writeFileSync(join(app, 'backend', 'main.py'), '');
  writeFileSync(join(app, 'frontend', 'package.json'), JSON.stringify({ name: 'f', version: '1.0.0', scripts: { build: "node -e \"require('fs').mkdirSync('dist');require('fs').writeFileSync('dist/index.html','ok')\"" } }));
  git(base, 'init', '-q', '-b', 'live', src);
  git(src, 'add', '.');
  git(src, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'live');
  const target = join(base, 'Alpha');
  const r = pwsh([join(import.meta.dirname, '..', 'scripts', 'prepare-alpha-here.ps1'), '-Target', target, '-Repo', src, '-Branch', 'live', '-Model', 'none:0']);
  assert.match(r.stdout, /cloned: /, r.stdout);
  assert.match(r.stdout, /Alpha's software\\ is .*BuildArtifacts.installers.Alpha-Full.software/);
  assert.doesNotMatch(r.stdout, /NOT READY: no software/);
  assert.match(r.stdout, /built: dist\\index\.html/);
  assert.doesNotMatch(r.stdout, /NOT READY: no frontend/);
});

test('what send-alpha-data packs, receive-alpha-data accepts: leftovers stay behind, no configuration travels', { skip }, () => {
  const scripts = join(import.meta.dirname, '..', 'scripts');
  const base = mkdtempSync(join(tmpdir(), 'roundtrip-'));
  const root = join(base, 'laptop41');
  mkdirSync(join(root, 'memory', 'local', 'pytest-fleet'), { recursive: true });
  mkdirSync(join(root, 'memory', 'local', 'agent-manager'), { recursive: true });
  writeFileSync(join(root, 'memory', 'local', 'agent-manager', 'manager-status.json'), '{"agents":1}');
  writeFileSync(join(root, 'memory', 'local', 'pytest-fleet', 'junk.bin'), 'x'.repeat(1000));
  writeFileSync(join(root, '.env.local'), 'OWNER_PASSWORD=do-not-print\n');
  const outbox = join(base, 'outbox');
  let r = pwsh([join(scripts, 'send-alpha-data.ps1'), '-Root', root, '-Outbox', outbox, '-NoSend']);
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(readdirSync(outbox).filter((n) => /env/i.test(n)), [], 'no configuration file is packed');
  assert.equal(readFileSync(join(root, '.env.local'), 'utf8'), 'OWNER_PASSWORD=do-not-print\n', 'the source is never changed');

  const host = join(base, 'host');
  mkdirSync(join(host, 'software', 'backend'), { recursive: true });
  writeFileSync(join(host, 'software', 'backend', 'main.py'), '');
  r = pwsh([join(scripts, 'receive-alpha-data.ps1'), '-Target', host, '-Inbox', outbox, '-NoFetch']);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(readFileSync(join(host, 'memory', 'local', 'agent-manager', 'manager-status.json'), 'utf8'), '{"agents":1}');
  assert.ok(!readdirSync(join(host, 'memory', 'local')).includes('pytest-fleet'), 'test leftovers are not moved');
  assert.ok(!readdirSync(host).includes('.env.local'), '.env.local goes by USB, never with the data');
});

test('a status channel that goes quiet is reported once by the watcher, and its return once more', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-watch-'));
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  const ctl = join(dir, 'ctl');
  git(dir, 'init', '-q', '--bare', remote);
  git(dir, 'clone', '-q', remote, work);
  git(work, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(work, 'scripts'));
  for (const f of ['autopilot.ps1', 'self-update.mjs', 'channel-watch.mjs']) copyFileSync(join(import.meta.dirname, '..', 'scripts', f), join(work, 'scripts', f));
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'init');
  git(work, 'push', '-q', 'origin', 'main');
  git(dir, 'clone', '-q', remote, ctl);
  let n = 0;
  const branch = (name, iso, file = 'r.md') => {
    git(ctl, 'checkout', '-q', '--orphan', `local-${n++}`);
    git(ctl, 'rm', '-rq', '--cached', '.', '--ignore-unmatch');
    writeFileSync(join(ctl, file), `${name} ${iso}`);
    git(ctl, 'add', file);
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', name], { cwd: ctl, env: { ...process.env, GIT_COMMITTER_DATE: iso, GIT_AUTHOR_DATE: iso } });
    git(ctl, 'push', '-q', 'origin', `+HEAD:refs/heads/${name}`); // a test remote: a new orphan each time
  };
  const nowIso = new Date().toISOString();
  branch('status/fresh', nowIso);
  branch('status/quiet', new Date(Date.now() - 3 * 3600 * 1000).toISOString());
  git(ctl, 'checkout', '-q', '--orphan', 'control/laptop41');
  git(ctl, 'rm', '-rq', '--cached', '.', '--ignore-unmatch');
  writeFileSync(join(ctl, 'actions.json'), JSON.stringify({ actions: [], autofix: { channelWatch: { channels: 'fresh:30,quiet:45' } } }));
  git(ctl, 'add', 'actions.json');
  git(ctl, 'commit', '-qm', 'control');
  git(ctl, 'push', '-q', 'origin', 'control/laptop41');

  const ops = join(dir, 'ops');
  const alpha = join(dir, 'alpha');
  mkdirSync(join(alpha, 'software'), { recursive: true });
  const run = () => spawnSync(PWSH, ['-NoProfile', '-Command', `& '${join(work, 'scripts', 'autopilot.ps1')}' -OpsDir '${ops}' -AlphaRoot '${join(alpha, 'software')}'; exit $LASTEXITCODE`],
    { encoding: 'utf8', env: { ...process.env, COMPUTERNAME: 'DESKTOP-41HPLCN' } });
  const report = () => git(remote, 'show', 'status/laptop41-autopilot:reports/autopilot.md');

  let r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /channel watch: 2 \(a channel went quiet\)/);
  assert.match(report(), /channel-watch \(standing\)\s+->\s+2 \(a channel went quiet\)[\s\S]*SILENT: status\/quiet/);

  r = run();
  assert.doesNotMatch(r.stdout, /channel watch:/, 'the same silence is not reported again');

  branch('status/quiet', new Date().toISOString());
  r = run();
  assert.match(r.stdout, /channel watch: 0 \(every channel talking\)/);
});

test('chat-task adds chat to self-heal\'s configuration and keeps everything else', { skip }, () => {
  const ops = mkdtempSync(join(tmpdir(), 'chat-task-'));
  // Written by Windows PowerShell 5.1: with a BOM, which JSON.parse refuses.
  writeFileSync(join(ops, 'selfheal.json'), '\uFEFF' + JSON.stringify({ stateDir: 'x', backend: { url: 'http://a' }, frontend: { url: 'http://b' }, cooldownMs: 300000 }));
  const r = pwsh([join(import.meta.dirname, '..', 'scripts', 'chat-task.ps1'), '-OpsDir', ops, '-ConfigOnly']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const raw = readFileSync(join(ops, 'selfheal.json'), 'utf8');
  assert.notEqual(raw.charCodeAt(0), 0xfeff, 'written without a BOM');
  const json = JSON.parse(raw);
  assert.deepEqual(json.chat, { url: 'http://127.0.0.1:11434/api/tags', task: 'Alpha Ollama', port: 11434 });
  assert.equal(json.cooldownMs, 300000);
  assert.equal(json.frontend.url, 'http://b');
});

test('the live report is written every pass, and a stopped self-heal is started again, not too often', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-live-'));
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  const ctl = join(dir, 'ctl');
  git(dir, 'init', '-q', '--bare', remote);
  git(dir, 'clone', '-q', remote, work);
  git(work, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(work, 'scripts'));
  for (const f of ['autopilot.ps1', 'self-update.mjs']) copyFileSync(join(import.meta.dirname, '..', 'scripts', f), join(work, 'scripts', f));
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'init');
  git(work, 'push', '-q', 'origin', 'main');
  git(dir, 'clone', '-q', remote, ctl);
  git(ctl, 'checkout', '-q', '--orphan', 'control/laptop41');
  writeFileSync(join(ctl, 'actions.json'), JSON.stringify({ actions: [], autofix: { heartbeat: true } }));
  git(ctl, 'add', 'actions.json');
  git(ctl, 'commit', '-qm', 'control');
  git(ctl, 'push', '-q', 'origin', 'control/laptop41');

  const ops = join(dir, 'ops');
  const alpha = join(dir, 'alpha');
  mkdirSync(join(alpha, 'software'), { recursive: true });
  mkdirSync(join(alpha, 'memory', 'local', 'deck-liveness'), { recursive: true });
  writeFileSync(join(alpha, 'memory', 'local', 'deck-liveness', 'latest.json'), JSON.stringify({
    checked_at: '2026-10-07T02:30:00+00:00', not_live: ['CrowPanel feed (/panel/crowpanel/state)'],
    // Two checks of one deck (the CrowPanel) are one deck, at its worst verdict.
    sources: [{ source: 'hubs pulse', decks: 'alpha, terminal', verdict: 'LIVE' }, { source: 'site', decks: 'every deck page', verdict: 'LIVE' },
      { source: 'CrowPanel feed (/panel/crowpanel/state)', decks: 'CrowPanel', verdict: 'SETTING' },
      { source: 'CrowPanel display (LAN reads)', decks: 'CrowPanel', verdict: 'STALE' }],
  }));
  mkdirSync(join(ops, 'logs'), { recursive: true });
  const log = join(ops, 'logs', 'selfheal.jsonl');
  const heal = (probes) => writeFileSync(log, `${JSON.stringify({ at: '2026-10-07T02:30:00Z', probes, actions: [], events: [] })}\n`);
  const ok = { ok: true, status: 200 };
  const kicks = join(dir, 'kicks');
  // Stand-ins for the Windows cmdlets: a task that can be started, a backend that answers.
  const fakes = `function Start-ScheduledTask { param($TaskName) Add-Content -LiteralPath '${kicks}' -Value $TaskName }; function Invoke-WebRequest { [pscustomobject]@{ StatusCode = 200 } }; `;
  const run = () => spawnSync(PWSH, ['-NoProfile', '-Command',
    `${fakes}& '${join(work, 'scripts', 'autopilot.ps1')}' -OpsDir '${ops}' -AlphaRoot '${join(alpha, 'software')}'; exit $LASTEXITCODE`],
  { encoding: 'utf8', env: { ...process.env, COMPUTERNAME: 'DESKTOP-41HPLCN' } });
  const live = () => git(remote, 'show', 'status/laptop41-live:reports/live.md');
  const commits = () => git(remote, 'rev-list', '--count', 'status/laptop41-live').trim();

  heal({ backend: ok, frontend: ok, public: ok, control: ok });
  let r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /live report: Alpha LIVE; self-heal RUNNING/);
  let md = live();
  assert.match(md, /^# Alpha is LIVE - DESKTOP-41HPLCN/);
  assert.match(md, /\| Alpha \(backend, site, alpha-ai\.uk\) \| LIVE \| backend 200, site 200, alpha-ai\.uk 200 \(checked by self-heal, 0 min ago\)/);
  assert.match(md, /\| Role \| PRIMARY \| this machine serves Alpha; automatic cover is not installed here \|/);
  assert.match(md, /\| Data copy \| OFF \| no data copy here \(autofix\.dataSync\) \|/);
  assert.match(md, /\| Decks \| 2 live, 1 setting \| not live: CrowPanel: feed \(\/panel\/crowpanel\/state\), display \(LAN reads\) \(checked/);
  const json = JSON.parse(git(remote, 'show', 'status/laptop41-live:reports/live.json').replace(/^﻿/, ''));
  assert.equal(json.alpha.verdict, 'LIVE');

  // Nothing changed, and it still reports: that is what tells a quiet machine from a dead reporter.
  const before = Number(commits());
  r = run();
  assert.match(r.stdout, /nothing new to run/);
  assert.equal(Number(commits()), before + 1);

  // Saving the rollback copy is not a repair; when it fails, the reason is shown.
  writeFileSync(log, `${JSON.stringify({ at: '2026-10-07T02:30:00Z', probes: { backend: ok, frontend: ok, public: ok, control: ok }, actions: [{ component: 'frontend', action: 'snapshot', code: 1, error: 'EPERM: operation not permitted, rename' }], events: [] })}\n`);
  run();
  assert.match(live(), /last pass 0 min ago, 0 repair\(s\) in it; the rollback copy of the site was not saved: EPERM: operation not permitted, rename/);

  // A part that does not answer is named.
  heal({ backend: ok, frontend: { ok: false, status: 502 }, public: ok, control: ok });
  run();
  assert.match(live(), /\| DOWN \| backend 200, site 502, alpha-ai\.uk 200; not answering: site/);

  // Self-heal stopped writing: started again once, not again inside 30 minutes.
  const old = new Date(Date.now() - 20 * 60 * 1000);
  utimesSync(log, old, old);
  r = run();
  md = live();
  assert.match(md, /\| Repair agent \(self-heal\) \| STOPPED \| last pass 20 min ago.*started its task again/);
  assert.match(md, /\| BACKEND UP \| backend 200; site and alpha-ai\.uk unchecked while self-heal is not running/);
  run();
  assert.equal(readFileSync(kicks, 'utf8').trim().split('\n').length, 1, 'one restart per 30 minutes');
  assert.match(live(), /restart already tried at/);

  // Quiet, with the reason on disk: a lock left by a pass that is gone, then
  // a config self-heal cannot read. "STOPPED" alone sent a person to Task Scheduler.
  mkdirSync(join(ops, 'selfheal'), { recursive: true });
  writeFileSync(join(ops, 'selfheal', 'selfheal.lock'), JSON.stringify({ pid: 999999, at: 0 }));
  run();
  assert.match(live(), /\| STOPPED \| last pass 20 min ago[^|]*; a pass has held its lock for \d+ min \(pid 999999, gone\)/);
  writeFileSync(join(ops, 'selfheal.json.error.json'), JSON.stringify({ at: '2026-10-09T12:24:00Z', error: 'Unexpected end of JSON input' }));
  run();
  assert.match(live(), /; it cannot read selfheal\.json \(Unexpected end of JSON input\): run scripts\\repair-alpha-host\.ps1/);

  // A pass that could not finish wrote its line: the page says where it
  // stopped, and does not call the site live on a pass that never probed it.
  writeFileSync(log, `${JSON.stringify({ at: '2026-10-09T12:24:00Z', actions: [], events: [], unfinished: { why: 'still running after 240 s', stage: 'probe', afterSec: 240 } })}\n`);
  run();
  md = live();
  assert.match(md, /\| RUNNING \| last pass 0 min ago, 0 repair\(s\) in it; the last pass did not finish \(still running after 240 s, at probe\)/);
  assert.match(md, /\| BACKEND UP \| backend 200; site and alpha-ai\.uk unchecked while self-heal is not finishing its passes/);

  // A standby: who serves, and no self-heal restart, however old its log.
  writeFileSync(join(ops, 'role.json'), JSON.stringify({ role: 'standby', primary: 'laptop-gj8dfmlk' }));
  const veryOld = new Date(Date.now() - 90 * 60 * 1000);
  utimesSync(log, veryOld, veryOld);
  writeFileSync(kicks, '');
  r = run();
  md = live();
  assert.match(r.stdout, /live report: Alpha STANDBY; self-heal OFF \(standby\)/);
  assert.match(md, /\| Alpha \(backend, site, alpha-ai\.uk\) \| STANDBY \| Alpha serves from laptop-gj8dfmlk: alpha-ai\.uk 200; nothing of Alpha runs here \(checked by this pass\)/);
  assert.match(md, /\| Repair agent \(self-heal\) \| OFF \(standby\) \| off on purpose: another machine serves Alpha/);
  assert.equal(readFileSync(kicks, 'utf8').trim(), '', 'a standby\'s self-heal is off on purpose');
  assert.match(md, /\| Role \| STANDBY \| laptop-gj8dfmlk serves Alpha; automatic cover is NOT INSTALLED: queue standby-install \|/);

  // Phase 3: the automatic cover's last pass is shown, and a stale one called out.
  mkdirSync(join(ops, 'standby'), { recursive: true });
  const coverStatus = join(ops, 'standby', 'status.json');
  writeFileSync(coverStatus, JSON.stringify({ at: 'x', role: 'standby', why: "laptop-gj8dfmlk's Alpha answers" }));
  run();
  assert.match(live(), /\| Role \| STANDBY \| laptop-gj8dfmlk serves Alpha; automatic cover: laptop-gj8dfmlk's Alpha answers \(0 min ago\) \|/);
  const stale = new Date(Date.now() - 12 * 60 * 1000);
  utimesSync(coverStatus, stale, stale);
  run();
  assert.match(live(), /automatic cover is NOT RUNNING \(last pass 12 min ago\)/);

  // Phase 3's data: what was sent and applied, and what waits for data-apply.
  mkdirSync(join(ops, 'data-sync'), { recursive: true });
  writeFileSync(join(ops, 'data-sync', 'state.json'), JSON.stringify({ lastSend: { at: '2026-10-09T18:10:00Z', to: 'laptop-gj8dfmlk', files: 12 }, lastApply: { at: '2026-10-09T18:00:00Z', from: 'LAPTOP-GJ8DFMLK', files: 3, keptNewerHere: 1 }, held: 1 }));
  run();
  assert.match(live(), /\| Data copy \| HELD \| sent 12 file\(s\) to laptop-gj8dfmlk at 2026-10-09T18:10:00Z; applied 3 from LAPTOP-GJ8DFMLK at 2026-10-09T18:00:00Z \(1 newer here kept\); 1 package\(s\) HELD: queue data-apply \|/);
  // a full copy streaming in parts, with files that could not be packed yet
  writeFileSync(join(ops, 'data-sync', 'state.json'), JSON.stringify({ lastSend: { at: '2026-10-09T19:27:00Z', to: 'alpha-serv-01', files: 41, leftBytes: 4513918156, notPacked: 3 } }));
  run();
  assert.match(live(), /\| Data copy \| ON \| sent 41 file\(s\) to alpha-serv-01 at 2026-10-09T19:27:00Z \(4305 MB still to send\) \(3 file\(s\) not packed yet, tried again each pass\) \|/);

  // Covering: this machine serves for the primary, and the page says so.
  writeFileSync(join(ops, 'role.json'), JSON.stringify({ role: 'covering', primary: 'laptop-gj8dfmlk', since: '2026-10-09T18:02:00Z' }));
  writeFileSync(coverStatus, JSON.stringify({ at: 'x', role: 'covering', why: 'covering for laptop-gj8dfmlk since 2026-10-09T18:02:00.000Z' }));
  heal({ backend: ok, frontend: ok, public: ok, control: ok });
  r = run();
  md = live();
  assert.match(md, /\| Alpha \(backend, site, alpha-ai\.uk\) \| LIVE \|/);
  assert.match(md, /\| Role \| COVERING \| this machine serves Alpha for laptop-gj8dfmlk since 2026-10-09T18:02:00Z; automatic cover: covering for laptop-gj8dfmlk/);
});

test('a pass that updates its checkout finishes with the new code, so it is never silent', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-update-'));
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  const dev = join(dir, 'dev');
  git(dir, 'init', '-q', '--bare', remote);
  git(dir, 'clone', '-q', remote, work);
  git(work, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(work, 'scripts'));
  for (const f of ['autopilot.ps1', 'self-update.mjs']) copyFileSync(join(import.meta.dirname, '..', 'scripts', f), join(work, 'scripts', f));
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'init');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  git(dir, 'clone', '-q', '-b', 'main', remote, dev);
  git(dev, 'checkout', '-q', '--orphan', 'control/laptop41');
  git(dev, 'rm', '-rq', '--cached', '.');
  writeFileSync(join(dev, 'actions.json'), JSON.stringify({ actions: [], autofix: { heartbeat: true } }));
  git(dev, 'add', 'actions.json');
  git(dev, 'commit', '-qm', 'control');
  git(dev, 'push', '-q', 'origin', 'control/laptop41');
  git(dev, 'checkout', '-q', '-f', 'main');
  git(dev, 'clean', '-qfd');

  const ops = join(dir, 'ops');
  mkdirSync(join(dir, 'alpha', 'software'), { recursive: true });
  const args = [join(work, 'scripts', 'autopilot.ps1'), '-OpsDir', ops, '-AlphaRoot', join(dir, 'alpha', 'software')];
  const env = { COMPUTERNAME: 'DESKTOP-41HPLCN' };
  let r = pwsh(args, env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const reports = () => Number(git(remote, 'rev-list', '--count', 'status/laptop41-live').trim());
  const before = reports();

  // Main moves while the machine is between passes: the next pass updates.
  const script = readFileSync(join(dev, 'scripts', 'autopilot.ps1'), 'utf8');
  writeFileSync(join(dev, 'scripts', 'autopilot.ps1'), script.replace("$ErrorActionPreference = 'Continue'", "$ErrorActionPreference = 'Continue'\nWrite-Host 'running the v2 code'"));
  git(dev, 'commit', '-qam', 'v2');
  git(dev, 'push', '-q', 'origin', 'main');

  r = pwsh(args, env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /updated this checkout; running the rest of this pass with the new code/);
  assert.match(r.stdout, /running the v2 code/, 'the rest of the pass is the new code');
  assert.equal(reports(), before + 1, 'and it still wrote its live report');
  assert.equal((r.stdout.match(/updated this checkout/g) || []).length, 1, 'it updates once, not in a loop');
});

// Worker1 kept a second `vite preview` tree (pid 6508) after the Alpha task's
// restart; stop-stray-site takes it and must never take the tree on 4173.
test('stop-stray-site stops only a preview tree that does not hold the port', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'stray-site-'));
  const file = join(dir, 'procs.json');
  const node = (pid, parent, cmd, mb = 50) => ({ pid, parent, name: 'node.exe', cmd, mb });
  writeFileSync(file, JSON.stringify([
    { pid: 4, parent: 0, name: 'System', cmd: '', mb: 1 },
    { pid: 900, parent: 4, name: 'svchost.exe', cmd: 'svchost', mb: 10 },
    { pid: 100, parent: 900, name: 'cmd.exe', cmd: 'cmd.exe /c "C:\\ProgramData\\AlphaBoot\\run-alpha.cmd"', mb: 3 },
    node(11396, 100, '"node" "C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" run preview'),
    { pid: 20808, parent: 11396, name: 'cmd.exe', cmd: 'cmd.exe /d /s /c vite preview --port 4173', mb: 3 },
    node(12448, 20808, '"node" "C:\\A\\frontend\\node_modules\\vite\\bin\\vite.js" preview --port 4173', 90),
    node(17388, 900, '"node" "C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" run preview'),
    node(6508, 17388, '"node" "C:\\A\\frontend\\node_modules\\vite\\bin\\vite.js" preview', 60),
    { pid: 6600, parent: 6508, name: 'esbuild.exe', cmd: 'esbuild --service', mb: 20 },
    node(7000, 900, '"node" "C:\\B\\frontend\\node_modules\\vite\\bin\\vite.js" --port 5173', 70),
  ]));
  const planFor = (...holders) => {
    const args = [join(import.meta.dirname, '..', 'scripts', 'stop-stray-site.ps1'), '-ProcessesJson', file];
    if (holders.length) args.push('-Holders', holders.join(','));
    const r = pwsh(args);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };

  const plan = planFor(12448);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.live.map((t) => t.pid), [20808], 'the tree whose node holds 4173 is live');
  assert.deepEqual(plan.stop.map((t) => t.pid), [17388], 'the leftover goes, with the npm run preview that waits on it');
  assert.equal(plan.stop[0].processes, 2);
  assert.deepEqual(plan.leave.map((t) => t.pid), [7000], 'a vite dev server is left to whoever is using it');

  // Turned around, the rule turns around with it: it is the port, not the pid.
  assert.deepEqual(planFor(6508).stop.map((t) => t.pid), [11396]);

  for (const [holders, reason] of [[[], /nothing listens/], [[900], /svchost\.exe 900, not a vite process/]]) {
    const p = planFor(...holders);
    assert.equal(p.ok, false);
    assert.match(p.reason, reason);
    assert.deepEqual(p.stop, [], 'without a live tree to tell it from, nothing is stopped');
  }
});

// The owner, 2026-10-07: Alpha checks her decks one by one and reports in the
// tunnel. Each new deck-audit report goes into the autopilot report once.
test("Alpha's deck audit reaches the tunnel once per report", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-audit-'));
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  const ctl = join(dir, 'ctl');
  git(dir, 'init', '-q', '--bare', remote);
  git(dir, 'clone', '-q', remote, work);
  git(work, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(work, 'scripts'));
  for (const f of ['autopilot.ps1', 'self-update.mjs']) copyFileSync(join(import.meta.dirname, '..', 'scripts', f), join(work, 'scripts', f));
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'init');
  git(work, 'push', '-q', 'origin', 'main');
  git(dir, 'clone', '-q', remote, ctl);
  git(ctl, 'checkout', '-q', '--orphan', 'control/laptop41');
  writeFileSync(join(ctl, 'actions.json'), JSON.stringify({ actions: [] }));
  git(ctl, 'add', 'actions.json');
  git(ctl, 'commit', '-qm', 'control');
  git(ctl, 'push', '-q', 'origin', 'control/laptop41');

  const ops = join(dir, 'ops');
  const alpha = join(dir, 'alpha');
  mkdirSync(join(alpha, 'software'), { recursive: true });
  const folder = join(alpha, 'memory', 'local', 'deck-audit');
  mkdirSync(folder, { recursive: true });
  const write = (at, verdict) => writeFileSync(join(folder, 'latest.json'), JSON.stringify({
    checked_at: at, machine: 'DESKTOP-41HPLCN', counts: { WORKING: 1, [verdict]: 1 },
    decks: [
      { deck: 'core', verdict: 'WORKING', why: 'answers with data', content: { keys: 3, lists: { agents: 4 } }, fixes: [] },
      { deck: 'phone', verdict, why: 'answered 500', content: null, fixes: ['retry: still broken'] },
    ],
  }));
  const run = () => spawnSync(PWSH, ['-NoProfile', '-Command',
    `& '${join(work, 'scripts', 'autopilot.ps1')}' -OpsDir '${ops}' -AlphaRoot '${join(alpha, 'software')}'; exit $LASTEXITCODE`],
  { encoding: 'utf8', env: { ...process.env, COMPUTERNAME: 'DESKTOP-41HPLCN' } });
  const report = () => git(remote, 'show', 'status/laptop41-autopilot:reports/autopilot.md');

  write('2026-10-07T21:50:00+00:00', 'BROKEN');
  let r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /deck audit \(Alpha\): 1 working, 0 empty, 1 broken/);
  let md = report();
  assert.match(md, /deck-audit \(Alpha\) {2}-> {2}2 \(1 working, 0 empty, 1 broken\)/);
  assert.match(md, /WORKING core: answers with data \(agents 4\)/);
  assert.match(md, /BROKEN {2}phone: answered 500 \(nothing read\) {2}\[retry: still broken\]/);

  r = run();
  assert.doesNotMatch(r.stdout, /deck audit \(Alpha\)/, 'the same report is not posted twice');

  write('2026-10-07T22:20:00+00:00', 'EMPTY');
  r = run();
  assert.match(r.stdout, /deck audit \(Alpha\): 1 working, 1 empty, 0 broken/);
});

// On 2026-10-09 a file in the full copy was too big for the standing check's
// 15 minutes, so every pass timed out and held the live page. The copy now runs
// as its own task, 'Alpha Data Copy', and the pass only reports it.
test('with the copy as its own task, the pass never copies, and reports each finished run once', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-dstask-'));
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  const ctl = join(dir, 'ctl');
  git(dir, 'init', '-q', '--bare', remote);
  git(dir, 'clone', '-q', remote, work);
  git(work, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(work, 'scripts'));
  for (const f of ['autopilot.ps1', 'self-update.mjs']) copyFileSync(join(import.meta.dirname, '..', 'scripts', f), join(work, 'scripts', f));
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'init');
  git(work, 'push', '-q', 'origin', 'main');
  git(dir, 'clone', '-q', remote, ctl);
  git(ctl, 'checkout', '-q', '--orphan', 'control/laptop41');
  writeFileSync(join(ctl, 'actions.json'), JSON.stringify({ actions: [], autofix: { dataSync: { peer: 'alpha-serv-01', everyMin: 5 } } }));
  git(ctl, 'add', 'actions.json');
  git(ctl, 'commit', '-qm', 'control');
  git(ctl, 'push', '-q', 'origin', 'control/laptop41');

  const ops = join(dir, 'ops');
  const alpha = join(dir, 'alpha');
  mkdirSync(join(alpha, 'software'), { recursive: true });
  mkdirSync(join(ops, 'data-sync'), { recursive: true });
  const inline = join(dir, 'inline');
  // The task as Task Scheduler would describe it, and a Start-Process that says
  // if the pass tried to copy by itself.
  const fakes = "function Get-ScheduledTask { param($TaskName) if ($TaskName -eq 'Alpha Data Copy') { [pscustomobject]@{ TaskName = $TaskName; State = $env:FAKE_DS_STATE } } }; "
    + 'function Get-ScheduledTaskInfo { param($TaskName) [pscustomobject]@{ LastRunTime = [datetime]$env:FAKE_DS_RUN; LastTaskResult = [int64]$env:FAKE_DS_RESULT } }; '
    + `function Start-Process { Add-Content -LiteralPath '${inline}' -Value ($args -join ' '); throw 'no inline copy' }; `;
  const run = (env) => spawnSync(PWSH, ['-NoProfile', '-Command',
    `${fakes}& '${join(work, 'scripts', 'autopilot.ps1')}' -OpsDir '${ops}' -AlphaRoot '${join(alpha, 'software')}'; exit $LASTEXITCODE`],
  { encoding: 'utf8', env: { ...process.env, COMPUTERNAME: 'DESKTOP-41HPLCN', ...env } });
  const report = () => git(remote, 'show', 'status/laptop41-autopilot:reports/autopilot.md');
  const taskLog = (text) => writeFileSync(join(ops, 'data-sync', 'task-last.log'), text);

  taskLog('DATA SYNC DESKTOP-41HPLCN 2026-10-10 00:40\n  SENT 1 file(s), 812.0 MB written since 2026-08-13T04:24:38Z, to alpha-serv-01\n');
  let r = run({ FAKE_DS_STATE: 'Ready', FAKE_DS_RUN: '2026-10-10T00:30:00', FAKE_DS_RESULT: '0' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /data sync task: 0 \(in step\)/);
  assert.match(report(), /data-sync \(task 'Alpha Data Copy', run at 2026-10-10T00:30:00\)\s+->\s+0 \(in step\)/);
  assert.match(report(), /SENT 1 file\(s\), 812\.0 MB written since 2026-08-13T04:24:38Z, to alpha-serv-01/);

  // The same run is not news; a run still going is reported when it ends; one
  // that never ran is not a failure.
  r = run({ FAKE_DS_STATE: 'Ready', FAKE_DS_RUN: '2026-10-10T00:30:00', FAKE_DS_RESULT: '0' });
  assert.doesNotMatch(r.stdout, /data sync task/);
  r = run({ FAKE_DS_STATE: 'Running', FAKE_DS_RUN: '2026-10-10T00:40:00', FAKE_DS_RESULT: '267009' });
  assert.doesNotMatch(r.stdout, /data sync task/);
  r = run({ FAKE_DS_STATE: 'Ready', FAKE_DS_RUN: '1999-11-30T00:00:00', FAKE_DS_RESULT: '267011' });
  assert.doesNotMatch(r.stdout, /data sync task/);

  taskLog('DATA SYNC DESKTOP-41HPLCN 2026-10-10 00:50\n  NOT SENT: alpha-serv-01 is offline (tailscale status)\n');
  r = run({ FAKE_DS_STATE: 'Ready', FAKE_DS_RUN: '2026-10-10T00:50:00', FAKE_DS_RESULT: '1' });
  assert.match(r.stdout, /data sync task: 1 \(failed\)/);
  assert.match(report(), /NOT SENT: alpha-serv-01 is offline/);

  assert.equal(readdirSync(dir).includes('inline'), false, 'the pass never ran the copy itself while the task exists');
});

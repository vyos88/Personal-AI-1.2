import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
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
    { id: 'p1', do: 'panel-endpoint', url: 'http://evil:1' },
    { id: 's1', do: 'stop-stray-site', pid: 12448, port: 8001 },
  ] }));
  const r = pwsh([SCRIPT, '-Plan', file, '-AlphaRoot', 'C:\\A\\software']);
  assert.equal(r.status, 0, r.stderr);
  const plan = Object.fromEntries(JSON.parse(r.stdout).map((p) => [p.id, p]));
  assert.deepEqual(Object.values(plan).filter((p) => p.ok).map((p) => p.id), ['a1', 'a2', 'a4', 'a7', 'a9', 'b1', 'c1', 'c2', 'd1', 'd2', 'e1', 'e2', 'f1', 'g1', 'g2', 'h1', 'h2', 'i1', 'i2', 'i3', 'p1', 's1']);
  assert.match(plan.s1.args.at(-1), /stop-stray-site\.ps1$/, 'no pid or port from the payload: the live tree is read off the machine');
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
  assert.match(plan.i3.args.at(-1), /prepare-alpha-here\.ps1$/, 'no target, branch or anything else from the payload');
  assert.equal(plan.i3.timeoutMin, 90);
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

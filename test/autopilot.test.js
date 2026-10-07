import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
    { id: 'p1', do: 'panel-endpoint', url: 'http://evil:1' },
  ] }));
  const r = pwsh([SCRIPT, '-Plan', file, '-AlphaRoot', 'C:\\A\\software']);
  assert.equal(r.status, 0, r.stderr);
  const plan = Object.fromEntries(JSON.parse(r.stdout).map((p) => [p.id, p]));
  assert.deepEqual(Object.values(plan).filter((p) => p.ok).map((p) => p.id), ['a1', 'a2', 'a4', 'a7', 'a9', 'b1', 'c1', 'c2', 'd1', 'd2', 'e1', 'e2', 'f1', 'g1', 'g2', 'h1', 'p1']);
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

test('doubled line ends in Alpha are repaired every pass, and reported once', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-eol-'));
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  git(dir, 'init', '-q', '--bare', remote);
  git(dir, 'clone', '-q', remote, work);
  git(work, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(work, 'scripts'));
  for (const f of ['autopilot.ps1', 'self-update.mjs', 'fix-line-endings.mjs']) copyFileSync(join(import.meta.dirname, '..', 'scripts', f), join(work, 'scripts', f));
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'init');
  git(work, 'push', '-q', 'origin', 'main');

  // Worker1's shape: software\ with Alpha's scripts\ beside it, and the
  // manager script as apply-alpha-update.mjs left it on 2026-10-06.
  const sw = join(dir, 'software');
  mkdirSync(join(sw, 'frontend'), { recursive: true });
  writeFileSync(join(sw, 'frontend', 'package.json'), '{}');
  mkdirSync(join(dir, 'scripts'));
  const manager = join(dir, 'scripts', 'alpha_agent_manager.ps1');
  writeFileSync(manager, 'Get-Thing -WorkerId $id `\r\r\n    -ReceiptStatus $s\r\r\n');
  const args = [join(work, 'scripts', 'autopilot.ps1'), '-OpsDir', join(dir, 'ops'), '-AlphaRoot', sw];
  const env = { COMPUTERNAME: '' };

  const first = pwsh(args, env);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /line endings: 0 \(repaired\)/);
  assert.equal(readFileSync(manager, 'utf8'), 'Get-Thing -WorkerId $id `\r\n    -ReceiptStatus $s\r\n');
  const report = git(remote, 'show', 'status/laptop41-autopilot:reports/autopilot.md');
  assert.match(report, /auto-line-endings-\S+ {2}line-endings \(standing\) {2}-> {2}0 \(repaired\)/);
  assert.match(report, /FIXED: scripts.alpha_agent_manager\.ps1/);
  // Clean is not news.
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

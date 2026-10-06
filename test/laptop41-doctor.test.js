import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

// scripts/laptop41-doctor.ps1 needs PowerShell. Set PWSH to its path, or have
// pwsh on PATH; without it these tests are skipped, not failed.
const PWSH = process.env.PWSH || 'pwsh';
const hasPwsh = !spawnSync(PWSH, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).error;
const skip = hasPwsh ? false : 'PowerShell not found (set PWSH)';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

test('the scheduled doctor finds scripts\\ beside software\\ and relays both cloud branches', { skip, timeout: 300_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-relay-'));
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  git(dir, 'init', '-q', '--bare', remote);
  git(dir, 'clone', '-q', remote, work);
  git(work, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(work, 'scripts'));
  copyFileSync(join(import.meta.dirname, '..', 'scripts', 'laptop41-doctor.ps1'), join(work, 'scripts', 'laptop41-doctor.ps1'));
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'init');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-q', '--orphan', 'status/cloud');
  git(work, 'rm', '-rq', '--cached', '.');
  mkdirSync(join(work, 'reports'));
  writeFileSync(join(work, 'reports', 'cloud.md'), 'Claude (cloud) report, test\n');
  git(work, 'add', 'reports/cloud.md');
  git(work, 'commit', '-qm', 'cloud');
  git(work, 'push', '-q', 'origin', 'status/cloud');
  const cloudHead = git(work, 'rev-parse', 'HEAD').trim();
  git(work, 'checkout', '-q', '--orphan', 'status/claude-laptop41');
  git(work, 'rm', '-rq', '--cached', '.');
  writeFileSync(join(work, 'reports', 'handoff.md'), '# Claude handoff, test\n');
  git(work, 'add', 'reports/handoff.md');
  git(work, 'commit', '-qm', 'handoff');
  git(work, 'push', '-q', 'origin', 'status/claude-laptop41');
  const handoffHead = git(work, 'rev-parse', 'HEAD').trim();
  git(work, 'checkout', '-q', '-f', 'main');
  git(work, 'clean', '-qfd');

  // Laptop41's layout: the schedule passes software\ as -AlphaRoot, and
  // Alpha's coordination script sits in scripts\ beside it. A stand-in
  // records what would have been posted.
  const app = join(dir, 'app');
  mkdirSync(join(app, 'software', 'backend'), { recursive: true });
  mkdirSync(join(app, 'scripts'));
  const posts = join(app, 'scripts', 'posts.log');
  writeFileSync(join(app, 'scripts', 'alpha_coordination_tunnel.ps1'),
    'param([string]$Action, [string]$Actor, [string]$Message)\n' +
    'Add-Content -Path (Join-Path $PSScriptRoot "posts.log") -Value "$Action|$Actor|$($Message.Split("`n")[0])"\n' +
    'exit 0\n');
  // The doctor calls powershell.exe by name.
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'powershell.exe'), `#!/bin/sh\nexec "${PWSH}" "$@"\n`);
  chmodSync(join(bin, 'powershell.exe'), 0o755);
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
  const ops = join(dir, 'ops');
  const args = ['-NoProfile', '-File', join(work, 'scripts', 'laptop41-doctor.ps1'), '-Watch', '-AlphaRoot', join(app, 'software'), '-OpsDir', ops];

  const first = spawnSync(PWSH, args, { encoding: 'utf8', env });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.ok(existsSync(posts), `nothing was posted:\n${first.stdout}`);
  const lines = readFileSync(posts, 'utf8').trim().split(/\r?\n/);
  assert.ok(lines.some((l) => /^Post\|alpha-doctor\|Alpha host check/.test(l)), lines.join('\n'));
  assert.ok(lines.includes('Post|claude-cloud|Claude (cloud) report, test'), lines.join('\n'));
  const state = JSON.parse(readFileSync(join(ops, 'doctor-state.json'), 'utf8'));
  assert.ok(lines.includes('Post|claude-laptop41|# Claude handoff, test'), lines.join('\n'));
  assert.equal(state.cloudSeen, cloudHead);
  assert.equal(state.handoffSeen, handoffHead);
  assert.ok(state.lastPost, 'lastPost is recorded');
  assert.match(state.relay, /relayed status\//);

  const pushes = () => Number(git(remote, 'rev-list', '--count', 'status/laptop41').trim());
  const pushedFirst = pushes();
  assert.ok(pushedFirst >= 1, 'the first run pushed status/laptop41');

  // A new handoff arrives while nothing else changed: the relay alone is
  // reason to push, or the cloud session never sees that it got through.
  git(work, 'checkout', '-q', 'status/claude-laptop41');
  writeFileSync(join(work, 'reports', 'handoff.md'), '# Claude handoff, second\n');
  git(work, 'commit', '-qam', 'handoff 2');
  git(work, 'push', '-q', 'origin', 'status/claude-laptop41');
  const handoff2 = git(work, 'rev-parse', 'HEAD').trim();
  git(work, 'checkout', '-q', 'main');

  // The same reports are relayed once, not every 15 minutes.
  const second = spawnSync(PWSH, args, { encoding: 'utf8', env });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  const again = readFileSync(posts, 'utf8').trim().split(/\r?\n/);
  assert.equal(again.filter((l) => l.startsWith('Post|claude-cloud|')).length, 1);
  assert.equal(again.filter((l) => l.startsWith('Post|claude-laptop41|')).length, 2);
  assert.ok(again.includes('Post|claude-laptop41|# Claude handoff, second'), again.join('\n'));
  assert.equal(pushes(), pushedFirst + 1, 'the new relay was pushed');
  const pushedState = JSON.parse(git(remote, 'show', 'status/laptop41:reports/doctor-state.json'));
  assert.equal(pushedState.handoffSeen, handoff2);

  // Nothing new: nothing relayed again.
  const third = spawnSync(PWSH, args, { encoding: 'utf8', env });
  assert.equal(third.status, 0, third.stdout + third.stderr);
  assert.equal(readFileSync(posts, 'utf8').trim().split(/\r?\n/).filter((l) => l.startsWith('Post|claude-')).length, 3);
});

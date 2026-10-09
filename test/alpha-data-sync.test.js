import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// scripts/alpha-data-sync.ps1 needs PowerShell. Set PWSH to its path, or have
// pwsh on PATH; without it these tests are skipped, not failed.
const PWSH = process.env.PWSH || 'pwsh';
const hasPwsh = !spawnSync(PWSH, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).error;
const skip = hasPwsh ? false : 'PowerShell not found (set PWSH)';
const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'alpha-data-sync.ps1');

// Taildrop between two folders: `file cp` drops the files into the peer's
// folder, `file get` moves this machine's into the inbox. And a backend that
// answers or not, and the two tasks data-apply touches.
const FAKES = String.raw`
function tailscale {
  if ($args[0] -eq 'status') {
    # every machine the tests use, online unless FAKE_OFFLINE names it
    $peers = @{}
    foreach ($n in 'laptop-gj8dfmlk', 'desktop-41hplcn', 'alpha-server-01') {
      $peers["nodekey:$n"] = @{ HostName = $n.ToUpper(); DNSName = "$n.tail1.ts.net."; Online = ($env:FAKE_OFFLINE -ne $n) }
    }
    $global:LASTEXITCODE = 0
    return (@{ BackendState = 'Running'; Peer = $peers } | ConvertTo-Json -Depth 4)
  }
  if ($args[0] -eq 'file' -and $args[1] -eq 'cp') {
    $peer = ([string]$args[-1]).TrimEnd(':')
    $to = Join-Path $env:FAKE_TAILDROP $peer
    New-Item -ItemType Directory -Force -Path $to | Out-Null
    foreach ($f in $args[2..($args.Count - 2)]) { Copy-Item -LiteralPath $f -Destination $to }
    if ($env:FAKE_TAILDROP_FAILS) { $global:LASTEXITCODE = 1; 'peer is offline' } else { $global:LASTEXITCODE = 0 }
  } elseif ($args[0] -eq 'file' -and $args[1] -eq 'get') {
    $mine = Join-Path $env:FAKE_TAILDROP $env:FAKE_ME
    if (Test-Path $mine) { Get-ChildItem $mine -File | Move-Item -Destination $args[-1] }
    $global:LASTEXITCODE = 0
  }
}
function Invoke-WebRequest { if ($env:FAKE_SERVING -eq '1') { [pscustomobject]@{ StatusCode = 200 } } else { throw 'refused' } }
function Stop-ScheduledTask { param($TaskName) Add-Content -LiteralPath $env:FAKE_TASKLOG -Value "stop $TaskName" }
function Start-ScheduledTask { param($TaskName) Add-Content -LiteralPath $env:FAKE_TASKLOG -Value "start $TaskName" }
function Get-NetTCPConnection { }
`;

function machine(root, name) {
  const home = join(root, name);
  mkdirSync(join(home, 'software', 'backend'), { recursive: true });
  mkdirSync(join(home, 'memory', 'chats'), { recursive: true });
  const ops = join(root, `${name}-ops`);
  const inbox = join(root, `${name}-inbox`);
  const run = (args = [], env = {}) => {
    const r = spawnSync(PWSH, ['-NoProfile', '-Command', `${FAKES}; & '${SCRIPT}' -OpsDir '${ops}' -AlphaRoot '${join(home, 'software')}' -Inbox '${inbox}' ${args.join(' ')}; exit $LASTEXITCODE`],
      { encoding: 'utf8', env: { ...process.env, FAKE_TAILDROP: join(root, 'taildrop'), FAKE_ME: name, FAKE_TASKLOG: join(root, `${name}-tasks.log`), COMPUTERNAME: name.toUpperCase(), ...env } });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const write = (rel, body, mtimeMs) => {
    const p = join(home, 'memory', rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
    if (mtimeMs) utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
    return p;
  };
  const read = (rel) => readFileSync(join(home, 'memory', rel), 'utf8');
  const has = (rel) => existsSync(join(home, 'memory', rel));
  return { home, ops, inbox, run, write, read, has, name };
}

const serving = { FAKE_SERVING: '1' };
const later = (min) => Date.now() + min * 60_000;

test('the serving machine sends what changed, the other applies it, and nothing comes back', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'data-sync-'));
  const host = machine(root, 'laptop-gj8dfmlk');
  const w1 = machine(root, 'desktop-41hplcn');
  const old = Date.now() - 2 * 86400_000;
  host.write('chats/old.json', 'v1', old);
  w1.write('chats/old.json', 'v1', old);

  let r = host.run(['-Peer', 'desktop-41hplcn'], serving);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /baseline set to .*: from now on, what changes here goes to desktop-41hplcn/);

  host.write('chats/new.json', 'hello', later(1));
  host.write('chats/old.json', 'v2', later(1));
  host.write('local/pytest-123/junk.txt', 'x', later(1));
  host.write('k/__pycache__/m.pyc', 'x', later(1));
  r = host.run(['-Peer', 'desktop-41hplcn'], serving);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /SENT 2 file\(s\)/, 'test leftovers and caches stay behind');

  // Worker1 is the standby: it does not serve, so it applies and sends nothing.
  r = w1.run(['-Peer', 'laptop-gj8dfmlk']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /APPLIED alpha-data-laptop-gj8dfmlk-.*: 2 file\(s\) written \(1 replaced, kept under data-sync\\replaced\\/);
  assert.equal(w1.read('chats/new.json'), 'hello');
  assert.equal(w1.read('chats/old.json'), 'v2');
  // tar keeps whole seconds, so to the second
  assert.ok(Math.abs(statSync(join(w1.home, 'memory', 'chats', 'new.json')).mtimeMs - statSync(join(host.home, 'memory', 'chats', 'new.json')).mtimeMs) < 1000, 'the time travels with the file');
  assert.equal(w1.has('local/pytest-123/junk.txt'), false);
  const replacedDir = join(w1.ops, 'data-sync');
  const kept = readdirSync(replacedDir).includes('replaced');
  assert.ok(kept, 'the replaced file is kept, never deleted');
  assert.match(r.out, /baseline set to/, 'its own first send pass only sets a baseline');

  // Even serving, Worker1 does not send back what it only received.
  r = w1.run(['-Peer', 'laptop-gj8dfmlk', '-NoReceive'], serving);
  assert.match(r.out, /nothing written here since/);
  r = host.run(['-Peer', 'desktop-41hplcn'], serving);
  assert.match(r.out, /nothing written here since/);
  assert.match(r.out, /nothing received/);
});

test('a file newer on the receiving side is kept, and counted', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'data-sync-'));
  const host = machine(root, 'laptop-gj8dfmlk');
  const w1 = machine(root, 'desktop-41hplcn');
  host.run(['-Peer', 'desktop-41hplcn'], serving);
  host.write('notes.json', 'from the host', later(1));
  w1.write('notes.json', 'written here later', later(5));
  host.run(['-Peer', 'desktop-41hplcn'], serving);
  const r = w1.run();
  assert.match(r.out, /0 file\(s\) written \(0 replaced.*\), 0 already the same, 1 newer here and kept/);
  assert.equal(w1.read('notes.json'), 'written here later');
});

test('nothing is applied under a running Alpha: it is held, and data-apply stops the backend, applies and starts it', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'data-sync-'));
  const w1 = machine(root, 'desktop-41hplcn');
  const host = machine(root, 'laptop-gj8dfmlk');
  // Worker1 covered and handed back: its last changes go to the Host, which serves.
  w1.run(['-Peer', 'laptop-gj8dfmlk'], serving);
  w1.write('chats/during-the-outage.json', 'covered', later(1));
  let r = w1.run(['-Peer', 'laptop-gj8dfmlk']);
  assert.match(r.out, /SENT 1 file\(s\)/, 'it stopped serving, and still sends what it wrote while it served');
  r = w1.run(['-Peer', 'laptop-gj8dfmlk']);
  assert.match(r.out, /not serving here, and nothing unsent from when it did: nothing to send/);

  r = host.run([], serving);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /HELD: alpha-data-desktop-41hplcn-.*\(1 file\(s\)\): Alpha serves here, so it waits for the data-apply job/);
  assert.equal(host.has('chats/during-the-outage.json'), false);

  r = host.run(['-ApplyHeld'], serving);
  assert.equal(r.code, 0, r.out);
  assert.equal(host.read('chats/during-the-outage.json'), 'covered');
  const tasks = readFileSync(join(root, 'laptop-gj8dfmlk-tasks.log'), 'utf8').trim().split(/\r?\n/);
  assert.deepEqual(tasks, ['stop Alpha Backend', 'start Alpha Backend']);
});

test('a package that does not match its manifest, or reaches outside memory\\, changes nothing', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'data-sync-'));
  const host = machine(root, 'laptop-gj8dfmlk');
  const w1 = machine(root, 'desktop-41hplcn');
  host.run(['-Peer', 'desktop-41hplcn'], serving);
  host.write('a.json', 'a', later(1));
  host.run(['-Peer', 'desktop-41hplcn'], serving);
  const drop = join(root, 'taildrop', 'desktop-41hplcn');
  const tarFile = readdirSync(drop).find((f) => f.endsWith('.tar'));
  writeFileSync(join(drop, tarFile), 'tampered');
  let r = w1.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /REFUSED: alpha-data-.*\.tar does not match its manifest/);
  assert.equal(w1.has('a.json'), false);

  // An archive with a path outside memory\, under a manifest that matches it.
  const evil = mkdtempSync(join(tmpdir(), 'data-sync-evil-'));
  mkdirSync(join(evil, 'evil'));
  writeFileSync(join(evil, 'evil', 'x.txt'), 'x');
  const evilTar = join(w1.inbox, 'alpha-data-evil-1.tar');
  execFileSync('tar', ['-cf', evilTar, '-C', evil, 'evil']);
  const sha = execFileSync('sha256sum', [evilTar], { encoding: 'utf8' }).split(' ')[0];
  writeFileSync(join(w1.inbox, 'alpha-data-evil-1.json'), JSON.stringify({ from: 'X', files: 1, archive: { name: 'alpha-data-evil-1.tar', bytes: statSync(evilTar).size, sha256: sha } }));
  r = w1.run(['-NoFetch']);
  assert.match(r.out, /REFUSED: alpha-data-evil-1\.tar holds paths outside memory\\ \(\d+\); nothing applied/);
  assert.equal(existsSync(join(w1.home, 'evil')), false);
});

test('a send Taildrop could not deliver is sent again next time, and -Since starts from an older copy', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'data-sync-'));
  const w1 = machine(root, 'desktop-41hplcn');
  // The Host's copy is from 2026-10-07: everything Worker1 wrote since goes.
  w1.write('chats/oct8.json', 'x', Date.parse('2026-10-08T12:00:00Z'));
  w1.write('chats/oct6.json', 'y', Date.parse('2026-10-06T12:00:00Z'));
  let r = w1.run(['-Peer', 'laptop-gj8dfmlk', '-Since', '2026-10-07T21:00:00Z'], { ...serving, FAKE_TAILDROP_FAILS: '1' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /baseline set to 2026-10-07T21:00:00Z \(-Since\)/);
  assert.match(r.out, /NOT SENT: 1 file\(s\) wait for the next pass/);
  r = w1.run(['-Peer', 'laptop-gj8dfmlk'], serving);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /SENT 1 file\(s\), .* written since 2026-10-07T21:00:00Z, to laptop-gj8dfmlk/);
});

test('a peer that is offline or not on the tailnet is reported at once, and nothing is packed', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'data-sync-'));
  const w1 = machine(root, 'desktop-41hplcn');
  w1.run(['-Peer', 'laptop-gj8dfmlk'], serving);
  w1.write('chats/a.json', 'a', later(1));
  // the Host had gone dark: on 2026-10-09 a send to it held Worker1's pass
  let r = w1.run(['-Peer', 'laptop-gj8dfmlk'], { ...serving, FAKE_OFFLINE: 'laptop-gj8dfmlk' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NOT SENT: laptop-gj8dfmlk is offline \(tailscale status\); 1 file\(s\), .* MB wait for it/);
  assert.equal(existsSync(join(root, 'taildrop', 'laptop-gj8dfmlk')), false, 'nothing was handed to Taildrop');
  r = w1.run(['-Peer', 'no-such-machine'], serving);
  assert.match(r.out, /NOT SENT: no-such-machine is not on this tailnet \(tailscale status\)/);
  r = w1.run(['-Peer', 'laptop-gj8dfmlk'], serving);
  assert.match(r.out, /SENT 1 file\(s\)/, 'once it is back, what waited goes');
});

test('a backlog over the cap is left for a data-sync job, which sends it whole', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'data-sync-'));
  const w1 = machine(root, 'desktop-41hplcn');
  w1.write('big.bin', 'x'.repeat(4096), Date.parse('2026-10-08T00:00:00Z'));
  let r = w1.run(['-Peer', 'alpha-server-01', '-Since', '2000-01-01T00:00:00Z', '-MaxBytes', '1024'], serving);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /TOO LARGE for this pass: 1 file\(s\), 0\.0 MB written since 2000-01-01T00:00:00Z \(the cap is 0 MB\): queue a data-sync job/);
  r = w1.run(['-Peer', 'alpha-server-01'], serving);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /SENT 1 file\(s\), .* written since 2000-01-01T00:00:00Z, to alpha-server-01/, 'the full copy, from the start of time');
});

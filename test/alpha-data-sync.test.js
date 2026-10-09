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
    foreach ($n in 'laptop-gj8dfmlk', 'desktop-41hplcn', 'alpha-server-01', 'alpha-serv-01') {
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

test('a backlog over the cap goes in parts, oldest first, and the next pass carries on', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'data-sync-'));
  const w1 = machine(root, 'desktop-41hplcn');
  const server = machine(root, 'alpha-serv-01');
  w1.write('a-old.bin', 'a'.repeat(3000), Date.parse('2026-10-01T00:00:00Z'));
  w1.write('b-mid.bin', 'b'.repeat(3000), Date.parse('2026-10-05T00:00:00Z'));
  w1.write('c-twin1.bin', 'c'.repeat(3000), Date.parse('2026-10-08T00:00:00Z'));
  w1.write('c-twin2.bin', 'd'.repeat(3000), Date.parse('2026-10-08T00:00:00Z'));
  const cap = ['-MaxBytes', '4000'];
  // the full copy: from the start of time, a part a pass
  let r = w1.run(['-Peer', 'alpha-serv-01', '-Since', '2000-01-01T00:00:00Z', ...cap], serving);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /SENT 1 file\(s\), .* written since 2000-01-01T00:00:00Z, to alpha-serv-01/);
  assert.match(r.out, /PART of a backlog: 3 file\(s\), 0\.0 MB still to send, from 2026-10-01T00:00:00Z; the next pass carries on/);
  r = w1.run(['-Peer', 'alpha-serv-01', ...cap], serving);
  assert.match(r.out, /SENT 1 file\(s\), .* written since 2026-10-01T00:00:00Z/);
  // two files with the same time go together, or the next pass would skip one
  r = w1.run(['-Peer', 'alpha-serv-01', ...cap], serving);
  assert.match(r.out, /SENT 2 file\(s\), .* written since 2026-10-05T00:00:00Z/);
  assert.doesNotMatch(r.out, /PART of a backlog/);
  r = w1.run(['-Peer', 'alpha-serv-01', ...cap], serving);
  assert.match(r.out, /nothing written here since/);
  // and the server, applying the three parts in order, has all four
  r = server.run();
  assert.equal((r.out.match(/APPLIED/g) || []).length, 3, r.out);
  for (const f of ['a-old.bin', 'b-mid.bin', 'c-twin1.bin', 'c-twin2.bin']) assert.ok(server.has(f), f);
});

test('one file over the cap still goes, alone', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'data-sync-'));
  const w1 = machine(root, 'desktop-41hplcn');
  w1.write('big.bin', 'x'.repeat(9000), Date.parse('2026-10-08T00:00:00Z'));
  const r = w1.run(['-Peer', 'alpha-serv-01', '-Since', '2000-01-01T00:00:00Z', '-MaxBytes', '1000'], serving);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /SENT 1 file\(s\)/);
  assert.doesNotMatch(r.out, /PART of a backlog/);
});

// On 2026-10-09 the full copy to alpha-serv-01 copied each file under
// alpha-ops\data-sync\outbox-<time>\staging\ before packing it, and a
// 254-character path in memory\ came out at 274. Copy-Item failed, and the
// file was counted as sent anyway, so it would never have gone.
test('a file that cannot be packed is never counted as sent, and goes with the next pass', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'data-sync-'));
  const w1 = machine(root, 'desktop-41hplcn');
  const server = machine(root, 'alpha-serv-01');
  w1.write('vendor/deep/manual.pdf', 'pdf', Date.parse('2026-10-01T00:00:00Z'));
  w1.write('chats/a.json', 'a', Date.parse('2026-10-02T00:00:00Z'));
  let r = w1.run(['-Peer', 'alpha-serv-01', '-Since', '2000-01-01T00:00:00Z', '-TestCopyFails', 'manual\\.pdf$'], serving);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /SENT 1 file\(s\)/);
  assert.match(r.out, /NOT IN THIS PART: 1 file\(s\) could not be packed, and go with the next pass \(first: memory\/vendor\/deep\/manual\.pdf: could not copy/);
  const sent = JSON.parse(readFileSync(join(w1.ops, 'data-sync', 'sent.json'), 'utf8'));
  assert.deepEqual(Object.keys(sent), ['memory/chats/a.json'], 'only what went is counted as sent');
  // the send moved past its time, and it still rides with the next pass
  r = w1.run(['-Peer', 'alpha-serv-01'], serving);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /SENT 1 file\(s\), .* written since/);
  assert.match(r.out, /with 1 file\(s\) an earlier pass could not pack/);
  r = w1.run(['-Peer', 'alpha-serv-01'], serving);
  assert.match(r.out, /nothing written here since/, 'and once it went, it is done');
  r = server.run();
  assert.equal(r.code, 0, r.out);
  assert.equal(server.read('vendor/deep/manual.pdf'), 'pdf');
  assert.equal(server.read('chats/a.json'), 'a');
});

test('when nothing in a part can be packed, the send still moves on and keeps them pending', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'data-sync-'));
  const w1 = machine(root, 'desktop-41hplcn');
  // the oldest file alone fills a part, and cannot be copied: it must not hold
  // every later part behind it
  w1.write('big.bin', 'x'.repeat(5000), Date.parse('2026-10-01T00:00:00Z'));
  w1.write('chats/b.json', 'b', Date.parse('2026-10-02T00:00:00Z'));
  const cap = ['-MaxBytes', '4000'];
  let r = w1.run(['-Peer', 'alpha-serv-01', '-Since', '2000-01-01T00:00:00Z', ...cap, '-TestCopyFails', 'big\\.bin$'], serving);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NOT SENT: none of 1 file\(s\) could be packed, and they go with the next pass \(first: memory\/big\.bin/);
  assert.equal(existsSync(join(root, 'taildrop', 'alpha-serv-01')), false, 'nothing was handed to Taildrop');
  r = w1.run(['-Peer', 'alpha-serv-01', ...cap, '-TestCopyFails', 'big\\.bin$'], serving);
  assert.match(r.out, /SENT 1 file\(s\), .* written since 2026-10-01T00:00:00Z/, 'the next part went');
  assert.match(r.out, /NOT IN THIS PART: 1 file\(s\)/, 'and the stuck file is still reported');
  r = w1.run(['-Peer', 'alpha-serv-01', ...cap], serving);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /with 1 file\(s\) an earlier pass could not pack/);
});

test('a file that cannot be written on the receiving side keeps its package for the next pass', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'data-sync-'));
  const w1 = machine(root, 'desktop-41hplcn');
  const server = machine(root, 'alpha-serv-01');
  w1.write('chats/a.json', 'a', Date.parse('2026-10-01T00:00:00Z'));
  w1.write('chats/b.json', 'b', Date.parse('2026-10-02T00:00:00Z'));
  assert.equal(w1.run(['-Peer', 'alpha-serv-01', '-Since', '2000-01-01T00:00:00Z'], serving).code, 0);
  let r = server.run(['-TestCopyFails', 'alpha-serv-01/memory/chats/b\\.json$']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /APPLIED .*: 1 file\(s\) written/);
  assert.match(r.out, /FAILED: 1 file\(s\) and 0 folder\(s\) from alpha-data-desktop-41hplcn-.*\.tar could not be written here \(first: memory\/chats\/b\.json: could not copy/);
  assert.equal(server.has('chats/b.json'), false);
  assert.ok(readdirSync(server.inbox).some((f) => f.endsWith('.tar')), 'the package is kept');
  r = server.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /APPLIED .*: 1 file\(s\) written \(0 replaced, .*\), 1 already the same/);
  assert.equal(server.read('chats/b.json'), 'b');
  assert.equal(readdirSync(server.inbox).length, 0, 'and once it all landed, it goes');
});

test('-Resend sends again what an older pass counted as sent', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'data-sync-'));
  const w1 = machine(root, 'desktop-41hplcn');
  w1.write('chats/a.json', 'a', Date.parse('2026-10-01T00:00:00Z'));
  assert.match(w1.run(['-Peer', 'alpha-serv-01', '-Since', '2000-01-01T00:00:00Z'], serving).out, /SENT 1 file\(s\)/);
  let r = w1.run(['-Peer', 'alpha-serv-01', '-Since', '2000-01-01T00:00:00Z'], serving);
  assert.match(r.out, /nothing written here since 2000-01-01T00:00:00Z/, 'without it, what went once does not go again');
  r = w1.run(['-Peer', 'alpha-serv-01', '-Since', '2000-01-01T00:00:00Z', '-Resend'], serving);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /-Resend: what was sent before is forgotten/);
  assert.match(r.out, /SENT 1 file\(s\), .* written since 2000-01-01T00:00:00Z/);
});

// A folder whose path is too long cannot be read (on Windows, at 248
// characters). Its files used to be left out with nothing said.
test('a folder that cannot be read is reported, not walked past in silence', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'data-sync-'));
  const w1 = machine(root, 'desktop-41hplcn');
  w1.write('chats/a.json', 'a', Date.parse('2026-10-01T00:00:00Z'));
  // Linux refuses a path over 4096 bytes: build one a level at a time
  const here = process.cwd();
  try {
    process.chdir(join(w1.home, 'memory'));
    for (let i = 0; i < 22; i++) { mkdirSync('d'.repeat(200)); process.chdir('d'.repeat(200)); }
    writeFileSync('lost.txt', 'x');
  } finally { process.chdir(here); }
  const r = w1.run(['-Peer', 'alpha-serv-01', '-Since', '2000-01-01T00:00:00Z'], serving);
  assert.match(r.out, /SKIPPED: 1 folder\(s\) under memory\\ could not be read \(a path too long\?\), so nothing in them is sent \(first: memory\/dddd/, r.out);
  assert.match(r.out, /SENT 1 file\(s\)/, 'the rest still goes');
});

// What the installer actually registers, read off its own -WhatIfOnly output.
//
// The task it writes is the whole of the failover: an argument it does not pass
// is a failover that quietly does not happen. The case that bit is the probe —
// standby-alpha.mjs defaults it to the coordinator's /healthz, and on the
// machine that *runs* the coordinator that answers from loopback for ever, so a
// standby installed there never promotes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'install-always-on.ps1');

const PWSH = process.env.PWSH || 'pwsh';
const hasPwsh = !spawnSync(PWSH, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).error;
const skip = hasPwsh ? false : 'PowerShell not found (set PWSH)';

const plan = (args) =>
  spawnSync(PWSH, ['-NoProfile', '-File', SCRIPT, ...args, '-WhatIfOnly'], { encoding: 'utf8' });

test('the standby is registered with what to watch and what proves it took over', { skip }, () => {
  const alpha = mkdtempSync(join(tmpdir(), 'alpha-root-'));
  const r = plan([
    '-AlphaRoot', alpha,
    '-ProbeUrl', 'http://100.69.243.25:8001/health',
    '-LocalUrl', 'http://127.0.0.1:8001/health',
    '-ControlUrl', 'https://github.com',
    '-CloudflareTunnel', 'alpha-home',
  ]);
  assert.equal(r.status, 0, r.stderr);

  const standby = r.stdout.split('task  : alpha-tunnel standby')[1] ?? '';
  // Each one is load-bearing: the probe decides when to promote, the local URL
  // catches a promotion that started nothing, the control URL is the split-brain
  // guard, and the tunnel is the public address following the live machine.
  assert.match(standby, /--probe-url http:\/\/100\.69\.243\.25:8001\/health/);
  assert.match(standby, /--local-url http:\/\/127\.0\.0\.1:8001\/health/);
  assert.match(standby, /--control-url https:\/\/github\.com/);
  assert.match(standby, /--cloudflared alpha-home/);
  assert.match(standby, /--root /);
  // Never the token form: an argv is readable by every process on the machine.
  assert.doesNotMatch(standby, /--token/);
});

test('installing without a probe says what the standby will actually watch', { skip }, () => {
  const alpha = mkdtempSync(join(tmpdir(), 'alpha-root-'));
  const r = plan(['-AlphaRoot', alpha, '-ControlUrl', 'https://github.com']);
  assert.equal(r.status, 0, r.stderr);
  // The silent version of this is a laptop that looks configured for failover
  // and is watching the wrong thing.
  assert.match(r.stdout, /no -ProbeUrl, so the standby watches the coordinator/);
  assert.match(r.stdout, /-ProbeUrl http:\/\/<the machine running Alpha>:8001\/health/);
  // The louder branch — this machine is the coordinator — needs
  // Get-NetTCPConnection, so it is only reachable on Windows and is not asserted
  // here; what is asserted is that the advice appears either way.
});

test('a machine that only lends capacity gets no standby', { skip }, () => {
  const r = plan([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /task  : alpha-tunnel agent/);
  assert.doesNotMatch(r.stdout, /task  : alpha-tunnel standby/);
  // Said rather than left to be noticed: a half-configured failover is worse
  // than none, which is why the standby is skipped and not guessed at.
  assert.match(r.stdout, /no -AlphaRoot, so no standby was installed/);
});

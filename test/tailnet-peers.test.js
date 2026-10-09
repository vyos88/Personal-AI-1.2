import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PWSH = process.env.PWSH || 'pwsh';
const hasPwsh = !spawnSync(PWSH, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).error;
const skip = hasPwsh ? false : 'PowerShell not found (set PWSH)';
const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'tailnet-peers.ps1');

// The shape `tailscale status --json` answers with, trimmed. The User map holds
// login names, which are e-mail addresses: they must never reach the report.
const status = {
  BackendState: 'Running',
  Self: { HostName: 'DESKTOP-41HPLCN', DNSName: 'desktop-41hplcn.tail1234.ts.net.', TailscaleIPs: ['100.69.243.25', 'fd7a:115c::1'], OS: 'windows', Online: true, UserID: 1 },
  Peer: {
    'nodekey:a': { HostName: 'alpha-server-01', DNSName: 'alpha-server-01-us.tail1234.ts.net.', TailscaleIPs: ['100.70.1.2'], OS: 'linux', Online: true, UserID: 1 },
    'nodekey:b': { HostName: 'LAPTOP-GJ8DFMLK', DNSName: 'laptop-gj8dfmlk.tail1234.ts.net.', TailscaleIPs: ['100.93.104.24'], OS: 'windows', Online: false, LastSeen: '2026-10-09T17:00:00Z', UserID: 1 },
  },
  User: { 1: { LoginName: 'owner@example.com', DisplayName: 'Owner' } },
};

test('the tailnet as a table of machines, with no account in it', { skip }, () => {
  const file = join(mkdtempSync(join(tmpdir(), 'tailnet-')), 'status.json');
  writeFileSync(file, JSON.stringify(status));
  const r = spawnSync(PWSH, ['-NoProfile', '-File', SCRIPT, '-StatusJson', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /self\s+desktop-41hplcn\s+100\.69\.243\.25\s+windows\s+online/);
  assert.match(r.stdout, /peer\s+alpha-server-01-us\s+100\.70\.1\.2\s+linux\s+online/);
  assert.match(r.stdout, /peer\s+laptop-gj8dfmlk\s+100\.93\.104\.24\s+windows\s+offline, last seen/);
  assert.match(r.stdout, /2 peer\(s\), 1 online/);
  assert.doesNotMatch(r.stdout, /owner@example\.com|Owner|fd7a/, 'no account, no IPv6');
});

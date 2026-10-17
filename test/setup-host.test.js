import test from 'node:test';
import assert from 'node:assert/strict';

import { serviceHint } from '../scripts/setup-host.mjs';

const args = { node: '/usr/bin/node', root: '/opt/alpha-tunnel' };

test('the service hint matches the platform it is printed on', () => {
  // It printed NSSM unconditionally, so on a Linux server the last thing
  // setup-host said was "install a Windows service manager".
  assert.match(serviceHint('win32', args), /nssm install alpha-coordinator/);
  assert.match(serviceHint('darwin', args), /launchctl/);
  assert.match(serviceHint('linux', args), /systemctl enable --now alpha-coordinator/);
  assert.doesNotMatch(serviceHint('linux', args), /nssm/);
  // Every one of them points at this checkout's coordinator entrypoint.
  for (const platform of ['win32', 'darwin', 'linux']) {
    assert.match(serviceHint(platform, args), /src[\\/]host[\\/]index\.js/);
  }
});

test('the Windows hint is unchanged, because two laptops already follow it', () => {
  const hint = serviceHint('win32', args);
  for (const line of [
    'nssm install alpha-coordinator "/usr/bin/node" "/opt/alpha-tunnel/src/host/index.js"',
    'nssm set alpha-coordinator AppDirectory /opt/alpha-tunnel',
    'nssm install alpha-agent "/usr/bin/node" "/opt/alpha-tunnel/src/agent/index.js"',
    'nssm start alpha-coordinator',
    'nssm start alpha-agent',
  ]) assert.ok(hint.includes(line), line);
});

test('a server runs the coordinator; the agents dial in to it', () => {
  // On the Alpha host both run, because the handlers worth having beside the
  // coordinator there drive PowerShell and hardware on that machine. Naming
  // alpha-agent on a server offers a worker that could run none of them.
  assert.match(serviceHint('win32', args), /alpha-agent/);
  assert.doesNotMatch(serviceHint('linux', args), /alpha-agent/);
});

test('the unit body is flush-left, so the heredoc writes a unit systemd accepts', () => {
  const lines = serviceHint('linux', args).split('\n');
  const open = lines.findIndex((l) => l.includes("<<'UNIT'"));
  const close = lines.indexOf('UNIT');
  assert.ok(open > 0 && close > open, 'the heredoc opens and closes');
  // <<'UNIT' keeps leading whitespace, so an indented body would be written
  // into the unit file verbatim. The quoted delimiter is the other half: it
  // stops the shell expanding anything in the body.
  for (const line of lines.slice(open + 1, close)) {
    assert.equal(line, line.trimStart(), `indented unit line: ${JSON.stringify(line)}`);
  }
  assert.ok(lines.slice(open + 1, close).includes('[Unit]'));
  assert.ok(lines.slice(open + 1, close).includes('[Install]'));
});

test('ProtectHome is off for a checkout under /home, which it would otherwise hide', () => {
  // ProtectHome=yes hides /home from the service, so a checkout living there
  // is unreadable to the unit that runs it: the service fails to start and the
  // reason looks nothing like the cause.
  assert.match(serviceHint('linux', { ...args, root: '/opt/alpha-tunnel' }), /^ProtectHome=yes$/m);
  for (const root of ['/home/alpha/alpha-tunnel', '/home']) {
    const hint = serviceHint('linux', { ...args, root });
    assert.match(hint, /^ProtectHome=no\b/m, root);
    assert.match(hint, /under \/home/, 'and says why');
  }
  // A path that merely starts with the same letters is not under /home.
  assert.match(serviceHint('linux', { ...args, root: '/homeless/tunnel' }), /^ProtectHome=yes$/m);
});

test('the data directory and the logs are the only writable paths', () => {
  const hint = serviceHint('linux', args);
  assert.match(hint, /^ReadWritePaths=\/opt\/alpha-tunnel\/data \/opt\/alpha-tunnel\/logs$/m);
  // ProtectSystem=strict makes the rest of the filesystem read-only, which is
  // the point: the coordinator writes the auth store, the ledger and the
  // journal, and nothing else.
  assert.match(hint, /^ProtectSystem=strict$/m);
  // The secrets are not in the unit, which is world-readable.
  assert.match(hint, /^EnvironmentFile=\/etc\/alpha-tunnel\.env$/m);
  assert.doesNotMatch(hint, /ALPHA_BOOTSTRAP_TOKEN=|ALPHA_ADMIN_TOKEN=/);
});

test('it orders after tailscaled, because the bind address does not exist at boot', () => {
  // ALPHA_BIND_WAIT_MS exists because at boot Tailscale has not yet assigned
  // the 100.x address the coordinator binds. Ordering after it means the wait
  // is usually unnecessary rather than usually used.
  assert.match(serviceHint('linux', args), /^After=network-online\.target tailscaled\.service$/m);
});

test('importing it provisions nothing', async () => {
  // main() used to run on import, so a test could not read its decisions
  // without creating an admin account.
  const mod = await import('../scripts/setup-host.mjs');
  assert.equal(typeof mod.serviceHint, 'function');
});

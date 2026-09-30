// One command that connects the panel, and the one thing it will not fake.
//
// Every step of flashing and provisioning can succeed while the screen stays
// dark: the board takes the firmware, joins the network, and then cannot reach
// the coordinator — or reaches it and is refused. So the script's last step
// asks the host whether the panel's key has actually been used, and that is
// what decides the exit code. These tests drive that decision, and the port
// picking that keeps a flash off the wrong board.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { choosePort, verify } from '../scripts/connect-panel.mjs';
import { createHost } from '../src/host/server.js';
import { AuthService } from '../src/host/auth/service.js';
import { AuthStore } from '../src/host/auth/store.js';
import { parseToken } from '../src/host/auth/tokens.js';
import { fetchJson } from '../src/common/http.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'connect-panel.mjs');
const BOOTSTRAP = 'bootstrap-token-long-enough-for-tests';
const PASSWORD = 'a-perfectly-fine-password';

const ch340 = (address) => ({ address, protocol: 'serial', vid: '0x1a86', pid: '0x7523' });
const other = (address, vid) => ({ address, protocol: 'serial', vid, pid: '0x0001' });

test('the board is picked out of the ports by what it is, never by guessing', () => {
  // The CH340 bridge is the panel — the same evidence the board id rests on.
  assert.equal(choosePort([other('COM1', '0x0403'), ch340('COM3')]).port, 'COM3');

  // One serial port and nothing to distinguish it: that is the board.
  assert.equal(choosePort([other('/dev/ttyUSB0', '0x10c4')]).port, '/dev/ttyUSB0');

  // Two candidates and no CH340 among them: ask, never pick. Flashing the wrong
  // board is not something the next command can undo.
  const ambiguous = choosePort([other('COM1', '0x0403'), other('COM7', '0x10c4')]);
  assert.equal(ambiguous.port, null);
  assert.match(ambiguous.why, /name one with --port/);

  // Two boards that both look like the panel is the same problem.
  const twoBoards = choosePort([ch340('COM3'), ch340('COM4')]);
  assert.equal(twoBoards.port, null);
  assert.match(twoBoards.why, /2 CH340/);

  assert.equal(choosePort([]).port, null);
  assert.equal(choosePort(null).port, null);
});

async function startHost() {
  const auth = new AuthService({ store: new AuthStore({ path: null }), bootstrapToken: BOOTSTRAP });
  await auth.load();
  const host = createHost({ auth });
  await new Promise((r) => host.server.listen(0, '127.0.0.1', r));
  return { ...host, url: `http://127.0.0.1:${host.server.address().port}` };
}

async function mintKey(url, email) {
  const { body: invited } = await fetchJson(`${url}/invites`, {
    method: 'POST',
    token: BOOTSTRAP,
    body: { email, scopes: ['agents:read'] },
  });
  const { body: redeemed } = await fetchJson(`${url}/invites/redeem`, {
    method: 'POST',
    body: { token: invited.token, password: PASSWORD },
  });
  return { token: redeemed.token, id: parseToken(redeemed.token).id };
}

function runScript(url, args) {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      {
        cwd: ROOT,
        timeout: 30_000,
        env: { ...process.env, ALPHA_HOST_URL: url, ALPHA_ADMIN_TOKEN: BOOTSTRAP },
      },
      (error, stdout, stderr) => resolvePromise({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
}

test('--verify-only reports what the host knows, and nothing more', async (t) => {
  const host = await startHost();
  t.after(() => host.close());
  const panel = await mintKey(host.url, 'panel-verify@example.test');
  const log = join(ROOT, 'connect-panel.log');

  // Minted but never used. A flash and a join both "worked" in this state, and
  // the screen is still dark — which is why this is what the exit code reads.
  const dark = await runScript(host.url, ['--verify-only', '--key', panel.token, '--json', '--log', log]);
  const before = JSON.parse(dark.stdout);
  assert.equal(before.connected, false);
  assert.match(before.steps.verify.note, /never been used/);
  assert.equal(dark.code, 1);

  // The panel reads /stats. That request is the receipt.
  await fetchJson(`${host.url}/stats`, { token: panel.token });

  const live = await runScript(host.url, ['--verify-only', '--key', panel.token, '--json', '--log', log]);
  const after = JSON.parse(live.stdout);
  assert.equal(after.connected, true);
  assert.equal(after.steps.verify.key, panel.id);
  assert.match(after.steps.verify.lastUsedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(live.code, 0);
});

test('verify waits for the key to be used again, not merely to have been used', async (t) => {
  const host = await startHost();
  t.after(() => host.close());
  const panel = await mintKey(host.url, 'panel-since@example.test');

  // Used once, an hour ago as far as this call is concerned.
  await fetchJson(`${host.url}/stats`, { token: panel.token });
  const stale = Date.now() + 60_000;

  process.env.ALPHA_HOST_URL = host.url;
  process.env.ALPHA_ADMIN_TOKEN = BOOTSTRAP;

  // Nothing uses the key inside the window, so a previous use must not count:
  // "this key worked last Tuesday" is not "the panel is reading the host".
  const outcome = await verify(panel.id, { since: stale, windowMs: 200, pollMs: 50 });
  assert.equal(outcome.connected, false);
  assert.match(outcome.note, /not been used since provisioning/);

  // A fresh request inside the window is what flips it.
  await fetchJson(`${host.url}/stats`, { token: panel.token });
  const now = await verify(panel.id, { since: null, windowMs: 200, pollMs: 50 });
  assert.equal(now.connected, true);
});

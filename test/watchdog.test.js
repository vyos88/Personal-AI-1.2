// The scheduled check, and the one thing it could not see before: the panel.
//
// A laptop that stopped lending looks exactly like one that worked all week,
// which is what the watchdog exists for. The CrowPanel is worse: it is not an
// agent at all — it registers nothing, holds no lease and has no row in
// /agents — so nothing in the fleet notices when its screen freezes. What it
// does do is read GET /stats with a bearer key every five seconds, so the last
// use of that key is the receipt, and the host is the only party that has it.
//
// These drive the real script as a subprocess against a real host, because the
// wiring (argv, env, the exit code a scheduler alerts on) is the part that
// breaks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHost } from '../src/host/server.js';
import { AuthService } from '../src/host/auth/service.js';
import { AuthStore } from '../src/host/auth/store.js';
import { parseToken } from '../src/host/auth/tokens.js';
import { fetchJson } from '../src/common/http.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WATCHDOG = join(ROOT, 'scripts', 'watchdog.mjs');
const BOOTSTRAP = 'bootstrap-token-long-enough-for-tests';
const PASSWORD = 'a-perfectly-fine-password';
const MACHINE = 'panel-host';

async function startHost() {
  const auth = new AuthService({ store: new AuthStore({ path: null }), bootstrapToken: BOOTSTRAP });
  await auth.load();
  const host = createHost({ auth });
  await new Promise((r) => host.server.listen(0, '127.0.0.1', r));
  return { ...host, url: `http://127.0.0.1:${host.server.address().port}` };
}

/** A credential of its own, the way the panel gets one. */
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

function runWatchdog(url, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [WATCHDOG, ...args],
      {
        cwd: ROOT,
        timeout: timeoutMs,
        env: {
          ...process.env,
          ALPHA_HOST_URL: url,
          ALPHA_ADMIN_TOKEN: BOOTSTRAP,
          ALPHA_AGENT_NAME: MACHINE,
        },
      },
      (error, stdout, stderr) => {
        resolvePromise({ code: error?.code ?? 0, stdout, stderr });
      },
    );
  });
}

/** One registration, which is all "this machine is attached" needs. */
const attach = (url) =>
  fetchJson(`${url}/agent/register`, {
    method: 'POST',
    token: BOOTSTRAP,
    body: { protocolVersion: 1, name: MACHINE, capabilities: ['echo'] },
  });

test('the panel counts as connected only while its key is still being used', async (t) => {
  const host = await startHost();
  t.after(() => host.close());
  const log = join(await mkdtemp(join(tmpdir(), 'watchdog-')), 'watchdog.log');

  await attach(host.url);
  const panel = await mintKey(host.url, 'panel@example.test');

  // Minted but never used: a key for a panel that was never provisioned reads
  // exactly like one whose panel stopped, and both need a person.
  const never = await runWatchdog(host.url, ['--no-update', '--json', '--log', log, '--name', MACHINE, '--panel-key', panel.id]);
  const before = JSON.parse(never.stdout);
  assert.equal(before.fleet.attached, true);
  assert.equal(before.panel.connected, false);
  assert.match(before.panel.note, /never used/);
  assert.equal(never.code, 1, 'a dark panel needs a person, so the scheduler hears about it');

  // The panel polls /stats. That request, and nothing else, is the receipt.
  await fetchJson(`${host.url}/stats`, { token: panel.token });

  const now = await runWatchdog(host.url, ['--no-update', '--json', '--log', log, '--name', MACHINE, '--panel-key', panel.id]);
  const after = JSON.parse(now.stdout);
  assert.equal(after.panel.connected, true);
  assert.equal(after.panel.key, panel.id);
  assert.ok(after.panel.silentFor < 60_000);
  assert.equal(now.code, 0);

  // Both runs are on the log, which is what gets read a week later.
  const written = await readFile(log, 'utf8');
  const records = written.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((entry) => entry.panel.connected), [false, true]);
  // And the timestamp on the receipt is readable, not epoch milliseconds.
  assert.match(records[1].panel.lastUsedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('a key that is not there is reported as such, not as a quiet panel', async (t) => {
  const host = await startHost();
  t.after(() => host.close());
  const log = join(await mkdtemp(join(tmpdir(), 'watchdog-')), 'watchdog.log');

  await attach(host.url);
  const result = await runWatchdog(host.url, ['--no-update', '--json', '--log', log, '--name', MACHINE, '--panel-key', 'deadbeef']);
  const record = JSON.parse(result.stdout);
  assert.equal(record.panel.found, false);
  assert.equal(record.panel.connected, false);
  assert.match(record.panel.note, /no key with that id or name/);
  assert.equal(result.code, 1);
});

test('without --panel-key the run is exactly what it was', async (t) => {
  const host = await startHost();
  t.after(() => host.close());
  const log = join(await mkdtemp(join(tmpdir(), 'watchdog-')), 'watchdog.log');

  await attach(host.url);
  const result = await runWatchdog(host.url, ['--no-update', '--json', '--log', log, '--name', MACHINE]);
  const record = JSON.parse(result.stdout);
  assert.equal(record.panel, undefined);
  assert.equal(record.ok, true);
  assert.equal(result.code, 0);
});

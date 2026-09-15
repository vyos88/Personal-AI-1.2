// The one command, up to the point where hardware starts.
//
// Steps 1 to 4 — this machine's address, a coordinator, the panel's
// credential, the serial port — are all testable without a board, and they are
// the ones that go wrong silently. Picking a tailnet address is the worst of
// them: everything downstream succeeds and the screen never shows anything,
// because a 100.x address does not exist for an ESP32 on WiFi.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lanAddress, parseModeOutput } from '../scripts/panel-up.mjs';
import { createHost } from '../src/host/server.js';
import { AuthService } from '../src/host/auth/service.js';
import { AuthStore } from '../src/host/auth/store.js';
import { fetchJson } from '../src/common/http.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'panel-up.mjs');
const BOOTSTRAP = 'bootstrap-token-long-enough-for-tests';

test('the address offered to the panel is one the panel can reach', () => {
  // A tailnet address is never chosen, however it is ordered: the panel is on
  // WiFi and 100.x does not exist for it.
  assert.equal(
    lanAddress({
      tailscale0: [{ family: 4, internal: false, address: '100.101.102.103' }],
      wifi: [{ family: 4, internal: false, address: '192.168.1.50' }],
    }),
    '192.168.1.50',
  );

  // 192.168 beats the other private ranges: that is what a home router hands
  // out, and the panel is on the home router.
  assert.equal(
    lanAddress({
      docker0: [{ family: 4, internal: false, address: '10.1.2.3' }],
      wifi: [{ family: 4, internal: false, address: '192.168.0.9' }],
    }),
    '192.168.0.9',
  );

  // An address DHCP never handed out is not an address.
  assert.equal(
    lanAddress({ wifi: [{ family: 4, internal: false, address: '169.254.7.7' }] }),
    null,
  );
  assert.equal(lanAddress({ lo: [{ family: 4, internal: true, address: '127.0.0.1' }] }), null);
  assert.equal(lanAddress({}), null);
});

test('serial ports are found without arduino-cli installed', () => {
  // A board that is already flashed and on the wrong WiFi should not need a
  // compiler to be told a new password.
  assert.deepEqual(
    parseModeOutput('Status for device COM3:\n---------\nStatus for device COM12:\n'),
    ['COM3', 'COM12'],
  );
  assert.deepEqual(parseModeOutput('no devices here'), []);
  assert.deepEqual(parseModeOutput(undefined), []);
});

test('it uses a coordinator that is already up, and mints the panel a narrow key', async (t) => {
  const auth = new AuthService({ store: new AuthStore({ path: null }), bootstrapToken: BOOTSTRAP });
  await auth.load();
  const host = createHost({ auth });
  await new Promise((r) => host.server.listen(0, '127.0.0.1', r));
  t.after(() => host.close());
  const port = host.server.address().port;

  const result = await new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [
        SCRIPT,
        '--address',
        '127.0.0.1',
        '--ssid',
        'a-network',
        // A port that is not there: the run gets as far as the board and stops
        // with the reason, which is as far as a test without one can go.
        '--port',
        '/dev/ttyUSB31',
      ],
      {
        cwd: ROOT,
        timeout: 30_000,
        env: {
          ...process.env,
          ALPHA_HOST_PORT: String(port),
          ALPHA_ADMIN_TOKEN: BOOTSTRAP,
          ALPHA_PANEL_WIFI_PASSWORD: 'a-fine-password',
        },
      },
      (error, stdout, stderr) => resolvePromise({ code: error?.code ?? 0, stdout, stderr }),
    );
  });

  assert.match(result.stdout, /coordinator: already answering here/);
  assert.match(result.stdout, /key {8}: minted [0-9a-f]+, scoped to agents:read/);
  // It stopped at the board rather than reporting success without one.
  assert.match(result.stdout, /provision {2}: /);
  assert.equal(result.code, 1);

  // The credential it left behind can read the report and nothing else. A wall
  // panel must not hold a key that could queue work.
  const { body } = await fetchJson(`http://127.0.0.1:${port}/keys`, { token: BOOTSTRAP });
  const minted = body.keys.filter((key) => key.scopes.includes('agents:read'));
  assert.equal(minted.length, 1);
  assert.deepEqual(minted[0].scopes, ['agents:read']);
});

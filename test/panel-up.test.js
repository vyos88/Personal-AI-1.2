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

import {
  classifyBoard,
  identifyPorts,
  lanAddress,
  listPorts,
  parseModeOutput,
  parseSerialComm,
} from '../scripts/panel-up.mjs';
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

test('a COM port held by something else is still reported as being there', () => {
  // The registry's device map has the port whether or not anything can open
  // it, and mode.com only lists what it can open. A serial monitor somebody
  // left running is the usual reason a flash fails, and without this it looks
  // exactly like an unplugged board.
  const registry = [
    '',
    'HKEY_LOCAL_MACHINE\\HARDWARE\\DEVICEMAP\\SERIALCOMM',
    '    \\Device\\Serial0    REG_SZ    COM1',
    '    \\Device\\VCP0       REG_SZ    COM3',
    '',
  ].join('\r\n');
  assert.deepEqual(parseSerialComm(registry), ['COM1', 'COM3']);
  assert.deepEqual(parseSerialComm('no such key'), []);
  assert.deepEqual(parseSerialComm(undefined), []);
});

test('the ports this machine has come back with whatever label there is', async () => {
  const ports = await listPorts();
  // No board in this container, so the list is empty — the shape is what
  // matters, and that it does not throw on a machine with no /dev/serial.
  assert.ok(Array.isArray(ports));
  for (const entry of ports) {
    assert.equal(typeof entry.address, 'string');
    assert.ok(entry.label === null || typeof entry.label === 'string');
  }
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
  assert.match(result.stdout, /key {8}: minted [0-9a-f]+, scoped to agents:read \+ tasks:read/);
  // It stopped at the board rather than reporting success without one.
  assert.match(result.stdout, /provision {2}: /);
  assert.equal(result.code, 1);

  // The credential it left behind can read the report and nothing else. A wall
  // panel must not hold a key that could queue work.
  const { body } = await fetchJson(`http://127.0.0.1:${port}/keys`, { token: BOOTSTRAP });
  const minted = body.keys.filter((key) => key.scopes.includes('agents:read'));
  assert.equal(minted.length, 1);
  // Both read-only: the fleet pages need agents:read, the receipts page needs
  // tasks:read, and neither can queue anything.
  assert.deepEqual(minted[0].scopes, ['agents:read', 'tasks:read']);
});

test('a board says which board it is, and the four answers go to four places', () => {
  // It answered this firmware: this is the panel, whatever the port is called.
  assert.deepEqual(
    classifyBoard({
      ready: true,
      status: { firmware: 'panel-3', connected: true, ssid: 'BT-house', host: 'http://192.168.1.9:8787', page: 'fleet' },
    }),
    {
      kind: 'panel',
      detail: 'firmware panel-3, on BT-house, reading http://192.168.1.9:8787, showing fleet',
    },
  );

  // Alpha's own deck firmware: same board family, bare-word commands, and it
  // names itself in every line. Flashing this firmware over it would take
  // Alpha's deck away, so it is called out rather than treated as a stranger.
  const deck = classifyBoard({
    ready: false,
    spoke: true,
    heard: '[crowpanel] fw=alpha-1 wifi_set=yes alpha_set=yes',
  });
  assert.equal(deck.kind, 'alpha-deck');
  assert.match(deck.detail, /\[crowpanel\] fw=alpha-1/);

  // Talking, in neither protocol: somebody else's board.
  assert.deepEqual(classifyBoard({ ready: false, spoke: true, heard: 'ok T:21.5 /0.0' }), {
    kind: 'other',
    detail: 'talking, but not this protocol — ok T:21.5 /0.0',
  });

  // Silent is the one that gets mistaken for "no board": an unflashed board, or
  // one held in bootloader, looks exactly like an empty adapter.
  assert.deepEqual(classifyBoard({ ready: false, spoke: false }), {
    kind: 'silent',
    detail: 'nothing came back',
  });

  // A port that cannot be opened at all is an answer too, not a crash.
  assert.deepEqual(classifyBoard({ error: 'could not open COM24: Access denied' }), {
    kind: 'unreadable',
    detail: 'could not open COM24: Access denied',
  });
});

test('every port is asked, in turn, and one unopenable port does not end the sweep', async () => {
  // Worker1's actual shape: four CH340 clones and the panel, and nothing in the
  // label to tell them apart.
  const ports = [
    { address: 'COM4', label: null },
    { address: 'COM6', label: null },
    { address: 'COM20', label: 'in use by another program?' },
    { address: 'COM24', label: null },
  ];
  const asked = [];
  const seen = await identifyPorts(ports, async (address) => {
    asked.push(address);
    if (address === 'COM20') throw new Error('could not open COM20: Access is denied');
    if (address === 'COM24') return { ready: true, status: { firmware: 'panel-3', page: 'work' } };
    return { ready: false, spoke: false };
  });

  // In series — five boards rebooting at once on one laptop's USB is not a
  // diagnosis — and every one of them asked, including the ones after the throw.
  assert.deepEqual(asked, ['COM4', 'COM6', 'COM20', 'COM24']);
  assert.deepEqual(
    seen.map((entry) => [entry.address, entry.kind]),
    [
      ['COM4', 'silent'],
      ['COM6', 'silent'],
      ['COM20', 'unreadable'],
      ['COM24', 'panel'],
    ],
  );
  // The label the port list carried is kept: "in use by another program?" is
  // why COM20 could not be opened, and the two lines belong together.
  assert.equal(seen[2].label, 'in use by another program?');
});

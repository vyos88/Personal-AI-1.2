import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HandlerRegistry } from '../src/agent/handlers/index.js';
import * as panel from '../src/agent/handlers/alpha-panel.js';
import {
  ALLOWED_ACTIONS,
  available,
  buildArgs,
  redact,
  run,
  validateAction,
  validateAlphaTarget,
  validateCredentials,
  validateFqbn,
  validatePort,
} from '../src/agent/handlers/alpha-panel.js';

const isWindows = process.platform === 'win32';

/** Restores every env var this suite touches, whatever the test did to it. */
function withEnv(vars, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return (async () => fn())().finally(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/**
 * A throwaway sketch directory plus an "arduino-cli" that records the argv it
 * was handed. Argument construction is exactly the part that must not be
 * guessed at: a port or a board that reached the CLI as a flag rather than a
 * value is how a flash goes to the wrong device.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'alpha-panel-'));
  const sketch = join(root, 'firmware', 'crowpanel');
  await mkdir(sketch, { recursive: true });
  await writeFile(join(sketch, 'crowpanel.ino'), '// test\n');

  const argvLog = join(root, 'argv.log');
  const recorder = join(root, 'fake-arduino-cli');
  await writeFile(
    recorder,
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(argvLog)}; done\nprintf '\\n' >> ${JSON.stringify(argvLog)}\nexit 0\n`,
  );
  await chmod(recorder, 0o755);

  return { root, sketch, recorder, argvLog };
}

test('the allowlist is exactly what is documented, and nothing else runs', () => {
  assert.deepEqual([...ALLOWED_ACTIONS], ['Ports', 'Status', 'Compile', 'Flash', 'Provision']);
  for (const action of ALLOWED_ACTIONS) assert.equal(validateAction(action), action);

  // Ports is the harmless one, so it is what an empty payload means.
  assert.equal(validateAction(undefined), 'Ports');

  for (const bad of ['Erase', 'erase', 'Flash ', 'ReadFlash', '', 'Compile;Flash']) {
    assert.throws(() => validateAction(bad), /unsupported action/);
  }
});

test('a port name is matched, not escaped', () => {
  for (const good of ['COM3', 'COM12', '/dev/ttyUSB0', '/dev/ttyACM1', '/dev/cu.usbserial-110']) {
    assert.equal(validatePort(good), good);
  }
  // Each of these would land in an argv slot where arduino-cli takes flags.
  for (const bad of [
    '--port',
    '-p',
    'COM3 --upload-field',
    '/dev/ttyUSB0;reboot',
    '../../dev/ttyUSB0',
    'COM0',
    'COM',
    '',
    42,
  ]) {
    assert.throws(() => validatePort(bad), /must be a serial port name|no serial port given/);
  }
});

test('a port falls back to configuration, and says so when there is none', async () => {
  await withEnv({ ALPHA_PANEL_PORT: 'COM7' }, () => {
    assert.equal(validatePort(undefined), 'COM7');
  });
  await withEnv({ ALPHA_PANEL_PORT: undefined }, () => {
    assert.throws(() => validatePort(undefined), /ALPHA_PANEL_PORT is not set/);
  });
});

test('the board id comes from configuration only, and is validated', async () => {
  await withEnv({ ALPHA_PANEL_FQBN: 'esp32:esp32:esp32s3' }, () => {
    assert.equal(validateFqbn(), 'esp32:esp32:esp32s3');
  });
  await withEnv({ ALPHA_PANEL_FQBN: undefined }, () => {
    assert.throws(() => validateFqbn(), /ALPHA_PANEL_FQBN is not set/);
  });
  for (const bad of ['esp32', 'esp32:esp32', 'esp32:esp32:esp32s3 --extra', 'a:b:c:bad']) {
    assert.throws(() => validateFqbn(bad), /not a valid board id/);
  }
  assert.equal(
    validateFqbn('esp32:esp32:esp32s3:PSRAM=enabled,FlashSize=8M'),
    'esp32:esp32:esp32s3:PSRAM=enabled,FlashSize=8M',
  );
});

test('credentials are bounded, and a newline can never split the line protocol', () => {
  assert.deepEqual(validateCredentials({ ssid: 'home', password: 'hunter22' }), {
    ssid: 'home',
    password: 'hunter22',
  });

  // An open network is a legitimate answer.
  assert.deepEqual(validateCredentials({ ssid: 'cafe', password: '' }), {
    ssid: 'cafe',
    password: '',
  });

  assert.throws(() => validateCredentials({ password: 'hunter22' }), /"ssid" is required/);
  assert.throws(() => validateCredentials({ ssid: '', password: 'hunter22' }), /"ssid" is required/);
  assert.throws(() => validateCredentials({ ssid: 'x'.repeat(33), password: 'hunter22' }), /at most 32 bytes/);
  assert.throws(() => validateCredentials({ ssid: 'a\nb', password: 'hunter22' }), /must not contain a newline/);
  assert.throws(() => validateCredentials({ ssid: 'a', password: 'p\nq2345678' }), /must not contain a newline/);
  assert.throws(() => validateCredentials({ ssid: 'a', password: 'short' }), /8-63 characters/);
  assert.throws(() => validateCredentials({ ssid: 'a', password: 'x'.repeat(64) }), /8-63 characters/);
  assert.throws(() => validateCredentials({ ssid: 'a' }), /"password" is required/);
});

test('the report target is a plain http URL and carries no credentials', () => {
  assert.deepEqual(validateAlphaTarget({}), { host: null, key: '' });
  assert.deepEqual(validateAlphaTarget({ host: 'http://100.1.2.3:8787' }), {
    host: 'http://100.1.2.3:8787',
    key: '',
  });

  // A trailing slash would make the sketch request "//stats".
  assert.equal(validateAlphaTarget({ host: 'http://100.1.2.3:8787/' }).host, 'http://100.1.2.3:8787');

  assert.throws(() => validateAlphaTarget({ key: 'alpha_key_x' }), /without a "host"/);
  assert.throws(() => validateAlphaTarget({ host: 'file:///etc/passwd' }), /http or https/);
  assert.throws(() => validateAlphaTarget({ host: 'ftp://x/' }), /http or https/);
  assert.throws(() => validateAlphaTarget({ host: 'not a url' }), /absolute URL/);
  assert.throws(() => validateAlphaTarget({ host: 'http://user:pw@host/' }), /must not carry credentials/);
  assert.throws(() => validateAlphaTarget({ host: 'http://host/?a=1' }), /query string or fragment/);
  assert.throws(() => validateAlphaTarget({ host: 'http://host/#f' }), /query string or fragment/);
});

test('argv is exact, so a port or a board can never arrive as a flag', () => {
  assert.deepEqual(buildArgs({ action: 'Ports' }), ['board', 'list', '--format', 'json']);

  assert.deepEqual(buildArgs({ action: 'Compile', sketch: '/s', fqbn: 'esp32:esp32:esp32s3' }), [
    'compile',
    '--fqbn',
    'esp32:esp32:esp32s3',
    '--format',
    'json',
    '/s',
  ]);

  assert.deepEqual(
    buildArgs({ action: 'Flash', sketch: '/s', fqbn: 'esp32:esp32:esp32s3', port: 'COM3' }),
    ['upload', '--fqbn', 'esp32:esp32:esp32s3', '--port', 'COM3', '--format', 'json', '/s'],
  );

  // Provision never touches arduino-cli.
  assert.throws(() => buildArgs({ action: 'Provision' }), /does not run arduino-cli/);
});

test('a password never survives into anything that gets reported', () => {
  assert.equal(redact('joining with hunter22 ok', 'hunter22'), 'joining with *** ok');
  assert.equal(redact('hunter22hunter22', 'hunter22'), '******');
  assert.equal(redact('nothing here', 'hunter22'), 'nothing here');
  assert.equal(redact('', 'hunter22'), '');
  // An open network has no secret to redact, and must not blank the transcript.
  assert.equal(redact('some text', ''), 'some text');
});

test('an unconfigured agent refuses a flash instead of guessing', async () => {
  await withEnv(
    { ALPHA_PANEL_ROOT: undefined, ALPHA_PANEL_FQBN: 'esp32:esp32:esp32s3', ALPHA_PANEL_PORT: 'COM3' },
    async () => {
      await assert.rejects(run({ action: 'Flash' }), /ALPHA_PANEL_ROOT is not set/);
    },
  );
});

test('the sketch must resolve inside the configured root', async () => {
  const { root } = await fixture();
  await withEnv(
    {
      ALPHA_PANEL_ROOT: root,
      ALPHA_PANEL_SKETCH: join('..', 'elsewhere'),
      ALPHA_PANEL_FQBN: 'esp32:esp32:esp32s3',
    },
    async () => {
      await assert.rejects(run({ action: 'Compile' }), /must live inside ALPHA_PANEL_ROOT/);
    },
  );
});

test('Compile builds the pinned sketch and touches no port', { skip: isWindows }, async () => {
  const { root, sketch, recorder, argvLog } = await fixture();

  const result = await withEnv(
    {
      ALPHA_PANEL_ROOT: root,
      ALPHA_PANEL_SKETCH: join('firmware', 'crowpanel'),
      ALPHA_PANEL_FQBN: 'esp32:esp32:esp32s3',
      ALPHA_ARDUINO_CLI: recorder,
    },
    () => run({ action: 'Compile' }),
  );

  assert.equal(result.compiled, true);
  assert.equal(result.fqbn, 'esp32:esp32:esp32s3');

  const argv = (await readFile(argvLog, 'utf8')).split('\n').filter(Boolean);
  assert.deepEqual(argv, ['compile', '--fqbn', 'esp32:esp32:esp32s3', '--format', 'json', sketch]);
  // A compile that named a port would be reaching for hardware it was not asked
  // to touch.
  assert.ok(!argv.includes('--port'));
});

test('Flash compiles first and refuses to upload a sketch that did not build', { skip: isWindows }, async () => {
  const { root, recorder } = await fixture();
  // A recorder that fails, standing in for a compile error.
  await writeFile(recorder, '#!/bin/sh\necho "error: expected 1" >&2\nexit 1\n');
  await chmod(recorder, 0o755);

  const result = await withEnv(
    {
      ALPHA_PANEL_ROOT: root,
      ALPHA_PANEL_SKETCH: join('firmware', 'crowpanel'),
      ALPHA_PANEL_FQBN: 'esp32:esp32:esp32s3',
      ALPHA_ARDUINO_CLI: recorder,
      ALPHA_PANEL_PORT: 'COM3',
    },
    () => run({ action: 'Flash' }),
  );

  assert.equal(result.flashed, false);
  assert.equal(result.refused, 'sketch did not compile');
  assert.notEqual(result.exitCode, 0);
});

test('a machine that cannot flash never advertises the type', async () => {
  const { root, recorder } = await fixture();

  // Everything present: this machine really can do the work.
  await withEnv(
    {
      ALPHA_PANEL_ROOT: root,
      ALPHA_PANEL_SKETCH: join('firmware', 'crowpanel'),
      ALPHA_PANEL_FQBN: 'esp32:esp32:esp32s3',
      ALPHA_ARDUINO_CLI: recorder,
    },
    () => assert.deepEqual(available(), { ok: true }),
  );

  // The case this exists for: .env.agent copied to a machine with no sketch.
  await withEnv(
    { ALPHA_PANEL_ROOT: undefined, ALPHA_PANEL_FQBN: 'esp32:esp32:esp32s3', ALPHA_ARDUINO_CLI: recorder },
    () => {
      const check = available();
      assert.equal(check.ok, false);
      assert.match(check.reason, /ALPHA_PANEL_ROOT is not set/);
    },
  );

  // Configured sketch, but no board to build it for.
  await withEnv(
    {
      ALPHA_PANEL_ROOT: root,
      ALPHA_PANEL_SKETCH: join('firmware', 'crowpanel'),
      ALPHA_PANEL_FQBN: undefined,
      ALPHA_ARDUINO_CLI: recorder,
    },
    () => {
      const check = available();
      assert.equal(check.ok, false);
      assert.match(check.reason, /ALPHA_PANEL_FQBN is not set/);
    },
  );

  // Configured everything, but the CLI is not installed.
  await withEnv(
    {
      ALPHA_PANEL_ROOT: root,
      ALPHA_PANEL_SKETCH: join('firmware', 'crowpanel'),
      ALPHA_PANEL_FQBN: 'esp32:esp32:esp32s3',
      ALPHA_ARDUINO_CLI: join(root, 'no-such-arduino-cli'),
    },
    () => {
      const check = available();
      assert.equal(check.ok, false);
      assert.match(check.reason, /arduino-cli not found/);
    },
  );
});

test('the registry leaves the handler out rather than advertising it', async () => {
  const { root, recorder } = await fixture();

  await withEnv(
    { ALPHA_PANEL_ROOT: undefined, ALPHA_PANEL_FQBN: undefined, ALPHA_ARDUINO_CLI: recorder },
    () => {
      const registry = new HandlerRegistry([]);
      const outcome = registry.add(panel);
      assert.equal(outcome.registered, false);
      assert.match(outcome.reason, /ALPHA_PANEL_ROOT is not set/);
      // The point of all of it: the host is never offered alpha.panel by a
      // machine that would fail the task.
      assert.equal(registry.has('alpha.panel'), false);
      assert.deepEqual(registry.types(), []);
    },
  );

  await withEnv(
    {
      ALPHA_PANEL_ROOT: root,
      ALPHA_PANEL_SKETCH: join('firmware', 'crowpanel'),
      ALPHA_PANEL_FQBN: 'esp32:esp32:esp32s3',
      ALPHA_ARDUINO_CLI: recorder,
    },
    () => {
      const registry = new HandlerRegistry([]);
      const outcome = registry.add(panel);
      assert.equal(outcome.registered, true);
      assert.equal(registry.has('alpha.panel'), true);
    },
  );
});

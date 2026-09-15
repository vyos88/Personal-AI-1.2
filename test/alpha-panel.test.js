import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HandlerRegistry } from '../src/agent/handlers/index.js';
import { createHost } from '../src/host/server.js';
import { fetchJson } from '../src/common/http.js';
import { TaskStatus } from '../src/common/protocol.js';
import * as panel from '../src/agent/handlers/alpha-panel.js';
import {
  ALLOWED_ACTIONS,
  available,
  buildArgs,
  converseOver,
  devicePath,
  summarizePorts,
  portConfigArgs,
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
  assert.deepEqual(validateAlphaTarget({}), { host: null, standbyHost: null, key: '' });
  assert.deepEqual(validateAlphaTarget({ host: 'http://100.1.2.3:8787' }), {
    host: 'http://100.1.2.3:8787',
    standbyHost: null,
    key: '',
  });

  // The standby is where Alpha runs while the host is off, and it is held to
  // exactly the same rules as the primary.
  assert.deepEqual(
    validateAlphaTarget({ host: 'http://100.1.2.3:8787', standbyHost: 'http://192.168.1.50:8787/' }),
    { host: 'http://100.1.2.3:8787', standbyHost: 'http://192.168.1.50:8787', key: '' },
  );
  assert.throws(() => validateAlphaTarget({ host: 'http://h:1', standbyHost: 'ftp://x/' }), /"standbyHost" must be an http/);
  assert.throws(() => validateAlphaTarget({ standbyHost: 'http://h:1' }), /without a "host"/);

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

/**
 * A board on the other end of the port, without a board.
 *
 * It is written to like a file handle and read from like one, and it answers
 * only what it is told to answer — including, in the test that matters most,
 * nothing at all. `silentWrites` is how many opening commands it ignores: a
 * real ESP32 is reset by the port being opened and spends the first seconds of
 * every conversation deaf, which is the case this whole handshake exists for.
 */
function fakeBoard({ silentWrites = 0, noise = '', respond } = {}) {
  const writes = [];
  let pending = Buffer.from(noise, 'utf8');

  return {
    writes,
    commands: () => writes.map((line) => JSON.parse(line)),
    /** Puts a line on the wire out of band — a reply that arrives late. */
    say(answer) {
      pending = Buffer.concat([pending, Buffer.from(`${JSON.stringify(answer)}\n`, 'utf8')]);
    },
    async write(text) {
      writes.push(text);
      if (writes.length <= silentWrites) return { bytesWritten: text.length };
      const command = JSON.parse(text);
      const answer = respond(command, writes.length);
      // The sketch names the command in every reply; so does this.
      if (answer !== null && answer !== undefined) this.say({ cmd: command.cmd, ...answer });
      return { bytesWritten: text.length };
    },
    // Modelled on the tty this runs against once `min 0 time 1` is set: a read
    // with nothing to give comes back empty rather than waiting forever.
    async read(buffer, offset, length) {
      if (pending.length === 0) {
        await new Promise((r) => setTimeout(r, 5));
        return { bytesRead: 0 };
      }
      const n = Math.min(length, pending.length);
      pending.copy(buffer, offset, 0, n);
      pending = pending.subarray(n);
      return { bytesRead: n };
    },
  };
}

const FAST = { readyTimeoutMs: 1000, probeIntervalMs: 80, replyTimeoutMs: 500 };

test('a read on the port can always time out', () => {
  const posix = portConfigArgs('/dev/ttyUSB0', 'linux');
  assert.equal(posix.exe, 'stty');
  // `raw` sets min 1 time 0 — a read that waits for a byte a silent board never
  // sends. The override has to come after it, or the deadline is never reached.
  assert.deepEqual(posix.args, ['-F', '/dev/ttyUSB0', '115200', 'raw', '-echo', '-hupcl', 'min', '0', 'time', '1']);
  assert.ok(posix.args.indexOf('min') > posix.args.indexOf('raw'));

  const win = portConfigArgs('COM3', 'win32');
  assert.equal(win.exe, 'mode.com');
  assert.equal(win.args[0], 'COM3');
  assert.ok(win.args.includes('BAUD=115200'));
});

test('credentials wait for the board to come back from the reset opening the port caused', async () => {
  // Two writes into the void: the board is rebooting, exactly as it does when
  // DTR drops on open. Only the third probe finds it.
  const board = fakeBoard({
    silentWrites: 2,
    noise: 'rst:0x1 (POWERON_RESET),boot:0x13\nets Jun  8 2016 00:22:57\n',
    respond: (command) => {
      if (command.cmd === 'status') return { ok: true, ssid: '', host: '', keyed: false };
      if (command.cmd === 'alpha') return { ok: true, host: command.host };
      if (command.cmd === 'wifi') return { ok: true, ssid: command.ssid, ip: '100.1.2.3' };
      return { error: 'unknown cmd' };
    },
  });

  const outcome = await converseOver(
    board,
    [{ cmd: 'alpha', host: 'http://100.9.9.9:8787', key: 'alpha_key_x' }, { cmd: 'wifi', ssid: 'net', password: 'hunter22x' }],
    'hunter22x',
    FAST,
  );

  assert.equal(outcome.ready, true);
  assert.equal(outcome.replies.length, 2);
  assert.equal(outcome.replies.at(-1).reply.ip, '100.1.2.3');
  assert.equal(outcome.replies.some((entry) => entry.timedOut), false);

  const sent = board.commands();
  // The first three are probes; the password goes out only once something has
  // answered, and only after the probes it was waiting on.
  assert.deepEqual(sent.slice(0, 3).map((c) => c.cmd), ['status', 'status', 'status']);
  assert.deepEqual(sent.slice(3).map((c) => c.cmd), ['alpha', 'wifi']);

  // The board's boot banner is not a reply and must not be read as one.
  assert.match(outcome.transcript, /POWERON_RESET/);
  assert.equal(outcome.transcript.includes('hunter22x'), false);
});

test('a board that never answers times out instead of hanging, and is told nothing', async () => {
  const board = fakeBoard({ silentWrites: Number.MAX_SAFE_INTEGER, respond: () => null });

  const started = Date.now();
  const outcome = await converseOver(
    board,
    [{ cmd: 'wifi', ssid: 'net', password: 'hunter22x' }],
    'hunter22x',
    { readyTimeoutMs: 400, probeIntervalMs: 80, replyTimeoutMs: 500 },
  );

  assert.equal(outcome.ready, false);
  assert.deepEqual(outcome.replies, []);
  // The whole point: this returns. A read that blocks forever holds the lease
  // until the sweeper takes it away, and the task never answers at all.
  assert.ok(Date.now() - started < 4000);

  // Nothing but status queries reached a board that is not there — no
  // credential was written into the dark.
  assert.deepEqual([...new Set(board.commands().map((c) => c.cmd))], ['status']);
  assert.equal(board.writes.join('').includes('hunter22x'), false);
});

test('a failed command stops the sequence before the next one is sent', async () => {
  const board = fakeBoard({
    respond: (command) => {
      if (command.cmd === 'status') return { ok: true, ssid: '' };
      if (command.cmd === 'alpha') return { error: 'host required' };
      return { ok: true };
    },
  });

  const outcome = await converseOver(
    board,
    [{ cmd: 'alpha', host: 'http://h:1', key: '' }, { cmd: 'wifi', ssid: 'net', password: 'hunter22x' }],
    'hunter22x',
    FAST,
  );

  assert.equal(outcome.ready, true);
  assert.deepEqual(outcome.replies.map((entry) => entry.cmd), ['alpha']);
  assert.equal(board.commands().some((c) => c.cmd === 'wifi'), false);
});

test('each command reads its own reply, not the one before it', async () => {
  const board = fakeBoard({
    respond: (command) => (command.cmd === 'status' ? { ok: true, ssid: '' } : { ok: true, cmd: command.cmd }),
  });

  const outcome = await converseOver(
    board,
    [{ cmd: 'alpha', host: 'http://h:1', key: '' }, { cmd: 'wifi', ssid: 'net', password: '' }],
    '',
    FAST,
  );

  assert.deepEqual(outcome.replies.map((entry) => entry.reply.cmd), ['alpha', 'wifi']);
});

/**
 * The panel is the one consumer of `/stats` that cannot report a mistake.
 *
 * `crowpanel.ino` reads the summary by key, and a key that does not exist
 * reads as zero — so a sketch reaching for a plausible name shows a confident
 * row of zeroes and looks like an idle fleet rather than like a bug. That is
 * the failure this pins, against a real host rather than a fixture.
 */
test('the sketch reads /stats by the names the host actually answers with', async () => {
  const token = 'panel-stats-token-long-enough';
  const host = createHost({ token });
  await new Promise((resolve) => host.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${host.server.address().port}`;

  try {
    // One task, so the status bucket the panel calls "queued" is populated
    // rather than absent — an empty byStatus would pass a check that a wrong
    // key name also passes.
    await fetchJson(`${url}/tasks`, { method: 'POST', token, body: { type: 'echo', payload: {} } });
    const { body: stats } = await fetchJson(`${url}/stats`, { token });

    assert.equal(typeof stats.version, 'string');
    assert.equal(typeof stats.agents, 'number');
    assert.equal(stats.queue.byStatus[TaskStatus.QUEUED], 1);
    assert.equal(typeof stats.memory.blockedTasks, 'number');

    // The names the sketch maps onto its four counters are task statuses, not
    // words chosen for the screen.
    assert.equal(TaskStatus.LEASED, 'leased');
    assert.equal(TaskStatus.SUCCEEDED, 'succeeded');
    assert.equal(TaskStatus.FAILED, 'failed');

    const sketch = await readFile(new URL('../firmware/crowpanel/crowpanel.ino', import.meta.url), 'utf8');
    assert.match(sketch, /doc\["queue"\]\["byStatus"\]/);
    assert.match(sketch, /byStatus\["leased"\]/);
    // The shape it used to guess at, which no endpoint here has ever returned.
    assert.equal(/doc\["tasks"\]/.test(sketch), false);
  } finally {
    await host.close();
  }
});

test('a late answer to the readiness probe is not read as the next reply', async () => {
  // The probe that went unanswered at 80ms comes back at 200ms — after the
  // credentials have gone out. Untagged, that stale `status` reply is the next
  // thing in the buffer when the wifi reply is being waited for, and `ok:true`
  // would be reported as a provisioned panel that never joined anything.
  let board;
  board = fakeBoard({
    respond: (command, n) => {
      if (command.cmd === 'status' && n === 1) return null;
      if (command.cmd === 'status') return { ok: true, ssid: '' };
      // The wifi command: the board goes away instead of answering, and the
      // first probe's reply turns up in its place.
      setTimeout(() => board.say({ cmd: 'status', ok: true, ssid: '' }), 20);
      return null;
    },
  });

  const outcome = await converseOver(
    board,
    [{ cmd: 'wifi', ssid: 'net', password: 'hunter22x' }],
    'hunter22x',
    { readyTimeoutMs: 1000, probeIntervalMs: 80, replyTimeoutMs: 300 },
  );

  assert.equal(outcome.ready, true);
  assert.deepEqual(outcome.replies, [{ cmd: 'wifi', reply: null, timedOut: true }]);
});

test('a port past COM9 is opened by the path Windows actually has for it', () => {
  // COM1..COM9 are DOS device names; COM10 and up only exist as \\.\COMn, and
  // opening the bare name fails with ENOENT — "the board is not there" for a
  // board that is plugged in. Windows renumbers ports on re-enumeration, so a
  // few replugs is all it takes to get there.
  assert.equal(devicePath('COM3', 'win32'), 'COM3');
  assert.equal(devicePath('COM9', 'win32'), 'COM9');
  assert.equal(devicePath('COM10', 'win32'), '\\\\.\\COM10');
  assert.equal(devicePath('COM12', 'win32'), '\\\\.\\COM12');
  // Nothing changes off Windows, and nothing changes for arduino-cli's argv.
  assert.equal(devicePath('/dev/ttyUSB0', 'linux'), '/dev/ttyUSB0');
  assert.equal(devicePath('COM12', 'linux'), 'COM12');
  assert.equal(portConfigArgs('COM12', 'win32').args[0], '\\\\.\\COM12');
  assert.deepEqual(buildArgs({ action: 'Flash', sketch: '/s', fqbn: 'esp32:esp32:esp32', port: 'COM12' }).slice(3, 5), [
    '--port',
    'COM12',
  ]);
});

test('a sketch directory arduino-cli would reject is never advertised', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alpha-panel-noino-'));
  const sketch = join(root, 'firmware', 'crowpanel');
  await mkdir(sketch, { recursive: true });
  // A directory, but not a sketch: arduino-cli needs <dirname>.ino inside it.
  await writeFile(join(sketch, 'display.h'), '// only a header\n');

  await withEnv(
    {
      ALPHA_PANEL_ROOT: root,
      ALPHA_PANEL_SKETCH: join('firmware', 'crowpanel'),
      ALPHA_PANEL_FQBN: 'esp32:esp32:esp32',
      ALPHA_ARDUINO_CLI: undefined,
    },
    async () => {
      const check = available();
      assert.equal(check.ok, false);
      assert.match(check.reason, /has no crowpanel\.ino/);
      // run() refuses on exactly the same footing, which is the rule the check
      // follows: what available() asks is what run() asks.
      await assert.rejects(run({ action: 'Compile' }), /has no crowpanel\.ino/);
    },
  );
});

test('Ports answers which address the board is on, whichever CLI is installed', () => {
  // arduino-cli 1.x.
  const v1 = summarizePorts({
    detected_ports: [
      {
        matching_boards: [],
        port: {
          address: 'COM3',
          label: 'COM3',
          protocol: 'serial',
          protocol_label: 'Serial Port (USB)',
          properties: { vid: '0x1a86', pid: '0x7523', serialNumber: '' },
        },
      },
    ],
  });
  assert.deepEqual(v1, [
    {
      address: 'COM3',
      protocol: 'serial',
      label: 'Serial Port (USB)',
      // The CH340 evidence the board choice rests on, on the result rather
      // than in somebody's memory of a device panel.
      vid: '0x1a86',
      pid: '0x7523',
      serialNumber: '',
      boards: [],
    },
  ]);

  // arduino-cli 0.x, which answers a flat array and spells it FQBN.
  const v0 = summarizePorts([
    { address: '/dev/ttyUSB0', protocol: 'serial', protocol_label: 'Serial Port (USB)', boards: [{ name: 'ESP32 Dev Module', FQBN: 'esp32:esp32:esp32' }] },
  ]);
  assert.equal(v0[0].address, '/dev/ttyUSB0');
  assert.deepEqual(v0[0].boards, [{ name: 'ESP32 Dev Module', fqbn: 'esp32:esp32:esp32' }]);

  // Neither shape: say nothing rather than an empty list, which would read as
  // "no ports" on a machine whose CLI simply printed a table.
  assert.equal(summarizePorts(null), null);
  assert.equal(summarizePorts('COM3 serial'), null);
});

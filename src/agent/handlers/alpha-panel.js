import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { delimiter, join, resolve, sep } from 'node:path';

import { ProtocolError } from '../../common/protocol.js';

/**
 * Drives the CrowPanel (ESP32) attached to this machine, by queued task.
 *
 * This is the handler that makes "flash the panel" something the Alpha host can
 * ask for instead of something a person does by hand in the Arduino IDE. The
 * panel hangs off a USB serial port on one laptop; nothing reaches into that
 * laptop to use it, the agent there dials out and claims the task exactly like
 * any other work.
 *
 * It runs an external program, so it follows the rules `alpha-coordination`
 * set: a pinned executable, a pinned sketch that must resolve inside a
 * configured root, an allowlisted action, and an argv array passed to execFile.
 * There is no shell in this file. Nothing the payload carries ever becomes a
 * path, a board or a flag — the payload chooses an action and, at most, which
 * of this machine's serial ports to talk to.
 *
 * **Credentials are runtime data, never build input.** `Provision` sends the
 * WiFi SSID and password down the wire to a sketch that is already running, and
 * the sketch puts them in NVS itself. The alternative — baking them in with
 * `--build-property` — would put the password in an argv that every process
 * listing on the machine can read, and in build artifacts on disk, and would
 * mean a reflash every time the network changes. So the firmware stays fixed
 * and the secret stays out of it. The password is never logged and never
 * appears in the result; see `redact`.
 *
 * It is NOT registered by default — it drives a program and touches hardware.
 * Enable it on the laptop with the panel on it:
 *   ALPHA_EXTRA_HANDLERS=alpha-panel
 *
 * Because the panel is on exactly one machine, queue these with
 * `--agent <that machine>`. Targeting is what keeps the task from landing on a
 * laptop that merely has a copy of the same configuration.
 *
 * Configuration:
 *   ALPHA_PANEL_ROOT    Root holding the sketch (required for Compile/Flash).
 *   ALPHA_PANEL_SKETCH  Sketch directory, relative to root.
 *                       Defaults to firmware/crowpanel.
 *   ALPHA_PANEL_FQBN    Board id, e.g. esp32:esp32:esp32 (required for
 *                       Compile/Flash). The panel enumerates through a CH340
 *                       USB-UART bridge, so it is a classic ESP32 rather than
 *                       an S3 — those present native USB or a CH343.
 *   ALPHA_PANEL_PORT    Default serial port, e.g. COM3 or /dev/ttyUSB0.
 *   ALPHA_ARDUINO_CLI   arduino-cli executable. Defaults to `arduino-cli`.
 */

export const type = 'alpha.panel';

export const description =
  'Drives the CrowPanel on this machine: lists serial ports, compiles and flashes the pinned sketch, and provisions its WiFi credentials.';

/**
 * What this handler will do, narrowest first.
 *
 * - `Ports` and `Status` read and change nothing.
 * - `Compile` builds the pinned sketch and touches no hardware, so it answers
 *   "would a flash even work?" without writing to the board.
 * - `Flash` writes that same pinned sketch to the board.
 * - `Provision` hands a running sketch new WiFi credentials.
 *
 * There is deliberately no action that erases flash, reads it back, or names a
 * binary of its own. A handler that flashed a file the payload chose would be
 * arbitrary code execution on the microcontroller — the hardware equivalent of
 * the remote shell `handlers/index.js` says must never appear here.
 */
export const ALLOWED_ACTIONS = Object.freeze(['Ports', 'Status', 'Compile', 'Flash', 'Provision']);

const DEFAULT_SKETCH = 'firmware/crowpanel';
const CLI_TIMEOUT_MS = 300_000; // A cold ESP32 core build is minutes, not seconds.
const PROVISION_TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 16_000;

// A port name lands in an argv slot where arduino-cli would otherwise accept a
// flag, so it is matched rather than escaped: Windows COM ports, and the tty
// device names Linux and macOS give USB serial adapters.
const PORT_PATTERN = /^(COM[1-9][0-9]{0,2}|\/dev\/tty[A-Za-z0-9._-]{1,32}|\/dev\/cu\.[A-Za-z0-9._-]{1,32})$/;

// vendor:arch:board, optionally with :opt=value,opt=value after it.
const FQBN_PATTERN = /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+(:[A-Za-z0-9_.-]+=[A-Za-z0-9_.-]+(,[A-Za-z0-9_.-]+=[A-Za-z0-9_.-]+)*)?$/;

// 802.11 caps an SSID at 32 bytes and a WPA2 passphrase at 63 ASCII characters.
// Rejecting here rather than at the board turns a silent "it just never joins"
// into an answer that comes straight back on the task.
const MAX_SSID_BYTES = 32;
const MAX_PASSWORD_LENGTH = 63;
const MIN_PASSWORD_LENGTH = 8;

export function validateAction(action) {
  // Ports is the harmless one, so it is what an empty payload means.
  const requested = action ?? 'Ports';
  if (!ALLOWED_ACTIONS.includes(requested)) {
    throw new ProtocolError(
      `unsupported action ${JSON.stringify(action)}; expected one of ${ALLOWED_ACTIONS.join(', ')}`,
    );
  }
  return requested;
}

export function validatePort(port) {
  const requested = port ?? process.env.ALPHA_PANEL_PORT;
  if (!requested) {
    throw new ProtocolError(
      'no serial port given and ALPHA_PANEL_PORT is not set on this agent',
      { status: 500, code: 'not_configured' },
    );
  }
  if (typeof requested !== 'string' || !PORT_PATTERN.test(requested)) {
    throw new ProtocolError(
      `"port" must be a serial port name such as COM3 or /dev/ttyUSB0, got ${JSON.stringify(requested)}`,
    );
  }
  return requested;
}

/**
 * The board id. Read from configuration only — never from the payload. Whoever
 * queues a flash chooses *whether* to flash, not what board the firmware is
 * built for; a wrong FQBN is how you brick a panel from another room.
 */
export function validateFqbn(fqbn = process.env.ALPHA_PANEL_FQBN) {
  if (!fqbn) {
    throw new ProtocolError(
      'ALPHA_PANEL_FQBN is not set on this agent, so there is no board to build for',
      { status: 500, code: 'not_configured' },
    );
  }
  if (!FQBN_PATTERN.test(fqbn)) {
    throw new ProtocolError(`ALPHA_PANEL_FQBN is not a valid board id: ${JSON.stringify(fqbn)}`, {
      status: 500,
      code: 'not_configured',
    });
  }
  return fqbn;
}

export function validateCredentials(payload) {
  const ssid = payload?.ssid;
  const password = payload?.password;

  if (typeof ssid !== 'string' || ssid.length === 0) {
    throw new ProtocolError('"ssid" is required for the Provision action');
  }
  if (Buffer.byteLength(ssid, 'utf8') > MAX_SSID_BYTES) {
    throw new ProtocolError(`"ssid" must be at most ${MAX_SSID_BYTES} bytes`);
  }
  // The line protocol below is newline-delimited JSON, so a newline inside a
  // credential would split one message into two and leave half a password
  // sitting in the board's input buffer.
  if (/[\r\n]/.test(ssid)) throw new ProtocolError('"ssid" must not contain a newline');

  if (typeof password !== 'string') {
    throw new ProtocolError('"password" is required for the Provision action');
  }
  if (/[\r\n]/.test(password)) throw new ProtocolError('"password" must not contain a newline');
  // An open network is a legitimate answer; anything else has a WPA2 floor.
  if (password.length > 0) {
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      throw new ProtocolError(
        `"password" must be empty (open network) or ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters`,
      );
    }
  }
  return { ssid, password };
}

/**
 * Where the panel should point itself, for the live report.
 *
 * Optional: provisioning WiFi alone is a legitimate thing to do, and a panel
 * with no host simply shows the network and waits. Constrained when present,
 * because it is the address the panel will hand a bearer key to — an http(s)
 * URL with no credentials, no query and no fragment in it.
 */
export function validateAlphaTarget(payload) {
  const host = payload?.host;
  const key = payload?.key;

  if (host === undefined || host === null || host === '') {
    if (key) throw new ProtocolError('"key" was given without a "host" to use it against');
    return { host: null, key: '' };
  }
  if (typeof host !== 'string') throw new ProtocolError('"host" must be a string');

  let url;
  try {
    url = new URL(host);
  } catch {
    throw new ProtocolError(`"host" must be an absolute URL, got ${JSON.stringify(host)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProtocolError('"host" must be an http or https URL');
  }
  if (url.username || url.password) {
    throw new ProtocolError('"host" must not carry credentials in the URL');
  }
  if (url.search || url.hash) {
    throw new ProtocolError('"host" must not carry a query string or fragment');
  }
  if (key !== undefined && key !== null && typeof key !== 'string') {
    throw new ProtocolError('"key" must be a string');
  }
  if (/[\r\n]/.test(key ?? '')) throw new ProtocolError('"key" must not contain a newline');

  // Trailing slash removed once here so the sketch can append "/stats" without
  // producing a double slash that some routers answer with a 301 the panel
  // does not follow.
  return { host: url.origin + url.pathname.replace(/\/$/, ''), key: key ?? '' };
}

function requireSketch() {
  const root = process.env.ALPHA_PANEL_ROOT;
  if (!root) {
    throw new ProtocolError(
      'ALPHA_PANEL_ROOT is not set on this agent, so there is no sketch to build',
      { status: 500, code: 'not_configured' },
    );
  }
  const base = resolve(root);
  if (!existsSync(base)) {
    throw new ProtocolError(`ALPHA_PANEL_ROOT does not exist: ${base}`, {
      status: 500,
      code: 'not_configured',
    });
  }
  const sketch = resolve(base, process.env.ALPHA_PANEL_SKETCH ?? DEFAULT_SKETCH);
  // Same containment check the coordination handler does, and for the same
  // reason: both sides resolved, so a root written as "C:/panel" or with a
  // trailing separator still compares correctly.
  if (sketch !== base && !sketch.startsWith(base + sep)) {
    throw new ProtocolError('ALPHA_PANEL_SKETCH must live inside ALPHA_PANEL_ROOT', {
      status: 500,
      code: 'not_configured',
    });
  }
  if (!existsSync(sketch)) {
    throw new ProtocolError(`panel sketch not found at ${sketch}`, {
      status: 500,
      code: 'not_configured',
    });
  }
  return { base, sketch };
}

/**
 * Whether this machine can actually drive a panel, checked before the agent
 * offers the type at all.
 *
 * `.env.agent` is copied from one machine to the next — that is how a second
 * machine gets set up — so a laptop with no board, no arduino-cli and no sketch
 * would otherwise advertise `alpha.panel`, win it on free RAM, and fail it with
 * an attempt spent and a retry free to land right back there. Being opt-in does
 * not cover that: the copied file carries ALPHA_EXTRA_HANDLERS too.
 *
 * It asks exactly what `run()` asks, the same way — same root, same
 * sketch-inside-root rule, same FQBN validation, same executable resolved
 * against PATH — or a machine could pass the check and fail the task, which is
 * the failure the check exists to prevent.
 *
 * It requires everything `Flash` needs, not the smaller set `Ports` or
 * `Provision` would do with. `alpha.panel` is advertised as one name: a machine
 * that answers to it is offering the whole type, and flashing is the part that
 * cannot be recovered from by queueing elsewhere. A machine set up only to
 * provision is not a case that exists — the board is on the machine that
 * flashes it.
 *
 * It executes nothing. Whether arduino-cli actually talks to the board is not
 * knowable without trying, and `run()` still reports that honestly.
 */
export function available() {
  try {
    requireSketch();
    validateFqbn();
  } catch (error) {
    return { ok: false, reason: error.message };
  }

  const cli = process.env.ALPHA_ARDUINO_CLI ?? 'arduino-cli';
  if (!resolveExecutable(cli)) {
    return { ok: false, reason: `arduino-cli not found (${cli}). Set ALPHA_ARDUINO_CLI to its path.` };
  }
  return { ok: true };
}

/**
 * Where a command would be found, or null.
 *
 * `execFile` resolves a bare name against PATH, so the check has to as well or
 * the default `arduino-cli` would look missing on every machine that has it
 * installed normally. Windows needs PATHEXT too — the panel is on the Alpha
 * host, which is the Windows box, and a check that only looked for the bare
 * name would take the one machine with the board out of the running.
 */
function resolveExecutable(command) {
  if (command.includes('/') || command.includes(sep)) {
    return existsSync(command) ? command : null;
  }
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, command + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Builds the argv passed to arduino-cli. Exported so tests can assert on it. */
export function buildArgs({ action, sketch, fqbn, port }) {
  if (action === 'Ports') return ['board', 'list', '--format', 'json'];
  if (action === 'Status') return ['board', 'list', '--format', 'json'];
  if (action === 'Compile') return ['compile', '--fqbn', fqbn, '--format', 'json', sketch];
  // Upload only. The compile is a separate invocation above, so a build failure
  // is reported as a build failure rather than as a failed flash.
  if (action === 'Flash') {
    return ['upload', '--fqbn', fqbn, '--port', port, '--format', 'json', sketch];
  }
  throw new ProtocolError(`action ${JSON.stringify(action)} does not run arduino-cli`);
}

function arduino(args, { signal } = {}) {
  const exe = process.env.ALPHA_ARDUINO_CLI ?? 'arduino-cli';
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      exe,
      args,
      { signal, timeout: CLI_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && error.code === 'ENOENT') {
          rejectPromise(
            new ProtocolError(
              `arduino-cli not found (${exe}). Set ALPHA_ARDUINO_CLI to its path.`,
              { status: 500, code: 'no_arduino_cli' },
            ),
          );
          return;
        }
        // A non-zero exit is an outcome, not a fault: a compile error and a
        // board that is not in bootloader mode are both answers the caller
        // asked for. Report them rather than throwing.
        resolvePromise({
          stdout: (stdout ?? '').toString(),
          stderr: (stderr ?? '').toString(),
          exitCode: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
        });
      },
    );
  });
}

/**
 * Sets the line discipline on a serial port.
 *
 * Node's standard library can open a serial device as a file but cannot set its
 * baud rate, and this repo has no runtime dependencies — so the one thing that
 * needs termios is delegated to the tool every platform already ships. Both
 * invocations are fixed argv with a validated port; neither takes anything from
 * the payload beyond that port.
 */
async function configurePort(port, { signal } = {}) {
  const isWindows = process.platform === 'win32';
  const exe = isWindows ? 'mode.com' : 'stty';
  const args = isWindows
    ? [port, 'BAUD=115200', 'PARITY=n', 'DATA=8', 'STOP=1', 'to=off', 'xon=off', 'odsr=off', 'octs=off', 'dtr=on', 'rts=on', 'idsr=off']
    : ['-F', port, '115200', 'raw', '-echo', '-hupcl'];

  return new Promise((resolvePromise, rejectPromise) => {
    execFile(exe, args, { signal, timeout: 10_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error && error.code === 'ENOENT') {
        rejectPromise(
          new ProtocolError(`${exe} not found; cannot configure ${port}`, {
            status: 500,
            code: 'no_stty',
          }),
        );
        return;
      }
      if (error) {
        rejectPromise(
          new ProtocolError(`could not configure ${port}: ${(stderr || error.message).trim()}`, {
            status: 500,
            code: 'port_unavailable',
          }),
        );
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

/** Never let a password reach a log line, a task result or an error message. */
export function redact(text, password) {
  if (!text) return '';
  if (!password) return text;
  return text.split(password).join('***');
}

/**
 * Runs a short command sequence against a running sketch over the wire.
 *
 * One newline-delimited JSON line out per command, lines back until the sketch
 * says what happened or the clock runs out. The timeout is the whole point: a
 * board in bootloader mode, or one running firmware that predates this
 * protocol, will never answer, and a task that hangs on a serial read holds its
 * lease until the sweeper takes it away.
 *
 * The port is opened once for the whole sequence. Opening it per command would
 * reset the board between them on every adapter that ties DTR to EN — which is
 * most of them — so the sketch would be restarting instead of answering.
 */
async function converse(port, commands, secret, { signal, log } = {}) {
  await configurePort(port, { signal });

  const handle = await open(port, 'r+').catch((error) => {
    throw new ProtocolError(`could not open ${port}: ${error.message}`, {
      status: 500,
      code: 'port_unavailable',
    });
  });

  const buffer = Buffer.alloc(4096);
  let received = '';
  let consumed = 0;

  // Reads until a JSON line carrying `ok` or `error` shows up, or the deadline
  // passes. `consumed` keeps the scan from re-matching the previous command's
  // reply, which would otherwise make every command after the first appear to
  // succeed instantly.
  async function awaitReply(deadline) {
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new ProtocolError('aborted', { status: 499, code: 'aborted' });

      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null).catch(() => ({
        bytesRead: 0,
      }));

      if (bytesRead > 0) {
        received += buffer.subarray(0, bytesRead).toString('utf8');
        const lines = received.split('\n');
        for (let i = consumed; i < lines.length - 1; i++) {
          const trimmed = lines[i].trim();
          consumed = i + 1;
          if (!trimmed.startsWith('{')) continue;
          try {
            const reply = JSON.parse(trimmed);
            if (reply?.ok !== undefined || reply?.error !== undefined) return reply;
          } catch {
            // Not a reply of ours — the board's ordinary logging.
          }
        }
      } else {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    return null;
  }

  try {
    const replies = [];
    for (const command of commands) {
      await handle.write(`${JSON.stringify(command)}\n`);
      // Logged by name only. The payload of a wifi command is the password.
      log?.info?.('sent panel command', { port, cmd: command.cmd });
      const reply = await awaitReply(Date.now() + PROVISION_TIMEOUT_MS);
      replies.push({ cmd: command.cmd, reply, timedOut: reply === null });
      // Stop at the first command that fails: handing an unreachable panel a
      // host and key after its network join failed just buries the real error.
      if (reply === null || reply.ok !== true) break;
    }
    return { replies, transcript: redact(received, secret).slice(-MAX_OUTPUT) };
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function run(payload, { signal, log } = {}) {
  const action = validateAction(payload?.action);

  // Ports is the discovery call: it is what you run to find out that the panel
  // came up as COM3 this time. It needs no configuration at all, which is the
  // point — it has to work on a machine that has not been set up yet.
  if (action === 'Ports' || action === 'Status') {
    const result = await arduino(buildArgs({ action }), { signal });
    let boards = null;
    try {
      boards = JSON.parse(result.stdout);
    } catch {
      // Older arduino-cli prints a table even with --format json. Hand back the
      // raw text rather than failing the task over a formatting difference.
    }
    return {
      action,
      exitCode: result.exitCode,
      boards,
      stdout: boards ? undefined : result.stdout.slice(-MAX_OUTPUT),
      stderr: result.stderr.slice(-MAX_OUTPUT),
    };
  }

  if (action === 'Provision') {
    const port = validatePort(payload?.port);
    const { ssid, password } = validateCredentials(payload);
    const { host, key } = validateAlphaTarget(payload);

    // Host and key first, then the network. The sketch answers the wifi command
    // only after it has tried to join, so putting it last means the single
    // reply the operator reads is the one that says whether the panel is
    // actually on the network.
    const commands = [];
    if (host) commands.push({ cmd: 'alpha', host, key });
    commands.push({ cmd: 'wifi', ssid, password });

    const outcome = await converse(port, commands, password, { signal, log });
    const wifi = outcome.replies.find((entry) => entry.cmd === 'wifi');

    // The SSID is which network, not a secret, and naming it is the whole
    // report. The password is not here and never will be.
    return {
      action,
      port,
      ssid,
      host: host ?? null,
      provisioned: wifi?.reply?.ok === true,
      ip: wifi?.reply?.ip ?? null,
      timedOut: outcome.replies.some((entry) => entry.timedOut),
      replies: outcome.replies,
      transcript: outcome.transcript,
    };
  }

  const { sketch } = requireSketch();
  const fqbn = validateFqbn();

  if (action === 'Compile') {
    log?.info?.('compiling panel sketch', { sketch, fqbn });
    const result = await arduino(buildArgs({ action, sketch, fqbn }), { signal });
    return {
      action,
      sketch,
      fqbn,
      compiled: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout.slice(-MAX_OUTPUT),
      stderr: result.stderr.slice(-MAX_OUTPUT),
    };
  }

  // Flash. Compile first and stop if that fails — uploading after a failed
  // build either flashes a stale binary from the cache or half-writes the
  // board, and both are worse than not having started.
  const port = validatePort(payload?.port);
  log?.info?.('flashing panel', { sketch, fqbn, port });

  const built = await arduino(buildArgs({ action: 'Compile', sketch, fqbn }), { signal });
  if (built.exitCode !== 0) {
    return {
      action,
      sketch,
      fqbn,
      port,
      flashed: false,
      refused: 'sketch did not compile',
      exitCode: built.exitCode,
      stdout: built.stdout.slice(-MAX_OUTPUT),
      stderr: built.stderr.slice(-MAX_OUTPUT),
    };
  }

  const uploaded = await arduino(buildArgs({ action, sketch, fqbn, port }), { signal });
  return {
    action,
    sketch,
    fqbn,
    port,
    flashed: uploaded.exitCode === 0,
    exitCode: uploaded.exitCode,
    stdout: uploaded.stdout.slice(-MAX_OUTPUT),
    stderr: uploaded.stderr.slice(-MAX_OUTPUT),
  };
}

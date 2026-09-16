import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, delimiter, join, resolve, sep } from 'node:path';

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
 * - `Scan` asks the board which WiFi networks *it* can see. The laptop beside
 *   it is not the same radio in the same place, and provisioning a panel with
 *   a network it cannot hear is the failure that looks like a wrong password.
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
export const ALLOWED_ACTIONS = Object.freeze([
  'Ports',
  'Status',
  'Scan',
  'Compile',
  'Flash',
  'Provision',
]);

const DEFAULT_SKETCH = 'firmware/crowpanel';
const CLI_TIMEOUT_MS = 300_000; // A cold ESP32 core build is minutes, not seconds.

// How long one command may take to answer. It has to outlast the longest thing
// the sketch does before it replies, which is the 20s join inside its `wifi`
// command — a shorter budget here reports a wrong password as "the board said
// nothing", which sends an operator to the cable instead of to the password.
const REPLY_TIMEOUT_MS = 25_000;

// How long to wait for the board to come back after the port opens, and how
// often to ask. Opening the port resets the board on every adapter that ties
// DTR to EN, and the sketch's own setup() joins WiFi (15s) before its loop
// starts reading serial at all, so "it is not answering yet" is the normal
// state for the first few seconds of every Provision.
const READY_TIMEOUT_MS = 30_000;
const PROBE_INTERVAL_MS = 2_000;

// Neither read below may sit on the port indefinitely: on a raw tty a read with
// no data waits forever, which is exactly the case — a silent board — the
// timeouts exist for.
const READ_SLICE_MS = 250;

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
// What the firmware stores (PANEL_MAX_NETWORKS). Kept in step by hand, and the
// board is the one that enforces it — this only turns "silently forgot the
// fourth" into an answer that comes back on the task.
const MAX_NETWORKS = 4;

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
 * The name this process has to open the port by.
 *
 * COM1 to COM9 are legacy DOS device names and open by name. COM10 and up do
 * not exist in that namespace at all: the only way to reach them is the device
 * path `\\\\.\\COM10`, and opening the bare name fails with ENOENT — which reads
 * as "the board is not there" when it is sitting on the desk, plugged in.
 *
 * That is not an edge case here. Windows renumbers COM ports on every
 * re-enumeration — the failure `device.inventory` exists to make visible — so a
 * board that has been replugged a few times is *how* a panel ends up on COM12.
 *
 * arduino-cli does not go through the DOS namespace, so its argv keeps the
 * plain name; this is only for the handle this process opens and for
 * `mode.com`. The low ports keep the name they have always worked under.
 */
export function devicePath(port, platform = process.platform) {
  if (platform !== 'win32') return port;
  const match = /^COM(\d+)$/.exec(port);
  if (!match || Number(match[1]) < 10) return port;
  return `\\\\.\\${port}`;
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
 * The networks this panel should know, best-effort first.
 *
 * A panel that knows one network is dark wherever that network is not: the
 * laptop it reports on moves between the house WiFi and a hotspot, and the
 * board on the shelf does not. So `Provision` takes a list — `networks: [...]`
 * — and the single `ssid`/`password` form still means a list of one, because
 * that is what every existing caller sends and what one WiFi actually needs.
 *
 * Each entry is validated exactly as a single credential is; a bad one in the
 * list fails the whole command rather than being dropped, since a panel
 * provisioned with three of the four networks somebody meant is the kind of
 * half-success nobody notices until they are in the wrong room.
 */
export function validateNetworks(payload) {
  const list = payload?.networks;

  if (list === undefined || list === null) {
    // One network, the way it has always been sent.
    return [validateCredentials(payload)];
  }
  if (!Array.isArray(list)) throw new ProtocolError('"networks" must be an array');
  if (list.length === 0) throw new ProtocolError('"networks" must name at least one network');
  if (list.length > MAX_NETWORKS) {
    throw new ProtocolError(
      `"networks" must be at most ${MAX_NETWORKS} — the board stores that many, and every one it tries and fails is seconds the screen is dark`,
    );
  }

  const networks = list.map((entry) => validateCredentials(entry));
  const seen = new Set();
  for (const network of networks) {
    // Two entries for one SSID means one of the two passwords is wrong and
    // nobody knows which. Refusing is the only answer that cannot be silently
    // the wrong one.
    if (seen.has(network.ssid)) {
      throw new ProtocolError(`"networks" names ${JSON.stringify(network.ssid)} twice`);
    }
    seen.add(network.ssid);
  }
  return networks;
}

/**
 * Where the panel should point itself, for the live report.
 *
 * Optional: provisioning WiFi alone is a legitimate thing to do, and a panel
 * with no host simply shows the network and waits. Constrained when present,
 * because it is the address the panel will hand a bearer key to — an http(s)
 * URL with no credentials, no query and no fragment in it.
 */
function validateReportUrl(value, field) {
  if (typeof value !== 'string') throw new ProtocolError(`"${field}" must be a string`);

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ProtocolError(`"${field}" must be an absolute URL, got ${JSON.stringify(value)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProtocolError(`"${field}" must be an http or https URL`);
  }
  if (url.username || url.password) {
    throw new ProtocolError(`"${field}" must not carry credentials in the URL`);
  }
  if (url.search || url.hash) {
    throw new ProtocolError(`"${field}" must not carry a query string or fragment`);
  }
  // Trailing slash removed once here so the sketch can append "/stats" without
  // producing a double slash that some routers answer with a 301 the panel
  // does not follow.
  return url.origin + url.pathname.replace(/\/$/, '');
}

export function validateAlphaTarget(payload) {
  const host = payload?.host;
  const standbyHost = payload?.standbyHost;
  const key = payload?.key;

  if (host === undefined || host === null || host === '') {
    if (key) throw new ProtocolError('"key" was given without a "host" to use it against');
    if (standbyHost) throw new ProtocolError('"standbyHost" was given without a "host"');
    return { host: null, standbyHost: null, key: '' };
  }

  const primary = validateReportUrl(host, 'host');
  // Optional, and the same rules: it is the laptop running Alpha while the host
  // is off, so the panel keeps showing live numbers through a failover instead
  // of going dark. A fleet without one simply has none.
  const standby =
    standbyHost === undefined || standbyHost === null || standbyHost === ''
      ? null
      : validateReportUrl(standbyHost, 'standbyHost');

  if (key !== undefined && key !== null && typeof key !== 'string') {
    throw new ProtocolError('"key" must be a string');
  }
  if (/[\r\n]/.test(key ?? '')) throw new ProtocolError('"key" must not contain a newline');

  return { host: primary, standbyHost: standby, key: key ?? '' };
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
  // arduino-cli requires the sketch directory to hold a .ino of the same name,
  // and refuses the build otherwise. Checking it here is what keeps the rule
  // that `available()` asks exactly what `run()` asks: a machine whose
  // ALPHA_PANEL_SKETCH points at a directory arduino-cli would reject should
  // never advertise alpha.panel and lose a task to it.
  const main = join(sketch, `${basename(sketch)}.ino`);
  if (!existsSync(main)) {
    throw new ProtocolError(`panel sketch at ${sketch} has no ${basename(main)}`, {
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

/**
 * The serial ports, out of whatever shape this arduino-cli speaks.
 *
 * `Ports` is the discovery call — it exists to answer "which port is the panel
 * on this time", because Windows renumbers them on re-enumeration and the
 * answer decides what every other action here is queued with. Handing back the
 * raw blob makes a person read JSON to find one string; this pulls out the
 * address, and the vid/pid that say *what* is on it.
 *
 * Two shapes, because a machine set up last year has the older CLI on it:
 * v1 answers `{detected_ports:[{port, matching_boards}]}`, v0 a flat array. The
 * field names are the CLI's own, for the reason `alpha-devices.js` records —
 * reading for a plausible name that does not exist returns an empty list on
 * every machine, which looks like "nothing attached" rather than like a bug.
 *
 * A CH340 bridge (vid 0x1a86) is the evidence this board is a classic ESP32
 * rather than an S3, so the recipe for that call travels on the result too.
 */
export function summarizePorts(parsed) {
  const entries = Array.isArray(parsed?.detected_ports)
    ? parsed.detected_ports.map((entry) => ({
        port: entry?.port ?? {},
        boards: Array.isArray(entry?.matching_boards) ? entry.matching_boards : [],
      }))
    : Array.isArray(parsed)
      ? parsed.map((entry) => ({ port: entry ?? {}, boards: Array.isArray(entry?.boards) ? entry.boards : [] }))
      : null;
  if (!entries) return null;

  return entries.map(({ port, boards }) => ({
    address: port.address ?? null,
    protocol: port.protocol ?? null,
    label: port.protocol_label ?? port.label ?? null,
    vid: port.properties?.vid ?? null,
    pid: port.properties?.pid ?? null,
    serialNumber: port.properties?.serialNumber ?? null,
    // `fqbn` in v1, `FQBN` in v0. Advisory either way: a bare ESP32 behind a
    // CH340 matches no board definition, which is not a problem — the FQBN
    // this handler builds with comes from configuration, never from here.
    boards: boards.map((board) => ({ name: board?.name ?? null, fqbn: board?.fqbn ?? board?.FQBN ?? null })),
  }));
}

/**
 * The line-protocol commands a Provision sends, in the order they have to go.
 *
 * Host and key first, then the networks: the sketch answers `wifi` only after
 * it has tried to join, so putting it last means the single reply an operator
 * reads is the one that says whether the panel is actually on a network.
 *
 * Exported for the same reason `buildArgs` is — this is the shape the firmware
 * agrees to, and the two are only in step if something pins it.
 */
export function buildProvisionCommands({ networks, host, standbyHost, key }) {
  const commands = [];
  if (host) commands.push({ cmd: 'alpha', host, host2: standbyHost ?? '', key: key ?? '' });
  commands.push({ cmd: 'wifi', networks });
  return commands;
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
export function portConfigArgs(port, platform = process.platform) {
  if (platform === 'win32') {
    return {
      exe: 'mode.com',
      args: [devicePath(port, platform), 'BAUD=115200', 'PARITY=n', 'DATA=8', 'STOP=1', 'to=off', 'xon=off', 'odsr=off', 'octs=off', 'dtr=on', 'rts=on', 'idsr=off'],
    };
  }
  // `min 0 time 1` has to come after `raw`, which sets `min 1 time 0` — a read
  // that waits for a byte that never arrives. With VMIN 0 and VTIME 1 the read
  // comes back empty after a tenth of a second instead, which is what lets the
  // deadline below ever be looked at. A board in bootloader mode, or one
  // running firmware older than this protocol, is silent by definition.
  return { exe: 'stty', args: ['-F', port, '115200', 'raw', '-echo', '-hupcl', 'min', '0', 'time', '1'] };
}

async function configurePort(port, { signal } = {}) {
  const { exe, args } = portConfigArgs(port);

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
  // One secret or several: a provision that carries four networks carries four
  // passwords, and a transcript is only redacted if every one of them is.
  const secrets = (Array.isArray(password) ? password : [password]).filter(Boolean);
  // Longest first, so a password that contains another is not left half
  // visible by the shorter one being replaced inside it.
  secrets.sort((a, b) => b.length - a.length);
  let out = String(text);
  for (const secret of secrets) out = out.split(secret).join('***');
  return out;
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
 *
 * Split in two so the conversation can be tested without a board: `converse`
 * owns the port, `converseOver` owns the protocol.
 */
async function converse(port, commands, secret, { signal, log } = {}) {
  await configurePort(port, { signal });

  const handle = await open(devicePath(port), 'r+').catch((error) => {
    throw new ProtocolError(`could not open ${port}: ${error.message}`, {
      status: 500,
      code: 'port_unavailable',
    });
  });

  try {
    return await converseOver(handle, commands, secret, { signal, log });
  } finally {
    // Closing is also what releases a read still sitting on the port: on
    // Windows there is no termios knob for a read timeout, so an outstanding
    // read is ended by the close rather than by a clock.
    await handle.close().catch(() => {});
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * The provisioning conversation itself, against anything with `read` and
 * `write` — a real serial port, or a fake board in the tests.
 *
 * Two things here are about hardware rather than about protocol:
 *
 * - **The board is reset by the act of opening the port.** Every CH340-style
 *   adapter ties DTR to EN, so the sketch reboots the moment this handler
 *   arrives, and the sketch's own `setup()` then spends up to 15 seconds
 *   joining WiFi before its loop reads a single byte of serial. A command
 *   written straight after the open is written into a board that is not
 *   listening, and is simply lost. So the first thing sent is `status`, which
 *   changes nothing, repeated until the board answers — the credentials go out
 *   only once something is there to receive them.
 * - **No read may block forever.** A read on a raw tty waits for a byte that a
 *   silent board never sends, so every read is raced against the deadline and
 *   the *same* outstanding read is picked back up on the next pass. Issuing a
 *   second read while the first is still pending would split the board's reply
 *   across two buffers.
 */
export async function converseOver(handle, commands, secret, options = {}) {
  const {
    signal,
    log,
    readyTimeoutMs = READY_TIMEOUT_MS,
    replyTimeoutMs = REPLY_TIMEOUT_MS,
    probeIntervalMs = PROBE_INTERVAL_MS,
  } = options;

  let received = '';
  let consumed = 0;
  let inflight = null;

  function readChunk() {
    if (!inflight) {
      const buffer = Buffer.alloc(4096);
      inflight = handle.read(buffer, 0, buffer.length, null).then(
        ({ bytesRead }) => buffer.subarray(0, Math.max(bytesRead ?? 0, 0)).toString('utf8'),
        // A closed or vanished port reads as nothing rather than as a throw:
        // the caller is already on a deadline, and "no reply" is the answer.
        () => '',
      );
    }
    return inflight;
  }

  // `consumed` keeps the scan from re-matching the previous command's reply,
  // which would otherwise make every command after the first appear to succeed
  // instantly. Lines that are not ours — the board's boot banner and its
  // ordinary logging — are stepped over.
  //
  // So is a reply to a command that is no longer the one being waited on. The
  // readiness probe below can be answered late, after its own window closed,
  // and that answer would otherwise be read as the reply to whatever was sent
  // next — reporting a `wifi` command as succeeded on the strength of a
  // `status` reply. The sketch names the command in every reply for exactly
  // this; a reply without one is firmware older than that and is taken as-is.
  function nextReply(expected) {
    const lines = received.split('\n');
    for (let i = consumed; i < lines.length - 1; i++) {
      const trimmed = lines[i].trim();
      consumed = i + 1;
      if (!trimmed.startsWith('{')) continue;
      try {
        const reply = JSON.parse(trimmed);
        if (reply?.ok === undefined && reply?.error === undefined) continue;
        if (reply.cmd !== undefined && reply.cmd !== expected) continue;
        return reply;
      } catch {
        // Not a reply of ours.
      }
    }
    return null;
  }

  async function awaitReply(expected, deadline) {
    for (;;) {
      const reply = nextReply(expected);
      if (reply) return reply;
      if (signal?.aborted) throw new ProtocolError('aborted', { status: 499, code: 'aborted' });

      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;

      const chunk = await Promise.race([
        readChunk(),
        delay(Math.min(remaining, READ_SLICE_MS)).then(() => null),
      ]);
      // null means the read is still outstanding — keep it, and look at the
      // deadline again rather than starting a second one.
      if (chunk === null) continue;
      inflight = null;
      if (chunk) received += chunk;
      else await delay(50);
    }
  }

  async function send(command, deadline) {
    await handle.write(`${JSON.stringify(command)}\n`);
    // Logged by name only. The payload of a wifi command is the password.
    log?.info?.('sent panel command', { cmd: command.cmd });
    return awaitReply(command.cmd, deadline);
  }

  const transcript = () => redact(received, secret).slice(-MAX_OUTPUT);

  // Wait for the board to be there before handing it anything that matters.
  const readyBy = Date.now() + readyTimeoutMs;
  let ready = null;
  while (ready === null && Date.now() < readyBy) {
    ready = await send({ cmd: 'status' }, Math.min(Date.now() + probeIntervalMs, readyBy));
  }

  if (ready === null) {
    // Nothing was sent but a status query, so there is no half-provisioned
    // board here: either it is not running this firmware, or it is not there.
    return { ready: false, status: null, replies: [], transcript: transcript() };
  }

  const replies = [];
  for (const command of commands) {
    const reply = await send(command, Date.now() + replyTimeoutMs);
    replies.push({ cmd: command.cmd, reply, timedOut: reply === null });
    // Stop at the first command that fails: handing an unreachable panel a
    // host and key after its network join failed just buries the real error.
    if (reply === null || reply.ok !== true) break;
  }

  return { ready: true, status: ready, replies, transcript: transcript() };
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
    const ports = summarizePorts(boards);
    return {
      action,
      exitCode: result.exitCode,
      // The answer to the question this action is asked: which addresses are
      // there, and what is on them.
      ports,
      portCount: ports?.length ?? null,
      boards,
      stdout: boards ? undefined : result.stdout.slice(-MAX_OUTPUT),
      stderr: result.stderr.slice(-MAX_OUTPUT),
    };
  }

  if (action === 'Scan') {
    // Read-only, and the one question only the board can answer: what this
    // radio hears from where the panel actually sits.
    const port = validatePort(payload?.port);
    const outcome = await converse(port, [{ cmd: 'scan' }], '', { signal, log });
    const scan = outcome.replies.find((entry) => entry.cmd === 'scan');
    const networks = scan?.reply?.networks ?? null;

    return {
      action,
      port,
      ready: outcome.ready,
      refused: outcome.ready
        ? undefined
        : `nothing on ${port} answered; check the board is running this firmware and not held in bootloader`,
      // Strongest first, because the answer people want from a scan is "which
      // of these should I provision".
      networks: Array.isArray(networks)
        ? [...networks].sort((a, b) => (b?.rssi ?? -999) - (a?.rssi ?? -999))
        : null,
      timedOut: !outcome.ready || outcome.replies.some((entry) => entry.timedOut),
      transcript: outcome.transcript,
    };
  }

  if (action === 'Provision') {
    const port = validatePort(payload?.port);
    const networks = validateNetworks(payload);
    const { host, standbyHost, key } = validateAlphaTarget(payload);
    const passwords = networks.map((network) => network.password);

    // Host and key first, then the networks. The sketch answers the wifi
    // command only after it has tried to join, so putting it last means the
    // single reply the operator reads is the one that says whether the panel is
    // actually on a network.
    const commands = buildProvisionCommands({ networks, host, standbyHost, key });

    const outcome = await converse(port, commands, passwords, { signal, log });
    const wifi = outcome.replies.find((entry) => entry.cmd === 'wifi');

    // Which networks, not which passwords. The SSIDs are the whole report and
    // the secrets are not here — not in the result, not in the log, and taken
    // back out of the transcript.
    return {
      action,
      port,
      // The one it actually joined, which is not necessarily the first asked
      // for: the board picks by signal from where it is.
      ssid: wifi?.reply?.ssid ?? null,
      networks: networks.map((network) => network.ssid),
      rssi: wifi?.reply?.rssi ?? null,
      host: host ?? null,
      standbyHost: standbyHost ?? null,
      // Whether anything on the other end of the port answered at all. A board
      // that never came back is a different problem from one that came back and
      // could not join, and the two send an operator to different places.
      ready: outcome.ready,
      refused: outcome.ready ? undefined : `nothing on ${port} answered; check the board is running this firmware and not held in bootloader`,
      provisioned: wifi?.reply?.ok === true,
      ip: wifi?.reply?.ip ?? null,
      // What it tried and could not join, straight from the board: "none of
      // these three" is a different morning from "that password is wrong".
      tried: wifi?.reply?.tried ?? null,
      timedOut: !outcome.ready || outcome.replies.some((entry) => entry.timedOut),
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

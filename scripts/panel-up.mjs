#!/usr/bin/env node
/**
 * Get the CrowPanel showing live data, from this machine, in one command.
 *
 *     node scripts/panel-up.mjs --ssid "the wifi"
 *
 * Run it on the laptop the board is plugged into. It does every step that was
 * a separate command, in the order they have to happen, and stops at the first
 * one that fails with the reason rather than carrying on:
 *
 *   1. address      — this machine's LAN address. The panel is an ESP32 on
 *                     WiFi, not on the tailnet, so a 100.x address does not
 *                     exist for it and a panel pointed at one shows "no host"
 *                     for ever. That is the mistake this script exists to stop
 *   2. coordinator  — is one answering? If not, start one, bound to loopback
 *                     *and* that LAN address, and leave it running
 *   3. credential   — a key for the panel, scoped to agents:read + tasks:read
 *                     and nothing else: both read-only, so the screen on the
 *                     wall can show the fleet and its receipts and queue
 *                     nothing
 *   4. port         — which serial port the board is on
 *   5. provision    — SSID, password and the address, down the wire
 *   6. verify       — wait for the coordinator to see that key being used
 *
 * Step 6 is the only one that decides the exit code. Every step above it can
 * succeed while the screen stays dark, which is the whole reason this ends by
 * asking the coordinator rather than by reporting that the commands ran.
 *
 * The WiFi password is never an argument: ALPHA_PANEL_WIFI_PASSWORD, or it is
 * asked for. argv is readable by every process on the machine.
 */

import { execFile, spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchJson } from '../src/common/http.js';
import { loadEnv } from '../src/common/env.js';
import { parseToken } from '../src/host/auth/tokens.js';
import * as panel from '../src/agent/handlers/alpha-panel.js';

loadEnv();

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PORT = Number.parseInt(process.env.ALPHA_HOST_PORT ?? '8787', 10);

// The panel polls every five seconds; this is the window to see it happen once.
const VERIFY_MS = 90_000;
const COORDINATOR_START_MS = 45_000;

// How long one port gets to say what it is. The same window the handler gives a
// board it is provisioning, deliberately: opening the port reboots every board
// whose adapter ties DTR to EN, and the sketch spends up to 15 s joining WiFi in
// `setup()` before its loop reads a byte. A shorter window here would report the
// panel itself as silent, which is the one answer identification must never get
// wrong — it would send somebody looking for an unplugged board.
const IDENTIFY_MS = 30_000;

const USAGE = `
panel-up — make the panel show live data, from this machine

  node scripts/panel-up.mjs --ssid "the wifi"

Options
  --ssid <n>       WiFi network for the panel. Repeat it for more than one:
                   the board keeps up to four and joins whichever it can
                   actually hear. Default: ALPHA_PANEL_WIFI_SSID
  --port <p>       Serial port. Default: the one serial port on this machine
  --address <ip>   This machine's LAN address. Default: worked out from the
                   network interfaces
  --primary <url>  The usual coordinator, if it is not this machine. The panel
                   then reads that first and falls back to here
  --no-serve       Do not start a coordinator; fail if none is answering
  --list-ports     Print the serial ports on this machine and stop
  --identify       Ask every serial port here which board is on it, and stop.
                   For a machine carrying several — four CH340 clones and the
                   panel is a real fleet — this is what says which is which
  --pin [port]     Remember the board on that port (or the one a sweep finds) as
                   this machine's panel, by what it says about itself rather
                   than by its COM number. Later runs use it and check it
  --unpin          Forget it
  --scan           Ask the board which WiFi networks it can see, and stop
  --page <n>       Turn the display to a page (fleet, machines, work, receipts,
                   panel, or next) and stop. Add --hold to stop the rotation
                   there, --no-hold to let it run again
  --help           This message

  Password: ALPHA_PANEL_WIFI_PASSWORD, or you will be asked
  Admin:    ALPHA_ADMIN_TOKEN or ALPHA_BOOTSTRAP_TOKEN. One is generated if a
            coordinator has to be started here and neither is set
`.trim();

/**
 * This machine's address on the LAN the panel is on.
 *
 * Private ranges only, 192.168 first because that is what a home router hands
 * out. A tailnet 100.x is never chosen: the panel cannot reach it, and an
 * address that looks right and does not work is worse than no address at all.
 */
export function lanAddress(interfaces = networkInterfaces()) {
  const candidates = [];
  for (const addresses of Object.values(interfaces)) {
    for (const entry of addresses ?? []) {
      const isV4 = entry.family === 4 || entry.family === 'IPv4';
      if (!isV4 || entry.internal) continue;
      const ip = entry.address;
      if (ip.startsWith('100.')) continue; // tailnet: not reachable from WiFi
      if (ip.startsWith('169.254.')) continue; // link-local: no DHCP happened
      const rank = ip.startsWith('192.168.')
        ? 0
        : ip.startsWith('10.')
          ? 1
          : /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
            ? 2
            : 9;
      if (rank === 9) continue;
      candidates.push({ ip, rank });
    }
  }
  candidates.sort((a, b) => a.rank - b.rank);
  return candidates[0]?.ip ?? null;
}

/**
 * Serial ports without needing arduino-cli installed.
 *
 * The board this talks to is already flashed — that is the ordinary case for
 * "it is on the wrong WiFi" — so requiring the whole build toolchain to change
 * a password would be asking for a compiler to send a string down a wire.
 */
export function parseModeOutput(text) {
  // `mode.com` with no arguments prints "Status for device COM3:" per port.
  return [...String(text ?? '').matchAll(/device\s+(COM\d+)\s*:/gi)].map((match) => match[1]);
}

/**
 * COM ports out of the registry's own device map.
 *
 * `mode.com` is not the whole truth on Windows: it lists devices it can open,
 * so a port held by another program — a serial monitor somebody left running,
 * which is the usual reason a flash fails — can be missing from it. The device
 * map has the port either way, which turns "no serial ports here" into "COM3
 * is there, something else has it".
 *
 *     \Device\VCP0    REG_SZ    COM3
 */
export function parseSerialComm(text) {
  return [...String(text ?? '').matchAll(/REG_SZ\s+(COM\d+)\s*$/gim)].map((match) => match[1]);
}

/** What a USB serial adapter calls itself, when the system knows. */
async function usbLabels() {
  const labels = new Map();
  const byId = '/dev/serial/by-id';
  const entries = await readdir(byId).catch(() => []);
  for (const entry of entries) {
    // The names here are the useful part — "usb-1a86_USB_Serial-if00-port0" is
    // the CH340 the panel is behind — but they are symlinks, and the port this
    // handler can open is the node they point at.
    const target = await realpath(join(byId, entry)).catch(() => null);
    if (target) labels.set(target, entry);
  }
  return labels;
}

/**
 * Every serial port this machine has, with a label where one exists.
 *
 * Two sources on each platform rather than one, because the failure being
 * diagnosed is usually "the port is not where I expect it": a board that moved
 * to COM12 on a replug, or one held open by a monitor.
 */
export async function listPorts() {
  if (process.platform === 'win32') {
    const [mode, registry] = await Promise.all([
      new Promise((r) =>
        execFile('mode.com', [], { timeout: 10_000, windowsHide: true }, (error, stdout) => r(stdout ?? '')),
      ),
      new Promise((r) =>
        execFile(
          'reg.exe',
          ['query', 'HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM'],
          { timeout: 10_000, windowsHide: true },
          (error, stdout) => r(stdout ?? ''),
        ),
      ),
    ]);
    const open = new Set(parseModeOutput(mode));
    const known = new Set([...open, ...parseSerialComm(registry)]);
    return [...known]
      .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))
      .map((address) => ({
        address,
        // A port in the device map that mode cannot open is a port something
        // else is holding — worth saying, because it looks like a missing board.
        label: open.has(address) ? null : 'in use by another program?',
      }));
  }

  const [entries, labels] = await Promise.all([readdir('/dev').catch(() => []), usbLabels()]);
  return entries
    .filter((name) => /^(ttyUSB|ttyACM|cu\.usb)/.test(name))
    .map((name) => `/dev/${name}`)
    .sort()
    .map((address) => ({ address, label: labels.get(address) ?? null }));
}

/**
 * What the board on one port turned out to be.
 *
 * Worker1 carries five serial bridges — four CH340 clones and the panel — and
 * `mode.com` cannot tell them apart: every one of them is "USB-SERIAL CH340".
 * The board itself can, so this reads the answer out of one short conversation
 * rather than guessing from a label, a VID or a port number. Windows renumbers
 * COM ports on re-enumeration, so the number is the least durable thing there
 * is about a board.
 *
 * Four answers, and they send a person to four different places:
 *
 * - **panel** — it answered this firmware's `status`, so this is the board.
 * - **alpha-deck** — it is talking, and naming itself `[crowpanel]`: Alpha's
 *   own deck firmware, same board family, no credential, bare-word
 *   `STATUS`/`WIFI`/`ALPHA`. `scripts/panel-endpoint.ps1` is what points that
 *   one; flashing it here would take Alpha's deck away.
 * - **other** — talking, in neither protocol. Some other project's board.
 * - **silent** — nothing came back: an unflashed board, one held in bootloader,
 *   or an adapter with nothing on the far end of it.
 */
export function classifyBoard(outcome) {
  if (outcome?.error) return { kind: 'unreadable', detail: outcome.error };

  if (outcome?.ready) {
    const status = outcome.status ?? {};
    const detail = [
      status.firmware ? `firmware ${status.firmware}` : null,
      status.connected && status.ssid ? `on ${status.ssid}` : null,
      status.host ? `reading ${status.host}` : null,
      status.page ? `showing ${status.page}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    return { kind: 'panel', detail: detail || 'answers this firmware' };
  }

  if (outcome?.spoke) {
    const heard = String(outcome.heard ?? '').trim();
    // Alpha's deck firmware names itself in every line it prints, which is the
    // only reason these two can be told apart without a person at the board.
    if (/\[crowpanel\]/i.test(heard)) {
      return { kind: 'alpha-deck', detail: `Alpha's deck firmware — ${heard}` };
    }
    return {
      kind: 'other',
      detail: heard ? `talking, but not this protocol — ${heard}` : 'talking, but not this protocol',
    };
  }

  return { kind: 'silent', detail: 'nothing came back' };
}

/** One port, asked what it is. Sends a `status` query and nothing else. */
async function probeBoard(address) {
  // No commands: the readiness probe *is* the question, so nothing is written
  // to a board whose identity is not yet known but a status query — the same
  // thing the `Status` action sends, and the narrowest line there is.
  return panel.converse(address, [], '', { readyTimeoutMs: IDENTIFY_MS });
}

/**
 * Every port in turn, with what is on it.
 *
 * In series, not in parallel: opening a port reboots the board behind it, and
 * five boards rebooting at once on one laptop's USB is a brownout rather than a
 * diagnosis. `probe` is injected so this is testable without hardware.
 */
export async function identifyPorts(ports, probe = probeBoard, onResult = null) {
  const seen = [];
  for (const entry of ports) {
    const outcome = await probe(entry.address).catch((error) => ({
      // A port that cannot even be opened is an answer too — usually a serial
      // monitor somebody left running — and must not end the sweep.
      error: error?.message ?? String(error),
    }));
    // `status` is kept beside the classification because a pin remembers what
    // the board said about itself — its firmware and its MAC — and not just
    // which port it was on when somebody looked.
    const result = { ...entry, ...classifyBoard(outcome), status: outcome?.status ?? null };
    seen.push(result);
    onResult?.(result);
  }
  return seen;
}

/**
 * The board, remembered — `data/panel-board.json` on this machine.
 *
 * Which port the panel is on is the least durable fact about it: Windows
 * renumbers COM ports on re-enumeration, so a replug moves the board and
 * anything holding the old number stops finding it. That is the failure
 * `device.inventory` exists to make visible, and pinning *the number* would
 * reintroduce it. So a pin records what the board **said** — its firmware and,
 * from `panel-4` on, its MAC — beside where it was, and the port is treated as a
 * hint to check rather than as the answer.
 *
 * It lives in `data/`, which is gitignored: which USB socket a laptop's panel is
 * in is a fact about that laptop, not about the fleet. It holds nothing secret —
 * the panel's key is minted per provisioning and lives in the board's own NVS,
 * and a MAC is in every frame the radio sends.
 */
const PIN_FILE = process.env.ALPHA_PANEL_BOARD_FILE ?? join(ROOT, 'data', 'panel-board.json');

/** What to remember about a board that identified itself. */
export function pinFromBoard(found, { name = 'CrowPanel', now = Date.now() } = {}) {
  // Only a board that answered is pinned. A silent or unreadable port is
  // exactly the thing a pin must not assert, or the next run trusts a guess.
  if (found?.kind !== 'panel' && found?.kind !== 'alpha-deck') return null;
  const status = found.status ?? {};
  return {
    name,
    port: found.address,
    kind: found.kind,
    label: found.label ?? null,
    firmware: typeof status.firmware === 'string' ? status.firmware : null,
    mac: typeof status.mac === 'string' ? status.mac.toUpperCase() : null,
    savedAt: now,
  };
}

/**
 * Is the board on the pinned port still the pinned board?
 *
 * The MAC decides when both sides have one, because it is the only identifier
 * that survives a replug *and* a reflash. Alpha's deck firmware reports none and
 * neither did this one before `panel-4`, so the weaker answer — same kind on the
 * same port — is given as what it is rather than dressed up as proof.
 */
export function verifyPin(pin, found) {
  if (!found || (found.kind !== 'panel' && found.kind !== 'alpha-deck')) {
    return { ok: false, why: `nothing answered on ${pin.port}` };
  }
  if (found.kind !== pin.kind) {
    return { ok: false, why: `the board on ${pin.port} answers as ${found.kind} now, not ${pin.kind}` };
  }
  const mac = typeof found.status?.mac === 'string' ? found.status.mac.toUpperCase() : null;
  if (pin.mac && mac) {
    return mac === pin.mac
      ? { ok: true, why: `MAC ${mac}` }
      : { ok: false, why: `a different board: MAC ${mac}, pinned ${pin.mac}` };
  }
  return {
    ok: true,
    why: pin.mac
      ? 'it answered but reports no MAC, so this is by kind and port only'
      : 'by kind and port: this board reports no MAC to check (reflash for panel-4 to get one)',
  };
}

/** The pin, or null — a missing or damaged file is "no pin", never a crash. */
export async function readPin(file = PIN_FILE) {
  try {
    const pin = JSON.parse(await readFile(file, 'utf8'));
    return typeof pin?.port === 'string' && typeof pin?.kind === 'string' ? pin : null;
  } catch {
    return null;
  }
}

export async function writePin(pin, file = PIN_FILE) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(pin, null, 2)}\n`);
  return file;
}

const healthy = async (url) => {
  try {
    const { body } = await fetchJson(`${url}/healthz`, { timeoutMs: 3_000 });
    return Boolean(body?.ok);
  } catch {
    return false;
  }
};

/**
 * Starts a coordinator here and leaves it running.
 *
 * Detached, because the panel needs something to read five seconds from now
 * and every five seconds after that — a coordinator that dies with this script
 * would make the verify step below pass and the screen go dark a moment later.
 * Bound to loopback *and* the LAN address: the default is loopback only,
 * deliberately, and this is the case that has to override it.
 */
function startCoordinator(address, token) {
  const out = openSync(join(ROOT, 'coordinator.log'), 'a');
  const child = spawn(process.execPath, [join(ROOT, 'src', 'host', 'index.js')], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      ALPHA_HOST_BIND: `127.0.0.1,${address}`,
      ALPHA_BOOTSTRAP_TOKEN: token,
      // The long default wait exists for Tailscale coming up at boot. Here the
      // address is already on the machine, so waiting would only hide a typo.
      ALPHA_BIND_WAIT_MS: '15000',
    },
  });
  child.unref();
  return child.pid;
}

// Two read scopes and nothing else: agents:read for the fleet pages, tasks:read
// for the receipts page. Both are read-only — nothing here can queue work, which
// is the property that matters for a credential living on a wall.
const PANEL_SCOPES = ['agents:read', 'tasks:read'];

/** A credential for the panel: two read scopes, and nothing else, ever. */
async function mintPanelKey(url, token) {
  const email = `panel-${randomBytes(3).toString('hex')}@panel.local`;
  const { body: invited } = await fetchJson(`${url}/invites`, {
    method: 'POST',
    token,
    body: { email, scopes: PANEL_SCOPES },
  });
  const { body: redeemed } = await fetchJson(`${url}/invites/redeem`, {
    method: 'POST',
    // The panel never logs in. This password exists so the account is complete
    // and is deliberately thrown away.
    body: { token: invited.token, password: randomBytes(18).toString('base64url') },
  });
  return { token: redeemed.token, id: parseToken(redeemed.token).id };
}

/** Reads a line from the terminal, optionally without echoing it. */
function ask(question, { hidden = false } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const input = process.stdin;
    if (!input.isTTY) {
      rejectPromise(new Error(`nothing to read ${question.trim()} from — pass it as an option`));
      return;
    }
    process.stdout.write(question);

    let answer = '';
    const wasRaw = input.isRaw;
    if (hidden) input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    const done = () => {
      input.off('data', onData);
      if (hidden) input.setRawMode(Boolean(wasRaw));
      input.pause();
      process.stdout.write('\n');
      resolvePromise(answer.trim());
    };

    function onData(chunk) {
      for (const character of chunk) {
        if (character === '\n' || character === '\r') return done();
        // Ctrl-C in raw mode is this process's to handle: the terminal will
        // not do it while raw, and a prompt you cannot escape is a trap.
        if (character === '') {
          input.off('data', onData);
          if (hidden) input.setRawMode(Boolean(wasRaw));
          process.stdout.write('\n');
          process.exit(130);
        }
        if (character === '' || character === '\b') {
          answer = answer.slice(0, -1);
          continue;
        }
        answer += character;
        if (!hidden) process.stdout.write(character);
      }
    }

    input.on('data', onData);
  });
}

function parseArgs(argv) {
  const options = {
    ssids: process.env.ALPHA_PANEL_WIFI_SSID ? [process.env.ALPHA_PANEL_WIFI_SSID] : [],
    port: process.env.ALPHA_PANEL_PORT ?? null,
    address: null,
    primary: process.env.ALPHA_PRIMARY_URL ?? null,
    serve: true,
    listPorts: false,
    identify: false,
    pin: false,
    unpin: false,
    scan: false,
    page: null,
    hold: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-serve') options.serve = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--ssid') options.ssids.push(argv[++i] ?? '');
    else if (arg === '--list-ports') options.listPorts = true;
    else if (arg === '--identify') options.identify = true;
    else if (arg === '--unpin') options.unpin = true;
    else if (arg === '--pin') {
      options.pin = true;
      // `--pin COM4` names the port; a bare `--pin` sweeps and pins what it
      // finds, so the next argument is only taken when it is not another option.
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) options.port = argv[++i];
    }
    else if (arg === '--scan') options.scan = true;
    else if (arg === '--page') options.page = argv[++i] ?? '';
    else if (arg === '--hold') options.hold = true;
    else if (arg === '--no-hold') options.hold = false;
    else if (arg === '--port') options.port = argv[++i] ?? '';
    else if (arg === '--address') options.address = argv[++i] ?? '';
    else if (arg === '--primary') options.primary = argv[++i] ?? '';
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`panel-up: ${error.message}\n\n${USAGE}\n`);
    process.exit(1);
  }
  if (options.help) return void process.stdout.write(`${USAGE}\n`);

  const say = (line) => process.stdout.write(`${line}\n`);
  const stop = (line) => {
    process.stdout.write(`${line}\n`);
    process.exit(1);
  };

  /** The port to talk to, or a reason there is not one. */
  async function pickPort() {
    if (options.port) return options.port;

    // A pin is a hint that gets checked, not an answer that gets trusted: the
    // board is asked whether it is still the pinned one, and a board that moved
    // on a replug is found by the sweep below instead of failing the run.
    const pinned = await readPin();
    if (pinned) {
      const [found] = await identifyPorts([{ address: pinned.port, label: null }], probeBoard);
      const check = verifyPin(pinned, found);
      if (check.ok) {
        say(`port       : ${pinned.port} — ${pinned.name}, pinned (${check.why})`);
        return pinned.port;
      }
      say(`port       : ${pinned.name} is not on ${pinned.port} any more — ${check.why}`);
    }

    const ports = await listPorts();
    if (ports.length === 0) {
      stop('port       : no serial ports here. Is the board plugged into this machine?');
    }
    if (ports.length > 1) {
      // Several boards on one laptop is the ordinary case, not an error, and
      // refusing to guess is right — but the board can be asked. Only one that
      // answers *this* firmware is used, so a CH340 belonging to another
      // project is never written to beyond the status query that identified it.
      say(`port       : ${ports.length} serial ports here — asking each which one is the panel`);
      const seen = await identifyPorts(ports, probeBoard, (entry) =>
        say(`             ${entry.address}  ${entry.kind} — ${entry.detail}`),
      );
      const panels = seen.filter((entry) => entry.kind === 'panel');
      if (panels.length === 1) {
        // Found it somewhere else: remember the new port, so the next run does
        // not pay for the sweep again. This is the replug case, which is the
        // ordinary one rather than the exception.
        await writePin(pinFromBoard(panels[0])).catch(() => {});
        say(`port       : ${panels[0].address} is the panel — pinned`);
        return panels[0].address;
      }
      stop(
        `port       : ${
          panels.length === 0
            ? 'none of these answered this firmware — a board not flashed with it yet cannot, so'
            : `${panels.length} of them answered it, so`
        } name the one you mean with --port`,
      );
    }
    if (ports[0].label && ports[0].label.includes('in use')) {
      say(`port       : ${ports[0].address} — ${ports[0].label}`);
    }
    return ports[0].address;
  }

  // --- read-only: what is plugged in ------------------------------------
  if (options.listPorts) {
    const ports = await listPorts();
    if (ports.length === 0) {
      say('no serial ports on this machine.');
      say('The board shows up as one when it is plugged in and its driver is there —');
      say(process.platform === 'win32' ? 'a CH340 on Windows needs the CH341SER driver.' : 'on Linux it is /dev/ttyUSB0 and needs no driver.');
      process.exit(1);
    }
    for (const entry of ports) {
      say(`${entry.address}${entry.label ? `   ${entry.label}` : ''}`);
    }
    process.exit(0);
  }

  // --- the pin: which board this machine's panel is ----------------------
  if (options.unpin) {
    await rm(PIN_FILE, { force: true });
    say(`unpinned   : ${PIN_FILE} is gone — the next run works it out again`);
    process.exit(0);
  }

  if (options.pin) {
    // One named port, or a sweep. Either way the board has to answer: a pin on
    // a port that said nothing is a guess the next run would trust.
    const ports = options.port
      ? [{ address: options.port, label: null }]
      : await listPorts();
    if (ports.length === 0) stop('pin        : no serial ports on this machine');
    const seen = await identifyPorts(ports, probeBoard, (entry) =>
      say(`  ${entry.address.padEnd(14)} ${entry.kind.padEnd(10)} ${entry.detail}`),
    );
    const boards = seen.filter((entry) => entry.kind === 'panel' || entry.kind === 'alpha-deck');
    if (boards.length !== 1) {
      stop(
        `pin        : ${boards.length === 0 ? 'no board here identified itself' : `${boards.length} boards did`} — ` +
          'nothing pinned. Name the port with --pin <port>',
      );
    }
    const pin = pinFromBoard(boards[0]);
    await writePin(pin);
    say(`pinned     : ${pin.name} on ${pin.port} — ${pin.kind}${pin.firmware ? `, ${pin.firmware}` : ''}${pin.mac ? `, MAC ${pin.mac}` : ''}`);
    if (!pin.mac) {
      // Said plainly, because it decides how much the pin can promise: without a
      // MAC the only check left is "a board of this kind is still on this port".
      say('pinned     : this board reports no MAC, so the pin is by kind and port.');
      say(`pinned     : ${pin.kind === 'alpha-deck' ? "Alpha's deck firmware has none" : 'reflash for panel-4 and it will report one'}`);
    }
    say(`pinned     : written to ${PIN_FILE} (machine-local, gitignored, no credential in it)`);
    process.exit(0);
  }

  // --- read-only: which of these boards is the panel --------------------
  if (options.identify) {
    const ports = await listPorts();
    if (ports.length === 0) stop('no serial ports on this machine. Is the board plugged in?');
    say(
      `asking ${ports.length} port(s) what is on them, up to ${IDENTIFY_MS / 1000}s each — ` +
        'opening a port reboots the board behind it, which is why this is not instant.',
    );
    const seen = await identifyPorts(ports, probeBoard, (entry) =>
      say(`  ${entry.address.padEnd(14)} ${entry.kind.padEnd(10)} ${entry.detail}`),
    );
    const panels = seen.filter((entry) => entry.kind === 'panel');
    const decks = seen.filter((entry) => entry.kind === 'alpha-deck');
    say('');
    const pinned = await readPin();
    if (pinned) {
      // The pin is reported against what the sweep just found, never on its own:
      // a pin that quietly disagrees with the machine is worse than none.
      const found = seen.find((entry) => entry.address === pinned.port);
      const check = verifyPin(pinned, found);
      say(`pinned     : ${pinned.name} on ${pinned.port} — ${check.ok ? `still there (${check.why})` : check.why}`);
      if (!check.ok) say('pinned     : re-pin with --pin, or --pin <port> to name it');
    }
    if (panels.length === 1) {
      say(`the panel is on ${panels[0].address}. Point it at a coordinator with:`);
      say(`  node scripts/panel-up.mjs --port ${panels[0].address} --ssid "<your wifi>"`);
    } else if (panels.length > 1) {
      say(`${panels.length} boards answered this firmware: ${panels.map((entry) => entry.address).join(', ')}`);
    } else if (seen.every((entry) => entry.kind === 'unreadable')) {
      // Not the same answer as "none of these is the panel", and it sends you
      // somewhere else: no port could be read at all, so nothing here was asked.
      say('no port here could be read, so no board was asked. Each one says why above.');
      say('A port held by a serial monitor or Alpha\'s own provisioning is the usual reason.');
    } else {
      say('no board here is running this firmware.');
    }
    for (const deck of decks) {
      // Worth saying either way: it is the board people mean when they say the
      // panel, and flashing this firmware over it would take Alpha's deck away.
      say(`${deck.address} is Alpha's own deck — point that one with scripts\\panel-endpoint.ps1, not with this.`);
    }
    process.exit(panels.length === 1 ? 0 : 1);
  }

  // --- the display, which is the only thing this changes -----------------
  if (options.page !== null || options.hold !== undefined) {
    const port = await pickPort();
    const turned = await panel.run(
      {
        action: 'Page',
        port,
        ...(options.page ? { page: options.page } : {}),
        ...(options.hold === undefined ? {} : { hold: options.hold }),
      },
      {},
    );
    if (!turned.ready) stop(`page       : ${turned.refused}`);
    say(`page       : showing ${turned.page}${turned.hold ? ' (held)' : ''}`);
    if (turned.pages) say(`page       : pages are ${turned.pages.join(', ')}`);
    process.exit(0);
  }

  // --- read-only: what the board can hear -------------------------------
  if (options.scan) {
    const port = await pickPort();
    say(`scanning   : asking the board on ${port} what it can see...`);
    const scan = await panel.run({ action: 'Scan', port }, {});
    if (!scan.ready) stop(`scan       : ${scan.refused}`);
    if (!scan.networks?.length) stop('scan       : the board sees no networks at all from where it is');
    for (const network of scan.networks) {
      say(`  ${String(network.rssi).padStart(4)} dBm  ${network.ssid}${network.open ? '  (open)' : ''}`);
    }
    process.exit(0);
  }

  // 1. address
  const address = options.address ?? lanAddress();
  if (!address) {
    stop('address    : no private IPv4 address here. Is this machine on the WiFi? Pass --address');
  }
  const here = `http://${address}:${PORT}`;
  say(`address    : ${address} — this is what the panel will read`);

  // 2. coordinator
  let token = process.env.ALPHA_ADMIN_TOKEN ?? process.env.ALPHA_BOOTSTRAP_TOKEN ?? null;
  if (await healthy(here)) {
    say('coordinator: already answering here');
    if (!token) stop('coordinator: running, but no ALPHA_ADMIN_TOKEN to mint the panel a key with');
  } else if (!options.serve) {
    stop(`coordinator: nothing answering at ${here}, and --no-serve was given`);
  } else {
    const generated = !token;
    token = token ?? randomBytes(24).toString('base64url');
    const pid = startCoordinator(address, token);
    say(`coordinator: starting one here (pid ${pid}), logging to coordinator.log`);

    const deadline = Date.now() + COORDINATOR_START_MS;
    let up = false;
    while (Date.now() < deadline && !(up = await healthy(here))) {
      await new Promise((r) => setTimeout(r, 1_000));
    }
    if (!up) {
      stop(`coordinator: did not come up within ${COORDINATOR_START_MS / 1000}s — see coordinator.log`);
    }
    say('coordinator: up');
    if (generated) {
      say(`coordinator: ALPHA_BOOTSTRAP_TOKEN=${token}`);
      say('coordinator: keep that line — it is this coordinator\'s admin credential');
    }
  }

  // 3. credential
  let panelKey;
  try {
    panelKey = await mintPanelKey(here, token);
    say(`key        : minted ${panelKey.id}, scoped to ${PANEL_SCOPES.join(' + ')}`);
  } catch (error) {
    stop(`key        : could not mint one — ${error.message}`);
  }

  // 4. port
  const port = await pickPort();
  say(`port       : ${port}`);

  // 5. provision
  const ssids = options.ssids.filter(Boolean);
  if (ssids.length === 0) {
    const asked = await ask('wifi ssid  : ');
    if (!asked) stop('provision  : no SSID given');
    ssids.push(asked);
  }

  // One password per network, asked for in turn. The first can come from the
  // environment, which is what a scripted run uses; the rest are asked for,
  // because an argv is readable by every process on the machine and four
  // passwords on a command line is four of them.
  const networks = [];
  for (const [index, ssid] of ssids.entries()) {
    const fromEnv = index === 0 ? process.env.ALPHA_PANEL_WIFI_PASSWORD : undefined;
    const password = fromEnv ?? (await ask(`pass (${ssid})  : `, { hidden: true }));
    networks.push({ ssid, password });
  }

  const names = networks.map((network) => network.ssid).join(', ');
  say(`provision  : sending ${names} and ${here} to the board...`);
  let provisioned;
  try {
    provisioned = await panel.run(
      {
        action: 'Provision',
        port,
        networks,
        // With a --primary the panel learns both, so it follows the fleet home
        // when the main host comes back instead of staying on this laptop.
        host: options.primary ?? here,
        standbyHost: options.primary ? here : undefined,
        key: panelKey.token,
      },
      {},
    );
  } catch (error) {
    stop(`provision  : ${error.message}`);
  }

  if (!provisioned.ready) stop(`provision  : ${provisioned.refused}`);
  if (!provisioned.provisioned) {
    // Ask the board what it can hear before blaming the password. "None of
    // these is in range" and "that password is wrong" are different mornings,
    // and only the board can tell them apart.
    say(`provision  : the board is there but joined none of ${names}`);
    const scan = await panel.run({ action: 'Scan', port }, {}).catch(() => null);
    if (scan?.networks?.length) {
      say('provision  : what the board can actually see from where it is:');
      for (const network of scan.networks.slice(0, 8)) {
        const known = networks.some((entry) => entry.ssid === network.ssid);
        say(`               ${String(network.rssi).padStart(4)} dBm  ${network.ssid}${known ? '   <- you gave me this one, so it is the password' : ''}`);
      }
    } else if (scan) {
      say('provision  : and it can see no networks at all — the radio or the place, not the password');
    }
    process.exit(1);
  }
  say(`provision  : joined ${provisioned.ssid} as ${provisioned.ip}${provisioned.rssi ? ` (${provisioned.rssi} dBm)` : ''}`);
  if (networks.length > 1) {
    say(`provision  : ${networks.length} networks stored — it will pick whichever it can hear`);
  }

  // 6. verify — the only step that decides anything
  say('verify     : waiting for the panel to read the coordinator...');
  const deadline = Date.now() + VERIFY_MS;
  for (;;) {
    const { body } = await fetchJson(`${here}/keys`, { token, timeoutMs: 10_000 });
    const record = (body.keys ?? []).find((entry) => entry.id === panelKey.id);
    if (typeof record?.lastUsedAt === 'number') {
      const ago = Math.round((Date.now() - record.lastUsedAt) / 1000);
      say(`verify     : the panel is reading ${here} — ${ago}s ago`);
      say('');
      say('The screen is live. To keep it that way:');
      say(`  node scripts/watchdog.mjs --no-update --panel-key ${panelKey.id} --json`);
      process.exit(0);
    }
    if (Date.now() >= deadline) {
      stop(
        // `provisioned.ssid` is the network the board actually joined, which is
        // not necessarily the first one asked for — and naming a variable that
        // is not in scope here threw a ReferenceError over the top of the one
        // diagnostic this step exists to print.
        `verify     : the panel joined ${provisioned.ssid} but has not read ${here}. ` +
          'Same network? Is 8787 allowed inbound on this machine?',
      );
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`panel-up: ${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}

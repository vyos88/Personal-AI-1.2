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
 *   3. credential   — a key for the panel, scoped to agents:read and nothing
 *                     else
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
import { readdir, realpath } from 'node:fs/promises';
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
  --scan           Ask the board which WiFi networks it can see, and stop
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

/** A credential for the panel: agents:read, and nothing else, ever. */
async function mintPanelKey(url, token) {
  const email = `panel-${randomBytes(3).toString('hex')}@panel.local`;
  const { body: invited } = await fetchJson(`${url}/invites`, {
    method: 'POST',
    token,
    body: { email, scopes: ['agents:read'] },
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
    scan: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-serve') options.serve = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--ssid') options.ssids.push(argv[++i] ?? '');
    else if (arg === '--list-ports') options.listPorts = true;
    else if (arg === '--scan') options.scan = true;
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
    const ports = await listPorts();
    if (ports.length === 0) {
      stop('port       : no serial ports here. Is the board plugged into this machine?');
    }
    if (ports.length > 1) {
      const names = ports.map((entry) => entry.address + (entry.label ? ` (${entry.label})` : ''));
      stop(`port       : ${ports.length} serial ports — name one with --port\n             ${names.join('\n             ')}`);
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

  // --- read-only: what the board can hear -------------------------------
  if (options.scan) {
    const port = await pickPort();
    say(`scanning   : asking the board on ${port} what it can see...`);
    const scan = await panel.run({ action: 'Scan', port }, {});
    if (!scan.ready) stop(`scan       : nothing on ${port} answered. Wrong port, or the board needs flashing`);
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
    say(`key        : minted ${panelKey.id}, scoped to agents:read`);
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

  if (!provisioned.ready) {
    stop(`provision  : nothing on ${port} answered. Wrong port, or the board needs flashing`);
  }
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
        `verify     : the panel joined ${ssid} but has not read ${here}. ` +
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

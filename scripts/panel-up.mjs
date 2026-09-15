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
import { readdir } from 'node:fs/promises';
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
  --ssid <n>       WiFi network for the panel. Default: ALPHA_PANEL_WIFI_SSID
  --port <p>       Serial port. Default: the one serial port on this machine
  --address <ip>   This machine's LAN address. Default: worked out from the
                   network interfaces
  --primary <url>  The usual coordinator, if it is not this machine. The panel
                   then reads that first and falls back to here
  --no-serve       Do not start a coordinator; fail if none is answering
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

async function listPorts() {
  if (process.platform === 'win32') {
    const out = await new Promise((r) =>
      execFile('mode.com', [], { timeout: 10_000, windowsHide: true }, (error, stdout) =>
        r(stdout ?? ''),
      ),
    );
    return parseModeOutput(out);
  }
  const entries = await readdir('/dev').catch(() => []);
  return entries.filter((name) => /^(ttyUSB|ttyACM|cu\.usb)/.test(name)).map((name) => `/dev/${name}`);
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
    ssid: process.env.ALPHA_PANEL_WIFI_SSID ?? null,
    port: process.env.ALPHA_PANEL_PORT ?? null,
    address: null,
    primary: process.env.ALPHA_PRIMARY_URL ?? null,
    serve: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-serve') options.serve = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--ssid') options.ssid = argv[++i] ?? '';
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
  let port = options.port;
  if (!port) {
    const ports = await listPorts();
    if (ports.length === 0) {
      stop('port       : no serial ports here. Is the board plugged into this machine?');
    }
    if (ports.length > 1) {
      stop(`port       : ${ports.length} serial ports (${ports.join(', ')}) — name one with --port`);
    }
    port = ports[0];
  }
  say(`port       : ${port}`);

  // 5. provision
  const ssid = options.ssid || (await ask('wifi ssid  : '));
  if (!ssid) stop('provision  : no SSID given');
  const password =
    process.env.ALPHA_PANEL_WIFI_PASSWORD ?? (await ask('wifi pass   : ', { hidden: true }));

  say(`provision  : sending ${ssid} and ${here} to the board...`);
  let provisioned;
  try {
    provisioned = await panel.run(
      {
        action: 'Provision',
        port,
        ssid,
        password,
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
    stop(`provision  : the board is there but did not join ${ssid} — check the password`);
  }
  say(`provision  : joined ${ssid} as ${provisioned.ip}`);

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

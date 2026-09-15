#!/usr/bin/env node
/**
 * Connect the CrowPanel to Alpha, in one command, and prove it.
 *
 * Run this on the machine the board is plugged into — the Alpha host. It does
 * the whole sequence that was four queued tasks and a trip to `alpha-admin`:
 *
 *   1. check   — can this machine drive a panel at all? (handler available())
 *   2. port    — which serial port is it on? The CH340 bridge is picked out of
 *                the list, because that is the panel
 *   3. flash   — only with --flash: compile, then upload. Minutes, not seconds
 *   4. key     — the credential the panel reads /stats with. Minted here if you
 *                do not pass one, scoped to agents:read and nothing else
 *   5. provision — SSID, password, host and key, down the wire to the sketch
 *   6. verify  — watch the host until that key is actually used. This is the
 *                part that matters: everything above can succeed while the
 *                screen stays dark, and only the host can say the panel is
 *                reading it
 *
 * The receipt at the end is `lastUsedAt` moving on the panel's key. Nothing
 * else is evidence — not a COM port, not a successful flash, not "no error".
 *
 * Usage:
 *   node scripts/connect-panel.mjs --ssid <network> --flash
 *   node scripts/connect-panel.mjs --verify-only
 *
 * The password is never an argument. It comes from ALPHA_PANEL_WIFI_PASSWORD,
 * because argv is readable by every process on the machine — the same reason
 * the sketch takes credentials over the wire instead of having them built in.
 *
 * Exit codes:
 *   0  the panel is reading the host
 *   1  something needs a person; the step that failed says which
 */

import { appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchJson, HttpError } from '../src/common/http.js';
import { loadEnv } from '../src/common/env.js';
import { parseToken } from '../src/host/auth/tokens.js';
import * as panel from '../src/agent/handlers/alpha-panel.js';

loadEnv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Read when used, not when imported. A module-level const captures whatever
// the environment was at import time, which is wrong for a test that starts a
// host on a random port, and wrong for anything loading this file to reuse a
// piece of it.
const hostUrl = () => (process.env.ALPHA_HOST_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const adminToken = () => process.env.ALPHA_ADMIN_TOKEN ?? process.env.ALPHA_BOOTSTRAP_TOKEN;

// The panel polls every five seconds. Sixty covers a join, a DHCP lease and a
// first request with room to spare; longer than that is not slowness, it is a
// panel that is not coming.
const VERIFY_WINDOW_MS = 60_000;
const VERIFY_POLL_MS = 3_000;

// CH340 (1a86:7523) is the bridge on this board, and the evidence the FQBN
// rests on. Matching it is how the right port gets picked on a machine with a
// mouse dongle and a phone also enumerated as serial.
const PANEL_VID = '0x1a86';

const USAGE = `
connect-panel — flash, provision and prove the CrowPanel, from the machine it is on

  node scripts/connect-panel.mjs --ssid home-wifi --flash
  node scripts/connect-panel.mjs --verify-only

Options
  --ssid <n>        WiFi network for the panel. Default: ALPHA_PANEL_WIFI_SSID
  --port <p>        Serial port. Default: whichever port looks like the board
  --host <url>      What the panel should read. Default: ALPHA_HOST_URL
  --key <token>     The panel's credential. Default: mint one (needs an admin
                    token) named by --key-name
  --key-name <n>    Name for a minted key. Default: crowpanel
  --flash           Compile and upload the sketch first. Minutes
  --verify-only     Skip the board entirely; just ask the host whether the
                    panel is reading it
  --json            Print the record instead of the running commentary
  --log <file>      Append the record here. Default: connect-panel.log
  --help            This message

  Password:  ALPHA_PANEL_WIFI_PASSWORD (never an argument — argv is public)
  Host:      ALPHA_HOST_URL
  Auth:      ALPHA_ADMIN_TOKEN, to mint the key and to read it back
`.trim();

function parseArgs(argv) {
  const options = {
    ssid: process.env.ALPHA_PANEL_WIFI_SSID ?? null,
    port: process.env.ALPHA_PANEL_PORT ?? null,
    host: hostUrl(),
    key: null,
    keyName: 'crowpanel',
    flash: false,
    verifyOnly: false,
    json: false,
    log: resolve(ROOT, 'connect-panel.log'),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--flash') options.flash = true;
    else if (arg === '--verify-only') options.verifyOnly = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--ssid') options.ssid = argv[++i] ?? '';
    else if (arg === '--port') options.port = argv[++i] ?? '';
    else if (arg === '--host') options.host = argv[++i] ?? '';
    else if (arg === '--key') options.key = argv[++i] ?? '';
    else if (arg === '--key-name') options.keyName = argv[++i] ?? '';
    else if (arg === '--log') options.log = resolve(argv[++i] ?? '');
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  return options;
}

/**
 * Which of these ports is the panel.
 *
 * The CH340 first, then a lone serial port, then nothing — never a guess
 * between two candidates. Flashing the wrong board is not recoverable from
 * here, and "it picked the Bluetooth port" is a worse outcome than being asked
 * for --port.
 */
export function choosePort(ports) {
  if (!Array.isArray(ports) || ports.length === 0) return { port: null, why: 'no serial ports detected' };

  const serial = ports.filter((entry) => entry.address && (entry.protocol ?? 'serial') === 'serial');
  const ch340 = serial.filter((entry) => (entry.vid ?? '').toLowerCase() === PANEL_VID);
  if (ch340.length === 1) return { port: ch340[0].address, why: 'the only CH340 bridge attached' };
  if (ch340.length > 1) {
    return { port: null, why: `${ch340.length} CH340 boards attached — name one with --port` };
  }
  if (serial.length === 1) return { port: serial[0].address, why: 'the only serial port attached' };
  if (serial.length > 1) {
    return { port: null, why: `${serial.length} serial ports and no CH340 among them — name one with --port` };
  }
  return { port: null, why: 'no serial ports detected' };
}

/** Mints the narrowest credential that can read /stats. */
async function mintKey(name) {
  if (!adminToken()) throw new Error('no ALPHA_ADMIN_TOKEN, so no key could be minted — pass --key instead');
  const { body } = await fetchJson(`${hostUrl()}/keys`, {
    method: 'POST',
    token: adminToken(),
    // agents:read and nothing else. The panel reads one endpoint; a key that
    // could queue work is a screen on the wall that could queue work.
    body: { name, scopes: ['agents:read'] },
  });
  return { token: body.token, id: body.key.id };
}

/** Reads one key back off the host, by id. */
async function readKey(id) {
  const { body } = await fetchJson(`${hostUrl()}/keys`, { token: adminToken(), timeoutMs: 10_000 });
  return (body.keys ?? []).find((entry) => entry.id === id) ?? null;
}

/**
 * Step 6. Waits for the panel's key to be used, and says when it was.
 *
 * `lastUsedAt` is epoch milliseconds, recorded by the auth service on every
 * verified request. Waiting for it to *move* rather than merely be set is what
 * separates "this panel is reading the host now" from "this key was used once,
 * last Tuesday".
 */
async function verify(id, { since = null, windowMs = VERIFY_WINDOW_MS, pollMs = VERIFY_POLL_MS, onWait } = {}) {
  if (!adminToken()) return { connected: null, note: 'no ALPHA_ADMIN_TOKEN, so the panel could not be verified' };
  const deadline = Date.now() + windowMs;

  for (;;) {
    let record;
    try {
      record = await readKey(id);
    } catch (error) {
      return {
        connected: null,
        note: error instanceof HttpError ? `HTTP ${error.status} from /keys` : error.message,
      };
    }
    if (!record) return { connected: false, note: `no key ${id} on the host — revoked, or the wrong id` };

    const usedAt = typeof record.lastUsedAt === 'number' ? record.lastUsedAt : null;
    if (usedAt !== null && (since === null || usedAt > since)) {
      return {
        connected: true,
        key: id,
        lastUsedAt: new Date(usedAt).toISOString(),
        silentFor: Date.now() - usedAt,
      };
    }
    if (Date.now() >= deadline) {
      return {
        connected: false,
        key: id,
        lastUsedAt: usedAt ? new Date(usedAt).toISOString() : null,
        note: usedAt
          ? 'the key has not been used since provisioning — the panel joined nothing, or cannot reach the host'
          : 'the key has never been used — the panel is not reading the host',
      };
    }
    onWait?.(Math.max(0, deadline - Date.now()));
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`connect-panel: ${error.message}\n\n${USAGE}\n`);
    process.exit(1);
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const say = (line) => {
    if (!options.json) process.stdout.write(`${line}\n`);
  };
  const record = { at: new Date().toISOString(), host: options.host, steps: {} };

  // --- verify only -------------------------------------------------------
  if (options.verifyOnly) {
    const id = options.key ? parseToken(options.key)?.id ?? options.key : process.env.ALPHA_PANEL_KEY_ID;
    if (!id) {
      process.stderr.write('connect-panel: --verify-only needs --key or ALPHA_PANEL_KEY_ID\n');
      process.exit(1);
    }
    say(`asking ${options.host} whether the panel is reading it...`);
    record.steps.verify = await verify(id, { windowMs: 0 });
    return finish(record, options, say);
  }

  // --- 1. can this machine drive a panel ---------------------------------
  const ready = panel.available();
  record.steps.machine = ready;
  if (!ready.ok) {
    say(`this machine cannot drive the panel: ${ready.reason}`);
    return finish(record, options, say, 1);
  }
  say('machine   : sketch, board id and arduino-cli all present');

  // --- 2. which port ------------------------------------------------------
  let port = options.port;
  if (!port) {
    const listed = await panel.run({ action: 'Ports' }, {});
    record.steps.ports = listed.ports;
    const chosen = choosePort(listed.ports ?? []);
    if (!chosen.port) {
      say(`port      : ${chosen.why}`);
      return finish(record, options, say, 1);
    }
    port = chosen.port;
    say(`port      : ${port} — ${chosen.why}`);
  } else {
    say(`port      : ${port} (given)`);
  }
  record.port = port;

  // --- 3. flash -----------------------------------------------------------
  if (options.flash) {
    say('flash     : compiling and uploading, this takes minutes...');
    const flashed = await panel.run({ action: 'Flash', port }, {});
    record.steps.flash = { flashed: flashed.flashed, refused: flashed.refused, exitCode: flashed.exitCode };
    if (!flashed.flashed) {
      say(`flash     : FAILED — ${flashed.refused ?? `arduino-cli exited ${flashed.exitCode}`}`);
      record.steps.flash.stderr = (flashed.stderr ?? '').slice(-2000);
      return finish(record, options, say, 1);
    }
    say('flash     : written');
  }

  // --- 4. the panel's key -------------------------------------------------
  let keyToken = options.key;
  let keyId;
  if (keyToken) {
    keyId = parseToken(keyToken)?.id;
    if (!keyId) {
      say('key       : that does not look like an alpha key token');
      return finish(record, options, say, 1);
    }
    say(`key       : ${keyId} (given)`);
  } else {
    try {
      const minted = await mintKey(options.keyName);
      keyToken = minted.token;
      keyId = minted.id;
      say(`key       : minted ${keyId} as "${options.keyName}", scoped to agents:read`);
    } catch (error) {
      say(`key       : ${error.message}`);
      return finish(record, options, say, 1);
    }
  }
  record.key = keyId;

  // --- 5. provision -------------------------------------------------------
  const ssid = options.ssid;
  const password = process.env.ALPHA_PANEL_WIFI_PASSWORD ?? '';
  if (!ssid) {
    say('provision : no --ssid and no ALPHA_PANEL_WIFI_SSID');
    return finish(record, options, say, 1);
  }
  say(`provision : sending ${ssid} and the host to the board on ${port}...`);

  const before = (await readKey(keyId).catch(() => null))?.lastUsedAt ?? null;
  const provisioned = await panel.run(
    { action: 'Provision', port, ssid, password, host: options.host, key: keyToken },
    {},
  );
  record.steps.provision = {
    ready: provisioned.ready,
    provisioned: provisioned.provisioned,
    ip: provisioned.ip,
    ssid: provisioned.ssid,
    refused: provisioned.refused,
  };

  if (!provisioned.ready) {
    say(`provision : nothing on ${port} answered. Is the board running this firmware? Try --flash`);
    return finish(record, options, say, 1);
  }
  if (!provisioned.provisioned) {
    say(`provision : the board is there but did not join ${ssid} — check the password`);
    return finish(record, options, say, 1);
  }
  say(`provision : joined ${ssid} as ${provisioned.ip}`);

  // --- 6. the only evidence that counts -----------------------------------
  say('verify    : waiting for the panel to read the host...');
  record.steps.verify = await verify(keyId, {
    since: typeof before === 'number' ? before : null,
    onWait: (left) => say(`verify    : nothing yet, ${Math.round(left / 1000)}s left`),
  });

  return finish(record, options, say);
}

async function finish(record, options, say, forcedExit) {
  const verified = record.steps.verify;
  record.connected = verified?.connected === true;
  const exitCode = forcedExit ?? (record.connected ? 0 : 1);
  record.ok = exitCode === 0;

  try {
    await appendFile(options.log, JSON.stringify(record) + '\n');
  } catch (error) {
    process.stderr.write(`connect-panel: could not write ${options.log}: ${error.message}\n`);
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(record, null, 2) + '\n');
  } else if (verified) {
    if (verified.connected === true) {
      say(`verify    : the panel is reading the host — last seen ${Math.round(verified.silentFor / 1000)}s ago`);
      say('');
      say('Connected. Keep it that way with one scheduled check:');
      say(`  powershell -ExecutionPolicy Bypass -File .\\scripts\\install-watch-task.ps1 -PanelKey ${record.key ?? verified.key}`);
    } else if (verified.connected === null) {
      say(`verify    : not checked — ${verified.note}`);
    } else {
      say(`verify    : NOT CONNECTED — ${verified.note}`);
    }
  }

  process.exit(exitCode);
}

// Run when invoked, importable when tested: the port-picking and the verify
// loop are the parts worth testing without a board, and importing a module that
// runs itself would take the test process down with process.exit.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`connect-panel: ${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}

export { verify };

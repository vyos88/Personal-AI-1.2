#!/usr/bin/env node
/**
 * Make Alpha's backend reachable from the CrowPanel, on the machine it runs on.
 *
 *     node scripts/fix-panel-host.mjs
 *
 * The panel is an ESP32 on the house WiFi. It cannot reach `127.0.0.1`, and it
 * cannot reach a tailnet `100.x` address either — those do not exist for it. It
 * reaches this machine on a home-network address and nothing else, so three
 * settings in Alpha's `app/.env.local` decide whether the screen is dark:
 *
 *   HOST                  the addresses the backend binds. Without the home
 *                         address in it, nothing the panel can dial is listening
 *   ALPHA_TRUSTED_HOSTS   taken at startup. An address that is bound but not
 *                         trusted answers 400, which looks like the panel's fault
 *   ALPHA_PANEL_LAN_READ  the deck feed itself. Off, and
 *                         /panel/crowpanel/public-state is a 404
 *
 * This reads those three, adds this machine's home-network address to the first
 * two and turns the third on, keeping every other line and every address that
 * was already there — a DHCP lease that moved is the usual reason it is wrong,
 * and removing the old one is how the next person loses the tailnet. Then it
 * restarts the backend and checks the feed from the home address, which is the
 * only check that means anything: it is the request the panel makes.
 *
 * It changes Alpha's configuration, so it is deliberately a command somebody
 * runs, not an autopilot job. `--dry-run` prints the diff and writes nothing.
 *
 * Exit 0 when the feed answers on a home-network address; 1 with the reason.
 */

import { execFile } from 'node:child_process';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ALPHA_ROOT = process.env.ALPHA_APP_ROOT ?? 'C:\\AlphaData\\Alpha';
const DEFAULT_TASK = 'Alpha Backend';
const DEFAULT_PORT = 8001;
// The deck firmware polls this every three seconds and holds no credential.
const FEED_PATH = '/panel/crowpanel/public-state';

const USAGE = `
fix-panel-host — let the CrowPanel reach Alpha's backend on this machine

  node scripts/fix-panel-host.mjs

Options
  --alpha-root <dir>  Where Alpha lives. Default: ALPHA_APP_ROOT or
                      ${DEFAULT_ALPHA_ROOT}
  --env <file>        The env file to edit. Default: <alpha-root>\\app\\.env.local
  --address <ip>      The home-network address to publish. Default: this
                      machine's, worked out from its interfaces
  --port <n>          Backend port. Default: ${DEFAULT_PORT}
  --task <name>       Scheduled task to restart. Default: ${DEFAULT_TASK}
  --no-restart        Edit and check only; do not restart the backend
  --dry-run           Print what would change and write nothing
  --json              Print the record instead of the running commentary
  --help              This message
`.trim();

/**
 * This machine's addresses the panel could actually dial.
 *
 * Private ranges only, and never `100.x`: that is both Tailscale and Starlink's
 * CGNAT here, and neither is on the house WiFi. Virtual switches are left out by
 * name — a WSL or Hyper-V address is reachable from nothing with a screen.
 */
export function homeAddresses(interfaces = networkInterfaces()) {
  const virtual = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback|Bluetooth/i;
  const found = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (virtual.test(name)) continue;
    for (const entry of addresses ?? []) {
      const isV4 = entry.family === 4 || entry.family === 'IPv4';
      if (!isV4 || entry.internal) continue;
      const ip = entry.address;
      if (ip.startsWith('169.254.')) continue; // no DHCP happened
      const home =
        ip.startsWith('192.168.') ||
        ip.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
      if (!home) continue;
      found.push({ ip, nic: name, rank: ip.startsWith('192.168.') ? 0 : 1 });
    }
  }
  found.sort((a, b) => a.rank - b.rank);
  return found;
}

const splitList = (value) =>
  String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

/** The value of a key as the backend sees it: the last one wins, as dotenv does. */
export function readKey(lines, key) {
  let value = null;
  let count = 0;
  for (const line of lines) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match || match[1] !== key) continue;
    count += 1;
    value = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return { value, count };
}

/**
 * Sets a key, in place where it exists and appended where it does not.
 *
 * The *last* occurrence is the one rewritten, because that is the one the
 * backend reads: changing an earlier duplicate would look right in the file and
 * do nothing at all.
 */
function setKey(lines, key, value) {
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(lines[i]);
    if (match && match[1] === key) at = i;
  }
  if (at === -1) {
    lines.push(`${key}=${value}`);
    return lines;
  }
  lines[at] = `${key}=${value}`;
  return lines;
}

/**
 * The three settings the panel depends on, with this machine's address added.
 *
 * Nothing is removed. `127.0.0.1` stays so everything on this machine keeps
 * working when the network does not, and a tailnet address already listed stays
 * because the rest of the fleet is reaching the backend through it.
 */
export function planEnv(text, { addresses, lanRead = true } = {}) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const wanted = Array.isArray(addresses) ? addresses.filter(Boolean) : [addresses].filter(Boolean);

  const before = {
    host: readKey(lines, 'HOST'),
    trusted: readKey(lines, 'ALPHA_TRUSTED_HOSTS'),
    lan: readKey(lines, 'ALPHA_PANEL_LAN_READ'),
  };

  // HOST: keep loopback first — the doctor, the frontend and every local script
  // reach the backend there, and a bind list without it breaks them all.
  const host = splitList(before.host.value);
  if (!host.includes('127.0.0.1')) host.unshift('127.0.0.1');
  const added = [];
  for (const address of wanted) {
    if (!host.includes(address)) {
      host.push(address);
      added.push(address);
    }
  }

  // ALPHA_TRUSTED_HOSTS is read at startup and rejects anything not in it with a
  // 400, so an address bound but not trusted is a panel showing nothing with
  // every light green. Only touched when the key is already there: a backend
  // that trusts everything by default must not be narrowed by this.
  const trusted = splitList(before.trusted.value);
  const trustedAdded = [];
  if (before.trusted.count > 0) {
    for (const address of wanted) {
      if (!trusted.includes(address) && !trusted.includes('*')) {
        trusted.push(address);
        trustedAdded.push(address);
      }
    }
  }

  const next = [...lines];
  setKey(next, 'HOST', host.join(','));
  if (before.trusted.count > 0) setKey(next, 'ALPHA_TRUSTED_HOSTS', trusted.join(','));
  if (lanRead) setKey(next, 'ALPHA_PANEL_LAN_READ', 'true');

  const text2 = next.join(eol);
  return {
    text: text2,
    changed: text2 !== text,
    host: host.join(','),
    trusted: before.trusted.count > 0 ? trusted.join(',') : null,
    added,
    trustedAdded,
    lanWas: before.lan.value,
    // Duplicates are legal and the last wins, which is exactly why a reader of
    // the file can be sure a setting is right and be wrong.
    duplicates: Object.entries(before)
      .filter(([, entry]) => entry.count > 1)
      .map(([name]) => name),
  };
}

const run = (command, args) =>
  new Promise((resolvePromise) => {
    execFile(command, args, { timeout: 120_000, windowsHide: true }, (error, stdout, stderr) =>
      resolvePromise({ ok: !error, out: `${stdout ?? ''}${stderr ?? ''}`.trim() }),
    );
  });

/** The request the panel makes, from the address the panel would use. */
export async function checkFeed(base, { timeoutMs = 5_000 } = {}) {
  const result = { base, health: null, feed: null, status: null, ok: false };
  for (const [name, path] of [
    ['health', '/health'],
    ['feed', FEED_PATH],
  ]) {
    try {
      const response = await fetch(`${base}${path}`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json' },
      });
      result[name] = response.status;
      if (name === 'feed' && response.ok) {
        const body = await response.json().catch(() => null);
        result.status = body?.status ?? null;
      } else {
        await response.arrayBuffer().catch(() => {});
      }
    } catch (error) {
      result[name] = error.name === 'TimeoutError' ? 'timeout' : 'unreachable';
    }
  }
  result.ok = result.feed === 200;
  return result;
}

function parseArgs(argv) {
  const options = {
    alphaRoot: DEFAULT_ALPHA_ROOT,
    env: null,
    address: null,
    port: DEFAULT_PORT,
    task: DEFAULT_TASK,
    restart: true,
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-restart') options.restart = false;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--alpha-root') options.alphaRoot = argv[++i] ?? '';
    else if (arg === '--env') options.env = argv[++i] ?? '';
    else if (arg === '--address') options.address = argv[++i] ?? '';
    else if (arg === '--task') options.task = argv[++i] ?? '';
    else if (arg === '--port') options.port = Number.parseInt(argv[++i] ?? '', 10);
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (!Number.isInteger(options.port) || options.port <= 0) throw new Error('--port must be a port number');
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`fix-panel-host: ${error.message}\n\n${USAGE}\n`);
    process.exit(1);
  }
  if (options.help) return void process.stdout.write(`${USAGE}\n`);

  const record = { at: new Date().toISOString(), steps: {} };
  const say = (line) => {
    if (!options.json) process.stdout.write(`${line}\n`);
  };
  const stop = (line) => {
    record.problem = line;
    if (options.json) process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    else process.stdout.write(`${line}\n`);
    process.exit(1);
  };

  // 1. the address the panel would dial
  const addresses = options.address ? [{ ip: options.address, nic: 'given' }] : homeAddresses();
  if (addresses.length === 0) {
    stop(
      'address : this machine has no home-network address (192.168/10/172.16-31). ' +
        'Is it on the house WiFi? A tailnet 100.x will not do — the panel cannot reach one.',
    );
  }
  const address = addresses[0].ip;
  record.address = address;
  record.addresses = addresses;
  say(`address : ${address} (${addresses[0].nic})${addresses.length > 1 ? `, also ${addresses.slice(1).map((a) => a.ip).join(', ')}` : ''}`);

  // 2. the env file
  const envPath = options.env || join(options.alphaRoot, 'app', '.env.local');
  if (!existsSync(envPath)) {
    stop(`env     : no file at ${envPath}. Pass --alpha-root or --env.`);
  }
  record.env = envPath;

  const text = await readFile(envPath, 'utf8');
  const plan = planEnv(text, { addresses: [address] });
  record.steps.env = {
    changed: plan.changed,
    host: plan.host,
    trusted: plan.trusted,
    added: plan.added,
    trustedAdded: plan.trustedAdded,
    lanWas: plan.lanWas,
    duplicates: plan.duplicates,
  };

  say(`env     : ${envPath}`);
  say(`HOST    : ${plan.host}${plan.added.length ? `   (added ${plan.added.join(', ')})` : '   (already right)'}`);
  if (plan.trusted !== null) {
    say(`trusted : ${plan.trusted}${plan.trustedAdded.length ? `   (added ${plan.trustedAdded.join(', ')})` : ''}`);
  } else {
    // Worth saying: a 400 from the address the panel uses is this key, and this
    // file does not set it, so the default decides.
    say('trusted : ALPHA_TRUSTED_HOSTS is not set here — if the panel gets a 400, that is why');
  }
  if (plan.lanWas !== 'true') say(`deck    : ALPHA_PANEL_LAN_READ ${plan.lanWas ?? 'not set'} -> true`);
  if (plan.duplicates.length) {
    say(`note    : ${plan.duplicates.join(', ')} appears more than once; the last line is the one that counts, and that is the one changed`);
  }

  if (options.dryRun) {
    say(plan.changed ? 'dry run : nothing written' : 'dry run : nothing to change');
    if (options.json) process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return;
  }

  if (plan.changed) {
    // A backup before touching the file that decides whether Alpha starts.
    await copyFile(envPath, `${envPath}.bak`);
    await writeFile(envPath, plan.text, 'utf8');
    say(`env     : written (backup at ${envPath}.bak)`);
  }

  // 3. the restart, because HOST and ALPHA_TRUSTED_HOSTS are both read at startup
  if (!options.restart) {
    say('restart : skipped — the new HOST only takes effect when the backend restarts');
  } else if (plan.changed) {
    say(`restart : "${options.task}"`);
    // End then Run: a scheduled task that is already running ignores /Run.
    await run('schtasks', ['/End', '/TN', options.task]);
    const started = await run('schtasks', ['/Run', '/TN', options.task]);
    record.steps.restart = { task: options.task, ok: started.ok, out: started.out.slice(-400) };
    if (!started.ok) {
      say(`restart : could not start it — ${started.out.slice(-200)}`);
      say('restart : start Alpha however this machine normally does, then re-run with --no-restart');
    }
    // The backend takes a few seconds to bind and load its model config.
    await new Promise((r) => setTimeout(r, 8_000));
  } else {
    say('restart : not needed, nothing changed');
  }

  // 4. the only check that means anything: the request the panel makes
  const base = `http://${address}:${options.port}`;
  let feed = await checkFeed(base);
  if (!feed.ok && options.restart && plan.changed) {
    // One more look: a cold backend can still be binding.
    await new Promise((r) => setTimeout(r, 7_000));
    feed = await checkFeed(base);
  }
  record.steps.feed = feed;

  if (feed.ok) {
    say(`feed    : ${base}${FEED_PATH} answers 200${feed.status ? ` (status ${feed.status})` : ''}`);
    say('');
    say('Point the panel at it:');
    say(`  Alpha's deck firmware:  ALPHA ${base}        (over USB serial)`);
    say(`  the tunnel's firmware:  node scripts/panel-up.mjs --primary ${base}`);
    if (options.json) process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return;
  }

  if (feed.health === 'unreachable' || feed.health === 'timeout') {
    stop(
      `feed    : nothing answers on ${base} — the backend is not listening on that address. ` +
        'If it did not restart, start it and re-run with --no-restart; a firewall rule for ' +
        `TCP ${options.port} on the private profile is the other thing that blocks this.`,
    );
  }
  if (feed.feed === 404) {
    stop(
      `feed    : ${base}/health answers ${feed.health} but ${FEED_PATH} is 404 — the backend ` +
        'started before ALPHA_PANEL_LAN_READ was true. Restart it and re-run.',
    );
  }
  if (feed.feed === 400) {
    stop(
      `feed    : ${base} answers 400 — ${address} is not in ALPHA_TRUSTED_HOSTS, which is read ` +
        'at startup. Add it there, restart the backend, and re-run.',
    );
  }
  stop(`feed    : ${base}${FEED_PATH} answered ${feed.feed} (health ${feed.health}).`);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`fix-panel-host: ${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}

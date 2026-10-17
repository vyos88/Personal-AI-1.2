#!/usr/bin/env node
/**
 * Make Alpha's backend reachable from the CrowPanel, on the machine it runs on.
 *
 *     node scripts/fix-panel-host.mjs
 *
 * The panel is an ESP32 on the house WiFi. It cannot reach `127.0.0.1`, and it
 * cannot reach a tailnet `100.x` address either — those do not exist for it. It
 * reaches this machine on a home-network address and nothing else, so three
 * settings in Alpha's env file decide whether the screen is dark (found the way
 * the doctor finds it: `backend/.env.local`, then the root, then above it):
 *
 *   HOST                  the addresses the backend binds. Without the home
 *                         address in it, nothing the panel can dial is listening
 *   ALPHA_TRUSTED_HOSTS   taken at startup. An address that is bound but not
 *                         trusted answers 400, which looks like the panel's fault
 *   ALPHA_PANEL_LAN_READ  the deck feed itself. Off, and
 *                         /panel/crowpanel/public-state is a 404
 *
 * A fourth place can override the first: the boot task's wrapper
 * (AlphaBoot\run-alpha-backend.cmd) when it passes `--host`, which it does when
 * repair-alpha-host.ps1 adopted a backend start-local.ps1 had started.
 *
 * This reads those three, adds this machine's home-network address to the first
 * two (and to the wrapper's `--host`) and turns the third on, keeping every other line and every address that
 * was already there — a DHCP lease that moved is the usual reason it is wrong,
 * and removing the old one is how the next person loses the tailnet. Then it
 * restarts the backend and checks the feed from the home address, which is the
 * only check that means anything: it is the request the panel makes.
 *
 * It changes Alpha's configuration, so it runs only when somebody asks for it:
 * by hand, or as one queued autopilot id (`panel-host`), never as a standing
 * check. Nothing in it comes from the queue: the address is this machine's own
 * and the file is the one the autopilot's own Alpha root names. The owner asked
 * for that on 2026-10-07, after the router renumbered the house network from
 * 192.168.2.x to 192.168.1.x and the panel went dark with nobody at the
 * machine. `--dry-run` prints the diff and writes nothing.
 *
 * Exit 0 when the feed answers on a home-network address; 1 with the reason.
 */

import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { restartWindows } from './apply-alpha-update.mjs';

const DEFAULT_ALPHA_ROOT = process.env.ALPHA_APP_ROOT ?? 'C:\\AlphaData\\Alpha';

/**
 * Where this backend keeps its settings, in the order it reads them.
 *
 * Taken from `laptop41-doctor.ps1`'s `EnvSetting`, which is the repo's own
 * statement of the convention — `backend\.env.local` first, then the root, then
 * the directory above it, and `.env` after each `.env.local`. Guessing one path
 * instead is what made a hand-run on Worker1 stop at "no file at
 * ...\app\.env.local" on a machine whose Alpha has no `app` directory at all.
 */
export function envCandidates(alphaRoot) {
  const root = resolve(alphaRoot);
  const parent = dirname(root);
  return [
    join(root, 'backend', '.env.local'),
    join(root, '.env.local'),
    join(parent, '.env.local'),
    join(root, 'backend', '.env'),
    join(root, '.env'),
    join(parent, '.env'),
  ];
}

/** The first of those that is there, or null with the list that was tried. */
export function findEnvFile(alphaRoot, exists = existsSync) {
  const tried = envCandidates(alphaRoot);
  return { path: tried.find((candidate) => exists(candidate)) ?? null, tried };
}
const DEFAULT_TASK = 'Alpha Backend';
// The boot task's wrapper (repair-alpha-host.ps1). It is written from the live
// backend's own command line, and start-local.ps1 always passes --host, so the
// wrapper carries the address list as it was that day. An explicit --host wins
// over HOST in .env.local (run_server.py): on 2026-10-07 the file gained the new
// address, the backend restarted, and came back on the old list.
const DEFAULT_WRAPPER = process.env.ProgramData
  ? join(process.env.ProgramData, 'AlphaBoot', 'run-alpha-backend.cmd')
  : null;
const DEFAULT_PORT = 8001;
// The deck firmware polls this every three seconds and holds no credential.
const FEED_PATH = '/panel/crowpanel/public-state';

const USAGE = `
fix-panel-host — let the CrowPanel reach Alpha's backend on this machine

  node scripts/fix-panel-host.mjs

Options
  --alpha-root <dir>  Where Alpha lives. Default: ALPHA_APP_ROOT or
                      ${DEFAULT_ALPHA_ROOT}
  --env <file>        The env file to edit. Default: the first of
                      backend\\.env.local, .env.local, ..\\.env.local (then the
                      .env of each) that exists under --alpha-root
  --address <ip>      The home-network address to publish. Default: this
                      machine's, worked out from its interfaces
  --port <n>          Backend port. Default: ${DEFAULT_PORT}
  --task <name>       Scheduled task to restart. Default: ${DEFAULT_TASK}
  --no-restart        Edit and check only; do not restart the backend
  --wrapper <file>    The boot task's wrapper, whose --host wins over HOST.
                      Default: %ProgramData%\\AlphaBoot\\run-alpha-backend.cmd
                      when it exists; --wrapper "" leaves it alone
  --require-host      Stop unless the file already sets HOST (the autopilot
                      passes this: then the file is surely the one the
                      backend reads)
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
/**
 * The value this backend will read, and how many lines claim to set it.
 *
 * The **first** line wins: `run_server.py` loads the file that way, and
 * `laptop41-doctor.ps1` reads it the same way for the same reason. Taking the
 * last — which is what dotenv would do — means reporting a value the backend
 * never sees, so a reader of the file is confident and wrong.
 */
export function readKey(lines, key) {
  let value = null;
  let count = 0;
  for (const line of lines) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match || match[1] !== key) continue;
    count += 1;
    if (count === 1) value = match[2].trim().replace(/^["']|["']$/g, '');
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
/**
 * Sets a key on **every** line that sets it, appending when none does.
 *
 * Not just the one the loader reads. Which copy that is depends on the loader —
 * first here, last under dotenv — and leaving the others behind is how a file
 * ends up disagreeing with itself and with the running backend. Writing all of
 * them is right whichever way it is read.
 */
function setKey(lines, key, value) {
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(lines[i]);
    if (!match || match[1] !== key) continue;
    lines[i] = `${key}=${value}`;
    found = true;
  }
  if (!found) lines.push(`${key}=${value}`);
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

/**
 * The boot wrapper with this machine's address added to every `--host` list.
 *
 * Same rule as HOST: nothing is removed, so loopback and the tailnet stay. A
 * list holding 0.0.0.0 or :: already covers every address and is left alone.
 * Without `--host` the backend reads HOST, and the wrapper is not touched.
 */
export function planWrapper(text, { addresses } = {}) {
  const wanted = Array.isArray(addresses) ? addresses.filter(Boolean) : [addresses].filter(Boolean);
  const added = new Set();
  const hosts = [];
  const next = text.replace(/(--host[ =])(?:"([^"]*)"|([^\s"]+))/g, (whole, flag, quoted, bare) => {
    const list = splitList(quoted ?? bare);
    if (!list.includes('0.0.0.0') && !list.includes('::')) {
      for (const address of wanted) {
        if (!list.includes(address)) {
          list.push(address);
          added.add(address);
        }
      }
    }
    hosts.push(list.join(','));
    return quoted !== undefined ? `${flag}"${list.join(',')}"` : `${flag}${list.join(',')}`;
  });
  return { found: hosts.length > 0, changed: next !== text, text: next, host: hosts[0] ?? null, added: [...added] };
}

/**
 * Restart the backend the way apply-alpha-update.mjs does, the restart that has
 * worked on the host: /End, stop whatever still holds the port, /Run. /End alone
 * can leave the backend's python serving the old HOST, and Alpha's
 * single-instance lock then refuses the new one, so the change never takes.
 */
export function restartBackend(task, port, { restart = restartWindows } = {}) {
  const lines = [];
  restart((line) => lines.push(String(line).trim()), { tasks: [{ task, port }] });
  return { task, ok: lines.includes(`restarted task '${task}'`), out: lines.join('\n').slice(-400), lines };
}

/**
 * Ask until the feed answers or the deadline passes. A restarted backend loads
 * for a while before it binds, and the next queued step (panel-endpoint) checks
 * the same address, so giving up early would fail both while Alpha came up fine.
 */
export async function waitForFeed(base, { deadlineMs = 120_000, everyMs = 5_000, check = checkFeed, sleep } = {}) {
  const nap = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const until = Date.now() + deadlineMs;
  let feed = await check(base);
  while (!feed.ok && Date.now() + everyMs <= until) {
    await nap(everyMs);
    feed = await check(base);
  }
  return feed;
}

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
    wrapper: undefined,
    address: null,
    port: DEFAULT_PORT,
    task: DEFAULT_TASK,
    restart: true,
    requireHost: false,
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-restart') options.restart = false;
    else if (arg === '--require-host') options.requireHost = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--alpha-root') options.alphaRoot = argv[++i] ?? '';
    else if (arg === '--env') options.env = argv[++i] ?? '';
    else if (arg === '--wrapper') options.wrapper = argv[++i] ?? '';
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
  const found = options.env ? { path: options.env, tried: [options.env] } : findEnvFile(options.alphaRoot);
  const envPath = found.path;
  if (!envPath || !existsSync(envPath)) {
    // A path that was named and a path that was searched for are different
    // mistakes: the first is a typo, the second is the wrong --alpha-root.
    if (options.env) stop(`env     : no file at ${options.env}.`);
    stop(
      `env     : no settings file under ${options.alphaRoot}. Looked for:\n             ` +
        found.tried.join('\n             ') +
        '\n           Pass --env with the file that holds HOST.',
    );
  }
  record.env = envPath;

  const text = await readFile(envPath, 'utf8');
  if (options.requireHost && readKey(text.split(/\r?\n/), 'HOST').count === 0) {
    // The backend is listening somewhere, so its addresses come from elsewhere
    // (the task's environment, a wrapper). A HOST written here would either do
    // nothing or replace that list, and the tailnet with it.
    stop(`env     : ${envPath} sets no HOST, so the backend takes its addresses from somewhere else. Nothing changed.`);
  }
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
    say(
      `note    : ${plan.duplicates.join(', ')} appears more than once. The backend reads the first ` +
        'line; every copy was set to the same value so they cannot disagree',
    );
  }

  // 2b. the boot wrapper, whose --host wins over the file
  const wrapperPath = options.wrapper === undefined ? DEFAULT_WRAPPER : options.wrapper || null;
  let wrapper = null;
  if (wrapperPath && existsSync(wrapperPath)) {
    wrapper = planWrapper(await readFile(wrapperPath, 'utf8'), { addresses: [address] });
    record.steps.wrapper = { path: wrapperPath, found: wrapper.found, host: wrapper.host, added: wrapper.added };
    if (!wrapper.found) say(`wrapper : ${wrapperPath} passes no --host, so HOST above decides`);
    else say(`wrapper : --host ${wrapper.host}${wrapper.added.length ? `   (added ${wrapper.added.join(', ')})` : '   (already right)'}`);
  }
  const changed = plan.changed || Boolean(wrapper?.changed);

  if (options.dryRun) {
    say(changed ? 'dry run : nothing written' : 'dry run : nothing to change');
    if (options.json) process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return;
  }

  if (plan.changed) {
    // A backup before touching the file that decides whether Alpha starts.
    await copyFile(envPath, `${envPath}.bak`);
    await writeFile(envPath, plan.text, 'utf8');
    say(`env     : written (backup at ${envPath}.bak)`);
  }
  if (wrapper?.changed) {
    await copyFile(wrapperPath, `${wrapperPath}.bak`);
    await writeFile(wrapperPath, wrapper.text, 'utf8');
    say(`wrapper : written (backup at ${wrapperPath}.bak)`);
  }

  // 3. the restart, because HOST and ALPHA_TRUSTED_HOSTS are both read at startup
  if (!options.restart) {
    say('restart : skipped — the new HOST only takes effect when the backend restarts');
  } else if (changed) {
    say(`restart : "${options.task}"`);
    const restarted = restartBackend(options.task, options.port);
    for (const line of restarted.lines) say(`restart : ${line}`);
    record.steps.restart = { task: restarted.task, ok: restarted.ok, out: restarted.out };
    if (!restarted.ok) {
      say('restart : start Alpha however this machine normally does, then re-run with --no-restart');
    }
  } else {
    say('restart : not needed, nothing changed');
  }

  // 4. the only check that means anything: the request the panel makes
  const base = `http://${address}:${options.port}`;
  const feed = options.restart && changed ? await waitForFeed(base) : await checkFeed(base);
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

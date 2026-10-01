#!/usr/bin/env node
/**
 * One scheduled run of "is this machine still working for Alpha?".
 *
 * Built for the week nobody is watching. `self-update.mjs` keeps the checkout
 * current and says when a restart is due; the agent itself keeps reconnecting
 * across host restarts and network drops. What neither does is *check*, and
 * leave a record — so a laptop that quietly stopped lending in the first hour
 * looks exactly like one that worked all week.
 *
 * So, in order, and each step reported:
 *
 *   1. update  — run self-update.mjs (fast-forward only, never over local work)
 *   2. restart — only if the update moved something, and only the command the
 *                machine's owner supplied. Which service to bounce is not
 *                something a script gets to guess.
 *   3. reach   — is the coordinator answering at all?
 *   4. attach  — is *this* machine in its list of agents, and is it on the
 *                same release? Needs an operator key; without one this step
 *                says so rather than pretending.
 *   5. panel   — with --panel-key: is the CrowPanel still reading the host?
 *                The panel is not an agent — it registers nothing, holds no
 *                lease and has no row in /agents — so the only evidence it is
 *                alive is that its own key keeps being used. It polls /stats
 *                every five seconds, so a key idle for two minutes is a screen
 *                showing numbers that stopped being true.
 *
 * Every run appends one JSON line to the log, so a week later `tail` tells you
 * what happened and when it stopped.
 *
 * Usage:
 *   node scripts/watchdog.mjs [--name <agent name>] [--restart-command "<cmd>"]
 *                             [--panel-key <key id or name>]
 *                             [--log <file>] [--no-update] [--json]
 *
 * Exit codes, so a scheduler can alert on them:
 *   0  this machine is attached and current
 *   1  something needs a person: cannot reach the host, not attached, or the
 *      panel has gone quiet
 *   10 updated and a restart is needed but no --restart-command was given
 */

import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchJson, HttpError } from '../src/common/http.js';
import { loadEnv } from '../src/common/env.js';
import { AGENT_STALE_MS } from '../src/common/protocol.js';
import { ALPHA_VERSION } from '../src/common/version.js';

loadEnv();

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const HOST = (process.env.ALPHA_HOST_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const TOKEN = process.env.ALPHA_ADMIN_TOKEN ?? process.env.ALPHA_BOOTSTRAP_TOKEN;

// Two missed heartbeats. The host itself waits AGENT_STALE_MS before dropping a
// registration, which is the right call for placement — a laptop that sleeps
// through a GC pause should not lose its place — but far too patient for a
// check that only runs twice a day.
const SILENT_MS = Math.min(45_000, AGENT_STALE_MS / 2);

// The panel polls /stats every five seconds (firmware/crowpanel: POLL_INTERVAL_MS),
// so two minutes is roughly twenty missed polls — past a WiFi reconnect, past a
// reboot, and comfortably clear of one failed request. Anything longer and the
// screen is showing a frozen report, which is worse than a blank one.
const PANEL_SILENT_MS = 120_000;

const EXIT_OK = 0;
const EXIT_NEEDS_A_PERSON = 1;
const EXIT_RESTART_DUE = 10;

const USAGE = `
watchdog — one scheduled check that this machine is still working for Alpha

  node scripts/watchdog.mjs --name laptop --restart-command "nssm restart alpha-agent"

Options
  --name <n>              This machine's agent name. Default: the hostname
  --restart-command <c>   Run this when an update needs the agent restarted.
                          Omit and the run exits 10 instead, having changed
                          nothing about the running agent
  --log <file>            Append one JSON line per run here.
                          Default: watchdog.log beside this checkout
  --panel-key <k>         Key id or name the CrowPanel polls with. Its last
                          use is the receipt that the panel is still reading
                          the host. Needs a key with keys:read
  --no-update             Check only; do not touch the checkout
  --json                  Print the record instead of a human line
  --help                  This message

  Host:   ALPHA_HOST_URL
  Auth:   ALPHA_ADMIN_TOKEN — an operator key, only for reading /agents. The
          agent's own key cannot, so without one the attach check is skipped
          and says so.
`.trim();

function parseArgs(argv) {
  const options = {
    name: process.env.ALPHA_AGENT_NAME || hostname(),
    restartCommand: null,
    panelKey: process.env.ALPHA_PANEL_KEY_ID || null,
    log: resolve(ROOT, 'watchdog.log'),
    update: true,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--no-update') options.update = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--name') options.name = argv[++i] ?? '';
    else if (arg === '--restart-command') options.restartCommand = argv[++i] ?? '';
    else if (arg === '--panel-key') options.panelKey = argv[++i] ?? '';
    else if (arg === '--log') options.log = resolve(argv[++i] ?? '');
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  return options;
}

function run(command, args, { shell = false } = {}) {
  return new Promise((resolvePromise) => {
    execFile(command, args, { cwd: ROOT, shell, timeout: 300_000 }, (error, stdout, stderr) => {
      resolvePromise({
        code: error?.code ?? 0,
        stdout: (stdout ?? '').trim(),
        stderr: (stderr ?? '').trim(),
      });
    });
  });
}

/** Step 1: fast-forward the checkout, and say whether that needs a restart. */
async function update() {
  const result = await run(process.execPath, [resolve(HERE, 'self-update.mjs'), '--repo', ROOT]);
  if (result.code === 0) return { ran: true, updated: false, note: result.stdout.split('\n').pop() };
  if (result.code === 10) return { ran: true, updated: true, note: result.stdout.split('\n').pop() };
  // Exit 1 is "refused or failed, nothing changed" — a dirty tree, usually.
  // Not fatal to the run: a machine that is lending work is still lending it.
  return { ran: true, updated: false, failed: true, note: result.stdout || result.stderr };
}

/** Step 3 and 4: the coordinator, and this machine's place in it. */
async function checkFleet(name) {
  const fleet = { reachable: false, attached: null, version: null, drifted: null, agents: null };
  try {
    const { body } = await fetchJson(`${HOST}/healthz`, { timeoutMs: 10_000 });
    fleet.reachable = Boolean(body?.ok);
    fleet.hostVersion = body?.version ?? null;
  } catch (error) {
    fleet.error = error.message;
    return fleet;
  }

  if (!TOKEN) {
    // Deliberately not guessed from a running process: "the agent is up" and
    // "the host is placing work on it" are different claims, and only the
    // second one matters.
    fleet.attached = null;
    fleet.note = 'no ALPHA_ADMIN_TOKEN, so whether this machine is attached was not checked';
    return fleet;
  }

  try {
    const { body } = await fetchJson(`${HOST}/agents`, { token: TOKEN, timeoutMs: 10_000 });
    const mine = body.agents.filter((agent) => agent.name === name);
    fleet.agents = body.agents.length;
    fleet.version = mine[0]?.version ?? null;
    fleet.drifted = Boolean(fleet.version && body.hostVersion && fleet.version !== body.hostVersion);
    fleet.inFlight = mine.reduce((total, agent) => total + (agent.inFlight ?? 0), 0);
    fleet.idleMs = mine.length ? Math.min(...mine.map((agent) => agent.idleMs ?? Infinity)) : null;
    // A registration in the list is not a working machine. A killed agent
    // never deregisters, so its row sits there until the stale sweep at
    // AGENT_STALE_MS — and a watchdog that read that row as "attached" would
    // report a dead laptop as healthy for the first ninety seconds, which is
    // exactly the window a twelve-hourly check is most likely to land in.
    // A live agent heartbeats every twenty seconds, so anything past two
    // missed beats has stopped talking.
    fleet.silentFor = fleet.idleMs;
    fleet.stale = mine.length > 0 && fleet.idleMs > SILENT_MS;
    fleet.attached = mine.length > 0 && !fleet.stale;
  } catch (error) {
    fleet.error = error instanceof HttpError ? `HTTP ${error.status} from /agents` : error.message;
  }
  return fleet;
}

/**
 * Step 5: is the panel still reading the host?
 *
 * `lastUsedAt` on the panel's key is recorded by the auth service on every
 * verified request, so this asks the one party that can answer — the host —
 * rather than the laptop the board is plugged into. A COM port existing says
 * the board has power; it says nothing about whether the screen is live.
 *
 * Matched by id first, then by name: the id is what `alpha-admin keys` prints
 * and never changes, the name is what a person remembers.
 */
export function panelFromKeys(keys, { key, now = Date.now(), silentMs = PANEL_SILENT_MS }) {
  const wanted = String(key);
  const record =
    keys.find((entry) => entry.id === wanted) ?? keys.find((entry) => entry.name === wanted);

  if (!record) {
    return { key: wanted, found: false, connected: false, note: 'no key with that id or name' };
  }
  if (record.revokedAt) {
    // A revoked key is not a quiet panel, it is a panel that is being refused.
    return { key: record.id, name: record.name ?? null, found: true, revokedAt: record.revokedAt, connected: false, note: 'the panel\'s key is revoked' };
  }

  // The auth service records this as epoch milliseconds (see
  // `publicKey` and what `alpha-admin keys` does with it), not as an ISO
  // string. Reading it as text gives NaN, which compares false against every
  // threshold — a live panel reported as silent, for ever.
  const lastUsedAt = record.lastUsedAt ?? null;
  const usedAtMs = typeof lastUsedAt === 'number' ? lastUsedAt : Date.parse(lastUsedAt ?? '');
  const silentFor = Number.isFinite(usedAtMs) ? now - usedAtMs : null;
  return {
    key: record.id,
    name: record.name ?? null,
    found: true,
    lastUsedAt: Number.isFinite(usedAtMs) ? new Date(usedAtMs).toISOString() : null,
    silentFor,
    // Never used at all is not connected: a key minted for a panel that was
    // never provisioned looks exactly like one whose panel stopped.
    connected: silentFor !== null && silentFor <= silentMs,
    note: lastUsedAt ? undefined : 'never used — the panel has not been provisioned with it',
  };
}

async function checkPanel(key) {
  if (!TOKEN) {
    return { key, connected: null, note: 'no ALPHA_ADMIN_TOKEN, so the panel was not checked' };
  }
  try {
    const { body } = await fetchJson(`${HOST}/keys`, { token: TOKEN, timeoutMs: 10_000 });
    return panelFromKeys(body.keys ?? [], { key });
  } catch (error) {
    return {
      key,
      connected: null,
      note:
        error instanceof HttpError
          ? `HTTP ${error.status} from /keys — the watchdog's key needs keys:read`
          : error.message,
    };
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`watchdog: ${error.message}\n\n${USAGE}\n`);
    process.exit(EXIT_NEEDS_A_PERSON);
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const record = {
    at: new Date().toISOString(),
    machine: options.name,
    host: HOST,
    checkout: ALPHA_VERSION,
  };

  if (options.update) record.update = await update();

  // Restart only for an update that actually moved something, and only with
  // the command this machine's owner gave. A guessed service name is a
  // scheduled task that fails silently every twelve hours.
  let restartDue = Boolean(record.update?.updated);
  if (restartDue && options.restartCommand) {
    const result = await run(options.restartCommand, [], { shell: true });
    record.restart = { command: options.restartCommand, code: result.code };
    if (result.code !== 0) record.restart.stderr = result.stderr.slice(-500);
    // Give the agent a moment to come back before asking whether it is there.
    await new Promise((r) => setTimeout(r, 5_000));
    restartDue = false;
  }

  record.fleet = await checkFleet(options.name);
  if (options.panelKey && record.fleet.reachable) record.panel = await checkPanel(options.panelKey);
  else if (options.panelKey) record.panel = { key: options.panelKey, connected: null, note: 'host unreachable' };

  let exitCode = EXIT_OK;
  if (!record.fleet.reachable || record.fleet.attached === false) exitCode = EXIT_NEEDS_A_PERSON;
  // A dark panel needs a person as much as a detached laptop does, and for the
  // same reason: nothing in the fleet will fix it by itself.
  else if (record.panel?.connected === false) exitCode = EXIT_NEEDS_A_PERSON;
  else if (restartDue) exitCode = EXIT_RESTART_DUE;
  record.ok = exitCode === EXIT_OK;

  try {
    await appendFile(options.log, JSON.stringify(record) + '\n');
  } catch (error) {
    process.stderr.write(`watchdog: could not write ${options.log}: ${error.message}\n`);
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(record, null, 2) + '\n');
  } else {
    const fleet = record.fleet;
    const attached =
      fleet.attached === null
        ? 'attach not checked'
        : fleet.attached
          ? 'attached'
          : fleet.stale
            ? `REGISTERED BUT SILENT for ${Math.round(fleet.silentFor / 1000)}s`
            : 'NOT ATTACHED';
    process.stdout.write(
      `watchdog: ${record.machine} — ${fleet.reachable ? 'host up' : 'HOST UNREACHABLE'}, ` +
        `${attached}${fleet.inFlight ? `, ${fleet.inFlight} task(s) running` : ''}` +
        `${record.update?.updated ? ', updated' : ''}` +
        `${record.restart ? `, restarted (exit ${record.restart.code})` : ''}` +
        `${restartDue ? ', RESTART DUE' : ''}` +
        `${fleet.drifted ? `, version drift (${fleet.version} vs host ${fleet.hostVersion})` : ''}\n`,
    );
    if (fleet.error) process.stdout.write(`  ${fleet.error}\n`);
    if (fleet.note) process.stdout.write(`  ${fleet.note}\n`);
    if (record.panel) {
      const panel = record.panel;
      const seen =
        panel.connected === null
          ? 'panel not checked'
          : panel.connected
            ? `panel reading the host (${Math.round(panel.silentFor / 1000)}s ago)`
            : panel.silentFor
              ? `PANEL SILENT for ${Math.round(panel.silentFor / 60_000)} min`
              : 'PANEL NEVER SEEN';
      process.stdout.write(`  ${seen}${panel.note ? ` — ${panel.note}` : ''}\n`);
    }
  }

  process.exit(exitCode);
}

main().catch((error) => {
  process.stderr.write(`watchdog: ${error.stack ?? error.message}\n`);
  process.exit(EXIT_NEEDS_A_PERSON);
});

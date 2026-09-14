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
 *
 * Every run appends one JSON line to the log, so a week later `tail` tells you
 * what happened and when it stopped.
 *
 * Usage:
 *   node scripts/watchdog.mjs [--name <agent name>] [--restart-command "<cmd>"]
 *                             [--log <file>] [--no-update] [--json]
 *
 * Exit codes, so a scheduler can alert on them:
 *   0  this machine is attached and current
 *   1  something needs a person: cannot reach the host, or not attached
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

  let exitCode = EXIT_OK;
  if (!record.fleet.reachable || record.fleet.attached === false) exitCode = EXIT_NEEDS_A_PERSON;
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
  }

  process.exit(exitCode);
}

main().catch((error) => {
  process.stderr.write(`watchdog: ${error.stack ?? error.message}\n`);
  process.exit(EXIT_NEEDS_A_PERSON);
});

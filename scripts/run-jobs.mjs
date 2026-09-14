#!/usr/bin/env node
/**
 * Put a batch of work on the fleet, and say which machine did each piece.
 *
 * `alpha-admin task` queues one task and prints its result. That is the wrong
 * shape for the question this repository exists to answer — *are the laptops
 * actually doing Alpha's work?* — which needs several jobs at once and a
 * per-machine tally at the end. Hence this: queue N, wait for all of them, and
 * report where each landed.
 *
 * It reads the same configuration as alpha-admin (ALPHA_HOST_URL and
 * ALPHA_ADMIN_TOKEN, or .env beside this checkout), so on the Alpha host it
 * needs no arguments beyond what to run.
 */

import { parseArgs } from 'node:util';

import { fetchJson, HttpError } from '../src/common/http.js';
import { loadEnv } from '../src/common/env.js';

loadEnv();

const HOST = (process.env.ALPHA_HOST_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const TOKEN =
  process.env.ALPHA_ADMIN_TOKEN ??
  process.env.ALPHA_BOOTSTRAP_TOKEN ??
  process.env.ALPHA_TUNNEL_TOKEN;

const USAGE = `
run-jobs — queue a batch of work and report which machine ran each piece

  node scripts/run-jobs.mjs --type sysinfo --count 6

Options
  --type <t>            Task type to run (required)
  --count <n>           How many to queue. Default: 1
  --payload <json>      Payload for every job in the batch
  --agent <name>        Run them all on this machine — the NAME from
                        \`alpha-admin agents\`. Renders want this: the GPU and
                        the generator are only on one box
  --min-memory-mb <n>   Only place each job where that much RAM is free
  --lease-ms <n>        Lease per job. Raise it for work that outlives 60s
  --timeout <seconds>   How long to wait for the batch. Default: 120
  --json                The finished tasks, as JSON
  --help                This message

  Host:  ALPHA_HOST_URL    (default http://127.0.0.1:8787)
  Auth:  ALPHA_ADMIN_TOKEN
`.trim();

const OPTIONS = {
  type: { type: 'string' },
  count: { type: 'string' },
  payload: { type: 'string' },
  agent: { type: 'string' },
  'min-memory-mb': { type: 'string' },
  'lease-ms': { type: 'string' },
  timeout: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const say = (line = '') => process.stdout.write(`${line}\n`);
const mb = (bytes) => (Number.isFinite(bytes) ? `${Math.round(bytes / (1024 * 1024))}M` : '-');
const pct = (value) => (Number.isFinite(value) ? `${Math.round(value * 100)}%` : '-');

function die(message) {
  process.stderr.write(`\n\x1b[31mrun-jobs:\x1b[0m ${message}\n`);
  process.exit(1);
}

const api = (path, { method = 'GET', body } = {}) =>
  fetchJson(`${HOST}${path}`, { method, token: TOKEN, body, timeoutMs: 20_000 }).then((r) => r.body);

function positiveInt(raw, label, fallback) {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) die(`--${label} must be a positive whole number`);
  return value;
}

/**
 * Names, by agent id, sampled twice: once before the batch and once after.
 *
 * A machine can drop out mid-batch — a laptop sleeps, an agent restarts — and
 * its id then means nothing to a later lookup. Merging the two samples keeps a
 * finished task attributable to the machine that actually ran it.
 */
async function agentNames(into = new Map()) {
  const { agents } = await api('/agents');
  for (const agent of agents) into.set(agent.id, agent.name);
  return { names: into, agents };
}

function showFleet(agents) {
  if (agents.length === 0) {
    say('  (nothing attached — start an agent on the laptops first)');
    return;
  }
  const width = Math.max(...agents.map((a) => a.name.length));
  for (const agent of agents) {
    say(
      `  ${agent.name.padEnd(width)}  ${mb(agent.memory?.totalBytes)} RAM, ` +
        `${mb(agent.availableBytes)} free, cpu ${pct(agent.loadFactor)}, ` +
        `${agent.inFlight ?? 0} running`,
    );
  }
}

async function main() {
  let flags;
  try {
    ({ values: flags } = parseArgs({ args: process.argv.slice(2), options: OPTIONS }));
  } catch (error) {
    die(`${error.message}\n\n${USAGE}`);
  }
  if (flags.help) return say(USAGE);
  if (!TOKEN) die(`no credential. Set ALPHA_ADMIN_TOKEN.\n\n${USAGE}`);
  if (!flags.type) die(`--type is required.\n\n${USAGE}`);

  const count = positiveInt(flags.count, 'count', 1);
  const timeoutMs = positiveInt(flags.timeout, 'timeout', 120) * 1_000;

  let payload = {};
  if (flags.payload) {
    try {
      payload = JSON.parse(flags.payload);
    } catch (error) {
      die(`--payload is not valid JSON: ${error.message}`);
    }
  }

  const { names, agents } = await agentNames();
  say(`\nFleet at ${HOST}`);
  showFleet(agents);

  const body = { type: flags.type, payload };
  if (flags.agent) body.targetAgent = flags.agent;
  if (flags['min-memory-mb']) body.minMemoryMB = Number.parseInt(flags['min-memory-mb'], 10);
  if (flags['lease-ms']) body.leaseMs = Number.parseInt(flags['lease-ms'], 10);

  say(
    `\nQueueing ${count} × ${flags.type}` +
      `${flags.agent ? ` for "${flags.agent}"` : ''}` +
      `${body.minMemoryMB ? `, needing ${body.minMemoryMB} MB each` : ''}`,
  );

  const queued = [];
  for (let i = 0; i < count; i++) {
    const task = await api('/tasks', { method: 'POST', body });
    queued.push({ id: task.id, queuedAt: Date.now() });
    // Said once, not per job: the whole batch shares one reason for waiting.
    if (i === 0 && !task.agentAvailable) {
      if (task.targetAttached === false) {
        say(`  ! no attached agent is called "${flags.agent}" — the batch waits for it`);
      } else if (task.memoryAvailable === false) {
        say(`  ! nothing has ${body.minMemoryMB} MB free right now — the batch waits`);
      } else {
        say(`  ! nothing attached offers "${flags.type}" — the batch waits`);
      }
    }
  }

  const deadline = Date.now() + timeoutMs;
  const finished = new Map();
  while (finished.size < queued.length && Date.now() < deadline) {
    for (const job of queued) {
      if (finished.has(job.id)) continue;
      const task = await api(`/tasks/${job.id}`);
      if (task.status !== 'queued' && task.status !== 'leased') {
        finished.set(job.id, { ...task, ms: Date.now() - job.queuedAt });
      }
    }
    if (finished.size < queued.length) await new Promise((r) => setTimeout(r, 250));
  }
  await agentNames(names);

  if (flags.json) {
    process.stdout.write(JSON.stringify([...finished.values()], null, 2) + '\n');
    return;
  }

  say('');
  const ranOn = new Map();
  for (const job of queued) {
    const task = finished.get(job.id);
    if (!task) {
      say(`  ${job.id}  still queued after ${Math.round(timeoutMs / 1000)}s`);
      continue;
    }
    const machine = names.get(task.agentId) ?? task.agentId ?? '-';
    ranOn.set(machine, (ranOn.get(machine) ?? 0) + 1);
    const failure = task.error ? ` — ${task.error.message ?? task.error}` : '';
    say(
      `  ${task.id}  ${machine.padEnd(14)} ${task.status.padEnd(9)} ` +
        `${(task.ms / 1000).toFixed(1)}s  tries ${task.attempts}${failure}`,
    );
  }

  const spread = [...ranOn].map(([machine, n]) => `${machine} ${n}`).join(', ');
  const failed = [...finished.values()].filter((t) => t.status !== 'succeeded').length;
  say(`\nRan on: ${spread || '(nothing finished)'}`);
  if (failed) say(`${failed} of ${queued.length} did not succeed.`);
  if (finished.size < queued.length) {
    say(
      `${queued.length - finished.size} still waiting — check \`alpha-admin agents\`, ` +
        'or raise --timeout if the work is simply long.',
    );
  }
  process.exitCode = failed || finished.size < queued.length ? 1 : 0;
}

main().catch((error) => {
  if (error instanceof HttpError) {
    die(`HTTP ${error.status} from ${error.url}: ${error.body?.message ?? error.body?.error ?? ''}`);
  }
  die(error.stack ?? error.message);
});

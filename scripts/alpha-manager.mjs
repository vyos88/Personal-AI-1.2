#!/usr/bin/env node
/**
 * The manager: decide what to render, approve it, queue it, and say what came
 * back.
 *
 * `run-jobs.mjs` queues a batch and waits for it. That is the right shape for
 * a person at a keyboard and the wrong shape for the thing that actually keeps
 * a fleet producing: something scheduled, that runs unattended, that does not
 * render the same six seeds it rendered last time, and that can be trusted not
 * to fill a disk while nobody is watching.
 *
 * So this adds the three things a scheduled loop needs and a one-shot batch
 * does not:
 *
 * - **It continues, rather than repeating.** Seeds carry on from the highest
 *   already recorded for that species, so every pass is new creatures. A loop
 *   built on `run-jobs --seed 0` re-renders seeds 0..5 forever — the recipes
 *   are reproducible, which is exactly why a fixed start is wrong here.
 * - **It approves before it queues.** An allowlist bounds *what* may be
 *   rendered and a quota bounds *how much* per window. A 15-minute loop with
 *   no ceiling is a disk-filling machine with a retry policy.
 * - **It reports from the ledger, not from its own run.** `report` answers
 *   "what has this fleet produced" across every pass and every restart, which
 *   is the question a one-shot batch can never answer.
 *
 * It never waits for renders to finish. A render outlives any sensible
 * scheduled pass, so this queues with a lease that covers the work and exits;
 * the receipts are read later, by `report`. A manager that blocked for ten
 * minutes would still be running when the next pass started.
 *
 *     node scripts/alpha-manager.mjs render --species fern,beetle --count 4 \
 *       --agent alpha-host --max-per-window 40
 *     node scripts/alpha-manager.mjs report --since 24h
 *
 * Reads the same configuration as alpha-admin: ALPHA_HOST_URL and
 * ALPHA_ADMIN_TOKEN, or .env beside this checkout.
 */

import { fetchJson } from '../src/common/http.js';
import { loadEnv } from '../src/common/env.js';

loadEnv();

const HOST = (process.env.ALPHA_HOST_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const TOKEN =
  process.env.ALPHA_ADMIN_TOKEN ??
  process.env.ALPHA_BOOTSTRAP_TOKEN ??
  process.env.ALPHA_TUNNEL_TOKEN;

const USAGE = `
alpha-manager — approve and queue renders on a schedule, and report what landed

  node scripts/alpha-manager.mjs render --species fern,beetle --count 4 --agent alpha-host
  node scripts/alpha-manager.mjs report --since 24h

Commands
  render                Approve, then queue a batch. Never waits for it
  report                What the fleet has produced, from the host's ledger
  inventory             What is actually on the rendering machine's disk,
                        including everything that predates the ledger

render options
  --species <a,b,...>   Species to cycle through (required)
  --count <n>           How many to queue this pass. Default 1
  --seed <n>            Force the first seed. Default: continue from the ledger,
                        so each pass is new creatures rather than the same ones
  --agent <name>        Machine to pin to. Renders want this — the GPU and the
                        generator are only on one box
  --lease-ms <n>        Lease per render. Default 900000 (15 minutes)
  --min-memory-mb <n>   Only place where this much RAM is free. Default 4096
  --allow <a,b,...>     Approval: refuse any species not in this list
  --max-per-window <n>  Approval: refuse the pass if this many renders already
                        finished inside --window
  --window <duration>   Window for that quota. Default 24h
  --dry-run             Say what would be queued, and queue nothing

report options
  --since <duration>    Only count work finished inside this window
  --json                The summary as JSON

inventory options
  --agent <name>        Machine to ask. Defaults to wherever the task lands
  --species <name>      Only count this species
  --json                The inventory as JSON

  Durations are <n>[m|h|d], e.g. 90m, 24h, 7d.

  Host:  ALPHA_HOST_URL    (default http://127.0.0.1:8787)
  Auth:  ALPHA_ADMIN_TOKEN
`.trim();

const say = (line = '') => process.stdout.write(`${line}\n`);

const size = (bytes) => {
  if (!Number.isFinite(bytes) || bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
};

function die(message) {
  process.stderr.write(`\n\x1b[31malpha-manager:\x1b[0m ${message}\n`);
  process.exit(1);
}

const api = (path, { method = 'GET', body } = {}) =>
  fetchJson(`${HOST}${path}`, { method, token: TOKEN, body, timeoutMs: 20_000 }).then((r) => r.body);

/**
 * `24h` → milliseconds.
 *
 * Exported and total: an unparseable duration throws rather than defaulting,
 * because a quota window that silently became "everything" is a quota that
 * does not bound anything.
 */
export function parseDuration(raw) {
  const match = /^(\d+)([mhd])$/.exec(String(raw ?? '').trim());
  if (!match) {
    throw new Error(`duration must be <n>m, <n>h or <n>d (got ${JSON.stringify(raw)})`);
  }
  const value = Number.parseInt(match[1], 10);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  return value * unit;
}

export function parseList(raw) {
  return String(raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Where this species' seeds should carry on from.
 *
 * The ledger holds every recipe that ever finished, so the next unused seed is
 * one more than the highest seen. Seeds are per species, not global: `fern/4`
 * and `beetle/4` are two different creatures, and sharing a counter would skip
 * most of each species' range for no reason.
 *
 * A failed render still counts. Its seed was spent — re-issuing it would
 * re-run work that has already failed once, usually for a reason that has not
 * changed.
 */
export function nextSeedFor(receipts, species) {
  let highest = -1;
  for (const receipt of receipts) {
    if (receipt?.recipe?.species !== species) continue;
    const seed = receipt.recipe.seed;
    if (Number.isInteger(seed) && seed > highest) highest = seed;
  }
  return highest + 1;
}

/**
 * The approval gate, as a pure function so it can be tested without a host.
 *
 * Two independent bounds, because they fail differently: an allowlist stops
 * the wrong thing being made at all, and a quota stops the right thing being
 * made until the disk is full. A pass is refused whole rather than trimmed —
 * "I rendered some of what you asked" is a worse answer for a scheduled job
 * than "I rendered none, and here is why".
 */
export function approve({ species, count, allow = [], maxPerWindow = null, recentCount = 0 }) {
  if (species.length === 0) {
    return { ok: false, reason: '--species is required and must name at least one species' };
  }
  if (allow.length > 0) {
    const refused = species.filter((name) => !allow.includes(name));
    if (refused.length > 0) {
      return {
        ok: false,
        reason: `not approved: ${refused.join(', ')} — --allow permits ${allow.join(', ')}`,
      };
    }
  }
  if (Number.isFinite(maxPerWindow)) {
    if (recentCount >= maxPerWindow) {
      return {
        ok: false,
        reason: `quota reached: ${recentCount} render(s) already finished in this window, limit ${maxPerWindow}`,
      };
    }
    const room = maxPerWindow - recentCount;
    if (count > room) {
      return {
        ok: false,
        reason: `quota would be exceeded: ${recentCount} done, limit ${maxPerWindow}, so there is room for ${room} not ${count}`,
      };
    }
  }
  return { ok: true };
}

function flagsFrom(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) die(`unexpected argument ${JSON.stringify(arg)}`);
    const name = arg.slice(2);
    if (name === 'dry-run' || name === 'json' || name === 'help') flags[name] = true;
    else flags[name] = argv[++i];
  }
  return flags;
}

async function commandRender(flags) {
  const species = parseList(flags.species);
  const count = Number.parseInt(flags.count ?? '1', 10);
  if (!Number.isFinite(count) || count < 1) die('--count must be a whole number of at least 1');

  const windowMs = parseDuration(flags.window ?? '24h');
  const maxPerWindow = flags['max-per-window']
    ? Number.parseInt(flags['max-per-window'], 10)
    : null;

  // One read serves both halves: the quota counts what finished inside the
  // window, and the seeds continue from everything ever recorded.
  const { receipts } = await api('/receipts?type=alpha.render&limit=1000');
  const since = Date.now() - windowMs;
  const recentCount = receipts.filter((r) => (r.finishedAt ?? 0) >= since).length;

  const verdict = approve({
    species,
    count,
    allow: parseList(flags.allow),
    maxPerWindow: Number.isFinite(maxPerWindow) ? maxPerWindow : null,
    recentCount,
  });
  if (!verdict.ok) {
    say(`\nRefused. ${verdict.reason}`);
    process.exit(3);
  }

  // Seeds are allocated per species before anything is queued, so a batch
  // cycling two species gets two independent runs rather than interleaved
  // collisions.
  const nextSeed = new Map(species.map((name) => [name, nextSeedFor(receipts, name)]));
  const forced = flags.seed === undefined ? null : Number.parseInt(flags.seed, 10);

  const jobs = [];
  for (let i = 0; i < count; i += 1) {
    const name = species[i % species.length];
    const seed = forced === null ? nextSeed.get(name) : forced + Math.floor(i / species.length);
    if (forced === null) nextSeed.set(name, seed + 1);
    jobs.push({ species: name, seed });
  }

  const leaseMs = Number.parseInt(flags['lease-ms'] ?? '900000', 10);
  const minMemoryMB = Number.parseInt(flags['min-memory-mb'] ?? '4096', 10);

  say(
    `\nApproved ${count} render(s)` +
      `${maxPerWindow ? ` (${recentCount}/${maxPerWindow} used in the last ${flags.window ?? '24h'})` : ''}` +
      `${flags.agent ? ` for "${flags.agent}"` : ''}`,
  );
  for (const job of jobs) say(`  ${job.species}/${job.seed}`);

  if (flags['dry-run']) {
    say('\n--dry-run: nothing was queued.');
    return;
  }

  let queued = 0;
  for (const job of jobs) {
    const body = {
      type: 'alpha.render',
      payload: { species: job.species, seed: job.seed },
      leaseMs,
      minMemoryMB,
    };
    if (flags.agent) body.targetAgent = flags.agent;

    const task = await api('/tasks', { method: 'POST', body });
    queued += 1;
    if (queued === 1 && !task.agentAvailable) {
      if (task.targetAttached === false) {
        say(`\n  ! no attached agent is called "${flags.agent}" — the batch waits for it`);
      } else if (task.memoryAvailable === false) {
        say(`\n  ! nothing has ${minMemoryMB} MB free right now — the batch waits`);
      } else {
        say('\n  ! nothing attached offers "alpha.render" — the batch waits');
      }
    }
  }

  // Deliberately no wait: see the header. The receipts are the record.
  say(`\nQueued ${queued}. Not waiting — read them with: alpha-manager report`);
}

async function commandReport(flags) {
  const query = flags.since ? `?since=${Date.now() - parseDuration(flags.since)}` : '';
  const summary = await api(`/receipts/summary${query}`);

  if (flags.json) {
    say(JSON.stringify(summary, null, 2));
    return;
  }

  const window = flags.since ? ` in the last ${flags.since}` : ' (all time)';
  say(`\nAlpha fleet — what has actually been produced${window}\n`);

  if (summary.total === 0) {
    say('  Nothing recorded yet.');
    say('\n  A ledger is only written by a host with persistent credentials, and');
    say('  only from the moment it started keeping one. Work finished before');
    say('  then is not missing — it was never written down.');
    return;
  }

  say(`  Tasks finished   ${summary.total}`);
  for (const [status, n] of Object.entries(summary.byStatus)) {
    say(`    ${status.padEnd(14)} ${n}`);
  }

  say('');
  say(`  Images produced  ${summary.outputs}  (${size(summary.bytes)} on disk)`);

  const species = Object.entries(summary.species).sort((a, b) => b[1] - a[1]);
  if (species.length > 0) {
    say('\n  By species');
    for (const [name, n] of species) say(`    ${name.padEnd(14)} ${n}`);
  }

  const machines = Object.entries(summary.machines).sort((a, b) => b[1] - a[1]);
  if (machines.length > 0) {
    say('\n  By machine');
    for (const [name, n] of machines) say(`    ${name.padEnd(14)} ${n}`);
  }

  const failed = summary.byStatus.failed ?? 0;
  if (failed > 0) {
    say(`\n  ${failed} failed. See: alpha-admin tasks, or /receipts?status=failed`);
  }
}

/**
 * Ask a machine what is actually on its disk.
 *
 * `report` reads the host's ledger, which only knows what it was told and only
 * since it started keeping one. This asks the machine holding the images, so
 * it is the only way to count renders that predate the ledger — and afterwards
 * it stays the ground truth the ledger can be checked against.
 *
 * Unlike `render` this does wait: a directory scan is milliseconds, and an
 * inventory you have to come back for is not worth having.
 */
async function commandInventory(flags) {
  const payload = {};
  if (flags.species) payload.species = flags.species;

  const body = { type: 'alpha.render.inventory', payload, leaseMs: 60_000 };
  if (flags.agent) body.targetAgent = flags.agent;

  const queued = await api('/tasks', { method: 'POST', body });
  if (!queued.agentAvailable) {
    if (queued.targetAttached === false) {
      die(`no attached agent is called "${flags.agent}"`);
    }
    die(
      'nothing attached offers "alpha.render.inventory". Enable it on the rendering machine:\n' +
        '  ALPHA_EXTRA_HANDLERS=alpha-render,alpha-render-inventory',
    );
  }

  const deadline = Date.now() + 60_000;
  let task = queued;
  while (Date.now() < deadline) {
    task = await api(`/tasks/${queued.id}`);
    if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (task.status !== 'succeeded') {
    die(`inventory ${task.status}: ${task.error?.message ?? 'no result'}`);
  }

  const result = task.result;
  if (flags.json) {
    say(JSON.stringify(result, null, 2));
    return;
  }

  say(`\nRenders on disk${flags.agent ? ` — ${flags.agent}` : ''}  (${result.outputDir}/)\n`);

  if (result.total === 0) {
    say('  Nothing. This machine has an output directory and no images in it.');
    return;
  }

  say(`  Images           ${result.total}  (${size(result.bytes)} on disk)`);
  if (result.newest) say(`  Most recent      ${new Date(result.newest).toISOString()}`);
  if (result.rendersInFlight > 0) {
    say(`  Rendering now    ${result.rendersInFlight}  (not counted above)`);
  }

  const rows = Object.entries(result.species).sort((a, b) => b[1].count - a[1].count);
  say('\n  By species');
  for (const [name, row] of rows) {
    say(`    ${name.padEnd(14)} ${String(row.count).padStart(5)}  ${size(row.bytes)}`);
  }

  if (result.species['(unfiled)']) {
    say('\n  "(unfiled)" is everything rendered before images were filed by species.');
  }

  // The two records answering differently is worth knowing about: the ledger
  // is what the host was told, the disk is what is really there.
  const summary = await api('/receipts/summary').catch(() => null);
  if (summary && summary.outputs !== result.total) {
    say(
      `\n  Note: the host ledger records ${summary.outputs} image(s), the disk holds ` +
        `${result.total}. Anything rendered before the ledger existed is only on disk.`,
    );
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    say(USAGE);
    return;
  }
  if (!TOKEN) die('no admin token. Set ALPHA_ADMIN_TOKEN, or put it in .env beside this checkout.');

  const flags = flagsFrom(rest);
  if (flags.help) return say(USAGE);

  if (command === 'render') return commandRender(flags);
  if (command === 'report') return commandReport(flags);
  if (command === 'inventory') return commandInventory(flags);
  die(`unknown command ${JSON.stringify(command)}. Try: render, report, inventory`);
}

// Importable for tests; only the CLI path runs main().
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => die(error.message));
}

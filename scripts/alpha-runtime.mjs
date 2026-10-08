#!/usr/bin/env node
/**
 * What Alpha's loops and agents are actually doing, read from this machine.
 *
 *     node scripts/alpha-runtime.mjs --alpha-root C:\...\VyoS-advance-tech-ai
 *
 * Two questions kept needing a person at the keyboard, and both have answers
 * sitting on the machine that nothing printed:
 *
 *   1. **Is the assistant cycle running, or waiting for the background lane?**
 *      Alpha's awareness scan runs inside the assistant cycle and shares its
 *      gate, so `awareness: not-started` means the cycle has not had its turn
 *      yet — not that awareness is broken. Under memory pressure that wait can
 *      last hours, and the two look identical from outside.
 *   2. **Why is every agent receipt `incomplete`?** The receipt records the
 *      reason (which headings were missing, which references went uncited), and
 *      the deck feed shows only the failure *class*. The reason is the half that
 *      says what to change.
 *
 * It is read-only: one unauthenticated GET of the LAN deck feed, and one JSON
 * file read. It starts nothing, writes nothing, and takes no path from an
 * argument beyond Alpha's root — the registry is at the place Alpha's own
 * `AGENT_REGISTRY` names, `memory/local/alpha_agent_registry.json` under it.
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

/** This machine's home-network address: what the deck feed is served on. */
export function homeAddress(interfaces = networkInterfaces()) {
  const candidates = [];
  for (const addresses of Object.values(interfaces)) {
    for (const entry of addresses ?? []) {
      const isV4 = entry.family === 4 || entry.family === 'IPv4';
      if (!isV4 || entry.internal) continue;
      const ip = entry.address;
      // The feed is LAN-only, so a tailnet or link-local address is not it.
      if (ip.startsWith('100.') || ip.startsWith('169.254.')) continue;
      const rank = ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 9;
      if (rank !== 9) candidates.push({ ip, rank });
    }
  }
  candidates.sort((a, b) => a.rank - b.rank);
  return candidates[0]?.ip ?? '127.0.0.1';
}

/**
 * The loop state the deck feed carries, flattened to the three facts that
 * decide whether anything is wrong.
 *
 * `waiting_on` is the one that matters: a cycle waiting for the shared
 * background lane is healthy and starved, which reads as a dead loop everywhere
 * else.
 */
export function summarizeRuntime(feed) {
  const runtime = feed?.runtime ?? {};
  const freshness = feed?.freshness ?? {};
  return {
    assistant: runtime.assistant ?? null,
    awareness: runtime.awareness ?? null,
    thoughts: runtime.thoughts ?? null,
    heartbeatAgeS: runtime.heartbeat_age_s ?? freshness.heartbeat_age_s ?? null,
    waitingOn: freshness.waiting_on ?? null,
    waitingSince: freshness.waiting_since ?? null,
    cycleStep: freshness.cycle_step ?? null,
    stale: freshness.stale ?? null,
    advice: freshness.advice ?? null,
  };
}

/**
 * The newest agent receipts, as class + reason pairs.
 *
 * Alpha's `_classify_receipt_failure` names the class and `_incompletion_reason`
 * names the reason; a receipt carries both. Counting classes alone is what makes
 * "50 failures, evidence-contract" look like a broken fleet when the detail may
 * be one missing heading.
 */
export function summarizeReceipts(registry, limit = 8) {
  const agents = Array.isArray(registry?.agents) ? registry.agents : [];
  const rows = [];
  for (const agent of agents) {
    for (const receipt of Array.isArray(agent?.history) ? agent.history : []) {
      rows.push({
        agent: String(agent.name ?? agent.id ?? 'unknown'),
        role: String(agent.role ?? receipt.role ?? ''),
        at: String(receipt.recorded_at ?? receipt.at ?? ''),
        status: String(receipt.status ?? ''),
        outcome: String(receipt.outcome ?? ''),
        failureClass: receipt.failure_class ?? null,
        // Any of the three keys the manager fills a blocker from.
        reason: String(receipt.reason ?? receipt.error ?? receipt.detail ?? '').slice(0, 300),
      });
    }
  }
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const classes = new Map();
  for (const row of rows) {
    if (!row.failureClass) continue;
    classes.set(row.failureClass, (classes.get(row.failureClass) ?? 0) + 1);
  }
  return { total: rows.length, classes: [...classes].sort((a, b) => b[1] - a[1]), newest: rows.slice(0, limit) };
}

function parseArgs(argv) {
  const options = { alphaRoot: process.env.ALPHA_REPO_ROOT ?? '', port: 8001, limit: 8 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--alpha-root') options.alphaRoot = argv[++i] ?? '';
    else if (arg === '--port') options.port = Number.parseInt(argv[++i] ?? '', 10) || 8001;
    else if (arg === '--limit') options.limit = Number.parseInt(argv[++i] ?? '', 10) || 8;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('node scripts/alpha-runtime.mjs --alpha-root <Alpha root> [--port 8001] [--limit 8]\n');
    return;
  }
  if (!options.alphaRoot) {
    process.stdout.write('alpha-runtime: no --alpha-root and no ALPHA_REPO_ROOT\n');
    process.exit(1);
  }
  const root = resolve(options.alphaRoot);
  const say = (line) => process.stdout.write(`${line}\n`);

  const address = homeAddress();
  const url = `http://${address}:${options.port}/panel/crowpanel/public-state`;
  let feed = null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    feed = response.ok ? await response.json() : null;
    if (!feed) say(`feed     : ${url} answered ${response.status}`);
  } catch (error) {
    say(`feed     : ${url} did not answer (${error.message})`);
  }

  if (feed) {
    const runtime = summarizeRuntime(feed);
    say(`loops    : assistant=${runtime.assistant} awareness=${runtime.awareness} thoughts=${runtime.thoughts}`);
    say(`beat     : ${runtime.heartbeatAgeS}s old, stale=${runtime.stale}`);
    // The line this script exists for.
    say(`lane     : waiting_on=${runtime.waitingOn ?? 'nothing'} since=${runtime.waitingSince ?? '-'} step=${runtime.cycleStep ?? '-'}`);
    if (runtime.advice) say(`advice   : ${runtime.advice}`);
    if (runtime.awareness === 'not-started' && runtime.waitingOn) {
      say(`note     : awareness runs inside the assistant cycle, so "not-started" here means`);
      say(`           the cycle has not had the lane yet — look at free memory, not at awareness`);
    }
  }

  const registryPath = join(root, 'memory', 'local', 'alpha_agent_registry.json');
  let registry = null;
  try {
    registry = JSON.parse(await readFile(registryPath, 'utf8'));
  } catch (error) {
    say(`receipts : could not read ${registryPath} (${error.code ?? error.message})`);
  }
  if (registry) {
    const summary = summarizeReceipts(registry, options.limit);
    say(`receipts : ${summary.total} retained; classes ${summary.classes.map(([name, count]) => `${name}=${count}`).join(' ') || 'none'}`);
    for (const row of summary.newest) {
      say(`  ${row.at} ${row.agent} (${row.role}) ${row.status}${row.failureClass ? ` [${row.failureClass}]` : ''}`);
      if (row.reason) say(`      ${row.reason}`);
    }
  }
}

// fileURLToPath, not URL.pathname: on Windows the pathname is "/C:/...", which
// never equals the resolved argv path, so the job printed nothing and exited 0
// (Laptop41, 20261008-02-alpha-runtime).
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`alpha-runtime: ${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}

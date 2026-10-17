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

import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, posix as posixPath, resolve, win32 as winPath } from 'node:path';
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
 *
 * **Receipts are one flat top-level list, not a field on an agent.**
 * `_load_agent_registry` keeps `agents` and `receipts` side by side and joins
 * them by `agent_id` on read (`_agent_runtime_view`), so the derived `history`
 * exists only in an API response. The first version of this read
 * `agents[].history` out of the file and reported `0 retained; classes none`
 * from a registry holding failures -- the `alpha-devices.js` `serialPorts`
 * mistake, which reads as a healthy fleet rather than as a bug. Timestamps are
 * `completed_at` for the same reason.
 */
export function summarizeReceipts(registry, limit = 8) {
  const agents = Array.isArray(registry?.agents) ? registry.agents : [];
  const receipts = Array.isArray(registry?.receipts) ? registry.receipts : [];
  // Receipts name an agent id; the name lives on the roster. Resolved here
  // because an id alone sends nobody anywhere.
  const names = new Map();
  for (const agent of agents) {
    if (agent?.id) names.set(String(agent.id), String(agent.name ?? agent.id));
  }
  const rows = receipts.map((receipt) => ({
    agent: names.get(String(receipt?.agent_id ?? '')) ?? String(receipt?.agent_id ?? 'unknown'),
    role: String(receipt?.role ?? ''),
    deck: String(receipt?.deck ?? ''),
    at: String(receipt?.completed_at ?? ''),
    status: String(receipt?.status ?? ''),
    outcome: String(receipt?.outcome ?? ''),
    failureClass: receipt?.failure_class ?? null,
    // The order Alpha's own manager fills a blocker from.
    reason: String(receipt?.reason ?? receipt?.error ?? receipt?.detail ?? '').slice(0, 300),
  }));
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const classes = new Map();
  for (const row of rows) {
    if (!row.failureClass) continue;
    classes.set(row.failureClass, (classes.get(row.failureClass) ?? 0) + 1);
  }
  return {
    total: rows.length,
    classes: [...classes].sort((a, b) => b[1] - a[1]),
    newest: rows.slice(0, limit),
    // What an empty answer is: no receipts, or a file shaped unlike this reader
    // expects. Printed only when there is nothing to show, so the next person
    // to see "0 retained" can tell which it was without a debugger.
    shape: describeShape(registry),
  };
}

/** The registry's own top-level keys, so emptiness can be told from misreading. */
export function describeShape(registry) {
  if (!registry || typeof registry !== 'object') return 'not an object';
  return (
    Object.keys(registry)
      .map((key) => (Array.isArray(registry[key]) ? `${key}[${registry[key].length}]` : key))
      .join(' ') || 'no keys'
  );
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
    // The other awareness word that gets read as a broken loop. "degraded" is
    // `'ok' if failed == 0 else 'degraded'` over the awareness cycle's own
    // hardware-test report (ESP32 sketch compiles against the ports it found),
    // so it says a board or a compile failed -- the loop ran, and learning is
    // not what it is about.
    if (runtime.awareness === 'degraded') {
      say(`note     : "degraded" is the awareness cycle's hardware-test report, not the loop:`);
      say(`           it ran and at least one sketch compile or port test failed. Ports it saw:`);
      say(`           ${feed?.mapping?.ports_detected ?? '?'}; the failing items are in Alpha's awareness deck.`);
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
    // "0 retained" is the one answer that could mean this reader is wrong, so
    // it never stands alone.
    if (summary.total === 0) say(`           registry holds: ${summary.shape}`);
    for (const row of summary.newest) {
      say(`  ${row.at} ${row.agent} (${row.role}) ${row.status}${row.failureClass ? ` [${row.failureClass}]` : ''}`);
      if (row.reason) say(`      ${row.reason}`);
    }
  }
}

// fileURLToPath, not URL.pathname: on Windows the pathname is "/C:/...", which
// never equals the resolved argv path, so the job printed nothing and exited 0
// (Laptop41, 20261008-02-alpha-runtime).
/**
 * Was this file run, rather than imported?
 *
 * The plain `resolve(process.argv[1]) === fileURLToPath(import.meta.url)` form
 * silently answers *no* on Windows when the two spellings of the same file
 * differ, and a guard that answers no is a script that exits 0 having printed
 * nothing — exactly what the first real `alpha-runtime` pass on Worker1 did:
 * `-> 0` in 0 s with an empty block. Windows hands the same file out two ways:
 * `C:\\services\\...` against `C:\\Services\\...` (its paths are
 * case-insensitive, JavaScript string comparison is not, and the ESM loader
 * reports the on-disk casing), and a path reached through a symlink or a short
 * `PROGRA~1` segment, which `realpath` resolves and `argv[1]` may not.
 *
 * `platform` is a parameter rather than a read of `process.platform` because the
 * whole comparison is platform-specific — separators, drive letters and case
 * folding all differ — and a rule that can only be exercised on the machine it
 * is wrong on is a rule nothing checks. The real-path step is taken only when
 * the asked-for platform is this one; off it there is nothing to resolve
 * against.
 */
export function isEntrypoint(argv1, moduleUrl, platform = process.platform) {
  if (!argv1) return false;
  const windows = platform === 'win32';
  const rules = windows ? winPath : posixPath;
  const real = (value) => {
    // Only meaningful for the host: resolving a Windows path on POSIX would
    // answer about a file that is not there either way.
    if (platform !== process.platform) return value;
    try {
      return realpathSync(value);
    } catch {
      return value;
    }
  };
  const left = real(rules.resolve(argv1));
  const right = real(fileURLToPath(moduleUrl, { windows }));
  return windows ? left.toLowerCase() === right.toLowerCase() : left === right;
}

if (isEntrypoint(process.argv[1], import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`alpha-runtime: ${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}

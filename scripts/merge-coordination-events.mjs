#!/usr/bin/env node
/**
 * Appends to Worker1's coordination log the events only a standby has.
 *
 *   node scripts/merge-coordination-events.mjs --master <events.jsonl> --incoming <events.jsonl> [--dry-run]
 *
 * `--master` is the live log in Alpha's `memory/local/coordination/`.
 * `--incoming` is the standby's copy, brought over after Worker1 is back
 * (Alpha's `WORKER1_FAILOVER_PLAN.md`, step 1d). Running it twice adds nothing
 * the second time. It prints one JSON line saying what it added.
 *
 * Exit codes: 0 merged (or nothing to add), 1 refused (a bad incoming line,
 * a missing file, bad arguments). Nothing is written on a refusal.
 *
 * Hold the tunnel's mutex while it runs, so no Post lands mid-append. Node has
 * no Windows named mutex, so the scheduled task wraps it in PowerShell:
 *
 *   $m = [System.Threading.Mutex]::new($false, 'Global\AlphaCoordinationTunnel')
 *   if (-not $m.WaitOne([TimeSpan]::FromSeconds(60))) { throw 'tunnel busy' }
 *   try { node scripts\merge-coordination-events.mjs --master <...> --incoming <...> }
 *   finally { $m.ReleaseMutex() }
 *
 * then runs the tunnel's `-Action Status` so `status.json` is rebuilt.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

import { appendText, planMerge } from '../src/common/coordination-events.js';

function parseArgs(argv) {
  const options = { master: null, incoming: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--master') options.master = argv[++i] ?? '';
    else if (arg === '--incoming') options.incoming = argv[++i] ?? '';
    else if (arg === '--dry-run') options.dryRun = true;
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (!options.master) throw new Error('--master <events.jsonl> is required');
  if (!options.incoming) throw new Error('--incoming <events.jsonl> is required');
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    // A missing master is refused rather than created: on Worker1 it means
    // the path is wrong, and a fresh file there would hide the real log.
    for (const path of [options.master, options.incoming]) {
      if (!existsSync(path)) throw new Error(`no such file: ${path}`);
    }
    const masterText = readFileSync(options.master, 'utf8');
    const plan = planMerge(masterText, readFileSync(options.incoming, 'utf8'));
    if (!options.dryRun && plan.append.length > 0) {
      appendFileSync(options.master, appendText(masterText, plan.append), 'utf8');
    }
    process.stdout.write(
      `${JSON.stringify({
        merged: !options.dryRun,
        added: plan.ids.length,
        alreadyPresent: plan.alreadyPresent,
        masterUnreadable: plan.masterUnreadable,
        ids: plan.ids,
      })}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`merge-coordination-events: ${error.message}\n`);
    return 1;
  }
}

process.exitCode = main();

#!/usr/bin/env node
/**
 * Is each machine's autopilot still completing passes?
 *
 * `autopilot.ps1` rewrites `status/<channel>-live` every pass, five minutes
 * apart, whether or not anything changed. Nothing read it. On 2026-10-08
 * Laptop41's pass stopped publishing at 23:29:08Z and was still silent three
 * hours later, while its separately scheduled doctor kept pushing from the
 * same machine with the same credentials -- and two commits of queued work
 * landed on `control/laptop41` in the meantime, onto a queue nothing was
 * draining. The heartbeat said so the whole time; no one was listening.
 *
 * It cannot be checked on the machine itself. `Publish-Live` is the last thing
 * a pass does (`autopilot.ps1:850`), so a pass stuck in an action publishes
 * nothing and a hung pass is invisible to itself -- the same reason
 * `watchdog.mjs` asks the *host* whether a laptop is attached. This asks git,
 * so it needs no key, no tailnet and no coordinator: any machine, or a cloud
 * session, can run it.
 *
 *   node scripts/fleet-heartbeat.mjs
 *   node scripts/fleet-heartbeat.mjs --machine laptop41 --stale-min 15 --json
 *
 * Exit 0 every machine is current; 1 one or more are stale; 2 could not look.
 */

import { spawnSync } from 'node:child_process';

export const DEFAULT_MACHINES = ['laptop41', 'host'];
// Three missed five-minute passes. One missed pass is a pass that took longer
// than five minutes, which is ordinary; three in a row is not.
export const DEFAULT_STALE_MIN = 15;

export function parseArgs(argv) {
  const opts = { remote: 'origin', machines: [], staleMin: DEFAULT_STALE_MIN, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--remote') opts.remote = next();
    else if (a === '--machine') opts.machines.push(next());
    else if (a === '--json') opts.json = true;
    else if (a === '--stale-min') {
      opts.staleMin = Number(next());
      if (!Number.isFinite(opts.staleMin) || opts.staleMin <= 0) throw new Error('--stale-min needs a number of minutes');
    } else throw new Error(`unknown option ${a}`);
  }
  if (!opts.machines.length) opts.machines = [...DEFAULT_MACHINES];
  return opts;
}

/**
 * The live report's own JSON, or null.
 *
 * `Publish-Live` writes it with a UTF-8 BOM, which `JSON.parse` refuses; a
 * reader that forgets the BOM reports a live machine as unreadable.
 */
export function parseLive(text) {
  if (text == null) return null;
  try {
    const o = JSON.parse(String(text).replace(/^﻿/, ''));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

/**
 * Minutes between an instant and now, to one decimal place, or null.
 *
 * The live report's `at` carries the machine's own offset (`+01:00`) and the
 * deck receipt inside it is UTC. Subtracting the strings by eye is how a
 * five-minute-old report came to be reported here as an hour stale; parsing
 * both to an instant is the only honest way, and the reason this is a function
 * with a test rather than a line in a prompt.
 */
export function ageMinutes(at, now) {
  const t = Date.parse(String(at ?? ''));
  return Number.isFinite(t) ? Math.round(((now - t) / 60_000) * 10) / 10 : null;
}

/**
 * Whether a machine's autopilot is still completing passes, and why that is
 * the question being asked.
 *
 * Kept pure and pinned by tests, like `alpha-selfheal.mjs`'s `decide()`.
 */
export function verdict({ live, liveAgeMin, autopilotAgeMin, queuedAgeMin, staleMin = DEFAULT_STALE_MIN } = {}) {
  const notes = [];
  // Never a fault on its own: the report branch is pushed only when a queued id
  // actually ran (`autopilot.ps1:733`), so hours of silence there are normal.
  // Said out loud because reading it as a stall is the mistake that is made.
  if (autopilotAgeMin != null) {
    notes.push(`last report ${autopilotAgeMin} min ago, which is not a fault on its own: it is pushed only when a queued id ran`);
  }
  if (!live) return { state: 'NO REPORT', ok: true, notes: ['no live report on this branch yet, so there is nothing to age'] };
  if (liveAgeMin == null) return { state: 'UNREADABLE', ok: false, notes: ['the live report has no readable `at`', ...notes] };
  if (liveAgeMin <= staleMin) return { state: 'OK', ok: true, liveAgeMin, notes };
  const why = [
    `the pass publishes this last (autopilot.ps1:850), so a pass stuck in an action publishes nothing and the next pass finds the same wedge`,
  ];
  // The cost, not the symptom: work queued since the last completed pass is
  // work nothing is going to pick up.
  if (queuedAgeMin != null && queuedAgeMin < liveAgeMin) {
    why.push(`work was queued ${queuedAgeMin} min ago, after that last pass, and nothing has run it`);
  }
  return { state: 'STALE', ok: false, liveAgeMin, notes: [...why, ...notes] };
}

function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`git ${args.slice(0, 2).join(' ')}: ${r.error.message}`);
  return r;
}

/**
 * One branch's tip commit time and a file from it, without switching this
 * checkout and without touching its `refs/remotes`.
 *
 * Its own ref namespace for two reasons: a remote given as a path (which the
 * tests do, and which is how anyone points this at a clone) cannot be part of
 * a ref name, and rewriting `refs/remotes/origin/status/*` underneath whatever
 * checkout this runs in is a side effect nobody asked a read-only check for.
 */
export function readBranch({ remote, branch, path }) {
  const local = `refs/fleet-heartbeat/${branch.replace(/[^A-Za-z0-9._/-]/g, '_')}`;
  if (git(['fetch', remote, `+refs/heads/${branch}:${local}`]).status !== 0) return null;
  const ref = local;
  const at = git(['log', '-1', '--pretty=%cI', ref]);
  if (at.status !== 0) return null;
  const out = { committedAt: at.stdout.trim() };
  if (path) {
    const file = git(['show', `${ref}:${path}`]);
    out.text = file.status === 0 ? file.stdout : null;
  }
  return out;
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { log(`STOP: ${e.message}`); return 2; }
  const now = Date.now();
  const rows = [];
  for (const machine of opts.machines) {
    let live = null;
    let liveAgeMin = null;
    let autopilotAgeMin = null;
    let queuedAgeMin = null;
    try {
      const l = readBranch({ remote: opts.remote, branch: `status/${machine}-live`, path: 'reports/live.json' });
      live = parseLive(l?.text);
      // The report's own stamp, not the commit's: the commit is when it was
      // pushed, and a push that was slow is not a pass that was late.
      liveAgeMin = live ? ageMinutes(live.at, now) : null;
      autopilotAgeMin = ageMinutes(readBranch({ remote: opts.remote, branch: `status/${machine}-autopilot` })?.committedAt, now);
      queuedAgeMin = ageMinutes(readBranch({ remote: opts.remote, branch: `control/${machine}` })?.committedAt, now);
    } catch (e) {
      rows.push({ machine, state: 'CANNOT LOOK', ok: false, notes: [e.message] });
      continue;
    }
    rows.push({ machine, ...verdict({ live, liveAgeMin, autopilotAgeMin, queuedAgeMin, staleMin: opts.staleMin }) });
  }
  if (opts.json) {
    log(JSON.stringify({ at: new Date(now).toISOString(), staleMin: opts.staleMin, machines: rows }, null, 2));
  } else {
    for (const r of rows) {
      log(`${r.machine}  ${r.state}${r.liveAgeMin != null ? `  live report ${r.liveAgeMin} min old (stale past ${opts.staleMin})` : ''}`);
      for (const note of r.notes ?? []) log(`    ${note}`);
    }
  }
  return rows.every((r) => r.ok) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (e) => { console.error(`STOP: ${e.message}`); process.exit(2); });
}

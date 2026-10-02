#!/usr/bin/env node
/**
 * One pass of bounded self-repair for the Alpha host: the backend, the
 * production frontend, and the Cloudflare connector that publishes them.
 *
 * `repair-alpha-host.ps1` puts the host right once, with a person watching.
 * This is what keeps it right afterwards, with nobody watching — so everything
 * it may do is bounded, and everything it does is written down:
 *
 * - **It waits for a streak, not a blip.** A component is only repaired after
 *   it has failed on consecutive passes. One slow answer during a build is not
 *   an outage.
 * - **Cooldown and budget.** After a repair a component is left alone for
 *   `cooldownMs`, so a restart has time to take. Past `budgetPerHour` repairs
 *   of one component, or `budgetPerDay` in all, it stops repairing and says so
 *   once, to the coordination tunnel — a crash loop is a problem for a person,
 *   and a supervisor that restarts it forever just hides it.
 * - **The connector is last and gated.** cloudflared is only restarted when the
 *   origin has been proven healthy on consecutive passes, the Internet is
 *   reachable, and the public hostname answers with a code that means "the
 *   tunnel could not reach the origin". A 502 while the frontend is down is the
 *   frontend's fault, and bouncing the tunnel for it only adds a second outage.
 *   Nothing here reads, writes or prints the tunnel's config or credentials.
 * - **Rollback.** A frontend that stays healthy has its `dist` snapshotted as
 *   last-good. A frontend that is still failing after a plain restart gets that
 *   snapshot back — a bad build is the likeliest reason a restart did not help
 *   — and the failed build is kept beside it, never deleted.
 * - **Some failures are not restartable.** Vite answering 403 "Blocked request"
 *   to the public hostname is a configuration fault; restarting it answers the
 *   same. That is reported with the fix and no restart is spent on it.
 *
 * Every pass appends one JSON line to the log. Repairs, exhausted budgets and
 * recoveries are also posted to Alpha's coordination tunnel, so live progress
 * is where the rest of the fleet's receipts are.
 *
 * Usage:
 *   node scripts/alpha-selfheal.mjs --config <selfheal.json> [--dry-run]
 *   node scripts/alpha-selfheal.mjs --config <selfheal.json> --status
 *
 * Exit codes: 0 healthy, 1 something is failing (repairing or waiting),
 * 2 a budget is exhausted or a failure needs a person, 3 bad configuration.
 */

import { execFile } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildArgs } from '../src/agent/handlers/alpha-coordination.js';

export const DEFAULTS = Object.freeze({
  failuresBeforeRepair: 2,
  publicFailuresBeforeRepair: 3,
  originConfirmations: 2,
  goodPassesBeforeSnapshot: 3,
  cooldownMs: 5 * 60_000,
  budgetPerHour: 3,
  budgetPerDay: 12,
  probeTimeoutMs: 8_000,
  logMaxBytes: 5 * 1024 * 1024,
  lockStaleMs: 10 * 60_000,
  keepFailedBuilds: 2,
});

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const COMPONENTS = ['backend', 'frontend', 'public'];

// Codes Cloudflare returns when the edge was reached but the tunnel could not
// deliver the request to the origin (502/504), or no connector is serving the
// tunnel at all (530, error 1033). Anything under 500 — including an Access
// redirect or a bot-protection 403 — means the edge is fine and is not a
// connector fault.
const CONNECTOR_CODES = new Set([502, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);

// Failures a restart cannot fix. They are reported once, with the fix, and do
// not spend budget.
const NOT_RESTARTABLE = {
  'vite-host-blocked':
    'Vite refuses the public hostname (403 "Blocked request"). Add it to preview.allowedHosts ' +
    'in frontend/vite.config.* and rebuild; restarting serves the same 403.',
  'no-dist':
    'The frontend has no dist/index.html and no last-good snapshot to restore. Run the build ' +
    '(npm run build in the frontend) — restarting a preview server with nothing to serve does not help.',
};

// ---------------------------------------------------------------------------
// configuration and state

export function loadConfig(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const config = { ...DEFAULTS, ...raw };
  const missing = [];
  if (!config.stateDir) missing.push('stateDir');
  if (!config.backend?.url) missing.push('backend.url');
  if (!config.frontend?.url) missing.push('frontend.url');
  if (missing.length) throw new Error(`config is missing ${missing.join(', ')}`);
  config.logFile ??= join(config.stateDir, 'selfheal.jsonl');
  return config;
}

function emptyComponent() {
  return { failStreak: 0, okStreak: 0, level: 0, repairs: [], lastRepairAt: 0, flagged: null };
}

export function emptyState() {
  return {
    passes: 0,
    components: Object.fromEntries(COMPONENTS.map((c) => [c, emptyComponent()])),
    lastGoodFingerprint: null,
  };
}

export function readState(stateDir) {
  const file = join(stateDir, 'state.json');
  if (!existsSync(file)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const base = emptyState();
    for (const c of COMPONENTS) base.components[c] = { ...emptyComponent(), ...parsed.components?.[c] };
    return { ...base, ...parsed, components: base.components };
  } catch {
    // A torn state file costs the streaks, not the host: start counting again.
    return emptyState();
  }
}

export function writeState(stateDir, state) {
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, 'state.json');
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${file}.tmp`, file);
}

// ---------------------------------------------------------------------------
// the decision — pure, so the policy is testable without a Windows box

const ladders = {
  backend: ['restart'],
  frontend: ['restart', 'rollback'],
  public: ['restart-connector'],
};

function within(list, now, span) {
  return list.filter((t) => now - t < span);
}

/**
 * Given the previous state and this pass's probes, what should be done.
 *
 * Returns the next state, the actions to run (in order), and the events worth
 * telling a person about. Never performs anything itself.
 */
export function decide({ config, state, probes, now }) {
  const cfg = { ...DEFAULTS, ...config };
  const next = structuredClone(state);
  next.passes = (state.passes ?? 0) + 1;
  const actions = [];
  const events = [];

  // Spent repairs age out of the budget.
  for (const c of COMPONENTS) next.components[c].repairs = within(next.components[c].repairs, now, DAY);
  const spentToday = COMPONENTS.reduce((n, c) => n + next.components[c].repairs.length, 0);

  const judge = (name, probe, { threshold, gate }) => {
    const s = next.components[name];
    if (!probe || probe.skipped) return;

    if (probe.ok) {
      if (s.failStreak >= threshold || s.flagged) {
        events.push({ kind: 'recovered', component: name, after: s.failStreak });
      }
      s.okStreak += 1;
      s.failStreak = 0;
      s.level = 0;
      s.flagged = null;
      return;
    }

    s.okStreak = 0;
    s.failStreak += 1;

    if (NOT_RESTARTABLE[probe.reason]) {
      if (s.flagged !== probe.reason) {
        s.flagged = probe.reason;
        events.push({ kind: 'needs-person', component: name, reason: probe.reason, detail: NOT_RESTARTABLE[probe.reason] });
      }
      return;
    }
    if (s.failStreak < threshold) return;

    const blocked = gate?.();
    if (blocked) {
      if (s.flagged !== blocked) {
        s.flagged = blocked;
        events.push({ kind: 'waiting', component: name, reason: blocked });
      }
      return;
    }
    if (s.lastRepairAt && now - s.lastRepairAt < cfg.cooldownMs) return;

    const hourly = within(s.repairs, now, HOUR).length;
    if (hourly >= cfg.budgetPerHour || spentToday + actions.length >= cfg.budgetPerDay) {
      if (s.flagged !== 'budget-exhausted') {
        s.flagged = 'budget-exhausted';
        events.push({
          kind: 'budget-exhausted',
          component: name,
          detail: `${hourly} repair(s) this hour, ${spentToday} today; leaving it for a person`,
        });
      }
      return;
    }

    const ladder = ladders[name];
    const step = ladder[Math.min(s.level, ladder.length - 1)];
    let action = step;
    if (step === 'rollback' && !probe.hasLastGood) action = 'restart';
    actions.push({ component: name, action, level: s.level, reason: probe.reason ?? `status ${probe.status}` });
    s.level += 1;
    s.lastRepairAt = now;
    s.repairs.push(now);
    s.flagged = null;
  };

  judge('backend', probes.backend, { threshold: cfg.failuresBeforeRepair });
  judge('frontend', probes.frontend, { threshold: cfg.failuresBeforeRepair });

  const origin = next.components.frontend;
  judge('public', probes.public, {
    threshold: cfg.publicFailuresBeforeRepair,
    gate: () => {
      // Only the connector's own faults are the connector's to fix.
      if (!probes.frontend?.ok || origin.okStreak < cfg.originConfirmations) return 'origin-not-proven-healthy';
      if (probes.control && !probes.control.ok) return 'no-internet-from-host';
      if (!probes.public.connectorFault) return 'not-a-connector-fault';
      return null;
    },
  });

  // Last-good snapshot: a frontend that has stayed healthy is worth keeping.
  const f = probes.frontend;
  if (
    f?.ok &&
    f.fingerprint &&
    origin.okStreak >= cfg.goodPassesBeforeSnapshot &&
    f.fingerprint !== next.lastGoodFingerprint
  ) {
    actions.push({ component: 'frontend', action: 'snapshot', fingerprint: f.fingerprint });
  }

  return { state: next, actions, events };
}

// ---------------------------------------------------------------------------
// probes

function request(url, { timeoutMs, hostHeader } = {}) {
  return new Promise((resolvePromise) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      resolvePromise({ status: 0, body: '', error: 'bad url' });
      return;
    }
    const lib = target.protocol === 'https:' ? https : http;
    const headers = { 'user-agent': 'alpha-selfheal', accept: 'text/html,application/json' };
    // Node's http lets a probe send the Host the tunnel sends, which is the
    // only way to see what cloudflared will be told. fetch forbids it.
    if (hostHeader) headers.host = hostHeader;
    const req = lib.request(target, { method: 'GET', headers, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (body.length < 64 * 1024) body += chunk;
      });
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body }));
      res.on('error', (error) => resolvePromise({ status: 0, body, error: error.message }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => resolvePromise({ status: 0, body: '', error: error.message }));
    req.end();
  });
}

export function distFingerprint(distDir) {
  const index = join(distDir, 'index.html');
  if (!existsSync(index)) return null;
  const st = statSync(index);
  return `${Math.round(st.mtimeMs)}:${st.size}`;
}

export async function probeAll(config) {
  const timeoutMs = config.probeTimeoutMs ?? DEFAULTS.probeTimeoutMs;
  const probes = {};

  const backend = await request(config.backend.url, { timeoutMs });
  probes.backend = {
    ok: backend.status >= 200 && backend.status < 300,
    status: backend.status,
    reason: backend.error ?? (backend.status ? `status ${backend.status}` : 'no answer'),
  };

  const fe = config.frontend;
  const front = await request(fe.url, { timeoutMs, hostHeader: fe.hostHeader });
  const expect = fe.expect ?? 'id="root"';
  const dist = fe.dir ? join(fe.dir, 'dist') : null;
  const lastGood = fe.dir ? join(fe.dir, 'dist.last-good') : null;
  probes.frontend = {
    ok: front.status === 200 && front.body.includes(expect),
    status: front.status,
    reason: front.error ?? (front.status ? `status ${front.status}` : 'no answer'),
    fingerprint: dist ? distFingerprint(dist) : null,
    hasLastGood: Boolean(lastGood && existsSync(join(lastGood, 'index.html'))),
  };
  if (front.status === 403 && /Blocked request/i.test(front.body)) probes.frontend.reason = 'vite-host-blocked';
  else if (!probes.frontend.ok && dist && !probes.frontend.fingerprint && !probes.frontend.hasLastGood) {
    probes.frontend.reason = 'no-dist';
  } else if (front.status === 200 && !front.body.includes(expect)) {
    probes.frontend.reason = `served a page without ${expect}`;
  }

  if (config.public?.url) {
    const pub = await request(config.public.url, { timeoutMs });
    const code1033 = /error code: 1033|Error 1033/i.test(pub.body);
    probes.public = {
      ok: pub.status > 0 && pub.status < 500 && !code1033,
      status: pub.status,
      connectorFault: CONNECTOR_CODES.has(pub.status) || code1033,
      reason: pub.error ?? (code1033 ? 'cloudflare 1033' : `status ${pub.status}`),
    };
    if (config.public.controlUrl) {
      const control = await request(config.public.controlUrl, { timeoutMs });
      probes.control = { ok: control.status > 0 && control.status < 500, status: control.status };
    }
  } else {
    probes.public = { skipped: true };
  }
  return probes;
}

// ---------------------------------------------------------------------------
// actions

/** Swap the last-good snapshot into place, keeping the failed build beside it. */
export function rollbackDist(frontendDir, { now = Date.now(), keep = DEFAULTS.keepFailedBuilds } = {}) {
  const dist = join(frontendDir, 'dist');
  const lastGood = join(frontendDir, 'dist.last-good');
  if (!existsSync(join(lastGood, 'index.html'))) throw new Error('no last-good snapshot to roll back to');
  let kept = null;
  if (existsSync(dist)) {
    kept = join(frontendDir, `dist.failed-${now}`);
    renameSync(dist, kept);
  }
  cpSync(lastGood, dist, { recursive: true, preserveTimestamps: true });
  const failed = readdirSync(frontendDir)
    .filter((n) => n.startsWith('dist.failed-'))
    .sort()
    .reverse();
  for (const old of failed.slice(keep)) rmSync(join(frontendDir, old), { recursive: true, force: true });
  return { restored: dist, keptFailedBuild: kept };
}

/** Copy dist to dist.last-good through a temp dir, so a torn copy never replaces a good one. */
export function snapshotLastGood(frontendDir) {
  const dist = join(frontendDir, 'dist');
  const lastGood = join(frontendDir, 'dist.last-good');
  const tmp = `${lastGood}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  cpSync(dist, tmp, { recursive: true, preserveTimestamps: true });
  rmSync(lastGood, { recursive: true, force: true });
  renameSync(tmp, lastGood);
  return { snapshot: lastGood };
}

function run(file, args, { env, timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise) => {
    execFile(
      file,
      args,
      { env: { ...process.env, ...env }, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) =>
        resolvePromise({ code: error ? (error.code ?? 1) : 0, stdout: `${stdout ?? ''}`.trim(), stderr: `${stderr ?? ''}`.trim() }),
    );
  });
}

// Fixed script text. Every value it acts on arrives in an environment variable,
// so nothing from the configuration is ever parsed as PowerShell.
const RESTART_PS = `
$ErrorActionPreference = 'Continue'
$task = $env:ASH_TASK; $wrapper = $env:ASH_WRAPPER; $port = [int]$env:ASH_PORT
$allowed = @($env:ASH_ALLOWED -split ',' | Where-Object { $_ })
if ($wrapper) {
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -EA SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($wrapper, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
    ForEach-Object { taskkill.exe /T /F /PID $_.ProcessId 2>&1 | Out-Null; "killed wrapper $($_.ProcessId)" }
}
Stop-ScheduledTask -TaskName $task -EA SilentlyContinue
if ($port) {
  foreach ($c in @(Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue)) {
    $p = Get-Process -Id $c.OwningProcess -EA SilentlyContinue
    if (-not $p) { continue }
    if ($allowed -contains $p.ProcessName.ToLower()) { taskkill.exe /T /F /PID $p.Id 2>&1 | Out-Null; "killed port holder $($p.ProcessName) $($p.Id)" }
    else { "REFUSED to kill port holder $($p.ProcessName) $($p.Id): not an allowed process name" }
  }
}
Start-ScheduledTask -TaskName $task -EA Stop
"started task $task"
`;

const RESTART_SERVICE_PS = `
$ErrorActionPreference = 'Stop'
Restart-Service -Name $env:ASH_SERVICE -Force
Start-Sleep -Seconds 5
"$env:ASH_SERVICE is $((Get-Service -Name $env:ASH_SERVICE).Status)"
`;

export function makeWindowsExecutor(config) {
  const ps = config.powershell ?? 'powershell.exe';
  const psArgs = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];

  const restartComponent = (component) => {
    const c = config[component];
    if (!c.task) return Promise.resolve({ code: 1, stdout: '', stderr: `no task configured for ${component}` });
    return run(ps, psArgs(RESTART_PS), {
      env: {
        ASH_TASK: c.task,
        ASH_WRAPPER: c.wrapper ?? '',
        ASH_PORT: String(c.port ?? new URL(c.url).port ?? ''),
        ASH_ALLOWED: (c.killableNames ?? ['node', 'python', 'pythonw', 'uvicorn']).join(',').toLowerCase(),
      },
    });
  };

  return {
    async restart(component) {
      return restartComponent(component);
    },
    async rollback(component) {
      const result = rollbackDist(config.frontend.dir);
      const restarted = await restartComponent(component);
      return { code: restarted.code, stdout: `${JSON.stringify(result)}\n${restarted.stdout}`, stderr: restarted.stderr };
    },
    async 'restart-connector'() {
      const service = config.public?.service ?? 'cloudflared';
      return run(ps, psArgs(RESTART_SERVICE_PS), { env: { ASH_SERVICE: service } });
    },
    async snapshot() {
      return { code: 0, stdout: JSON.stringify(snapshotLastGood(config.frontend.dir)), stderr: '' };
    },
  };
}

/** Posts to Alpha's coordination tunnel. Never throws: a pass does not fail on its log. */
export function makePoster(config) {
  const co = config.coordination;
  if (!co?.root) return async () => ({ posted: false, why: 'no coordination root configured' });
  const root = resolve(co.root);
  const script = resolve(root, co.script ?? 'scripts/alpha_coordination_tunnel.ps1');
  return async (message) => {
    if (!existsSync(script)) return { posted: false, why: `no coordination script at ${script}` };
    const args = buildArgs({
      script,
      action: 'Post',
      actor: co.actor ?? 'alpha-selfheal',
      message: message.slice(0, 4_000),
      paths: [],
    });
    const res = await run(config.powershell ?? 'powershell.exe', args, { timeoutMs: 60_000 });
    return { posted: res.code === 0, code: res.code };
  };
}

// ---------------------------------------------------------------------------
// the pass

function appendLog(file, record, maxBytes) {
  mkdirSync(dirname(file), { recursive: true });
  try {
    if (existsSync(file) && statSync(file).size > maxBytes) renameSync(file, `${file}.1`);
  } catch {
    // Rotation is best effort; losing it must not lose the line.
  }
  appendFileSync(file, `${JSON.stringify(record)}\n`);
}

function acquireLock(stateDir, staleMs, now) {
  mkdirSync(stateDir, { recursive: true });
  const lock = join(stateDir, 'selfheal.lock');
  try {
    const fd = openSync(lock, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now }));
    closeSync(fd);
    return () => rmSync(lock, { force: true });
  } catch {
    try {
      if (now - statSync(lock).mtimeMs > staleMs) {
        rmSync(lock, { force: true });
        return acquireLock(stateDir, staleMs, now);
      }
    } catch {
      // raced with the holder releasing it; treat as held
    }
    return null;
  }
}

function describe(event) {
  switch (event.kind) {
    case 'repair':
      return `self-heal: ${event.action} ${event.component} (${event.reason}) -> exit ${event.code}${event.output ? `: ${event.output}` : ''}`;
    case 'recovered':
      return `self-heal: ${event.component} healthy again after ${event.after} failed pass(es)`;
    case 'budget-exhausted':
      return `self-heal: STOPPED repairing ${event.component} - ${event.detail}`;
    case 'needs-person':
      return `self-heal: ${event.component} needs a person (${event.reason}): ${event.detail}`;
    case 'waiting':
      return `self-heal: ${event.component} failing, not repaired: ${event.reason}`;
    default:
      return `self-heal: ${JSON.stringify(event)}`;
  }
}

export async function runPass({ config, probe = probeAll, executor, post, now = Date.now(), dryRun = false }) {
  const release = acquireLock(config.stateDir, config.lockStaleMs ?? DEFAULTS.lockStaleMs, now);
  if (!release) return { skipped: 'another pass holds the lock' };
  try {
    const state = readState(config.stateDir);
    const probes = await probe(config);
    const { state: next, actions, events } = decide({ config, state, probes, now });

    const done = [];
    for (const a of actions) {
      if (dryRun) {
        done.push({ ...a, dryRun: true });
        continue;
      }
      let res;
      try {
        res = await executor[a.action](a.component);
      } catch (error) {
        res = { code: 1, stdout: '', stderr: error.message };
      }
      if (a.action === 'snapshot' && res.code === 0) next.lastGoodFingerprint = a.fingerprint;
      done.push({ ...a, code: res.code });
      if (a.action !== 'snapshot') {
        events.push({
          kind: 'repair',
          component: a.component,
          action: a.action,
          reason: a.reason,
          code: res.code,
          output: `${res.stdout} ${res.stderr}`.trim().slice(0, 600),
        });
      }
    }

    if (!dryRun) writeState(config.stateDir, next);

    const posted = [];
    if (!dryRun && post) {
      for (const e of events) posted.push(await post(describe(e)));
    }

    const record = {
      at: new Date(now).toISOString(),
      probes: Object.fromEntries(
        Object.entries(probes).map(([k, v]) => [k, v.skipped ? 'skipped' : { ok: v.ok, status: v.status, reason: v.ok ? undefined : v.reason }]),
      ),
      actions: done,
      events: events.map(describe),
      dryRun: dryRun || undefined,
    };
    appendLog(config.logFile, record, config.logMaxBytes ?? DEFAULTS.logMaxBytes);

    const needsPerson = events.some((e) => e.kind === 'budget-exhausted' || e.kind === 'needs-person') ||
      COMPONENTS.some((c) => next.components[c].flagged === 'budget-exhausted');
    // The control URL only tells "the host is down" from "this machine is off
    // the network" (the connector gate above); it is not part of Alpha, so its
    // being down does not make Alpha failing.
    const failing = COMPONENTS.some((c) => probes[c] && !probes[c].skipped && !probes[c].ok);
    return { record, state: next, exitCode: needsPerson ? 2 : failing ? 1 : 0, posted };
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const out = { dryRun: false, status: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') out.config = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--status') out.status = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

async function main() {
  let args;
  let config;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help || !args.config) {
      process.stdout.write('usage: node scripts/alpha-selfheal.mjs --config <selfheal.json> [--dry-run | --status]\n');
      process.exit(args.help ? 0 : 3);
    }
    config = loadConfig(args.config);
  } catch (error) {
    process.stderr.write(`alpha-selfheal: ${error.message}\n`);
    process.exit(3);
  }

  if (args.status) {
    const s = readState(config.stateDir);
    for (const c of COMPONENTS) {
      const x = s.components[c];
      const hour = within(x.repairs, Date.now(), HOUR).length;
      process.stdout.write(
        `${c.padEnd(9)} ok-streak ${x.okStreak}  fail-streak ${x.failStreak}  repairs 1h/24h ${hour}/${x.repairs.length}` +
          `${x.flagged ? `  FLAGGED ${x.flagged}` : ''}\n`,
      );
    }
    process.stdout.write(`last-good frontend: ${s.lastGoodFingerprint ?? 'none yet'}\nlog: ${config.logFile}\n`);
    return;
  }

  const result = await runPass({
    config,
    executor: makeWindowsExecutor(config),
    post: makePoster(config),
    dryRun: args.dryRun,
  });
  if (result.skipped) {
    process.stdout.write(`alpha-selfheal: ${result.skipped}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(result.record)}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

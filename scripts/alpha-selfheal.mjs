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
 * - **Chat is optional, and restarted as its owner.** With `chat` in the
 *   configuration, Ollama is probed like the backend and restarted through
 *   its own scheduled task (`chat.task`). The task, not this SYSTEM process,
 *   starts it, because Ollama's models live in the user's profile: an Ollama
 *   started as SYSTEM answers with no model at all. On 2026-10-08 Ollama was
 *   down on Laptop41 for over three hours and nothing here could see it.
 *
 * Every pass appends one JSON line to the log. Repairs, exhausted budgets and
 * recoveries are also posted to Alpha's coordination tunnel, so live progress
 * is where the rest of the fleet's receipts are.
 *
 * **A pass that cannot finish still writes its line.** One pass at a time is
 * enforced with a lock file, and a pass that died holding it used to silence
 * every pass after it for `lockStaleMs`: each one skipped, wrote nothing, and
 * exited 0. On Laptop41 on 2026-10-09 the log stopped at 13:22 and the
 * autopilot's restart at 13:30 changed nothing, which is that. So the lock
 * names its process and a lock whose process is gone is taken at once; a pass
 * still running at `passDeadlineMs` (under Task Scheduler's 5-minute limit,
 * which kills without warning) logs the stage it was stuck in and exits 4; a
 * process that ends with the pass unfinished does the same on its way out; and
 * every probe settles, even on a connection cut mid-answer.
 *
 * Usage:
 *   node scripts/alpha-selfheal.mjs --config <selfheal.json> [--dry-run]
 *   node scripts/alpha-selfheal.mjs --config <selfheal.json> --status
 *
 * Exit codes: 0 healthy, 1 something is failing (repairing or waiting),
 * 2 a budget is exhausted or a failure needs a person, 3 bad configuration
 * (also written to `<config>.error.json`, since a scheduled task's stderr goes
 * nowhere), 4 the pass did not finish (its log line says at which stage).
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
  passDeadlineMs: 4 * 60_000,
  keepFailedBuilds: 2,
});

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const COMPONENTS = ['backend', 'frontend', 'public', 'chat'];

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
  'no-chat-task':
    'Ollama does not answer and chat.task names no scheduled task to start it. Create one that runs ' +
    'Ollama as its own user (the autopilot job chat-task does), then add it to selfheal.json.',
};

// ---------------------------------------------------------------------------
// configuration and state

export function loadConfig(path) {
  // Windows PowerShell 5.1 writes UTF-8 with a BOM, which JSON.parse refuses;
  // a config written by repair-alpha-host.ps1 failed every pass with exit 3.
  const raw = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  const config = { ...DEFAULTS, ...raw };
  const missing = [];
  if (!config.stateDir) missing.push('stateDir');
  if (!config.backend?.url) missing.push('backend.url');
  if (!config.frontend?.url) missing.push('frontend.url');
  if (missing.length) throw new Error(`config is missing ${missing.join(', ')}`);
  config.logFile ??= join(config.stateDir, 'selfheal.jsonl');
  // alpha-standdown.ps1 writes it beside the config (the ops directory).
  config.roleFile ??= join(dirname(path), 'role.json');
  return config;
}

/**
 * "standby" while another machine serves Alpha (alpha-standdown.ps1). Only one
 * Alpha may serve alpha-ai.uk, so a standby's self-heal repairs nothing; its
 * task is disabled by the stand-down, and this is what still holds when
 * something enables it again (repair-alpha-host re-registers it).
 */
export function readRole(file) {
  if (!file || !existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/**
 * The config as the scheduled pass reads it. Two writers rewrite the file in
 * place (repair-alpha-host and chat-task), so a pass can land on it half
 * written; that is retried rather than turned into exit 3. What still fails is
 * written beside the config, because a scheduled task's stderr goes nowhere and
 * "check the task's last result as Administrator" was the only lead there was.
 */
export function readConfigForPass(path, { attempts = 3, delayMs = 500, sleep = sleepSync, now = () => Date.now() } = {}) {
  const errorFile = `${path}.error.json`;
  for (let attempt = 1; ; attempt++) {
    try {
      const config = loadConfig(path);
      rmSync(errorFile, { force: true });
      return config;
    } catch (error) {
      if (attempt < attempts) {
        sleep(delayMs);
        continue;
      }
      try {
        writeFileSync(errorFile, JSON.stringify({ at: new Date(now()).toISOString(), error: error.message }));
      } catch {
        // Nowhere to say it; exit 3 is still the answer.
      }
      throw error;
    }
  }
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
  chat: ['restart'],
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

  // A state written before a component existed (chat, 2026-10-08) starts it fresh.
  for (const c of COMPONENTS) next.components[c] ??= emptyComponent();
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
  judge('chat', probes.chat, { threshold: cfg.failuresBeforeRepair });

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

export function request(url, { timeoutMs, hostHeader } = {}) {
  return new Promise((resolveRequest) => {
    // Settle exactly once. A connection cut mid-answer ends with 'close' and no
    // 'end', and a promise left pending there let the process exit with the
    // pass unfinished and its lock left behind.
    let settled = false;
    let deadline;
    const resolvePromise = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolveRequest(value);
    };
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
    // Vite preview serves TLS with its own certificate on loopback; the probe
    // asks whether it answers, not who signed it. Remote URLs stay verified.
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname);
    const tls = target.protocol === 'https:' && loopback ? { rejectUnauthorized: false } : {};
    const req = lib.request(target, { method: 'GET', headers, timeout: timeoutMs, ...tls }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (body.length < 64 * 1024) body += chunk;
      });
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body }));
      res.on('error', (error) => resolvePromise({ status: 0, body, error: error.message }));
      res.on('close', () => resolvePromise({ status: 0, body, error: 'connection closed before the answer ended' }));
    });
    // The socket timeout is idle time; a server that trickles bytes never
    // trips it. This bounds the whole request.
    if (timeoutMs) deadline = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => resolvePromise({ status: 0, body: '', error: error.message }));
    req.on('close', () => resolvePromise({ status: 0, body: '', error: 'connection closed without an answer' }));
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

  if (config.chat?.url) {
    const chat = await request(config.chat.url, { timeoutMs });
    probes.chat = {
      ok: chat.status >= 200 && chat.status < 300,
      status: chat.status,
      reason: !config.chat.task ? 'no-chat-task' : chat.error ?? (chat.status ? `status ${chat.status}` : 'no answer'),
    };
  } else {
    probes.chat = { skipped: true };
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

// Windows refuses to rename or remove a folder while anything holds a file in
// it open, and a folder that has just been copied is exactly what a virus
// scanner is reading. Worker1 failed every snapshot from 2026-10-07 02:30 UTC
// with "EPERM: operation not permitted, rename 'dist.last-good.tmp' ->
// 'dist.last-good'". Such holds usually last moments, so a few short retries
// get through them; anything else is thrown at once. Worker1's outlasted the
// retries too (still refused at 04:14 UTC with them in place), so a rename
// that stays refused falls back to copying: a scanner only reads, and reading
// the folder is all a copy needs.
const TRANSIENT_FS = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const FS_RETRY = { maxRetries: 5, retryDelay: 200 };

export function retryTransient(fn, { attempts = 6, delayMs = 250, sleep = sleepSync } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (error) {
      if (!TRANSIENT_FS.has(error.code) || attempt >= attempts) throw error;
      sleep(delayMs * attempt);
    }
  }
}

/**
 * Copy `from` to `to` with index.html last. A snapshot counts only when its
 * index.html is there (rollbackDist, hasLastGood), so a copy cut off part way
 * reads as no snapshot rather than as a good one with files missing.
 */
export function copyIndexLast(from, to) {
  const index = join(from, 'index.html');
  cpSync(from, to, { recursive: true, preserveTimestamps: true, filter: (src) => src !== index });
  cpSync(index, join(to, 'index.html'), { preserveTimestamps: true });
}

/** Copy dist to dist.last-good through a temp dir, so a torn copy never replaces a good one. */
export function snapshotLastGood(frontendDir, { rename = renameSync, attempts, delayMs, sleep } = {}) {
  const dist = join(frontendDir, 'dist');
  const lastGood = join(frontendDir, 'dist.last-good');
  const tmp = `${lastGood}.tmp`;
  rmSync(tmp, { recursive: true, force: true, ...FS_RETRY });
  cpSync(dist, tmp, { recursive: true, preserveTimestamps: true });
  rmSync(lastGood, { recursive: true, force: true, ...FS_RETRY });
  try {
    retryTransient(() => rename(tmp, lastGood), { attempts, delayMs, sleep });
    return { snapshot: lastGood };
  } catch (error) {
    if (!TRANSIENT_FS.has(error.code)) throw error;
  }
  // The rename is still refused. Copy what is already in tmp instead; dist is
  // only read, never moved. tmp is a spare copy once this lands, and if
  // Windows will not let it go yet, the next snapshot clears it first.
  retryTransient(() => copyIndexLast(tmp, lastGood), { attempts, delayMs, sleep });
  try {
    rmSync(tmp, { recursive: true, force: true, ...FS_RETRY });
  } catch {
    // Left for the next snapshot; the copy above is what counts.
  }
  return { snapshot: lastGood, copied: true };
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
        ASH_ALLOWED: (c.killableNames ?? (component === 'chat' ? ['ollama', 'ollama app'] : ['node', 'python', 'pythonw', 'uvicorn']))
          .join(',')
          .toLowerCase(),
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

export function appendLog(file, record, maxBytes) {
  mkdirSync(dirname(file), { recursive: true });
  try {
    if (existsSync(file) && statSync(file).size > maxBytes) renameSync(file, `${file}.1`);
  } catch {
    // Rotation is best effort; losing it must not lose the line.
  }
  appendFileSync(file, `${JSON.stringify(record)}\n`);
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists and belongs to someone else, which is still alive.
    return error.code === 'EPERM';
  }
}

/**
 * The lock names its process. A lock whose process is gone belongs to a pass
 * that was killed (Task Scheduler's time limit, a reboot) or ended unfinished,
 * and is taken at once rather than after `staleMs`; that wait was a silent gap
 * in the log every time. A lock with no readable pid is aged out as before.
 */
export function acquireLock(stateDir, staleMs, now, { alive = processAlive, retried = false, name = 'selfheal.lock' } = {}) {
  mkdirSync(stateDir, { recursive: true });
  const lock = join(stateDir, name);
  try {
    const fd = openSync(lock, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now }));
    closeSync(fd);
    return () => rmSync(lock, { force: true });
  } catch {
    // Broken once already: whatever holds it now is a live pass, or a file
    // Windows has not finished deleting. Either way, held.
    if (retried) return null;
    try {
      let holder = null;
      try {
        holder = JSON.parse(readFileSync(lock, 'utf8'));
      } catch {
        // half written or not ours: fall through to the age rule
      }
      const gone = Number.isInteger(holder?.pid) && holder.pid !== process.pid && !alive(holder.pid);
      if (gone || now - statSync(lock).mtimeMs > staleMs) {
        rmSync(lock, { force: true });
        return acquireLock(stateDir, staleMs, now, { retried: true, name });
      }
    } catch {
      // raced with the holder releasing it; treat as held
    }
    return null;
  }
}

function summarizeProbes(probes) {
  return Object.fromEntries(
    Object.entries(probes).map(([k, v]) => [k, v.skipped ? 'skipped' : { ok: v.ok, status: v.status, reason: v.ok ? undefined : v.reason }]),
  );
}

/**
 * Writes the line a pass that cannot finish would otherwise never write, and
 * gives its lock back. Called by the CLI at the pass deadline and on the way
 * out of a process whose pass did not finish; a finished pass is left alone.
 */
export function abandonPass(config, progress, why, now = Date.now()) {
  if (progress.finished || !progress.release) return false;
  progress.finished = true;
  if (progress.state) {
    try {
      writeState(config.stateDir, progress.state);
    } catch {
      // the line and the lock matter more
    }
  }
  const record = {
    at: new Date(now).toISOString(),
    ...(progress.probes ? { probes: summarizeProbes(progress.probes) } : {}),
    actions: [],
    events: [],
    unfinished: {
      why,
      stage: progress.stage ?? 'start',
      ...(progress.startedAt ? { afterSec: Math.round((now - progress.startedAt) / 1000) } : {}),
    },
  };
  try {
    appendLog(config.logFile, record, config.logMaxBytes ?? DEFAULTS.logMaxBytes);
  } catch {
    // The lock still goes back, which is what lets the next pass run.
  }
  try {
    progress.release();
  } catch {
    // already gone
  }
  return true;
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

export async function runPass({ config, probe = probeAll, executor, post, now = Date.now(), dryRun = false, progress = {}, alive }) {
  const role = readRole(config.roleFile);
  if (role?.role === 'standby') {
    const record = { at: new Date(now).toISOString(), standby: { primary: role.primary ?? null }, actions: [], events: [] };
    appendLog(config.logFile, record, config.logMaxBytes ?? DEFAULTS.logMaxBytes);
    return { skipped: `standby: Alpha serves from ${role.primary ?? 'another machine'}; nothing is probed or repaired here`, record };
  }
  const release = acquireLock(config.stateDir, config.lockStaleMs ?? DEFAULTS.lockStaleMs, now, alive ? { alive } : {});
  if (!release) return { skipped: 'another pass holds the lock' };
  // What the CLI needs to write this pass's line if it never finishes.
  progress.release = release;
  progress.startedAt = now;
  progress.stage = 'probe';
  try {
    const state = readState(config.stateDir);
    const probes = await probe(config);
    progress.probes = probes;
    progress.stage = 'decide';
    const { state: next, actions, events } = decide({ config, state, probes, now });
    // decide() has already counted the repairs it chose. If a repair hangs and
    // the pass is abandoned, this is what keeps that count: without it a restart
    // that hangs every pass is never charged to the budget.
    if (!dryRun) progress.state = next;

    const done = [];
    for (const a of actions) {
      progress.stage = `${a.action} ${a.component}`;
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
      // A failed action says why in the log. A failed snapshot raises no event,
      // so without this Worker1 logged {"action":"snapshot","code":1} every two
      // minutes on 2026-10-07 and nothing anywhere said what had failed.
      const why = res.code === 0 ? '' : `${res.stderr || res.stdout || ''}`.trim().slice(0, 300);
      done.push({ ...a, code: res.code, ...(why ? { error: why } : {}) });
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

    progress.stage = 'state';
    if (!dryRun) writeState(config.stateDir, next);

    progress.stage = 'post';
    const posted = [];
    if (!dryRun && post) {
      for (const e of events) posted.push(await post(describe(e)));
    }

    progress.stage = 'log';
    const record = {
      at: new Date(now).toISOString(),
      probes: summarizeProbes(probes),
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
    progress.finished = true;
    release();
  }
}

// ---------------------------------------------------------------------------
// CLI

/**
 * Task Scheduler stops a pass at its time limit by killing it, which writes
 * nothing and leaves the lock behind. So the pass stops itself first, at
 * `passDeadlineMs`, and says where it was; and a process that ends with its
 * pass unfinished (a promise nothing will settle) says so on the way out.
 * Both exit 4. Returns the function that stands the deadline down.
 */
export function guardPass(config, progress, { exit = (code) => process.exit(code) } = {}) {
  const deadlineMs = config.passDeadlineMs ?? DEFAULTS.passDeadlineMs;
  const deadline = setTimeout(() => {
    abandonPass(config, progress, `still running after ${Math.round(deadlineMs / 1000)} s`);
    exit(4);
  }, deadlineMs);
  // A watchdog, not pending work: it must not keep a finished pass alive.
  deadline.unref();
  process.on('exit', () => {
    if (abandonPass(config, progress, 'the process ended before the pass finished')) process.exitCode = 4;
  });
  return () => clearTimeout(deadline);
}

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
    config = args.status ? loadConfig(args.config) : readConfigForPass(args.config);
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

  const progress = {};
  const disarm = guardPass(config, progress);
  const result = await runPass({
    config,
    executor: makeWindowsExecutor(config),
    post: makePoster(config),
    dryRun: args.dryRun,
    progress,
  });
  disarm();
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

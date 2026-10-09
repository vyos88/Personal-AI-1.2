#!/usr/bin/env node
/**
 * Phase 3 of the Alpha move (docs/HANDOFF_2026-10-07d_alpha-moves-to-host.md):
 * the standby covers for the primary by itself, and hands Alpha back when the
 * primary is back. V's rule (2026-10-07): Alpha is hosted by the Host; Worker1
 * covers while the Host is down; when the Host has a heartbeat again, it takes
 * over again, automatically.
 *
 * One pass, every minute, as SYSTEM, installed by install-alpha-standby.ps1, so
 * it runs with nobody signed in. Like self-heal it is local and not a handler:
 * the coordinator runs on the primary, which is the machine that is down.
 *
 * What it does, by role (role.json beside the config, written by
 * alpha-standdown.ps1 and by this):
 *
 *   - **none**: this machine is the primary. Nothing to cover.
 *   - **standby**: the primary serves. After `failures` passes in which the
 *     primary's Alpha does not answer, it covers: alpha-standdown.ps1 -Undo
 *     -StartConnector, then role "covering".
 *   - **covering**: this machine serves. After `recover` passes in which the
 *     primary's Alpha answers again, it hands back: alpha-standdown.ps1, which
 *     writes role "standby", and a hand-back record of what changed in
 *     memory\ while it covered, which the carry-back takes to the primary.
 *
 * Two Alphas are the failure this exists not to cause, so covering needs three
 * things at once, each from a different path:
 *
 *   - the primary's Alpha does not answer over the tailnet (`primaryUrl`);
 *   - alpha-ai.uk is not served by anyone (`publicUrl`: no answer, a 5xx, or
 *     Cloudflare's 1033 "no connector"). A primary that is up but unseen over
 *     the tailnet still serves the public URL, and that keeps this put;
 *   - this machine's own internet works (`controlUrl`). If it does not, the
 *     fault is here, and covering on a broken link makes a second Alpha.
 *
 * It does not quorum. Handing back starts as soon as the primary answers, so
 * the overlap is `recover` passes at most, and a standby that finds Alpha still
 * serving here while the primary answers stands down again (at most every
 * `retryStandDownMs`).
 *
 * Usage:
 *   node scripts/alpha-standby.mjs --config <standby.json> [--status]
 *
 * Exit codes: 0 pass done, 1 an action it took failed, 3 bad configuration,
 * 4 the pass ran past its deadline.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { acquireLock, appendLog, readRole, request } from './alpha-selfheal.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = Object.freeze({
  // One pass a minute: three missed passes is about three minutes of outage
  // before covering, long enough to sit out a restart of the primary's Alpha.
  failures: 3,
  recover: 2,
  probeTimeoutMs: 8_000,
  retryStandDownMs: 10 * 60_000,
  lockStaleMs: 10 * 60_000,
  passDeadlineMs: 4 * 60_000,
  logMaxBytes: 2 * 1024 * 1024,
  actionTimeoutMs: 4 * 60_000,
});

// Left out of the hand-back's count, as send-alpha-data.ps1 leaves them out:
// none of them is Alpha's state.
const SKIP = [/^local[\\/]pytest-/, /^local[\\/]test-temp([\\/]|$)/, /^local[\\/]uno-q-recovery([\\/]|$)/, /^local[\\/]android-sdk([\\/]|$)/, /^local[\\/]books([\\/]|$)/, /(^|[\\/])__pycache__([\\/]|$)/];

export function loadStandbyConfig(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  const config = { ...DEFAULTS, ...raw };
  const missing = ['stateDir', 'primary', 'primaryUrl', 'publicUrl', 'controlUrl'].filter((k) => !config[k]);
  if (missing.length) throw new Error(`config is missing ${missing.join(', ')}`);
  config.opsDir ??= dirname(path);
  config.roleFile ??= join(config.opsDir, 'role.json');
  config.logFile ??= join(config.opsDir, 'logs', 'standby.jsonl');
  config.localUrl ??= 'http://127.0.0.1:8001/health';
  config.standdownScript ??= join(HERE, 'alpha-standdown.ps1');
  return config;
}

const ok2xx = (r) => r.status >= 200 && r.status < 300;
// The same reading self-heal gives the public URL: any answer under 500 that
// is not Cloudflare's "no connector" page means somebody serves it.
export const served = (r) => r.status > 0 && r.status < 500 && !/error code: 1033|Error 1033/i.test(r.body ?? '');

export async function probeStandby(config, { needLocal }) {
  const timeoutMs = config.probeTimeoutMs;
  const [primary, pub, control, local] = await Promise.all([
    request(config.primaryUrl, { timeoutMs }),
    request(config.publicUrl, { timeoutMs }),
    request(config.controlUrl, { timeoutMs }),
    needLocal ? request(config.localUrl, { timeoutMs }) : Promise.resolve(null),
  ]);
  return {
    primary: { ok: ok2xx(primary), status: primary.status, error: primary.error },
    public: { served: served(pub), status: pub.status, error: pub.error },
    control: { ok: control.status > 0 && control.status < 500, status: control.status },
    local: local ? { serving: ok2xx(local), status: local.status } : null,
  };
}

/**
 * The policy, pure. Returns the next state and one action: none, cover,
 * handback or standdown (a standby that finds Alpha serving here too).
 */
export function decideStandby({ role, state = {}, probes, config, now }) {
  const s = { misses: 0, hits: 0, lastStandDownAt: 0, coveringSince: null, ...state };
  const primary = role?.primary || config.primary;
  const result = (action, why) => ({ state: s, action, why });
  const kind = role?.role;
  if (kind !== 'standby' && kind !== 'covering') {
    s.misses = 0;
    s.hits = 0;
    return result('none', 'this machine is the primary: nothing to cover');
  }

  if (probes.primary.ok) {
    s.hits += 1;
    s.misses = 0;
  } else {
    s.misses += 1;
    s.hits = 0;
  }

  if (kind === 'standby') {
    if (probes.primary.ok && probes.local?.serving) {
      // A hand-back that did not finish, or something that started Alpha here
      // again (Alpha's own always-on script). Two Alphas write two histories.
      if (now - s.lastStandDownAt < config.retryStandDownMs) {
        return result('none', `standby, but Alpha serves here while ${primary} answers: two Alphas (stand-down tried less than ${Math.round(config.retryStandDownMs / 60_000)} min ago)`);
      }
      s.lastStandDownAt = now;
      return result('standdown', `standby, but Alpha serves here while ${primary} answers: two Alphas, standing down again`);
    }
    if (probes.primary.ok) return result('none', `${primary}'s Alpha answers`);
    if (s.misses < config.failures) return result('none', `${primary}'s Alpha did not answer (${s.misses} of ${config.failures})`);
    if (!probes.control.ok) {
      return result('none', `${primary}'s Alpha does not answer, but neither does the control URL: this machine is the one offline, not covering`);
    }
    if (probes.public.served) {
      return result('none', `${primary}'s Alpha does not answer over the tailnet, but alpha-ai.uk is served (${probes.public.status}): not covering, that would be two Alphas`);
    }
    return result('cover', `${primary}'s Alpha has not answered for ${s.misses} passes and alpha-ai.uk is down (${probes.public.status || 'no answer'}): covering`);
  }

  // covering
  const since = s.coveringSince ? ` since ${new Date(s.coveringSince).toISOString()}` : '';
  if (!probes.primary.ok) return result('none', `covering for ${primary}${since}`);
  if (s.hits < config.recover) return result('none', `${primary}'s Alpha answers again (${s.hits} of ${config.recover}): handing back soon`);
  return result('handback', `${primary}'s Alpha answered ${s.hits} passes in a row: handing Alpha back`);
}

/** What changed in memory\ since a time: count, bytes, newest. Never content. */
export function changedSince(dir, sinceMs, { skip = SKIP } = {}) {
  const out = { files: 0, bytes: 0, newest: null };
  if (!dir || !existsSync(dir)) return out;
  const walk = (abs, rel) => {
    let entries = [];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (skip.some((re) => re.test(r))) continue;
      const p = join(abs, e.name);
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) {
        let st;
        try {
          st = statSync(p);
        } catch {
          continue;
        }
        if (st.mtimeMs >= sinceMs) {
          out.files += 1;
          out.bytes += st.size;
          if (!out.newest || st.mtimeMs > out.newest) out.newest = st.mtimeMs;
        }
      }
    }
  };
  walk(dir, '');
  if (out.newest) out.newest = new Date(out.newest).toISOString();
  return out;
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${file}.tmp`, file);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

function run(file, args, timeoutMs) {
  return new Promise((resolvePromise) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) =>
      resolvePromise({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, text: `${stdout ?? ''}${stderr ?? ''}`.trim() }),
    );
  });
}

/** The two moves, through the tested stand-down script. */
export function makeWindowsExecutor(config) {
  const ps = config.powershell ?? 'powershell.exe';
  const base = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', config.standdownScript, '-OpsDir', config.opsDir];
  return {
    cover: () => run(ps, [...base, '-Undo', '-StartConnector'], config.actionTimeoutMs),
    standDown: (primary) => run(ps, [...base, '-Primary', primary], config.actionTimeoutMs),
  };
}

export async function runPass({ config, probe = probeStandby, executor, now = Date.now(), changed = changedSince }) {
  const release = acquireLock(config.stateDir, config.lockStaleMs, now, { name: 'standby.lock' });
  if (!release) return { skipped: 'another pass holds the lock', exitCode: 0 };
  try {
    const stateFile = join(config.stateDir, 'state.json');
    const state = readJson(stateFile) ?? {};
    const role = readRole(config.roleFile);
    const idle = role?.role !== 'standby' && role?.role !== 'covering';
    const probes = idle ? null : await probe(config, { needLocal: role?.role === 'standby' });
    const decided = decideStandby({ role, state, probes, config, now });
    const next = decided.state;
    const primary = role?.primary || config.primary;
    let action = null;
    let exitCode = 0;

    if (decided.action === 'cover') {
      const res = await executor.cover();
      action = { action: 'cover', code: res.code, tail: tail(res.text) };
      // A cover nobody can reach is the one failure the code cannot show:
      // the stand-up's exit is about the backend, so the connector is read here.
      if (/CONNECTOR NOT RUNNING/.test(res.text)) action.connector = false;
      // 3: the stand-up refused because alpha-ai.uk answered after all. Then
      // it changed nothing, and this machine is still the standby.
      if (res.code !== 3) {
        next.coveringSince = now;
        next.hits = 0;
        writeJson(config.roleFile, { role: 'covering', primary, since: new Date(now).toISOString(), by: 'alpha-standby.mjs' });
      }
      if (res.code !== 0) exitCode = 1;
    } else if (decided.action === 'handback' || decided.action === 'standdown') {
      const res = await executor.standDown(primary);
      action = { action: decided.action, code: res.code, tail: tail(res.text) };
      next.lastStandDownAt = now;
      if (decided.action === 'handback') {
        // What this machine wrote while it served: the carry-back takes it to
        // the primary. Counted here, before anything moves.
        const from = next.coveringSince ?? now;
        const record = {
          primary,
          coveredFrom: new Date(from).toISOString(),
          coveredUntil: new Date(now).toISOString(),
          changed: changed(config.memoryDir, from),
          standDownCode: res.code,
          carried: false,
        };
        writeJson(join(config.stateDir, `handback-${stampOf(now)}.json`), record);
        action.handback = record.changed;
        next.coveringSince = null;
      }
      // 2 is "stood down, Alpha's own runtime still runs": nothing serves.
      if (res.code !== 0 && res.code !== 2) exitCode = 1;
    }

    writeJson(stateFile, next);
    const status = {
      at: new Date(now).toISOString(),
      role: role?.role ?? 'primary',
      primary,
      why: decided.why,
      misses: next.misses,
      hits: next.hits,
      coveringSince: next.coveringSince ? new Date(next.coveringSince).toISOString() : null,
      probes: probes ? { primary: probes.primary.status, public: probes.public.status, control: probes.control.status, local: probes.local?.status } : null,
      ...(action ? { action } : {}),
    };
    writeJson(join(config.stateDir, 'status.json'), status);
    appendLog(config.logFile, status, config.logMaxBytes);
    return { status, exitCode };
  } finally {
    release();
  }
}

const tail = (text) => `${text ?? ''}`.split(/\r?\n/).filter((l) => l.trim()).slice(-3).join(' | ').slice(0, 400);
const stampOf = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');

// ---------------------------------------------------------------------------
// CLI

async function main() {
  const argv = process.argv.slice(2);
  let configPath = '';
  let statusOnly = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') configPath = argv[++i] ?? '';
    else if (argv[i] === '--status') statusOnly = true;
    else {
      process.stderr.write(`alpha-standby: unknown argument ${argv[i]}\n`);
      process.exit(3);
    }
  }
  let config;
  try {
    if (!configPath) throw new Error('usage: node scripts/alpha-standby.mjs --config <standby.json> [--status]');
    config = loadStandbyConfig(resolve(configPath));
  } catch (error) {
    process.stderr.write(`alpha-standby: ${error.message}\n`);
    process.exit(3);
  }
  if (statusOnly) {
    const role = readRole(config.roleFile);
    const status = readJson(join(config.stateDir, 'status.json'));
    process.stdout.write(`role: ${role?.role ?? 'primary (no role.json)'}${role?.primary ? `, primary ${role.primary}` : ''}\n`);
    process.stdout.write(`watching: ${config.primary} at ${config.primaryUrl}; public ${config.publicUrl}; control ${config.controlUrl}\n`);
    process.stdout.write(status ? `last pass ${status.at}: ${status.why}\n` : 'no pass yet\n');
    return;
  }
  // A pass Task Scheduler kills writes nothing; this one stops first.
  const deadline = setTimeout(() => {
    process.stderr.write('alpha-standby: the pass ran past its deadline\n');
    process.exit(4);
  }, config.passDeadlineMs);
  deadline.unref();
  const result = await runPass({ config, executor: makeWindowsExecutor(config) });
  clearTimeout(deadline);
  process.stdout.write(`${JSON.stringify(result.status ?? { skipped: result.skipped })}\n`);
  process.exitCode = result.exitCode;
}

// Windows hands the same file out as C:\services and C:\Services; a guard that
// answers no is a pass that exits 0 having done nothing.
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && same(resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  main();
}

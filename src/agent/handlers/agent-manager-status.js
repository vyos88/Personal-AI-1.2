import { existsSync, readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve, sep } from 'node:path';

import { ProtocolError } from '../../common/protocol.js';

/**
 * Reads Alpha's Agent Manager snapshot on this machine, so another machine can
 * see it.
 *
 * Alpha's Agent Manager (scripts/alpha_agent_manager.ps1 in vyos88/Alpha) runs
 * on the machine that runs Alpha, as a singleton, and every 15 s writes what it
 * knows to memory/local/agent-manager/manager-status.json: the devices on the
 * tailnet, every agent with its state and latest receipt, and its own
 * recommendations. Its HTTP twin, /agent-manager/status, wants the owner's
 * login, so a second laptop could not see any of it.
 *
 * The answer is not a second manager. The manager starts and stops agents, and
 * two of them are exactly how duplicate stewards and restart loops happen; it
 * already holds a machine-wide mutex for that reason. This handler is the
 * read-only half: the one manager stays the authority, and anyone with a tunnel
 * credential can ask what it currently thinks. scripts/fleet-agents.mjs is the
 * console that asks.
 *
 * Same shape as alpha-devices.js:
 *
 * - Pinned file, which must resolve inside the manager's Alpha install:
 *   ALPHA_AGENT_MANAGER_ROOT, else ALPHA_REPO_ROOT (the root the coordination
 *   handler already uses). The file's path inside it is not configurable.
 * - **No arguments at all**: a payload carrying anything is refused, so there
 *   is no path for caller data to travel.
 * - It starts no process. It is opt-in anyway, because it reads the
 *   filesystem and is only real where Alpha runs, and available() declines a
 *   machine with no snapshot rather than advertising a type it would fail.
 *
 *   ALPHA_EXTRA_HANDLERS=agent-manager-status
 *   ALPHA_AGENT_MANAGER_ROOT=<Alpha install the manager runs from>   (optional)
 */

export const type = 'alpha.agent-manager.status';

export const description =
  "Reads Alpha's Agent Manager snapshot on this machine (devices, agents, recommendations). Read-only; takes no arguments.";

export const SNAPSHOT = 'memory/local/agent-manager/manager-status.json';

/** The manager rewrites the snapshot every 15 s; two minutes without one means it is not running. */
export const STALE_AFTER_MS = 120_000;

const MAX_BYTES = 16 * 1024 * 1024;
const LIMITS = Object.freeze({ devices: 16, agents: 120, recommendations: 12, handoffs: 4, campaigns: 8, text: 160 });

/**
 * The Alpha install whose Agent Manager runs here.
 *
 * Usually ALPHA_REPO_ROOT, the root the coordination handler uses. Not on
 * Worker1: its coordination log lives in C:\Users\Vyo\Alpha-1.8 while the live
 * Alpha, and the manager the owner watches, run from
 * C:\Users\Vyo\Downloads\VyoS-advance-tech-ai. Read from ALPHA_REPO_ROOT there,
 * this handler served Alpha-1.8's week-old snapshot (and said it was stale).
 * ALPHA_AGENT_MANAGER_ROOT names the manager's install without moving the
 * coordination log. Machine configuration, like ALPHA_REPO_ROOT: never payload.
 */
function managerRoot() {
  const raw = process.env.ALPHA_AGENT_MANAGER_ROOT || process.env.ALPHA_REPO_ROOT;
  if (!raw) {
    throw new ProtocolError(
      'neither ALPHA_AGENT_MANAGER_ROOT nor ALPHA_REPO_ROOT is set: this machine has no Alpha whose manager could be read',
      { status: 500, code: 'not_configured' },
    );
  }
  return resolve(raw);
}

/** The snapshot's path. Exported so a test can pin it. */
export function snapshotPath() {
  const root = managerRoot();
  const path = resolve(root, SNAPSHOT);
  // SNAPSHOT is a constant, so this cannot fail today; it is here so it still
  // cannot escape if someone later makes the path settable.
  if (!path.startsWith(root + sep)) {
    throw new ProtocolError(`${SNAPSHOT} must live inside the manager's Alpha root`, { status: 500, code: 'not_configured' });
  }
  return path;
}

export function available() {
  let path;
  try {
    path = snapshotPath();
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  if (!existsSync(path)) {
    return { ok: false, reason: `no Agent Manager snapshot at ${path}: Alpha's manager does not run on this machine` };
  }
  return { ok: true };
}

/** The payload must be empty; see alpha-devices.js for why "ignored" is not good enough. */
export function rejectArguments(payload) {
  if (payload === undefined || payload === null) return;
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProtocolError(`${type} takes no payload`);
  }
  const keys = Object.keys(payload);
  if (keys.length > 0) {
    throw new ProtocolError(`${type} takes no arguments; ${JSON.stringify(keys)} would change nothing`);
  }
}

// PowerShell's ConvertTo-Json writes a one-element array as a bare object, so
// every list in the snapshot is read through this.
const list = (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);
const text = (value) => {
  if (value === undefined || value === null) return null;
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s.length > LIMITS.text ? `${s.slice(0, LIMITS.text - 3)}...` : s;
};
const num = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

/**
 * The part of the snapshot worth carrying over the tunnel. The full file runs
 * to megabytes (receipts, audits, the self-model); this keeps what the
 * manager's own console draws, under the field names the console reads, so
 * the two cannot drift into describing different things.
 */
export function summarize(snapshot, { now = Date.now(), machine = hostname() } = {}) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const generated = Date.parse(s.generated_at ?? '');
  const ageMs = Number.isFinite(generated) ? Math.max(0, now - generated) : null;
  const counts = s.fleet_counts ?? {};
  const claims = s.active_claims_v2 ?? {};
  const workers = list(s.workers);
  return {
    schema: text(s.schema),
    machine,
    generatedAt: Number.isFinite(generated) ? new Date(generated).toISOString() : null,
    ageSeconds: ageMs === null ? null : Math.round(ageMs / 1000),
    // An old snapshot is the manager not running, and must not read as a live fleet.
    stale: ageMs === null || ageMs > STALE_AFTER_MS,
    backend: { status: text(s.backend?.status), ready: s.backend?.ready === true },
    counts: {
      records: num(s.worker_count),
      resident: num(counts.resident_workers),
      registered: num(counts.registered_model_agents),
      runtime: (num(counts.runtime_daemons) ?? 0) + (num(counts.runtime_tasks) ?? 0),
      attention: num(s.attention_count),
      verifiedActive: num(s.verified_active_count),
      externalGates: num(s.external_gate_count),
      resourceProtected: num(s.resource_protected_count),
    },
    accuracy: {
      scored: num(s.accuracy?.scored_agents),
      strong: num(s.accuracy?.strong_count),
      improve: num(s.accuracy?.improve_count),
      average: num(s.accuracy?.average_score),
    },
    devices: list(s.devices).slice(0, LIMITS.devices).map((d) => ({
      name: text(d?.name),
      hostname: text(d?.hostname),
      kind: text(d?.kind),
      role: text(d?.role),
      online: d?.online === true,
      local: d?.local === true,
      state: text(d?.assignment_state),
      agentCount: num(d?.agent_count),
      ips: list(d?.ips).slice(0, 2).map(text),
      cpuPercent: num(d?.cpu_percent),
      memoryPercent: num(d?.memory_percent),
      heartbeatAgeSeconds: num(d?.heartbeat_age_seconds),
    })),
    agentsTotal: workers.length,
    agents: workers.slice(0, LIMITS.agents).map((w) => ({
      id: text(w?.worker_id),
      state: text(w?.state),
      pid: num(w?.pid),
      process: text(w?.process_state),
      grade: text(w?.accuracy?.grade),
      score: num(w?.accuracy?.score),
      work: text(w?.latest_evidence),
    })),
    recommendations: list(s.assistant?.recommendations).slice(0, LIMITS.recommendations).map((r) => ({
      priority: text(r?.priority),
      agent: text(r?.agent_id),
      title: text(r?.title),
      action: text(r?.suggested_action),
    })),
    workflow: {
      id: text(s.workflow_tunnel?.id),
      state: text(s.workflow_tunnel?.state),
      handoffs: list(s.workflow_tunnel?.handoffs).slice(0, LIMITS.handoffs).map((h) => ({
        from: text(h?.from),
        next: text(h?.next_owner),
        gate: text(h?.gate),
      })),
    },
    claims: {
      records: num(claims.records),
      current: num(claims.current),
      expired: num(claims.expired),
      abandoned: num(claims.abandoned),
      superseded: num(claims.superseded),
    },
    continuity: text(s.continuity?.status),
    campaigns: list(s.campaign_agents).slice(0, LIMITS.campaigns).map((c) => ({
      id: text(c?.id),
      status: text(c?.last_tick_status),
    })),
  };
}

export async function run(payload) {
  rejectArguments(payload);
  const path = snapshotPath();
  if (!existsSync(path)) {
    throw new ProtocolError(`no Agent Manager snapshot at ${path}`, { status: 500, code: 'no_snapshot' });
  }
  const { size } = statSync(path);
  if (size > MAX_BYTES) {
    throw new ProtocolError(`the Agent Manager snapshot is ${size} bytes, over ${MAX_BYTES}`, {
      status: 500,
      code: 'snapshot_too_large',
    });
  }
  let snapshot;
  try {
    // Windows PowerShell writes UTF-8 with a byte-order mark, which JSON.parse refuses.
    snapshot = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  } catch (error) {
    // The manager replaces the file atomically, so this is a damaged file, not a torn write.
    throw new ProtocolError(`the Agent Manager snapshot is not readable JSON: ${error.message}`, {
      status: 500,
      code: 'snapshot_unreadable',
    });
  }
  return summarize(snapshot);
}

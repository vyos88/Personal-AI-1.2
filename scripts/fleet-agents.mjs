#!/usr/bin/env node
/**
 * A read-only console of every agent in the fleet, for any machine on the
 * tunnel: the same Norton Commander layout as Alpha's Agent Manager, with both
 * laptops in it.
 *
 * Alpha's Agent Manager runs on the machine that runs Alpha and is the one
 * authority over Alpha's agents: it starts and stops them, it holds a
 * machine-wide mutex so a second copy exits, and its device-command path
 * checks the allocation before starting anything anywhere. A second manager on
 * another laptop would be a second authority, which is how duplicate stewards
 * and restart loops start. So this is not a manager. It draws:
 *
 *   - the manager's own snapshot (devices, agents, recommendations), read
 *     through `alpha.agent-manager.status` on whichever agent offers it;
 *   - the tunnel's agents and the work each one holds a lease on, from the
 *     coordinator, which is the authority for tunnel work and leases each task
 *     to exactly one agent.
 *
 * It sends nothing but reads and that one read-only task, at most one at a
 * time, and only when an attached agent offers it. It starts, stops and
 * restarts nothing.
 *
 *   node scripts/fleet-agents.mjs                      live, redraws every 15 s
 *   node scripts/fleet-agents.mjs --once               one frame, then exit
 *   node scripts/fleet-agents.mjs --once --json        what it read, as JSON
 *     [--refresh <s>] [--manager-every <s>]
 *     [--machines host=laptop-gj8dfmlk,worker1=desktop-41hplcn]
 *
 * --machines names which machine each tunnel agent runs on, so a device card
 * can show the tunnel agent beside it; agents report a name, not a hostname.
 * Credentials as alpha-admin: ALPHA_ADMIN_TOKEN, else ALPHA_REPORT_TOKEN, else
 * the session `alpha-admin login` saved. It needs agents and tasks read, and
 * may queue that one task type.
 */

import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { loadEnv } from '../src/common/env.js';
import { fetchJson } from '../src/common/http.js';
import { loadSession } from '../src/admin/session.js';

export const MANAGER_TYPE = 'alpha.agent-manager.status';
// The same two minutes the handler uses: the manager rewrites its snapshot every 15 s.
const STALE_SECONDS = 120;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired']);

// ------------------------------------------------------------------ planning

/**
 * Whether to ask the manager now. One request at a time, never sooner than
 * `everyMs` after the last, and only when an attached agent that is not
 * silent offers the type: a task nobody can take would sit queued forever,
 * and the next pass would queue another beside it.
 */
export function managerFetchDue({ inFlightId, lastAskedAt }, agents, now, everyMs) {
  if (inFlightId) return false;
  if (lastAskedAt && now - lastAskedAt < everyMs) return false;
  return agents.some((a) => !a.stale && (a.capabilities ?? []).includes(MANAGER_TYPE));
}

export function parseMachines(value) {
  const map = new Map();
  for (const pair of String(value ?? '').split(',')) {
    const [agent, machine] = pair.split('=').map((s) => s?.trim());
    if (agent && machine) map.set(agent.toLowerCase(), machine.toLowerCase());
  }
  return map;
}

// ------------------------------------------------------------------ drawing

const ANSI = { cyan: 36, green: 32, yellow: 33, red: 31, gray: 90, magenta: 35, white: 37 };

function painter(enabled) {
  return (name, text) => (enabled && ANSI[name] ? `\x1b[${ANSI[name]}m${text}\x1b[0m` : text);
}

/** Clip to size with ASCII "...", then pad: the manager's own console does the same. */
export function fit(text, size) {
  const s = text === null || text === undefined ? '' : String(text);
  if (size <= 0) return '';
  if (s.length > size) return `${s.slice(0, Math.max(0, size - 3))}...`.slice(0, size);
  return s.padEnd(size);
}

function grid(panels, columns, width, paint, borderColor) {
  const out = [];
  if (!panels.length) return out;
  // Fewer columns before narrower panels: no line may run past the window.
  const cols = Math.max(1, Math.min(columns, panels.length, Math.floor((width - 1) / 19)));
  const panelWidth = Math.max(18, Math.floor((width - (cols + 1)) / cols));
  const border = `${`+${'-'.repeat(panelWidth)}`.repeat(cols)}+`;
  for (let at = 0; at < panels.length; at += cols) {
    const row = panels.slice(at, at + cols);
    out.push(paint(borderColor, border));
    const height = Math.max(...row.map((p) => p.lines.length));
    for (let line = 0; line < height; line++) {
      let text = '';
      for (let c = 0; c < cols; c++) {
        const panel = row[c];
        const cell = fit(panel?.lines[line] ?? '', panelWidth);
        text += `|${panel && line === 0 && panel.color ? paint(panel.color, cell) : cell}`;
      }
      out.push(`${text}|`);
    }
  }
  out.push(paint(borderColor, `${`+${'-'.repeat(panelWidth)}`.repeat(cols)}+`));
  return out;
}

const pct = (n) => (Number.isFinite(n) ? `${Math.round(n)}%` : '-');
const mb = (bytes) => (Number.isFinite(bytes) ? `${Math.round(bytes / (1024 * 1024))}M` : '-');
// Unknown load is "-", never 0%: the coordinator reads a missing report as unknown, not idle.
const loadPct = (agent) => pct(Number.isFinite(agent.loadFactor) ? agent.loadFactor * 100 : NaN);
const age = (seconds) =>
  !Number.isFinite(seconds) ? '?' : seconds < 120 ? `${seconds}s` : seconds < 7200 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`;

function stateColor(state) {
  const s = String(state ?? '').toUpperCase();
  if (/ATTENTION|FAILED|ERROR|EXITED/.test(s)) return 'red';
  if (/DISABLED|MIRROR|OFFLINE/.test(s)) return 'gray';
  if (/STALE|AWAITING|PAUSED|WARMING/.test(s)) return 'yellow';
  if (/FRESH|HEALTHY|VERIFIED|ACTIVE|SUPERVISING|ONLINE|RUNNING/.test(s)) return 'green';
  return 'white';
}

/**
 * One frame, as text. Pure: everything it shows is in `view`, so a test can
 * pin the layout and a person can trust that what is drawn is what was read.
 */
export function renderFrame(view, { width = 132, now = Date.now(), color = false } = {}) {
  const paint = painter(color);
  const w = Math.max(80, width);
  const bar = `+${'='.repeat(w - 2)}+`;
  const line = (text) => `|${fit(text, w - 2)}|`;
  const out = [];
  const m = view.manager?.summary ?? null;
  const agents = view.agents ?? [];
  const leases = view.leases ?? [];
  const managerAt = m?.machine ?? view.manager?.agentName ?? 'the Alpha machine';
  // Its age when read, plus the time since: a kept snapshot keeps getting older.
  const mAge = Number.isFinite(m?.ageSeconds)
    ? m.ageSeconds + Math.max(0, Math.round((now - (view.manager?.readAt ?? now)) / 1000))
    : null;
  const mStale = Boolean(m) && (m.stale || mAge === null || mAge > STALE_SECONDS);

  // A heading or footer line, clipped to the window like every panel.
  const say = (color, text) => paint(color, fit(text, w).trimEnd());

  out.push(paint('cyan', bar));
  out.push(paint('cyan', line(` ALPHA FLEET AGENTS // READ-ONLY VIEWER on ${view.viewer ?? hostname()}`)));
  out.push(
    paint(
      'cyan',
      line(
        ` Updated ${new Date(now).toISOString().replace('T', ' ').slice(0, 19)}Z | coordinator=${view.coordinator ?? '?'}` +
          ` | tunnel agents=${agents.length} leases=${leases.length}`,
      ),
    ),
  );
  out.push(
    paint(
      'cyan',
      line(
        !m
          ? ' manager: not read'
          : ` manager on ${managerAt}: snapshot ${age(mAge)} old${mStale ? ' (STALE)' : ''} | backend=${m.backend.status ?? '?'}/${m.backend.ready}` +
              ` | records=${m.counts.records ?? '?'} attention=${m.counts.attention ?? '?'}` +
              ` | accuracy avg=${m.accuracy.average ?? '?'} strong=${m.accuracy.strong ?? '?'} improve=${m.accuracy.improve ?? '?'}`,
      ),
    ),
  );
  out.push(paint('cyan', bar));
  if (view.error) out.push(say('red', ` COORDINATOR: ${view.error}`));

  // Devices: the manager's view of the tailnet, each with the tunnel agent on it.
  const machines = view.machines ?? new Map();
  const tunnelOn = (device) =>
    agents.find((a) => machines.get(String(a.name ?? '').toLowerCase()) === String(device.hostname ?? '').toLowerCase());
  if (m?.devices?.length) {
    out.push(say('magenta', ` DEVICES // FROM ALPHA'S AGENT MANAGER ON ${String(managerAt).toUpperCase()}`));
    out.push(
      ...grid(
        m.devices.map((d) => {
          const t = tunnelOn(d);
          return {
            color: d.online ? 'green' : 'gray',
            lines: [
              ` ${d.online ? 'ONLINE ' : 'OFFLINE'} ${d.name ?? d.hostname}`,
              ` ${d.kind ?? '?'} / ${d.role ?? '?'}${d.local ? ' (manager here)' : ''}`,
              ` ${d.ips?.[0] ?? '-'}  cpu=${pct(d.cpuPercent)} ram=${pct(d.memoryPercent)}`,
              ` ${d.state ?? '-'}${Number.isFinite(d.heartbeatAgeSeconds) ? ` hb=${age(d.heartbeatAgeSeconds)}` : ''}`,
              t ? ` tunnel: ${t.name} run=${t.inFlight ?? 0} cpu=${loadPct(t)} free=${mb(t.availableBytes)}` : ' tunnel: -',
            ],
          };
        }),
        4,
        w,
        paint,
        'magenta',
      ),
    );
  }

  // Tunnel agents: what the coordinator has leased to whom.
  out.push(say('cyan', ' TUNNEL AGENTS // LEASED WORK (the coordinator leases each task to one agent)'));
  if (!agents.length) out.push(say('yellow', ' (no agents attached)'));
  out.push(
    ...grid(
      agents.map((a) => {
        const held = leases.filter((t) => t.agentId === a.id);
        return {
          color: a.stale ? 'yellow' : 'green',
          lines: [
            ` ${a.stale ? '!' : '*'} ${a.name}  v${a.version ?? '?'}${a.stale ? '  SILENT' : ''}`,
            `  run=${a.inFlight ?? 0} cpu=${loadPct(a)} free=${mb(a.availableBytes)} idle=${Math.round((a.idleMs ?? 0) / 1000)}s`,
            `  ${(a.capabilities ?? []).length} types: ${(a.capabilities ?? []).join(',')}`,
            held.length ? `  leased: ${held.map((t) => t.type).join(', ')}` : '  leased: nothing',
          ],
        };
      }),
      4,
      w,
      paint,
      'cyan',
    ),
  );

  // Alpha's agents, as the manager sees them.
  if (!m) {
    out.push(say('yellow', ` ALPHA AGENTS // ${view.manager?.note ?? 'not read yet'}`));
  } else {
    if (mStale) {
      out.push(say('red', ` ALPHA AGENTS // the snapshot is ${age(mAge)} old: Alpha's Agent Manager is not running on ${managerAt}, or cannot be read`));
    } else {
      out.push(say('cyan', ` ALPHA AGENTS // ${managerAt}'s MANAGER (${m.agentsTotal} records; resident=${m.counts.resident ?? '?'} registered=${m.counts.registered ?? '?'} runtime=${m.counts.runtime ?? '?'})`));
    }
    out.push(
      ...grid(
        m.agents.map((a) => ({
          color: stateColor(a.state),
          lines: [
            ` ${a.process === 'alive' || a.process === 'shared-backend' ? '*' : a.process === 'registry-only' ? '+' : '!'} ${a.id}`,
            `  ${a.state ?? '?'} pid=${a.pid ?? '-'}`,
            `  ${a.grade && Number.isFinite(a.score) ? `[${a.grade} ${a.score}] ` : ''}${a.work ?? 'No verified task receipt.'}`,
          ],
        })),
        5,
        w,
        paint,
        'gray',
      ),
    );
    if (m.agentsTotal > m.agents.length) out.push(say('gray', ` ... and ${m.agentsTotal - m.agents.length} more`));
    out.push(say('white', ' MANAGER ASSISTANT // RECOMMENDATION ONLY'));
    out.push(`+${'-'.repeat(w - 2)}+`);
    if (!m.recommendations.length) out.push(line(' No recommendations.'));
    m.recommendations.slice(0, 9).forEach((r, i) => {
      out.push(line(` ${String(i + 1).padStart(2, '0')} [${r.priority ?? '?'}] ${r.title ?? ''} -- ${r.action ?? ''}`));
    });
    out.push(`+${'-'.repeat(w - 2)}+`);
    const c = m.claims;
    out.push(say('white', ` WORKFLOW ${m.workflow.id ?? 'awaiting'} // ${m.workflow.state ?? '?'}   CLAIMS records=${c.records ?? '?'} current=${c.current ?? '?'} abandoned=${c.abandoned ?? '?'} | continuity=${m.continuity ?? '?'}`));
    if (m.campaigns.length) out.push(say('white', ` CAMPAIGN AGENTS: ${m.campaigns.map((x) => `${x.id}=${x.status}`).join(' | ')}`));
  }

  out.push(paint('cyan', bar));
  // What matters first, so a narrow window cannot clip it off.
  out.push(say('yellow', ` READ-ONLY: this viewer starts nothing. Alpha's agents: its Agent Manager on ${managerAt} | tunnel work: coordinator leases`));
  if (view.refreshSeconds) out.push(say('gray', ` refresh ${view.refreshSeconds}s | manager read every ${view.managerEverySeconds}s | Ctrl+C closes`));
  return out.join('\n');
}

// ------------------------------------------------------------------ reading

export function createClient({ host, token, timeoutMs = 15_000 }) {
  const call = async (path, { method = 'GET', body } = {}) =>
    (await fetchJson(`${host}${path}`, { method, body, token, timeoutMs })).body;
  return {
    agents: () => call('/agents'),
    leased: () => call('/tasks?limit=100&status=leased'),
    task: (id) => call(`/tasks/${encodeURIComponent(id)}`),
    askManager: () => call('/tasks', { method: 'POST', body: { type: MANAGER_TYPE, payload: {} } }),
  };
}

/** A manager request has finished (or vanished): keep its answer, or say why there is none. */
function settle(state, task, agents) {
  state.inFlightId = null;
  if (task?.status === 'succeeded' && task.result) {
    const holder = agents.find((a) => a.id === task.agentId);
    state.manager = { summary: task.result, agentName: holder?.name ?? null, readAt: Date.now() };
  } else if (task) {
    // The last good snapshot stays on screen, with its age; this says why it was not refreshed.
    state.manager = { ...state.manager, note: `the last read ${task.status}: ${task.error?.message ?? 'no detail'}` };
  }
}

/** One pass: read the coordinator, and move the single manager request along. */
export async function collect(client, state, { now = Date.now(), managerEveryMs = 60_000, waitMs = 0 } = {}) {
  const view = { coordinator: state.host, viewer: hostname(), machines: state.machines, agents: [], leases: [] };
  try {
    view.agents = (await client.agents()).agents ?? [];
    view.leases = (await client.leased()).tasks ?? [];
  } catch (error) {
    view.error = error.message;
    view.manager = state.manager;
    return view;
  }

  // A request still out is checked, never re-sent: the next one waits for it.
  if (state.inFlightId) {
    const task = await client.task(state.inFlightId).catch(() => null);
    if (!task || TERMINAL.has(task.status)) settle(state, task, view.agents);
  }
  if (managerFetchDue(state, view.agents, now, managerEveryMs)) {
    const queued = await client.askManager().catch(() => null);
    state.lastAskedAt = now;
    if (queued?.id) state.inFlightId = queued.id;
    // --once waits for its single answer instead of leaving it for a next pass.
    const deadline = Date.now() + waitMs;
    while (state.inFlightId && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      const task = await client.task(state.inFlightId).catch(() => null);
      if (task && TERMINAL.has(task.status)) settle(state, task, view.agents);
    }
  } else if (!state.manager && !state.inFlightId) {
    state.manager = {
      note: `${MANAGER_TYPE} not offered: add agent-manager-status to ALPHA_EXTRA_HANDLERS where Alpha runs, restart that agent`,
    };
  }
  view.manager = state.manager;
  return view;
}

// ------------------------------------------------------------------ main

async function main(argv) {
  loadEnv();
  const { values } = parseArgs({
    args: argv,
    options: {
      once: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      refresh: { type: 'string', default: '15' },
      'manager-every': { type: 'string', default: '60' },
      machines: { type: 'string', default: process.env.ALPHA_FLEET_MACHINES ?? '' },
    },
  });
  const host = (process.env.ALPHA_HOST_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const token = process.env.ALPHA_ADMIN_TOKEN ?? process.env.ALPHA_REPORT_TOKEN ?? loadSession(host)?.token;
  if (!token) {
    process.stderr.write('No credential: set ALPHA_ADMIN_TOKEN or ALPHA_REPORT_TOKEN, or run `node src/admin/run.js login` once.\n');
    return 1;
  }
  const refresh = Math.max(2, Number.parseInt(values.refresh, 10) || 15);
  const managerEvery = Math.max(15, Number.parseInt(values['manager-every'], 10) || 60);
  const client = createClient({ host, token });
  const state = { host, machines: parseMachines(values.machines), inFlightId: null, lastAskedAt: 0, manager: null };

  if (values.once) {
    const view = await collect(client, state, { managerEveryMs: managerEvery * 1000, waitMs: 30_000 });
    if (values.json) {
      process.stdout.write(`${JSON.stringify({ ...view, machines: Object.fromEntries(view.machines) }, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderFrame(view, { width: process.stdout.columns ?? 132, color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR })}\n`);
    }
    return view.error ? 1 : 0;
  }

  let stopping = false;
  process.on('SIGINT', () => {
    stopping = true;
  });
  while (!stopping) {
    const view = await collect(client, state, { managerEveryMs: managerEvery * 1000 });
    view.refreshSeconds = refresh;
    view.managerEverySeconds = managerEvery;
    const frame = renderFrame(view, { width: process.stdout.columns ?? 132, color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR });
    process.stdout.write(`${process.stdout.isTTY ? '\x1b[2J\x1b[H' : ''}${frame}\n`);
    // Not unref'd: this wait is the console's whole job between frames.
    await new Promise((r) => setTimeout(r, refresh * 1000));
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`fleet-agents: ${error.message}\n`);
      process.exitCode = 1;
    },
  );
}

// One console of every agent, on any machine, that starts nothing.
//
// Alpha's Agent Manager is the authority over Alpha's agents and the
// coordinator is the authority over tunnel work. The owner wanted to see both
// laptops' agents from either laptop, and to be sure two managers could not do
// the same work twice or restart each other in a loop. So the second laptop
// gets a viewer, not a manager, and these tests pin the two things that make
// it one: what it draws, and that the only thing it ever sends is a single
// read-only status request, at most one at a time, and only when some agent
// can answer it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  MANAGER_TYPE,
  fit,
  managerFetchDue,
  parseMachines,
  renderFrame,
} from '../scripts/fleet-agents.mjs';
import * as managerHandler from '../src/agent/handlers/agent-manager-status.js';
import { summarize } from '../src/agent/handlers/agent-manager-status.js';
import { TunnelAgent } from '../src/agent/agent.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';
import { createHost } from '../src/host/server.js';
import { fetchJson } from '../src/common/http.js';
import { managerSnapshot } from './fixtures/manager-status.js';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEWER = join(ROOT, 'scripts', 'fleet-agents.mjs');
const TOKEN = 'test-token-that-is-long-enough';
const IDLE_LOAD = { snapshot: () => ({ cpus: 1, busy: 0, loadAverage1: 0, loadFactor: 0 }) };

const agent = (name, extra = {}) => ({
  id: `agent_${name}`,
  name,
  version: '1.7.0',
  capabilities: ['echo', 'sysinfo'],
  loadFactor: 0.2,
  availableBytes: 2 * 1024 ** 3,
  inFlight: 0,
  idleMs: 3_000,
  stale: false,
  ...extra,
});

// ------------------------------------------------------------------ planning

test('it asks the manager only when someone can answer, and never twice at once', () => {
  const offering = [agent('worker1', { capabilities: ['alpha.coordination', MANAGER_TYPE] })];
  const nobody = [agent('host')];
  const now = 1_000_000;

  assert.equal(managerFetchDue({ inFlightId: null, lastAskedAt: 0 }, offering, now, 60_000), true);
  // A task nobody can take would sit queued, and the next pass would queue another.
  assert.equal(managerFetchDue({ inFlightId: null, lastAskedAt: 0 }, nobody, now, 60_000), false);
  // A silent machine is not "someone": its long poll is not coming back.
  const silent = [agent('worker1', { capabilities: [MANAGER_TYPE], stale: true })];
  assert.equal(managerFetchDue({ inFlightId: null, lastAskedAt: 0 }, silent, now, 60_000), false);
  // One out already: wait for it rather than add a second.
  assert.equal(managerFetchDue({ inFlightId: 'task_1', lastAskedAt: 0 }, offering, now, 60_000), false);
  // And not sooner than the interval.
  assert.equal(managerFetchDue({ inFlightId: null, lastAskedAt: now - 10_000 }, offering, now, 60_000), false);
  assert.equal(managerFetchDue({ inFlightId: null, lastAskedAt: now - 60_000 }, offering, now, 60_000), true);
});

test('--machines says which machine each tunnel agent is on', () => {
  const map = parseMachines('host=laptop-gj8dfmlk, worker1=DESKTOP-41HPLCN,broken,=x');
  assert.equal(map.get('host'), 'laptop-gj8dfmlk');
  assert.equal(map.get('worker1'), 'desktop-41hplcn');
  assert.equal(map.size, 2);
});

// ------------------------------------------------------------------ drawing

function view(overrides = {}) {
  const now = Date.parse('2026-10-06T20:07:16Z');
  return {
    now,
    view: {
      coordinator: 'http://127.0.0.1:8787',
      viewer: 'LAPTOP-GJ8DFMLK',
      machines: parseMachines('host=laptop-gj8dfmlk,worker1=desktop-41hplcn'),
      agents: [agent('host'), agent('worker1', { capabilities: [MANAGER_TYPE], loadFactor: null })],
      leases: [{ id: 'task_a', type: 'alpha.music', agentId: 'agent_host' }],
      manager: {
        summary: summarize(managerSnapshot({ generatedAt: '2026-10-06T20:07:00Z' }), { now, machine: 'DESKTOP-41HPLCN' }),
        agentName: 'worker1',
        readAt: now,
      },
      ...overrides,
    },
  };
}

test('one frame shows both laptops, the tunnel agents beside them, and Alpha\'s agents', () => {
  const { view: v, now } = view();
  const frame = renderFrame(v, { width: 132, now });

  assert.match(frame, /READ-ONLY VIEWER on LAPTOP-GJ8DFMLK/);
  assert.match(frame, /manager on DESKTOP-41HPLCN: snapshot 16s old \|/);
  // The manager's devices, each with the tunnel agent on that machine.
  assert.match(frame, /ONLINE  Main Laptop VyoS/);
  assert.match(frame, /tunnel: worker1 run=0 cpu=- /, 'unknown load is "-", never 0%');
  assert.match(frame, /tunnel: host run=0 cpu=20%/);
  // Tunnel work, with who holds the lease.
  assert.match(frame, /leased: alpha\.music/);
  // Alpha's agents and the assistant's advice, as the manager's console has them.
  assert.match(frame, /\* alpha-local/);
  assert.match(frame, /RECEIPT-FRESH pid=12616/);
  assert.match(frame, /01 \[HIGH\] Clear 'incomplete'/);
  assert.match(frame, /CLAIMS records=53 current=0 abandoned=53/);
  assert.match(frame, /READ-ONLY: this viewer starts nothing/);
});

test('no line runs past the window, at any width', () => {
  const { view: v, now } = view();
  for (const width of [80, 100, 132, 200]) {
    for (const line of renderFrame(v, { width, now }).split('\n')) {
      assert.ok(line.length <= width, `width ${width}: ${line.length} chars: ${line}`);
    }
  }
});

test('a snapshot the manager stopped writing is shown as that, not as a live fleet', () => {
  const { view: v } = view();
  // Read fresh, then shown five minutes later: it has aged on this side too.
  const later = Date.parse('2026-10-06T20:12:16Z');
  const frame = renderFrame(v, { width: 132, now: later });
  assert.match(frame, /\(STALE\)/);
  assert.match(frame, /Alpha's Agent Manager is not running on DESKTOP-41HPLCN/);
});

test('with no manager to read, it says how to give it one', () => {
  const { view: v, now } = view({
    manager: { note: `${MANAGER_TYPE} not offered: add agent-manager-status to ALPHA_EXTRA_HANDLERS where Alpha runs` },
  });
  const frame = renderFrame(v, { width: 132, now });
  assert.match(frame, /manager: not read/);
  assert.match(frame, /add agent-manager-status to ALPHA_EXTRA_HANDLERS/);
});

test('fit clips with ASCII dots and pads, like the manager\'s console', () => {
  assert.equal(fit('abcdef', 4), 'a...');
  assert.equal(fit('ab', 4), 'ab  ');
  assert.equal(fit(null, 3), '   ');
});

// -------------------------------------------------------------- over the wire

async function startHost() {
  const host = createHost({ token: TOKEN });
  await new Promise((resolve) => host.server.listen(0, '127.0.0.1', resolve));
  return { ...host, url: `http://127.0.0.1:${host.server.address().port}` };
}

async function waitFor(what, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function attach(t, host, name, handlers) {
  const a = new TunnelAgent({ loadSampler: IDLE_LOAD, hostUrl: host.url, token: TOKEN, name, instanceId: `inst_${name}`, handlers, pollWaitMs: 250 });
  const running = a.start();
  t.after(async () => {
    await a.stop({ drainMs: 0 });
    await running;
  });
  await waitFor(`${name} to attach`, async () => {
    const { body } = await fetchJson(`${host.url}/agents`, { token: TOKEN });
    return body.agents.some((x) => x.name === name);
  });
}

function viewer(host, ...args) {
  const env = { ...process.env, ALPHA_HOST_URL: host.url, ALPHA_ADMIN_TOKEN: TOKEN };
  delete env.ALPHA_REPO_ROOT;
  return run(process.execPath, [VIEWER, ...args], { cwd: ROOT, env, timeout: 60_000 });
}

test('over a real coordinator: it reads the manager through the agent that has it, with one task', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'alpha-root-'));
  mkdirSync(join(root, 'memory', 'local', 'agent-manager'), { recursive: true });
  writeFileSync(join(root, 'memory', 'local', 'agent-manager', 'manager-status.json'), `﻿${JSON.stringify(managerSnapshot())}`);
  const previous = process.env.ALPHA_REPO_ROOT;
  process.env.ALPHA_REPO_ROOT = root;
  t.after(() => {
    if (previous === undefined) delete process.env.ALPHA_REPO_ROOT;
    else process.env.ALPHA_REPO_ROOT = previous;
  });

  const host = await startHost();
  t.after(() => host.close());
  const withManager = new HandlerRegistry();
  assert.equal(withManager.add(managerHandler).registered, true);
  await attach(t, host, 'worker1', withManager);
  await attach(t, host, 'host', new HandlerRegistry());

  const { stdout } = await viewer(host, '--once', '--json', '--machines', 'worker1=desktop-41hplcn');
  const seen = JSON.parse(stdout);
  assert.deepEqual(seen.agents.map((a) => a.name).sort(), ['host', 'worker1']);
  assert.equal(seen.manager.agentName, 'worker1');
  assert.deepEqual(seen.manager.summary.agents.map((a) => a.id), ['manager', 'alpha-local', 'model:alpha-chat-qc-c63eb759']);

  // The whole of what it sent: one read-only task, of the one type it may send.
  const { body } = await fetchJson(`${host.url}/tasks?limit=100`, { token: TOKEN });
  assert.deepEqual(body.tasks.map((x) => x.type), [MANAGER_TYPE]);
  assert.deepEqual(body.tasks[0].payload ?? {}, {});
});

test('over a real coordinator: with nobody to answer, it queues nothing and says why', async (t) => {
  const host = await startHost();
  t.after(() => host.close());
  await attach(t, host, 'host', new HandlerRegistry());

  const { stdout } = await viewer(host, '--once', '--json');
  const seen = JSON.parse(stdout);
  assert.match(seen.manager.note, /alpha\.agent-manager\.status not offered: add agent-manager-status to ALPHA_EXTRA_HANDLERS/);

  const { body } = await fetchJson(`${host.url}/tasks?limit=100`, { token: TOKEN });
  assert.deepEqual(body.tasks, []);
});

// Alpha's Agent Manager, readable from another machine.
//
// The manager runs where Alpha runs and is the one authority over Alpha's
// agents. A second laptop wanted to see what it sees, and the HTTP route wants
// the owner's login. This handler is the read-only half: a pinned file, no
// arguments, no process. What the tests are mostly about is that it says
// "stale" when the manager has stopped, and that the PowerShell-written file
// reads correctly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import * as handler from '../src/agent/handlers/agent-manager-status.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';
import { ProtocolError } from '../src/common/protocol.js';
import { managerSnapshot } from './fixtures/manager-status.js';

const { available, rejectArguments, run, snapshotPath, summarize, type, description, SNAPSHOT } = handler;

function alphaRoot({ snapshot = managerSnapshot(), raw = null, bom = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'alpha-root-'));
  if (snapshot || raw) {
    const dir = join(root, 'memory', 'local', 'agent-manager');
    mkdirSync(dir, { recursive: true });
    // Windows PowerShell's Set-Content -Encoding utf8 writes a byte-order mark.
    writeFileSync(join(dir, 'manager-status.json'), `${bom ? '\uFEFF' : ''}${raw ?? JSON.stringify(snapshot)}`);
  }
  return root;
}

function useEnv(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

/** ALPHA_REPO_ROOT as given, and no manager override unless a test sets one. */
function useRoot(t, root, managerRoot = undefined) {
  useEnv(t, 'ALPHA_REPO_ROOT', root);
  useEnv(t, 'ALPHA_AGENT_MANAGER_ROOT', managerRoot);
}

// ------------------------------------------------------------------ contract

test('it is a read-only status read, by name and description', () => {
  assert.equal(type, 'alpha.agent-manager.status');
  assert.match(description, /read-only/i);
  assert.match(description, /no arguments/i);
});

test('it is not registered by default: it reads the filesystem and is only real where Alpha runs', () => {
  assert.equal(new HandlerRegistry().has(type), false);
});

test('the file is pinned inside ALPHA_REPO_ROOT, at the path the manager writes', (t) => {
  const root = alphaRoot();
  useRoot(t, root);
  assert.equal(snapshotPath(), resolve(root, SNAPSHOT));
  assert.equal(SNAPSHOT, 'memory/local/agent-manager/manager-status.json');
});

test('a payload is refused rather than ignored', async () => {
  rejectArguments(undefined);
  rejectArguments(null);
  rejectArguments({});
  assert.throws(() => rejectArguments({ path: 'C:/Windows/win.ini' }), ProtocolError);
  assert.throws(() => rejectArguments(['x']), /takes no payload/);
  assert.throws(() => rejectArguments('all'), /takes no payload/);
  await assert.rejects(run({ verbose: true }), /takes no arguments/);
});

// --------------------------------------------------------------- availability

test('a machine with no Alpha does not offer it', (t) => {
  useRoot(t, undefined);
  assert.equal(available().ok, false);
  assert.match(available().reason, /ALPHA_REPO_ROOT/);

  const registry = new HandlerRegistry([]);
  assert.equal(registry.add(handler).registered, false);
});

test('a machine whose Alpha runs no manager does not offer it either', (t) => {
  // The Host's records standby has an ALPHA_REPO_ROOT holding only the
  // coordination script: it must not advertise a type it would fail.
  useRoot(t, alphaRoot({ snapshot: null }));
  const check = available();
  assert.equal(check.ok, false);
  assert.match(check.reason, /no Agent Manager snapshot/);
});

test('the manager may run from a different Alpha install than the coordination log', async (t) => {
  // Worker1: the coordination log is in Alpha-1.8, the live manager in
  // VyoS-advance-tech-ai. Read from ALPHA_REPO_ROOT, the handler served a
  // week-old snapshot from the wrong install.
  const coordination = alphaRoot({
    snapshot: managerSnapshot({ generatedAt: '2026-09-29T18:02:44Z', workers: [] }),
  });
  const live = alphaRoot({ snapshot: managerSnapshot() });
  useRoot(t, coordination, live);

  assert.equal(snapshotPath(), resolve(live, SNAPSHOT));
  assert.deepEqual(available(), { ok: true });
  const result = await run({});
  assert.equal(result.stale, false);
  assert.equal(result.agentsTotal, 3);
});

test('with no manager root set, it reads ALPHA_REPO_ROOT as before', (t) => {
  const root = alphaRoot();
  useRoot(t, root, '');
  assert.equal(snapshotPath(), resolve(root, SNAPSHOT));
});

test('a machine where the manager runs offers it', (t) => {
  useRoot(t, alphaRoot());
  assert.deepEqual(available(), { ok: true });
  const registry = new HandlerRegistry([]);
  assert.equal(registry.add(handler).registered, true);
});

// ----------------------------------------------------------------- the reading

test('it reads the PowerShell-written file and keeps what the console draws', async (t) => {
  useRoot(t, alphaRoot());
  const result = await run({});

  assert.equal(result.schema, 'alpha.agent-manager.status.v3');
  assert.equal(result.machine, hostname());
  assert.equal(result.stale, false);
  assert.deepEqual(result.backend, { status: 'healthy', ready: true });
  assert.equal(result.counts.records, 59);
  assert.equal(result.counts.runtime, 25);
  assert.equal(result.devices.length, 2);
  assert.equal(result.devices[1].state, 'verified-worker');
  assert.equal(result.devices[1].heartbeatAgeSeconds, 12);
  assert.deepEqual(result.agents.map((a) => a.id), ['manager', 'alpha-local', 'model:alpha-chat-qc-c63eb759']);
  assert.equal(result.agents[1].grade, 'A');
  // A lone recommendation is written as an object; it still reads as a list of one.
  assert.equal(result.recommendations.length, 1);
  assert.equal(result.recommendations[0].priority, 'HIGH');
  assert.deepEqual(result.campaigns, [{ id: 'apps-management', status: 'error' }]);
  assert.equal(result.claims.abandoned, 53);
  // And the megabytes the console does not draw stay behind.
  assert.ok(JSON.stringify(result).length < 10_000);
  assert.ok(!('reliability_audit' in result));
});

test('a snapshot the manager stopped writing reads as stale, not as a live fleet', () => {
  const now = Date.parse('2026-10-06T20:00:00Z');
  const fresh = summarize(managerSnapshot({ generatedAt: '2026-10-06T19:59:45Z' }), { now });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.ageSeconds, 15);

  const old = summarize(managerSnapshot({ generatedAt: '2026-10-06T19:50:00Z' }), { now });
  assert.equal(old.stale, true);
  assert.equal(old.ageSeconds, 600);

  // No timestamp at all is not "fresh".
  assert.equal(summarize(managerSnapshot({ generatedAt: 'not a time' }), { now }).stale, true);
});

test('a snapshot copied from another machine says whose manager wrote it', () => {
  // The fixture is Worker1's own snapshot: DESKTOP-41HPLCN is the device it marks local.
  const there = summarize(managerSnapshot(), { machine: 'desktop-41hplcn' });
  assert.equal(there.writtenOn, 'DESKTOP-41HPLCN');
  assert.equal(there.copied, false, 'hostnames compare without case');

  // The same file read on the Host after memory\\ was copied across (2026-10-08).
  const here = summarize(managerSnapshot(), { machine: 'LAPTOP-GJ8DFMLK' });
  assert.equal(here.machine, 'LAPTOP-GJ8DFMLK');
  assert.equal(here.writtenOn, 'DESKTOP-41HPLCN');
  assert.equal(here.copied, true);

  // No device marked local: nothing to compare, so nothing is claimed.
  const unknown = summarize(managerSnapshot({ devices: [] }), { machine: 'LAPTOP-GJ8DFMLK' });
  assert.equal(unknown.writtenOn, null);
  assert.equal(unknown.copied, false);
});

test('long receipt text is clipped, and garbage fields do not throw', () => {
  const long = 'x'.repeat(5_000);
  const result = summarize(
    managerSnapshot({ workers: { worker_id: 'w', state: 'ATTENTION', latest_evidence: long }, devices: null, assistant: null }),
  );
  assert.equal(result.agents.length, 1);
  assert.ok(result.agents[0].work.length <= 160);
  assert.deepEqual(result.devices, []);
  assert.deepEqual(result.recommendations, []);
  assert.doesNotThrow(() => summarize(null));
  assert.doesNotThrow(() => summarize('nonsense'));
});

test('a damaged snapshot is a failure with a reason, not an empty fleet', async (t) => {
  useRoot(t, alphaRoot({ raw: '{"schema": "alpha.agent-manager.status.v3", "workers": [' }));
  await assert.rejects(run({}), (error) => error instanceof ProtocolError && error.code === 'snapshot_unreadable');
});

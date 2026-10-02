// The self-heal pass for the Alpha host.
//
// The policy (streaks, cooldown, budget, the connector gate, the rollback
// ladder) is exercised through decide() directly, because it is the part that
// must hold on a machine nobody is watching. The probes and the rollback are
// then run for real: real HTTP servers standing in for the backend, the
// frontend and the public hostname, and a real dist directory on disk. Only
// the Windows executor is replaced — by a recorder — since that half is
// schtasks and taskkill and cannot run here.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  decide,
  emptyState,
  probeAll,
  rollbackDist,
  runPass,
  snapshotLastGood,
} from '../scripts/alpha-selfheal.mjs';

const MIN = 60_000;
const ok = { ok: true, status: 200 };
const down = { ok: false, status: 0, reason: 'ECONNREFUSED' };
const config = { cooldownMs: 5 * MIN, budgetPerHour: 3, budgetPerDay: 12 };

function passes(sequence, { start = 0, step = 2 * MIN, cfg = config } = {}) {
  let state = emptyState();
  const log = [];
  sequence.forEach((probes, i) => {
    const out = decide({ config: cfg, state, probes, now: start + i * step });
    state = out.state;
    log.push(out);
  });
  return { state, log };
}

test('one failed pass is a blip, two are an outage', () => {
  const { log } = passes([
    { backend: down, frontend: ok, public: { skipped: true } },
    { backend: down, frontend: ok, public: { skipped: true } },
  ]);
  assert.deepEqual(log[0].actions, []);
  assert.deepEqual(log[1].actions.map((a) => [a.component, a.action]), [['backend', 'restart']]);
});

test('a repaired component is left alone for the cooldown', () => {
  const failing = { backend: down, frontend: ok, public: { skipped: true } };
  const { log } = passes([failing, failing, failing, failing], { step: 2 * MIN });
  const repairs = log.flatMap((l) => l.actions).filter((a) => a.component === 'backend');
  // Repaired at t=2m; t=4m and t=6m are inside the 5m cooldown.
  assert.equal(repairs.length, 1);
  const later = passes([failing, failing, failing, failing, failing], { step: 2 * MIN });
  assert.equal(later.log.flatMap((l) => l.actions).filter((a) => a.component === 'backend').length, 2);
});

test('the budget stops repairs and says so once', () => {
  const failing = { backend: down, frontend: ok, public: { skipped: true } };
  // Ten passes six minutes apart stay inside one rolling hour.
  const seq = Array.from({ length: 10 }, () => failing);
  const { log, state } = passes(seq, { step: 6 * MIN });
  const repairs = log.flatMap((l) => l.actions).filter((a) => a.component === 'backend');
  assert.equal(repairs.length, 3, 'budgetPerHour caps repairs');
  const exhausted = log.flatMap((l) => l.events).filter((e) => e.kind === 'budget-exhausted');
  assert.equal(exhausted.length, 1, 'said once, not every pass');
  assert.equal(state.components.backend.flagged, 'budget-exhausted');
});

test('recovery clears the ladder and is reported', () => {
  const failing = { backend: down, frontend: ok, public: { skipped: true } };
  const healthy = { backend: ok, frontend: ok, public: { skipped: true } };
  const { log, state } = passes([failing, failing, healthy]);
  assert.deepEqual(log[2].events.map((e) => e.kind), ['recovered']);
  assert.equal(state.components.backend.level, 0);
});

test('a frontend that survives a restart still failing gets its last-good build back', () => {
  const failing = { backend: ok, frontend: { ...down, hasLastGood: true }, public: { skipped: true } };
  const { log } = passes([failing, failing, failing, failing, failing], { step: 3 * MIN });
  const steps = log.flatMap((l) => l.actions).filter((a) => a.component === 'frontend').map((a) => a.action);
  assert.deepEqual(steps.slice(0, 2), ['restart', 'rollback']);
});

test('with no snapshot to roll back to, the second step is another restart', () => {
  const failing = { backend: ok, frontend: { ...down, hasLastGood: false }, public: { skipped: true } };
  const { log } = passes([failing, failing, failing, failing, failing], { step: 3 * MIN });
  const steps = log.flatMap((l) => l.actions).map((a) => a.action);
  assert.ok(!steps.includes('rollback'));
});

test('vite refusing the public hostname is reported, not restarted', () => {
  const blocked = { backend: ok, frontend: { ok: false, status: 403, reason: 'vite-host-blocked' }, public: { skipped: true } };
  const { log } = passes([blocked, blocked, blocked, blocked]);
  assert.deepEqual(log.flatMap((l) => l.actions), []);
  const flagged = log.flatMap((l) => l.events).filter((e) => e.kind === 'needs-person');
  assert.equal(flagged.length, 1);
  assert.match(flagged[0].detail, /allowedHosts/);
});

test('the connector is never restarted for an origin fault', () => {
  const pub502 = { ok: false, status: 502, connectorFault: true, reason: 'status 502' };
  const seq = Array.from({ length: 6 }, () => ({ backend: ok, frontend: down, public: pub502 }));
  const { log } = passes(seq, { step: 6 * MIN });
  const connector = log.flatMap((l) => l.actions).filter((a) => a.action === 'restart-connector');
  assert.equal(connector.length, 0);
  assert.ok(log.flatMap((l) => l.events).some((e) => e.reason === 'origin-not-proven-healthy'));
});

test('the connector is restarted once the origin is proven and the edge says it cannot reach it', () => {
  const pub502 = { ok: false, status: 502, connectorFault: true, reason: 'status 502' };
  const seq = Array.from({ length: 3 }, () => ({ backend: ok, frontend: ok, public: pub502, control: ok }));
  const { log } = passes(seq);
  assert.deepEqual(log[2].actions.map((a) => a.action), ['restart-connector']);
});

test('no connector restart when the host itself is off the Internet', () => {
  const pub = { ok: false, status: 0, connectorFault: false, reason: 'ENOTFOUND' };
  const seq = Array.from({ length: 4 }, () => ({ backend: ok, frontend: ok, public: pub, control: { ok: false } }));
  const { log } = passes(seq);
  assert.equal(log.flatMap((l) => l.actions).filter((a) => a.action === 'restart-connector').length, 0);
});

test('an Access redirect or a bot 403 at the edge is not a connector fault', () => {
  const seq = Array.from({ length: 4 }, () => ({ backend: ok, frontend: ok, public: { ok: true, status: 302 }, control: ok }));
  const { log } = passes(seq);
  assert.equal(log.flatMap((l) => l.actions).filter((a) => a.action === 'restart-connector').length, 0);
});

test('a frontend healthy for three passes is snapshotted, once per build', () => {
  const healthy = { backend: ok, frontend: { ...ok, fingerprint: 'build-1' }, public: { skipped: true } };
  let state = emptyState();
  const snaps = [];
  for (let i = 0; i < 6; i++) {
    const out = decide({ config, state, probes: healthy, now: i * MIN });
    state = out.state;
    for (const a of out.actions) {
      if (a.action === 'snapshot') {
        snaps.push(i);
        state.lastGoodFingerprint = a.fingerprint; // what runPass does on success
      }
    }
  }
  assert.deepEqual(snaps, [2]);
});

// --------------------------------------------------------------- real fs

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'alpha-selfheal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeDist(dir, name, body) {
  mkdirSync(join(dir, name, 'assets'), { recursive: true });
  writeFileSync(join(dir, name, 'index.html'), body);
  writeFileSync(join(dir, name, 'assets', 'app.js'), `/* ${body} */`);
}

test('rollback keeps the failed build and restores the snapshot', (t) => {
  const fe = tempDir(t);
  writeDist(fe, 'dist', '<div id="root">good</div>');
  snapshotLastGood(fe);
  writeDist(fe, 'dist', 'broken build');
  const out = rollbackDist(fe, { now: 1000 });
  assert.match(readFileSync(join(fe, 'dist', 'index.html'), 'utf8'), /good/);
  assert.match(readFileSync(join(out.keptFailedBuild, 'index.html'), 'utf8'), /broken/);
  assert.ok(existsSync(join(fe, 'dist.last-good', 'index.html')), 'the snapshot survives a rollback');
});

test('rollback keeps only the newest failed builds', (t) => {
  const fe = tempDir(t);
  writeDist(fe, 'dist', '<div id="root">good</div>');
  snapshotLastGood(fe);
  for (const n of [1000, 2000, 3000]) {
    writeDist(fe, 'dist', `broken ${n}`);
    rollbackDist(fe, { now: n, keep: 2 });
  }
  const failed = readdirSync(fe).filter((n) => n.startsWith('dist.failed-')).sort();
  assert.deepEqual(failed, ['dist.failed-2000', 'dist.failed-3000']);
});

test('rollback refuses when there is nothing to roll back to', (t) => {
  const fe = tempDir(t);
  writeDist(fe, 'dist', 'only build');
  assert.throws(() => rollbackDist(fe), /no last-good/);
  assert.match(readFileSync(join(fe, 'dist', 'index.html'), 'utf8'), /only build/, 'dist untouched');
});

// --------------------------------------------------------------- real http

function serve(t, handler) {
  return new Promise((resolvePromise) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((r) => server.close(r)));
      resolvePromise(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

test('probes send the tunnel\'s Host and recognise vite refusing it', async (t) => {
  const fe = tempDir(t);
  writeDist(fe, 'dist', '<div id="root"></div>');
  let seenHost = null;
  const frontend = await serve(t, (req, res) => {
    seenHost = req.headers.host;
    if (req.headers.host !== 'localhost') {
      res.writeHead(403).end(`Blocked request. This host ("${req.headers.host}") is not allowed.`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end('<div id="root"></div>');
  });
  const backend = await serve(t, (req, res) => res.writeHead(200).end('{"status":"ok"}'));
  const probes = await probeAll({
    backend: { url: `${backend}/health` },
    frontend: { url: `${frontend}/`, hostHeader: 'alpha-ai.uk', dir: fe },
  });
  assert.equal(seenHost, 'alpha-ai.uk');
  assert.equal(probes.backend.ok, true);
  assert.equal(probes.frontend.ok, false);
  assert.equal(probes.frontend.reason, 'vite-host-blocked');
  assert.equal(probes.public.skipped, true);
});

test('a 200 without the app in it is not healthy, and a 502 at the edge is a connector fault', async (t) => {
  const frontend = await serve(t, (req, res) => res.writeHead(200).end('<h1>Index of /</h1>'));
  const backend = await serve(t, (req, res) => res.writeHead(200).end('ok'));
  const edge = await serve(t, (req, res) => res.writeHead(502).end('Bad gateway'));
  const probes = await probeAll({
    backend: { url: `${backend}/health` },
    frontend: { url: `${frontend}/` },
    public: { url: `${edge}/`, controlUrl: `${backend}/health` },
  });
  assert.equal(probes.frontend.ok, false);
  assert.match(probes.frontend.reason, /without id="root"/);
  assert.equal(probes.public.connectorFault, true);
  assert.equal(probes.control.ok, true);
});

test('a full pass repairs, logs a line, posts, and persists its streaks', async (t) => {
  const dir = tempDir(t);
  const backend = await serve(t, (req, res) => res.writeHead(503).end('starting'));
  const frontend = await serve(t, (req, res) => res.writeHead(200).end('<div id="root"></div>'));
  const cfg = {
    stateDir: join(dir, 'state'),
    logFile: join(dir, 'state', 'selfheal.jsonl'),
    backend: { url: `${backend}/health`, task: 'Alpha Backend' },
    frontend: { url: `${frontend}/` },
  };
  const calls = [];
  const executor = { restart: async (c) => (calls.push(c), { code: 0, stdout: 'started task', stderr: '' }) };
  const posts = [];
  const post = async (m) => (posts.push(m), { posted: true });

  const first = await runPass({ config: cfg, executor, post, now: 0 });
  assert.equal(first.exitCode, 1);
  assert.deepEqual(calls, []);
  const second = await runPass({ config: cfg, executor, post, now: 2 * MIN });
  assert.deepEqual(calls, ['backend']);
  assert.equal(second.exitCode, 1);
  assert.match(posts.join('\n'), /restart backend/);

  const lines = readFileSync(cfg.logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[1].actions[0].component, 'backend');

  const dry = await runPass({ config: cfg, executor, post, now: 20 * MIN, dryRun: true });
  assert.equal(dry.record.dryRun, true);
  assert.deepEqual(calls, ['backend'], 'a dry run performs nothing');
});

test('a second pass while one runs is skipped, not doubled', async (t) => {
  const dir = tempDir(t);
  mkdirSync(join(dir, 'state'), { recursive: true });
  writeFileSync(join(dir, 'state', 'selfheal.lock'), '{}');
  const out = await runPass({
    config: { stateDir: join(dir, 'state'), backend: { url: 'http://127.0.0.1:1/' }, frontend: { url: 'http://127.0.0.1:1/' } },
    executor: {},
    now: Date.now(),
  });
  assert.match(out.skipped, /lock/);
});

test('a control URL that is down does not make a healthy Alpha failing', async (t) => {
  const dir = tempDir(t);
  const backend = await serve(t, (req, res) => res.writeHead(200).end('{"status":"ok"}'));
  const frontend = await serve(t, (req, res) => res.writeHead(200).end('<div id="root"></div>'));
  const edge = await serve(t, (req, res) => res.writeHead(200).end('<div id="root"></div>'));
  const control = await serve(t, (req, res) => res.writeHead(503).end('down'));
  const cfg = {
    stateDir: join(dir, 'state'),
    logFile: join(dir, 'state', 'selfheal.jsonl'),
    backend: { url: `${backend}/health`, task: 'Alpha Backend' },
    frontend: { url: `${frontend}/` },
    public: { url: `${edge}/`, controlUrl: `${control}/` },
  };
  const calls = [];
  const executor = { restart: async (c) => (calls.push(c), { code: 0, stdout: '', stderr: '' }) };
  for (const now of [0, 2 * MIN, 4 * MIN]) {
    const out = await runPass({ config: cfg, executor, now });
    assert.equal(out.record.probes.control.ok, false, 'the control probe still runs');
    assert.equal(out.exitCode, 0);
  }
  assert.deepEqual(calls, []);
});

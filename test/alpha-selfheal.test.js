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
import https from 'node:https';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  abandonPass,
  acquireLock,
  decide,
  emptyState,
  loadConfig,
  probeAll,
  readConfigForPass,
  request,
  retryTransient,
  copyIndexLast,
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

test('a config written by Windows PowerShell, BOM and all, loads', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'selfheal.json');
  const body = { stateDir: dir, backend: { url: 'http://127.0.0.1:8001/health' }, frontend: { url: 'https://127.0.0.1:4173/' } };
  writeFileSync(file, `\uFEFF${JSON.stringify(body)}`, 'utf8');
  assert.equal(loadConfig(file).frontend.url, 'https://127.0.0.1:4173/');
});

// Vite preview on Laptop41 serves TLS with its own certificate, and cloudflared
// is pointed at https://127.0.0.1:4173. A probe that refused the certificate
// would call a healthy frontend down and restart it every few minutes.
test('a loopback https frontend with a self-signed certificate is probed, not refused', async (t) => {
  const dir = tempDir(t);
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  } catch {
    t.skip('openssl not available to mint a test certificate');
    return;
  }
  const server = https.createServer(
    { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) },
    (req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<div id="root"></div>'),
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const backend = await serve(t, (req, res) => res.writeHead(200).end('{"status":"ok"}'));
  const probes = await probeAll({
    backend: { url: `${backend}/health` },
    frontend: { url: `https://127.0.0.1:${server.address().port}/`, hostHeader: 'alpha-ai.uk' },
  });
  assert.equal(probes.frontend.ok, true, probes.frontend.reason);
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

test('a rollback snapshot that fails says why in the log, and is tried again', async (t) => {
  const dir = tempDir(t);
  const cfg = { stateDir: join(dir, 'state'), logFile: join(dir, 'state', 'selfheal.jsonl'), backend: { url: 'http://x/' }, frontend: { url: 'http://x/' } };
  const healthy = async () => ({ backend: ok, frontend: { ...ok, fingerprint: 'build-7' }, public: { skipped: true } });
  let tries = 0;
  const executor = {
    snapshot: async () => {
      tries++;
      throw new Error("EPERM: operation not permitted, rename 'dist.last-good.tmp' -> 'dist.last-good'");
    },
  };
  for (const now of [0, 2 * MIN, 4 * MIN, 6 * MIN]) await runPass({ config: cfg, probe: healthy, executor, now });
  const lines = readFileSync(cfg.logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const snaps = lines.flatMap((l) => l.actions).filter((a) => a.action === 'snapshot');
  assert.equal(snaps.length, 2, 'not taken, so asked for again on the next pass');
  assert.equal(tries, 2);
  assert.equal(snaps[0].code, 1);
  assert.match(snaps[0].error, /EPERM: operation not permitted, rename/);
  assert.ok(lines.every((l) => l.events.length === 0), 'a snapshot is not a repair and posts nothing');
});

test('a snapshot whose rename Windows refuses for a moment is retried, and gets through', (t) => {
  const fe = tempDir(t);
  writeDist(fe, 'dist', 'build-2');
  let calls = 0;
  const waits = [];
  // EPERM twice, as a scanner holding the fresh copy would give, then through.
  const rename = (from, to) => {
    calls++;
    if (calls <= 2) throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' });
    return renameSync(from, to);
  };
  snapshotLastGood(fe, { rename, sleep: (ms) => waits.push(ms) });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [250, 500]);
  assert.match(readFileSync(join(fe, 'dist.last-good', 'index.html'), 'utf8'), /build-2/);
  assert.ok(!existsSync(join(fe, 'dist.last-good.tmp')));
});

test('a rename Windows refuses past every retry falls back to a copy, and dist is left alone', (t) => {
  const fe = tempDir(t);
  writeDist(fe, 'dist', 'build-3');
  writeDist(fe, 'dist.last-good', 'build-1');
  writeFileSync(join(fe, 'dist.last-good', 'assets', 'old.js'), 'gone');
  let calls = 0;
  const waits = [];
  // What Worker1 still gave at 04:14 UTC with the retries in place.
  const rename = (from, to) => {
    calls++;
    throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' });
  };
  const result = snapshotLastGood(fe, { rename, sleep: (ms) => waits.push(ms) });
  assert.equal(calls, 6, 'every retry is spent before falling back');
  assert.equal(waits.length, 5);
  assert.equal(result.copied, true);
  assert.match(readFileSync(join(fe, 'dist.last-good', 'index.html'), 'utf8'), /build-3/);
  assert.match(readFileSync(join(fe, 'dist.last-good', 'assets', 'app.js'), 'utf8'), /build-3/);
  assert.ok(!existsSync(join(fe, 'dist.last-good', 'assets', 'old.js')), 'nothing from the older build survives');
  assert.match(readFileSync(join(fe, 'dist', 'index.html'), 'utf8'), /build-3/, 'dist is only read');
  assert.ok(!existsSync(join(fe, 'dist.last-good.tmp')), 'the spare copy is cleared when Windows lets it go');
});

test('a rename refused for any other reason is not papered over with a copy', (t) => {
  const fe = tempDir(t);
  writeDist(fe, 'dist', 'build-4');
  const rename = () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); };
  assert.throws(() => snapshotLastGood(fe, { rename, sleep: () => {} }), /ENOSPC/);
  assert.ok(!existsSync(join(fe, 'dist.last-good', 'index.html')));
});

test('the fallback copy writes index.html last, so a copy cut short is no snapshot', (t) => {
  const fe = tempDir(t);
  writeDist(fe, 'dist', 'build-5');
  copyIndexLast(join(fe, 'dist'), join(fe, 'dist.last-good'));
  assert.deepEqual(readdirSync(join(fe, 'dist.last-good'), { recursive: true }).sort(), ['assets', join('assets', 'app.js'), 'index.html'].sort());
  // Cut short at the last step: an index.html that cannot be copied.
  const torn = join(fe, 'torn');
  writeDist(torn, 'dist', 'build-6');
  rmSync(join(torn, 'dist', 'index.html'));
  mkdirSync(join(torn, 'dist', 'index.html'));
  assert.throws(() => copyIndexLast(join(torn, 'dist'), join(torn, 'dist.last-good')));
  assert.ok(existsSync(join(torn, 'dist.last-good', 'assets', 'app.js')), 'everything else landed first');
  assert.throws(() => rollbackDist(torn, { now: 1 }), /no last-good snapshot/, 'and it reads as none');
});

test('a rename that stays refused is thrown with its own reason; other errors are not retried', () => {
  const eperm = () => { throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }); };
  let waits = 0;
  assert.throws(() => retryTransient(eperm, { attempts: 4, sleep: () => waits++ }), /EPERM/);
  assert.equal(waits, 3);
  let tries = 0;
  const missing = () => { tries++; throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }); };
  assert.throws(() => retryTransient(missing, { sleep: () => {} }), /ENOENT/);
  assert.equal(tries, 1);
});

// Chat (2026-10-08): Ollama was down on Laptop41 for over three hours while
// every other component was healthy, and nothing here looked at it.
test('chat that stays down is restarted through its own task, like the backend', () => {
  const chatDown = { backend: ok, frontend: ok, public: { skipped: true }, chat: { ok: false, status: 0, reason: 'ECONNREFUSED' } };
  const { log } = passes([chatDown, chatDown]);
  assert.deepEqual(log[0].actions, [], 'one failed pass is a blip for chat too');
  assert.deepEqual(log[1].actions.map((a) => [a.component, a.action]), [['chat', 'restart']]);
});

test('chat with no task to start it is reported to a person once, and nothing is spent on it', () => {
  const noTask = { backend: ok, frontend: ok, public: { skipped: true }, chat: { ok: false, status: 0, reason: 'no-chat-task' } };
  const { log } = passes([noTask, noTask, noTask]);
  assert.deepEqual(log.flatMap((l) => l.actions), []);
  const told = log.flatMap((l) => l.events).filter((e) => e.kind === 'needs-person' && e.component === 'chat');
  assert.equal(told.length, 1);
  assert.match(told[0].detail, /chat-task/);
});

test('a state written before chat existed still decides, and a machine without chat is unchanged', () => {
  const old = emptyState();
  delete old.components.chat;
  const out = decide({ config, state: old, probes: { backend: ok, frontend: ok, public: { skipped: true }, chat: { skipped: true } }, now: 0 });
  assert.deepEqual(out.actions, []);
  assert.equal(out.state.components.chat.failStreak, 0);
});

test('the chat probe asks the configured URL, and calls a missing task what it is', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/api/tags' ? 200 : 404, { 'content-type': 'application/json' });
    res.end('{"models":[]}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const base = { backend: { url: `http://127.0.0.1:${port}/api/tags` }, frontend: { url: `http://127.0.0.1:${port}/api/tags` } };
    let probes = await probeAll({ ...base, chat: { url: `http://127.0.0.1:${port}/api/tags`, task: 'Alpha Ollama' } });
    assert.equal(probes.chat.ok, true);
    probes = await probeAll({ ...base, chat: { url: 'http://127.0.0.1:1/api/tags' } });
    assert.equal(probes.chat.ok, false);
    assert.equal(probes.chat.reason, 'no-chat-task');
    probes = await probeAll(base);
    assert.deepEqual(probes.chat, { skipped: true });
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// A pass that cannot finish. On Laptop41 on 2026-10-09 the log stopped at
// 13:22 local and the autopilot's restart at 13:30 changed nothing: a pass that
// dies holding the lock makes every pass after it skip, silently, until the
// lock ages out. These pin the four ways that gap is closed.

const SELFHEAL = fileURLToPath(new URL('../scripts/alpha-selfheal.mjs', import.meta.url));

function hangingServer(t, onSocket) {
  return new Promise((resolvePromise) => {
    const server = http.createServer((req, res) => onSocket(req, res));
    server.listen(0, '127.0.0.1', () => {
      t.after(() => {
        server.closeAllConnections();
        return new Promise((r) => server.close(r));
      });
      resolvePromise(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function lockFile(dir, body) {
  mkdirSync(join(dir, 'state'), { recursive: true });
  writeFileSync(join(dir, 'state', 'selfheal.lock'), JSON.stringify(body));
}

test('a lock whose process is gone is taken at once, not after it ages out', (t) => {
  const dir = tempDir(t);
  lockFile(dir, { pid: 424242, at: 0 });
  const release = acquireLock(join(dir, 'state'), 10 * MIN, Date.now(), { alive: () => false });
  assert.equal(typeof release, 'function', 'the dead pass\'s lock was broken');
  assert.equal(JSON.parse(readFileSync(join(dir, 'state', 'selfheal.lock'), 'utf8')).pid, process.pid);
  release();
  assert.equal(existsSync(join(dir, 'state', 'selfheal.lock')), false);
});

test('a lock whose process still runs is held until it ages out', (t) => {
  const dir = tempDir(t);
  lockFile(dir, { pid: 424242, at: 0 });
  assert.equal(acquireLock(join(dir, 'state'), 10 * MIN, Date.now(), { alive: () => true }), null);
  // the age rule still applies to a live holder: ten minutes is a hung pass
  const later = acquireLock(join(dir, 'state'), 10 * MIN, Date.now() + 11 * MIN, { alive: () => true });
  assert.equal(typeof later, 'function');
  later();
});

test('a pass behind a dead pass\'s lock runs and writes its line', async (t) => {
  const dir = tempDir(t);
  lockFile(dir, { pid: 424242, at: 0 });
  const cfg = { stateDir: join(dir, 'state'), logFile: join(dir, 'state', 'selfheal.jsonl'), backend: { url: 'x' }, frontend: { url: 'x' } };
  const probe = async () => ({ backend: ok, frontend: { ...ok, fingerprint: null }, public: { skipped: true }, chat: { skipped: true } });
  const out = await runPass({ config: cfg, probe, executor: {}, now: Date.now(), alive: () => false });
  assert.equal(out.skipped, undefined);
  assert.equal(readFileSync(cfg.logFile, 'utf8').trim().split('\n').length, 1);
});

test('an unfinished pass writes its line, names its stage, and gives the lock back', (t) => {
  const dir = tempDir(t);
  const cfg = { stateDir: join(dir, 'state'), logFile: join(dir, 'state', 'selfheal.jsonl') };
  const release = acquireLock(cfg.stateDir, 10 * MIN, 0);
  const progress = { release, startedAt: 1_000, stage: 'restart backend', probes: { backend: down, public: { skipped: true } } };
  assert.equal(abandonPass(cfg, progress, 'still running after 240 s', 241_000), true);
  const line = JSON.parse(readFileSync(cfg.logFile, 'utf8').trim());
  assert.deepEqual(line.unfinished, { why: 'still running after 240 s', stage: 'restart backend', afterSec: 240 });
  assert.equal(line.probes.backend.ok, false, 'what was probed is kept');
  assert.equal(line.probes.public, 'skipped');
  assert.equal(existsSync(join(cfg.stateDir, 'selfheal.lock')), false);
  assert.equal(abandonPass(cfg, progress, 'again'), false, 'once only');
  assert.equal(abandonPass(cfg, { finished: true, release: () => {} }, 'done'), false, 'a finished pass is left alone');
});

test('a pass abandoned mid-repair keeps the repair on the budget', async (t) => {
  const dir = tempDir(t);
  const cfg = { stateDir: join(dir, 'state'), logFile: join(dir, 'state', 'selfheal.jsonl'), backend: { url: 'x', task: 'Alpha Backend' }, frontend: { url: 'x' } };
  const probe = async () => ({ backend: down, frontend: { ...ok, fingerprint: null }, public: { skipped: true }, chat: { skipped: true } });
  await runPass({ config: cfg, probe, executor: {}, now: 0 });
  // The second failing pass restarts the backend, and the restart never returns.
  const progress = {};
  let hung;
  const reached = new Promise((r) => { hung = r; });
  runPass({ config: cfg, probe, executor: { restart: () => (hung(), new Promise(() => {})) }, now: 2 * MIN, progress });
  await reached;
  assert.equal(progress.stage, 'restart backend');
  assert.equal(abandonPass(cfg, progress, 'still running after 240 s', 6 * MIN), true);
  const saved = JSON.parse(readFileSync(join(cfg.stateDir, 'state.json'), 'utf8'));
  assert.deepEqual(saved.components.backend.repairs, [2 * MIN], 'the hung restart is counted');
  // so the next pass is inside the cooldown and does not restart again
  const calls = [];
  await runPass({ config: cfg, probe, executor: { restart: async (c) => (calls.push(c), { code: 0, stdout: '', stderr: '' }) }, now: 4 * MIN });
  assert.deepEqual(calls, []);
});

test('a pass still running at its deadline stops itself, says where, and exits 4', async (t) => {
  const dir = tempDir(t);
  // accepts and never answers, the way a wedged backend does
  const backend = await hangingServer(t, () => {});
  const cfgPath = join(dir, 'selfheal.json');
  const cfg = {
    stateDir: join(dir, 'state'),
    logFile: join(dir, 'logs', 'selfheal.jsonl'),
    backend: { url: `${backend}/health` },
    frontend: { url: `${backend}/` },
    probeTimeoutMs: 60_000,
    passDeadlineMs: 700,
  };
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const started = Date.now();
  const res = spawnSync(process.execPath, [SELFHEAL, '--config', cfgPath], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(res.status, 4, res.stderr);
  assert.ok(Date.now() - started < 15_000);
  const line = JSON.parse(readFileSync(cfg.logFile, 'utf8').trim());
  assert.equal(line.unfinished.stage, 'probe');
  assert.match(line.unfinished.why, /still running after 1 s/);
  assert.equal(existsSync(join(cfg.stateDir, 'selfheal.lock')), false, 'the next pass is not shut out');
});

test('a process that ends with its pass unfinished says so on the way out', (t) => {
  const dir = tempDir(t);
  const cfg = { stateDir: join(dir, 'state'), logFile: join(dir, 'selfheal.jsonl'), passDeadlineMs: 60_000 };
  // A probe nothing will ever settle, and no handle left to keep the process
  // alive: Node exits with the pass half done.
  const script = `
    const m = await import(${JSON.stringify(new URL('../scripts/alpha-selfheal.mjs', import.meta.url).href)});
    const cfg = ${JSON.stringify(cfg)};
    const progress = {};
    m.guardPass(cfg, progress);
    await m.runPass({ config: cfg, probe: () => new Promise(() => {}), executor: {}, progress });
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(res.status, 4, res.stderr);
  const line = JSON.parse(readFileSync(cfg.logFile, 'utf8').trim());
  assert.equal(line.unfinished.why, 'the process ended before the pass finished');
  assert.equal(line.unfinished.stage, 'probe');
  assert.equal(existsSync(join(cfg.stateDir, 'selfheal.lock')), false);
});

test('a probe settles when the connection is cut mid-answer', async (t) => {
  const url = await hangingServer(t, (req, res) => {
    res.writeHead(200, { 'content-length': '1000' });
    res.write('<div id=');
    setTimeout(() => req.socket.destroy(), 50);
  });
  const out = await request(url, { timeoutMs: 30_000 });
  assert.equal(out.status, 0);
  assert.ok(out.error);
});

test('a probe is bounded as a whole, not only while idle', async (t) => {
  // A byte every 100 ms keeps an idle timeout from ever firing.
  const url = await hangingServer(t, (req, res) => {
    res.writeHead(200);
    const tick = setInterval(() => res.write('.'), 100);
    res.on('close', () => clearInterval(tick));
  });
  const started = Date.now();
  const out = await request(url, { timeoutMs: 600 });
  assert.ok(Date.now() - started < 5_000);
  assert.equal(out.status, 0);
  assert.match(out.error, /timeout|closed/);
});

test('a config caught half written is read again, and what still fails is written down', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'selfheal.json');
  const body = { stateDir: dir, backend: { url: 'http://127.0.0.1:8001/health' }, frontend: { url: 'https://127.0.0.1:4173/' } };
  writeFileSync(file, '{"stateDir": ');
  const cfg = readConfigForPass(file, { sleep: () => writeFileSync(file, JSON.stringify(body)) });
  assert.equal(cfg.backend.url, 'http://127.0.0.1:8001/health');
  assert.equal(existsSync(`${file}.error.json`), false);

  writeFileSync(file, '{"stateDir": ');
  assert.throws(() => readConfigForPass(file, { sleep: () => {}, now: () => 0 }));
  const error = JSON.parse(readFileSync(`${file}.error.json`, 'utf8'));
  assert.equal(error.at, '1970-01-01T00:00:00.000Z');
  assert.match(error.error, /JSON/);

  writeFileSync(file, JSON.stringify(body));
  readConfigForPass(file, { sleep: () => {} });
  assert.equal(existsSync(`${file}.error.json`), false, 'a config that reads again clears the old error');
});

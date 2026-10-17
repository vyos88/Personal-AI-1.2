import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { changedSince, decideStandby, DEFAULTS, loadStandbyConfig, probeStandby, runPass } from '../scripts/alpha-standby.mjs';

const MIN = 60_000;
const SCRIPT = fileURLToPath(new URL('../scripts/alpha-standby.mjs', import.meta.url));
const config = { ...DEFAULTS, primary: 'laptop-gj8dfmlk' };
const up = { primary: { ok: true, status: 200 }, public: { served: true, status: 200 }, control: { ok: true, status: 200 }, local: { serving: false, status: 0 } };
const hostDown = { primary: { ok: false, status: 0 }, public: { served: false, status: 530 }, control: { ok: true, status: 200 }, local: { serving: false, status: 0 } };
const standby = { role: 'standby', primary: 'laptop-gj8dfmlk' };
const covering = { role: 'covering', primary: 'laptop-gj8dfmlk' };

function passes(role, sequence, { cfg = config, state = {} } = {}) {
  const out = [];
  sequence.forEach((probes, i) => {
    const d = decideStandby({ role, state, probes, config: cfg, now: i * MIN });
    state = d.state;
    out.push(d);
  });
  return out;
}

test('the primary covers for nobody', () => {
  const d = decideStandby({ role: null, state: {}, probes: null, config, now: 0 });
  assert.equal(d.action, 'none');
  assert.match(d.why, /this machine is the primary/);
});

test('a standby covers only after the primary misses three passes and nobody serves alpha-ai.uk', () => {
  const out = passes(standby, [hostDown, hostDown, hostDown]);
  assert.deepEqual(out.map((d) => d.action), ['none', 'none', 'cover']);
  assert.match(out[1].why, /did not answer \(2 of 3\)/);
  assert.match(out[2].why, /has not answered for 3 passes and alpha-ai\.uk is down \(530\): covering/);
  // one answer in the middle starts the count again: a restart is not an outage
  assert.deepEqual(passes(standby, [hostDown, hostDown, up, hostDown, hostDown]).map((d) => d.action), Array(5).fill('none'));
});

test('a standby does not cover from its own broken link, or while alpha-ai.uk is served', () => {
  const offline = { ...hostDown, control: { ok: false, status: 0 } };
  const last = passes(standby, [offline, offline, offline, offline]).at(-1);
  assert.equal(last.action, 'none');
  assert.match(last.why, /this machine is the one offline, not covering/);

  // the primary is up but unseen over the tailnet: it still serves the public URL
  const unseen = { ...hostDown, public: { served: true, status: 200 } };
  const held = passes(standby, [unseen, unseen, unseen, unseen]).at(-1);
  assert.equal(held.action, 'none');
  assert.match(held.why, /alpha-ai\.uk is served \(200\): not covering, that would be two Alphas/);
});

test('covering hands back after the primary answers two passes in a row, and not before', () => {
  const out = passes(covering, [hostDown, up, hostDown, up, up]);
  assert.deepEqual(out.map((d) => d.action), ['none', 'none', 'none', 'none', 'handback']);
  assert.match(out[3].why, /answers again \(1 of 2\): handing back soon/);
  assert.match(out[4].why, /answered 2 passes in a row: handing Alpha back/);
});

test('a standby that finds Alpha serving here too stands down again, at most every ten minutes', () => {
  const twoAlphas = { ...up, local: { serving: true, status: 200 } };
  let state = {};
  const actions = [];
  for (const now of [0, 2 * MIN, 9 * MIN, 11 * MIN]) {
    const d = decideStandby({ role: standby, state, probes: twoAlphas, config, now: now + 60 * MIN });
    state = d.state;
    actions.push(d.action);
  }
  assert.deepEqual(actions, ['standdown', 'none', 'none', 'standdown']);
});

// ---------------------------------------------------------------- the pass

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'alpha-standby-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function server(t, initial) {
  const box = { status: initial, body: '' };
  return new Promise((resolvePromise) => {
    const s = http.createServer((req, res) => res.writeHead(box.status).end(box.body));
    s.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((r) => s.close(r)));
      box.url = `http://127.0.0.1:${s.address().port}/`;
      resolvePromise(box);
    });
  });
}

async function setup(t) {
  const dir = tempDir(t);
  const [primary, pub, control, local] = await Promise.all([server(t, 503), server(t, 530), server(t, 200), server(t, 503)]);
  pub.body = 'error code: 1033';
  mkdirSync(join(dir, 'memory', 'chats'), { recursive: true });
  const cfg = loadStandbyConfig(writeConfig(dir, {
    stateDir: join(dir, 'standby'),
    primary: 'laptop-gj8dfmlk',
    primaryUrl: primary.url,
    publicUrl: pub.url,
    controlUrl: control.url,
    localUrl: local.url,
    memoryDir: join(dir, 'memory'),
  }));
  const role = (r) => writeFileSync(join(dir, 'role.json'), JSON.stringify(r));
  const readRoleFile = () => (existsSync(join(dir, 'role.json')) ? JSON.parse(readFileSync(join(dir, 'role.json'), 'utf8')) : null);
  // The real moves are alpha-standdown.ps1 (tested on its own): stand-up sets
  // role.json aside, stand-down writes "standby". These do the same to the file.
  const calls = [];
  const executor = {
    cover: async () => { calls.push('cover'); rmSync(join(dir, 'role.json'), { force: true }); return { code: 0, text: 'RESULT: Alpha serves here again' }; },
    standDown: async (p) => { calls.push(`standDown ${p}`); role({ role: 'standby', primary: p }); return { code: 0, text: 'RESULT: stood down' }; },
  };
  return { dir, cfg, primary, pub, control, local, role, readRoleFile, calls, executor };
}

function writeConfig(dir, body) {
  const file = join(dir, 'standby.json');
  writeFileSync(file, `﻿${JSON.stringify(body)}`);
  return file;
}

test('the whole cycle: the primary goes down, this machine covers, the primary comes back, it hands back with what changed', async (t) => {
  const { dir, cfg, primary, pub, role, readRoleFile, calls, executor } = await setup(t);
  role({ role: 'standby', primary: 'laptop-gj8dfmlk' });
  const T0 = Date.parse('2026-10-09T18:00:00Z');

  for (let i = 0; i < 3; i++) await runPass({ config: cfg, executor, now: T0 + i * MIN });
  assert.deepEqual(calls, ['cover']);
  const cov = readRoleFile();
  assert.equal(cov.role, 'covering');
  assert.equal(cov.primary, 'laptop-gj8dfmlk');
  let status = JSON.parse(readFileSync(join(cfg.stateDir, 'status.json'), 'utf8'));
  assert.equal(status.action.action, 'cover');
  assert.match(status.why, /covering/);

  // Alpha writes while this machine covers; the hand-back counts it.
  const coveredFrom = T0 + 2 * MIN;
  writeFileSync(join(dir, 'memory', 'chats', 'new.json'), '{"x":1}');
  utimesSync(join(dir, 'memory', 'chats', 'new.json'), new Date(coveredFrom + MIN), new Date(coveredFrom + MIN));
  writeFileSync(join(dir, 'memory', 'old.json'), '{}');
  utimesSync(join(dir, 'memory', 'old.json'), new Date(T0 - 60 * MIN), new Date(T0 - 60 * MIN));

  await runPass({ config: cfg, executor, now: T0 + 3 * MIN });
  assert.deepEqual(calls, ['cover'], 'still covering while the primary is down');

  primary.status = 200;
  pub.status = 200;
  pub.body = '';
  await runPass({ config: cfg, executor, now: T0 + 4 * MIN });
  assert.deepEqual(calls, ['cover'], 'one answer is not yet a heartbeat');
  const r = await runPass({ config: cfg, executor, now: T0 + 5 * MIN });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(calls, ['cover', 'standDown laptop-gj8dfmlk']);
  assert.equal(readRoleFile().role, 'standby');
  const records = readdirSync(cfg.stateDir).filter((f) => f.startsWith('handback-'));
  assert.equal(records.length, 1);
  const handback = JSON.parse(readFileSync(join(cfg.stateDir, records[0]), 'utf8'));
  assert.equal(handback.coveredFrom, new Date(coveredFrom).toISOString());
  assert.equal(handback.changed.files, 1, 'only what changed while covering');
  assert.equal(handback.carried, false);
  status = JSON.parse(readFileSync(join(cfg.stateDir, 'status.json'), 'utf8'));
  assert.equal(status.action.action, 'handback');

  const log = readFileSync(cfg.logFile, 'utf8').trim().split('\n');
  assert.equal(log.length, 6, 'one line per pass');
});

test('a primary that is down but still served publicly is not covered for, and a refused stand-up stays standby', async (t) => {
  const { cfg, pub, role, readRoleFile, calls, executor } = await setup(t);
  role({ role: 'standby', primary: 'laptop-gj8dfmlk' });
  pub.status = 200;
  pub.body = '';
  for (let i = 0; i < 5; i++) await runPass({ config: cfg, executor, now: i * MIN });
  assert.deepEqual(calls, []);

  pub.status = 530;
  const refusing = { ...executor, cover: async () => { calls.push('cover'); return { code: 3, text: 'REFUSED: alpha-ai.uk answers 200' }; } };
  let r = await runPass({ config: cfg, executor: refusing, now: 6 * MIN });
  assert.deepEqual(calls, ['cover']);
  assert.equal(r.exitCode, 1);
  assert.equal(readRoleFile().role, 'standby', 'a refused stand-up changed nothing');

  // A cover whose connector did not start is live and unreachable: said so.
  const unreachable = { ...executor, cover: async () => ({ code: 0, text: '  CONNECTOR NOT RUNNING: cloudflared did not start a cloudflared, so alpha-ai.uk stays down\nRESULT: Alpha serves here again (backend /health 200)' }) };
  r = await runPass({ config: cfg, executor: unreachable, now: 7 * MIN });
  assert.equal(r.status.action.connector, false);
  assert.equal(readRoleFile().role, 'covering');
});

test('the primary itself runs idle passes, and probes nothing', async (t) => {
  const { cfg, calls, executor } = await setup(t);
  let probed = false;
  const r = await runPass({ config: cfg, executor, probe: async () => { probed = true; return up; }, now: 0 });
  assert.equal(probed, false);
  assert.deepEqual(calls, []);
  assert.equal(r.status.role, 'primary');
  assert.match(r.status.why, /this machine is the primary/);
});

test('Cloudflare\'s "no connector" page is nobody serving alpha-ai.uk', async (t) => {
  const { cfg, pub } = await setup(t);
  let p = await probeStandby(cfg, { needLocal: true });
  assert.equal(p.public.served, false);
  assert.equal(p.local.serving, false);
  pub.status = 200;
  pub.body = 'error code: 1033';
  p = await probeStandby(cfg, { needLocal: false });
  assert.equal(p.public.served, false, 'a 200 with the 1033 body is still no connector');
  assert.equal(p.local, null);
  pub.body = '<div id="root"></div>';
  assert.equal((await probeStandby(cfg, { needLocal: false })).public.served, true);
});

test('the count of what changed skips what is not Alpha\'s state', (t) => {
  const dir = tempDir(t);
  for (const f of ['a.json', 'local/pytest-1/x', 'local/books/b.pdf', 'k/__pycache__/c.pyc', 'local/kept.json']) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), 'xx');
  }
  const c = changedSince(dir, 0);
  assert.equal(c.files, 2);
  assert.equal(c.bytes, 4);
  assert.deepEqual(changedSince(join(dir, 'nope'), 0), { files: 0, bytes: 0, newest: null });
});

test('the command line: a missing setting is exit 3, and --status says what it watches', (t) => {
  const dir = tempDir(t);
  const bad = writeConfig(dir, { stateDir: join(dir, 's'), primary: 'x' });
  let r = spawnSync(process.execPath, [SCRIPT, '--config', bad], { encoding: 'utf8' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /config is missing primaryUrl, publicUrl, controlUrl/);
  const good = writeConfig(dir, { stateDir: join(dir, 's'), primary: 'laptop-gj8dfmlk', primaryUrl: 'http://100.93.104.24:8001/health', publicUrl: 'https://alpha-ai.uk/', controlUrl: 'https://www.cloudflare.com/cdn-cgi/trace' });
  r = spawnSync(process.execPath, [SCRIPT, '--config', good, '--status'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /role: primary \(no role\.json\)/);
  assert.match(r.stdout, /watching: laptop-gj8dfmlk at http:\/\/100\.93\.104\.24:8001\/health/);
  assert.match(r.stdout, /no pass yet/);
});

// install-alpha-standby.ps1 needs PowerShell; skipped without it.
const PWSH = process.env.PWSH || 'pwsh';
const hasPwsh = !spawnSync(PWSH, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).error;
const INSTALL = fileURLToPath(new URL('../scripts/install-alpha-standby.ps1', import.meta.url));

test('the installer writes a config the pass can read, and refuses a URL that is not a plain one', { skip: hasPwsh ? false : 'PowerShell not found (set PWSH)' }, (t) => {
  const dir = tempDir(t);
  const ops = join(dir, 'ops');
  let r = spawnSync(PWSH, ['-NoProfile', '-File', INSTALL, '-OpsDir', ops, '-AlphaRoot', join(dir, 'app', 'software'), '-ConfigOnly'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const cfg = loadStandbyConfig(join(ops, 'standby.json'));
  assert.equal(cfg.primary, 'laptop-gj8dfmlk');
  assert.equal(cfg.primaryUrl, 'http://100.93.104.24:8001/health');
  assert.equal(cfg.roleFile, join(ops, 'role.json'), 'the role the stand-down writes, beside the config');
  assert.match(cfg.memoryDir, /app[\\/]memory$/, 'memory\\ beside software\\');
  r = spawnSync(PWSH, ['-NoProfile', '-File', INSTALL, '-OpsDir', ops, '-PrimaryUrl', 'http://x/h;calc', '-ConfigOnly'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /REFUSED: -PrimaryUrl is not a plain http\(s\) URL/);
});

// Making Alpha's backend reachable from the panel, which is three settings and
// one check.
//
// The panel is an ESP32 on the house WiFi: it cannot dial 127.0.0.1 and it
// cannot dial a tailnet 100.x, so HOST, ALPHA_TRUSTED_HOSTS and
// ALPHA_PANEL_LAN_READ between them decide whether the screen is dark. Each of
// the three has kept it dark on its own, and the file they live in is the one
// that decides whether Alpha starts at all — so the editing is tested against
// real files, and the check against a real server answering the way the backend
// does.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkFeed,
  envCandidates,
  findEnvFile,
  homeAddresses,
  planEnv,
  planWrapper,
  readKey,
  restartBackend,
  waitForFeed,
} from '../scripts/fix-panel-host.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'fix-panel-host.mjs');

test('the address offered to the panel is one the panel can dial', () => {
  // 100.x is Tailscale here and Starlink's CGNAT, and the panel is on neither.
  const picked = homeAddresses({
    'Tailscale': [{ family: 4, internal: false, address: '100.101.102.103' }],
    'Wi-Fi': [{ family: 4, internal: false, address: '192.168.2.151' }],
  });
  assert.deepEqual(picked.map((entry) => entry.ip), ['192.168.2.151']);

  // A WSL or Hyper-V switch address is reachable from nothing with a screen.
  assert.deepEqual(
    homeAddresses({
      'vEthernet (WSL)': [{ family: 4, internal: false, address: '172.20.1.1' }],
      'Ethernet': [{ family: 4, internal: false, address: '192.168.2.9' }],
    }).map((entry) => entry.ip),
    ['192.168.2.9'],
  );

  // 192.168 first when there are several: that is what a home router hands out.
  assert.deepEqual(
    homeAddresses({
      'Ethernet 2': [{ family: 4, internal: false, address: '10.0.0.5' }],
      'Wi-Fi': [{ family: 4, internal: false, address: '192.168.2.151' }],
    }).map((entry) => entry.ip),
    ['192.168.2.151', '10.0.0.5'],
  );

  assert.deepEqual(homeAddresses({ 'Wi-Fi': [{ family: 4, internal: false, address: '169.254.1.1' }] }), []);
  assert.deepEqual(homeAddresses({ 'Loopback': [{ family: 4, internal: true, address: '127.0.0.1' }] }), []);
});

test('the value a key has is the first one, because that is the one read', () => {
  // run_server.py loads the file first-line-wins, and laptop41-doctor.ps1 reads
  // it the same way. Taking the last — dotenv's rule — would report a value the
  // backend never sees, so a reader of the file is confident and wrong.
  const lines = ['HOST=127.0.0.1', '# comment', 'HOST=127.0.0.1,100.1.2.3'];
  assert.deepEqual(readKey(lines, 'HOST'), { value: '127.0.0.1', count: 2 });
  assert.deepEqual(readKey(lines, 'MISSING'), { value: null, count: 0 });
  assert.deepEqual(readKey(['ALPHA_PANEL_LAN_READ="true"'], 'ALPHA_PANEL_LAN_READ'), {
    value: 'true',
    count: 1,
  });
});

test('the home address is added, and nothing that was there is taken away', () => {
  const text = [
    '# Alpha',
    'HOST=127.0.0.1,100.101.102.103',
    'ALPHA_TRUSTED_HOSTS=127.0.0.1,100.101.102.103,alpha-ai.uk',
    'ALPHA_PANEL_LAN_READ=false',
    'OTHER=keep me',
    '',
  ].join('\n');

  const plan = planEnv(text, { addresses: ['192.168.2.151'] });
  assert.equal(plan.changed, true);
  // The tailnet address stays: the rest of the fleet reaches the backend there,
  // and loopback stays because every local script does.
  assert.equal(plan.host, '127.0.0.1,100.101.102.103,192.168.2.151');
  assert.equal(plan.trusted, '127.0.0.1,100.101.102.103,alpha-ai.uk,192.168.2.151');
  assert.deepEqual(plan.added, ['192.168.2.151']);
  assert.match(plan.text, /^ALPHA_PANEL_LAN_READ=true$/m);
  assert.match(plan.text, /^OTHER=keep me$/m);
  assert.match(plan.text, /^# Alpha$/m);

  // Running it twice changes nothing the second time.
  const again = planEnv(plan.text, { addresses: ['192.168.2.151'] });
  assert.equal(again.changed, false);
});

test('loopback is put back if somebody took it out', () => {
  // A bind list without 127.0.0.1 breaks the doctor, the frontend and every
  // local script, which is a worse outage than the one being fixed.
  const plan = planEnv('HOST=100.101.102.103\n', { addresses: ['192.168.2.151'] });
  assert.equal(plan.host, '127.0.0.1,100.101.102.103,192.168.2.151');
});

test('a backend that trusts everything is not narrowed, and a missing key is not invented', () => {
  // ALPHA_TRUSTED_HOSTS absent means the default decides; writing one here
  // would quietly tighten a backend nobody asked to tighten.
  const absent = planEnv('HOST=127.0.0.1\n', { addresses: ['192.168.2.151'] });
  assert.equal(absent.trusted, null);
  assert.equal(/ALPHA_TRUSTED_HOSTS/.test(absent.text), false);

  const wildcard = planEnv('HOST=127.0.0.1\nALPHA_TRUSTED_HOSTS=*\n', { addresses: ['192.168.2.151'] });
  assert.equal(wildcard.trusted, '*');
});

test('every duplicate is rewritten, so the file cannot disagree with itself', () => {
  // Which copy the backend reads depends on the loader — first for
  // run_server.py, last under dotenv — and a file left half-updated is one that
  // looks right to whichever reader happens to agree with the editor.
  const text = 'HOST=127.0.0.1\nALPHA_PANEL_LAN_READ=false\nALPHA_PANEL_LAN_READ=false\n';
  const plan = planEnv(text, { addresses: ['192.168.2.151'] });
  assert.deepEqual(plan.duplicates, ['lan']);
  const lines = plan.text.split('\n').filter((line) => line.startsWith('ALPHA_PANEL_LAN_READ'));
  assert.deepEqual(lines, ['ALPHA_PANEL_LAN_READ=true', 'ALPHA_PANEL_LAN_READ=true']);

  // Two HOST lines that disagree: the merge starts from the one the backend
  // reads, and both end up carrying the address.
  const twoHosts = planEnv('HOST=127.0.0.1\nHOST=100.1.2.3\n', { addresses: ['192.168.1.151'] });
  assert.equal(twoHosts.host, '127.0.0.1,192.168.1.151');
  assert.deepEqual(
    twoHosts.text.split('\n').filter((line) => line.startsWith('HOST')),
    ['HOST=127.0.0.1,192.168.1.151', 'HOST=127.0.0.1,192.168.1.151'],
  );
});

test('the settings file is looked for where this backend keeps it', () => {
  // The order laptop41-doctor.ps1's EnvSetting uses. A single guessed path is
  // what made a hand-run stop at "no file at ...\\app\\.env.local" on a machine
  // whose Alpha has no app directory.
  const candidates = envCandidates('/alpha/software');
  assert.deepEqual(candidates, [
    '/alpha/software/backend/.env.local',
    '/alpha/software/.env.local',
    '/alpha/.env.local',
    '/alpha/software/backend/.env',
    '/alpha/software/.env',
    '/alpha/.env',
  ]);

  // backend/.env.local wins when both are there.
  const both = findEnvFile('/alpha/software', (path) =>
    path === '/alpha/software/backend/.env.local' || path === '/alpha/software/.env.local');
  assert.equal(both.path, '/alpha/software/backend/.env.local');

  // And it falls through the list rather than stopping at the first miss.
  assert.equal(findEnvFile('/alpha/software', (path) => path === '/alpha/.env').path, '/alpha/.env');

  const none = findEnvFile('/alpha/software', () => false);
  assert.equal(none.path, null);
  // What was tried is reported, so a wrong --alpha-root is visible.
  assert.equal(none.tried.length, 6);
});

test('a Windows file keeps its line endings', () => {
  // Written back with \n, every line of a CRLF file looks changed to git and to
  // anything watching the file.
  const plan = planEnv('HOST=127.0.0.1\r\nALPHA_PANEL_LAN_READ=false\r\n', {
    addresses: ['192.168.2.151'],
  });
  assert.ok(plan.text.includes('\r\n'));
  assert.equal(/[^\r]\n/.test(plan.text), false);
});

/** A stand-in for Alpha's backend, answering the way it does in each state. */
async function backend(t, { feedStatus = 200, body = { status: 'live' }, health = 200 } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') return res.writeHead(health).end('{}');
    if (req.url === '/panel/crowpanel/public-state') {
      return res.writeHead(feedStatus, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    }
    res.writeHead(404).end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { port: server.address().port, base: `http://127.0.0.1:${server.address().port}` };
}

test('the check is the request the panel makes, and reads the feed it gets', async (t) => {
  const live = await backend(t, { body: { status: 'live' } });
  const ok = await checkFeed(live.base);
  assert.equal(ok.ok, true);
  assert.equal(ok.feed, 200);
  assert.equal(ok.status, 'live');

  // The feed off is a 404, which is ALPHA_PANEL_LAN_READ and not the network.
  const off = await backend(t, { feedStatus: 404 });
  const missing = await checkFeed(off.base);
  assert.equal(missing.ok, false);
  assert.equal(missing.feed, 404);

  // Nothing listening is the third state, and must not look like either.
  const dead = await checkFeed('http://127.0.0.1:1', { timeoutMs: 500 });
  assert.equal(dead.ok, false);
  assert.equal(dead.health, 'unreachable');
});

test('it edits a real file, backs it up, and proves the feed from that address', async (t) => {
  const live = await backend(t, { body: { status: 'live' } });
  const dir = await mkdtemp(join(tmpdir(), 'fix-panel-host-'));
  const envPath = join(dir, '.env.local');
  await writeFile(envPath, 'HOST=127.0.0.1\nALPHA_PANEL_LAN_READ=false\nKEEP=1\n');

  const result = await new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [
        SCRIPT,
        '--env', envPath,
        // 127.0.0.1 stands in for the home address: the point under test is
        // that the check is made against the address that was published.
        '--address', '127.0.0.1',
        '--port', String(live.port),
        '--no-restart',
        '--json',
      ],
      { cwd: ROOT, timeout: 30_000 },
      (error, stdout, stderr) => resolvePromise({ code: error?.code ?? 0, stdout, stderr }),
    );
  });

  assert.equal(result.code, 0, result.stdout + result.stderr);
  const record = JSON.parse(result.stdout);
  assert.equal(record.steps.env.changed, true);
  assert.equal(record.steps.feed.ok, true);
  assert.equal(record.steps.feed.status, 'live');

  const written = await readFile(envPath, 'utf8');
  assert.match(written, /^ALPHA_PANEL_LAN_READ=true$/m);
  assert.match(written, /^KEEP=1$/m);
  // The file that decides whether Alpha starts is never edited without a copy.
  assert.equal(await readFile(`${envPath}.bak`, 'utf8'), 'HOST=127.0.0.1\nALPHA_PANEL_LAN_READ=false\nKEEP=1\n');
});

test('a dry run writes nothing, and a dark feed exits 1 saying which of the three it is', async (t) => {
  const off = await backend(t, { feedStatus: 404 });
  const dir = await mkdtemp(join(tmpdir(), 'fix-panel-host-'));
  const envPath = join(dir, '.env.local');
  const original = 'HOST=127.0.0.1\n';
  await writeFile(envPath, original);

  const dry = await new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [SCRIPT, '--env', envPath, '--address', '127.0.0.1', '--port', String(off.port), '--no-restart', '--dry-run'],
      { cwd: ROOT, timeout: 30_000 },
      (error, stdout) => resolvePromise({ code: error?.code ?? 0, stdout }),
    );
  });
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /dry run : nothing written/);
  assert.equal(await readFile(envPath, 'utf8'), original);

  const real = await new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [SCRIPT, '--env', envPath, '--address', '127.0.0.1', '--port', String(off.port), '--no-restart'],
      { cwd: ROOT, timeout: 30_000 },
      (error, stdout) => resolvePromise({ code: error?.code ?? 0, stdout }),
    );
  });
  // 404 on the feed is the deck route being off, not the network — and the
  // operator is told which, because the three failures need three answers.
  assert.equal(real.code, 1);
  assert.match(real.stdout, /is 404 — the backend started before ALPHA_PANEL_LAN_READ was true/);
});

test('no file, or no home address, is said plainly rather than guessed at', async () => {
  const missing = await new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [SCRIPT, '--env', join(tmpdir(), 'definitely-not-here', '.env.local'), '--address', '192.168.1.2', '--no-restart'],
      { cwd: ROOT, timeout: 30_000 },
      (error, stdout) => resolvePromise({ code: error?.code ?? 0, stdout }),
    );
  });
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /no file at .*\.env\.local/);
  // And with no --env, the list it searched is printed, so a wrong --alpha-root
  // is visible rather than looking like a missing file.
  const searched = await new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [SCRIPT, '--alpha-root', join(tmpdir(), 'no-alpha-here'), '--address', '192.168.1.2', '--no-restart'],
      { cwd: ROOT, timeout: 30_000 },
      (error, stdout) => resolvePromise({ code: error?.code ?? 0, stdout }),
    );
  });
  assert.equal(searched.code, 1);
  assert.match(searched.stdout, /no settings file under/);
  assert.match(searched.stdout, /backend[\\/]\.env\.local/);
});

test('with --require-host, a file that sets no HOST is left alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fix-panel-host-'));
  const envPath = join(dir, '.env.local');
  const original = 'ALPHA_TRUSTED_HOSTS=127.0.0.1,100.69.243.25\nOLLAMA_MODEL=llama3.2:3b\n';
  await writeFile(envPath, original);
  const out = await new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [SCRIPT, '--env', envPath, '--address', '192.168.1.151', '--require-host'],
      { cwd: ROOT, timeout: 30_000 },
      (error, stdout) => resolvePromise({ code: error?.code ?? 0, stdout }),
    );
  });
  assert.equal(out.code, 1);
  assert.match(out.stdout, /sets no HOST, so the backend takes its addresses from somewhere else\. Nothing changed\./);
  assert.equal(await readFile(envPath, 'utf8'), original, 'no HOST invented that could drop the tailnet');
});

test('the restart frees the port the way apply-update does, and only a started task counts', () => {
  const asked = [];
  const fake = (started) => (log, options) => {
    asked.push(options.tasks);
    log('  stopped pid 42, which held port 8001');
    log(started ? "  restarted task 'Alpha Backend'" : "  could not start 'Alpha Backend': access denied");
  };
  const good = restartBackend('Alpha Backend', 8001, { restart: fake(true) });
  assert.deepEqual(asked[0], [{ task: 'Alpha Backend', port: 8001 }], 'the backend task and its port, nothing else');
  assert.equal(good.ok, true);
  assert.match(good.out, /stopped pid 42/);
  assert.equal(restartBackend('Alpha Backend', 8001, { restart: fake(false) }).ok, false);
});

test('after a restart the feed is asked until it answers, and no longer than the deadline', async () => {
  let asked = 0;
  const naps = [];
  const slowStart = async () => (++asked >= 4 ? { ok: true, feed: 200 } : { ok: false, health: 'unreachable' });
  const feed = await waitForFeed('http://192.168.1.151:8001', { check: slowStart, everyMs: 5, deadlineMs: 60_000, sleep: async (ms) => naps.push(ms) });
  assert.equal(feed.ok, true, 'a backend still loading is waited for, not reported as down');
  assert.equal(asked, 4);
  assert.deepEqual(naps, [5, 5, 5]);

  let tries = 0;
  const never = await waitForFeed('http://x', { check: async () => (tries++, { ok: false, health: 'timeout' }), everyMs: 10, deadlineMs: 5, sleep: async () => {} });
  assert.equal(never.ok, false);
  assert.equal(tries, 1, 'past the deadline it stops asking');
});

// What repair-alpha-host.ps1 writes, with the --host start-local.ps1 passed on
// the day it adopted the backend. Worker1's still said 192.168.2.151 after the
// router renumbered the house network to 192.168.1.x.
const WRAPPER = [
  '@echo off',
  'rem Written by repair-alpha-host.ps1. Re-run it instead of editing.',
  'cd /d "C:\\Alpha\\software\\backend"',
  ':loop',
  '"C:\\Alpha\\.venv\\Scripts\\python.exe" C:\\Alpha\\software\\backend\\run_server.py --host 127.0.0.1,100.69.243.25,192.168.2.151 --port 8001 >> "C:\\ProgramData\\AlphaBoot\\alpha-backend.log" 2>&1',
  'goto loop',
  '',
].join('\r\n');

test("the boot wrapper's --host gains the address, and keeps every other one", () => {
  const plan = planWrapper(WRAPPER, { addresses: ['192.168.1.151'] });
  assert.equal(plan.found, true);
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.added, ['192.168.1.151']);
  assert.equal(plan.host, '127.0.0.1,100.69.243.25,192.168.2.151,192.168.1.151');
  assert.equal(plan.text, WRAPPER.replace('192.168.2.151 --port', '192.168.2.151,192.168.1.151 --port'), 'only the list changes; line ends kept');
  assert.equal(planWrapper(plan.text, { addresses: ['192.168.1.151'] }).changed, false, 'running it twice changes nothing');

  const quoted = planWrapper('run_server.py --host "127.0.0.1, 100.69.243.25" --port 8001', { addresses: ['192.168.1.151'] });
  assert.equal(quoted.text, 'run_server.py --host "127.0.0.1,100.69.243.25,192.168.1.151" --port 8001');
  assert.equal(planWrapper('run_server.py --host=0.0.0.0 --port 8001', { addresses: ['192.168.1.151'] }).changed, false, 'every address is already served');
  const none = planWrapper('run_server.py --port 8001', { addresses: ['192.168.1.151'] });
  assert.equal(none.found, false, 'no --host: HOST decides, and the wrapper is left alone');
  assert.equal(none.changed, false);
});

test('a dry run names the wrapper change even when the env file is already right', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fix-panel-host-'));
  const envPath = join(dir, '.env.local');
  const wrapperPath = join(dir, 'run-alpha-backend.cmd');
  await writeFile(envPath, 'HOST=127.0.0.1,100.69.243.25,192.168.1.151\nALPHA_PANEL_LAN_READ=true\n');
  await writeFile(wrapperPath, WRAPPER);
  const out = await new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [SCRIPT, '--env', envPath, '--wrapper', wrapperPath, '--address', '192.168.1.151', '--require-host', '--dry-run'],
      { cwd: ROOT, timeout: 30_000 },
      (error, stdout) => resolvePromise({ code: error?.code ?? 0, stdout }),
    );
  });
  assert.equal(out.code, 0);
  assert.match(out.stdout, /HOST    : .*\(already right\)/);
  assert.match(out.stdout, /wrapper : --host 127\.0\.0\.1,100\.69\.243\.25,192\.168\.2\.151,192\.168\.1\.151 {3}\(added 192\.168\.1\.151\)/);
  assert.match(out.stdout, /dry run : nothing written/, 'the wrapper alone is a change worth a restart');
  assert.equal(await readFile(wrapperPath, 'utf8'), WRAPPER);
});


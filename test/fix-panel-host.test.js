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

import { checkFeed, homeAddresses, planEnv, readKey } from '../scripts/fix-panel-host.mjs';

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

test('the value a key has is the last one, because that is the one read', () => {
  // dotenv takes the last. A reader of the file can be sure a setting is right
  // and be wrong, which is why this is tested rather than assumed.
  const lines = ['HOST=127.0.0.1', '# comment', 'HOST=127.0.0.1,100.1.2.3'];
  assert.deepEqual(readKey(lines, 'HOST'), { value: '127.0.0.1,100.1.2.3', count: 2 });
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

test('the duplicate that counts is the one rewritten', () => {
  const text = 'HOST=127.0.0.1\nALPHA_PANEL_LAN_READ=false\nALPHA_PANEL_LAN_READ=false\n';
  const plan = planEnv(text, { addresses: ['192.168.2.151'] });
  assert.deepEqual(plan.duplicates, ['lan']);
  // The first stays false, the last — the one dotenv reads — is true.
  const lines = plan.text.split('\n').filter((line) => line.startsWith('ALPHA_PANEL_LAN_READ'));
  assert.deepEqual(lines, ['ALPHA_PANEL_LAN_READ=false', 'ALPHA_PANEL_LAN_READ=true']);
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
});

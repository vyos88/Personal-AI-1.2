// The laptop that runs Alpha when the main host stops answering.
//
// Real processes and a real HTTP endpoint that can be taken away, because the
// whole subject is what happens at the moment something disappears. The
// "Alpha" these tests start is a stub script inside a temp root — the script is
// the only part that varies on a real machine, and pinning that it must live
// inside --root is one of the things under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STANDBY = fileURLToPath(new URL('../scripts/standby-alpha.mjs', import.meta.url));

/** A stand-in for the main host's /healthz, which a test can switch off. */
async function fakeHost(t) {
  let up = true;
  const server = http.createServer((req, res) => {
    if (!up) {
      res.writeHead(503).end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    goDown: () => (up = false),
    comeBack: () => (up = true),
  };
}

/**
 * A stand-in for Alpha: it says when it started, serves a health endpoint if it
 * was given a port, and can be told to fall over or to go unhealthy without
 * exiting — which is the case a process supervisor alone would miss.
 */
const STUB_ALPHA = `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import http from 'node:http';
const log = process.env.STANDBY_TEST_LOG;
const dir = process.env.STANDBY_TEST_DIR;
appendFileSync(log, 'start\\n');
if (existsSync(dir + '/crash-once') && !existsSync(dir + '/crashed')) {
  writeFileSync(dir + '/crashed', '1');
  process.exit(1);
}
if (process.env.STANDBY_TEST_PORT) {
  http
    .createServer((req, res) => {
      if (existsSync(dir + '/unhealthy')) res.writeHead(503).end('{}');
      else res.writeHead(200).end('{"ok":true}');
    })
    .listen(Number(process.env.STANDBY_TEST_PORT), '127.0.0.1');
}
process.on('SIGTERM', () => {
  appendFileSync(log, 'stop\\n');
  process.exit(0);
});
setInterval(() => {}, 1000);
`;

function alphaRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'alpha-standby-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'start.mjs'), STUB_ALPHA);
  return dir;
}

function startStandby(t, { root, host, args = [], port = '', startArgs = ['--start', 'scripts/start.mjs'] }) {
  const dir = mkdtempSync(join(tmpdir(), 'alpha-standbylog-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logFile = join(dir, 'events.log');
  writeFileSync(logFile, '');
  const child = spawn(
    process.execPath,
    [
      STANDBY,
      '--root', root,
      ...startArgs,
      '--probe-url', `${host}/healthz`,
      '--probe-ms', '100',
      '--probe-timeout-ms', '1000',
      '--failures', '2',
      '--recover', '2',
      '--stop-timeout-ms', '3000',
      ...args,
    ],
    {
      env: {
        ...process.env,
        STANDBY_TEST_LOG: logFile,
        STANDBY_TEST_DIR: dir,
        STANDBY_TEST_PORT: port,
        ALPHA_LOG_LEVEL: 'error',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.stdout.resume();
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  t.after(() => child.kill('SIGKILL'));
  return {
    child,
    exited,
    dir,
    stderr: () => stderr,
    events: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : []),
  };
}

async function waitFor(what, predicate, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const freePort = () =>
  new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(String(port)));
    });
  });

// ------------------------------------------------------------------ failover

test('the laptop takes over when the main host stops answering, and hands back', async (t) => {
  const host = await fakeHost(t);
  const standby = startStandby(t, { root: alphaRoot(t), host: host.url });

  // Nothing happens while the host is up. That is the normal state and most of
  // this script's life.
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(standby.events(), [], 'no second Alpha while the first one is fine');

  host.goDown();
  await waitFor('the standby to promote', () => standby.events().includes('start'));

  host.comeBack();
  await waitFor('the standby to hand back', () => standby.events().includes('stop'));
  assert.deepEqual(standby.events(), ['start', 'stop']);

  standby.child.kill('SIGTERM');
  assert.equal(await standby.exited, 0);
});

test('--stay keeps the copy running after the host comes back', async (t) => {
  const host = await fakeHost(t);
  const standby = startStandby(t, { root: alphaRoot(t), host: host.url, args: ['--stay'] });

  host.goDown();
  await waitFor('the standby to promote', () => standby.events().includes('start'));
  host.comeBack();

  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(standby.events(), ['start'], 'handing back is a person’s call here');

  // And the standby still stops it on the way out, rather than orphaning it.
  standby.child.kill('SIGTERM');
  assert.equal(await standby.exited, 0);
  assert.deepEqual(standby.events(), ['start', 'stop']);
});

test('an Alpha that falls over while this machine is serving is brought back', async (t) => {
  const host = await fakeHost(t);
  const root = alphaRoot(t);
  const standby = startStandby(t, { root, host: host.url });
  writeFileSync(join(standby.dir, 'crash-once'), '1');

  host.goDown();
  await waitFor('Alpha to be started twice', () => standby.events().length >= 2);
  assert.deepEqual(standby.events(), ['start', 'start']);

  standby.child.kill('SIGTERM');
  assert.equal(await standby.exited, 0);
});

test('an Alpha that is up but not answering is restarted', async (t) => {
  const host = await fakeHost(t);
  const port = await freePort();
  const standby = startStandby(t, {
    root: alphaRoot(t),
    host: host.url,
    port,
    args: [
      '--local-url', `http://127.0.0.1:${port}/healthz`,
      '--local-grace-ms', '200',
      '--local-failures', '2',
    ],
  });

  host.goDown();
  await waitFor('the standby to promote', () => standby.events().includes('start'));

  // Alive, still holding its port, answering 503. A supervisor watching only
  // the process would call this healthy forever.
  writeFileSync(join(standby.dir, 'unhealthy'), '1');
  await waitFor('the hung Alpha to be restarted', () => standby.events().length >= 3);
  assert.deepEqual(standby.events().slice(0, 3), ['start', 'stop', 'start']);

  standby.child.kill('SIGTERM');
  assert.equal(await standby.exited, 0);
});

// ---------------------------------------------------------------- refusals

test('a start script outside the root is refused before anything runs', async (t) => {
  const host = await fakeHost(t);
  const standby = startStandby(t, {
    root: alphaRoot(t),
    host: host.url,
    startArgs: ['--start', '../../evil.sh'],
  });

  assert.equal(await standby.exited, 1);
  assert.match(standby.stderr(), /traverse upward|escapes the root/);
  assert.deepEqual(standby.events(), []);
});

test('a control URL that is down too means the fault is here, so it stays put', async (t) => {
  const host = await fakeHost(t);
  const control = await fakeHost(t);
  const standby = startStandby(t, {
    root: alphaRoot(t),
    host: host.url,
    args: ['--control-url', `${control.url}/healthz`],
  });

  // The laptop's own link has gone: everything it can name is unreachable.
  host.goDown();
  control.goDown();
  await new Promise((r) => setTimeout(r, 700));
  assert.deepEqual(standby.events(), [], 'no second Alpha on this machine’s own outage');

  // Now the control answers and the host still does not — that is a real host
  // outage, and this is what the standby is for.
  control.comeBack();
  await waitFor('the standby to promote once the fault is elsewhere', () =>
    standby.events().includes('start'),
  );

  standby.child.kill('SIGTERM');
  assert.equal(await standby.exited, 0);
});

// --------------------------------------------------- started by `npm run ...`

/**
 * The shape Alpha actually has: `npm run dev`, where npm is a wrapper and the
 * server is its *grandchild*. A supervisor that kills only what it spawned
 * leaves that grandchild holding the port, and the next start fails to bind.
 */
function npmRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'alpha-npmroot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'alpha-stub', private: true, scripts: { dev: 'node dev-server.mjs' } }),
  );
  writeFileSync(
    join(dir, 'dev-server.mjs'),
    `
import { appendFileSync } from 'node:fs';
const log = process.env.STANDBY_TEST_LOG;
appendFileSync(log, 'start\\n');
setInterval(() => appendFileSync(log, 'beat\\n'), 100);
`,
  );
  return dir;
}

test('Alpha can be started with `npm run <script>`, and stopping it stops the server it spawned', async (t) => {
  const host = await fakeHost(t);
  const standby = startStandby(t, {
    root: npmRoot(t),
    host: host.url,
    startArgs: ['--npm-script', 'dev'],
  });

  host.goDown();
  await waitFor('the dev server to be beating', () => standby.events().filter((e) => e === 'beat').length >= 2);

  standby.child.kill('SIGTERM');
  assert.equal(await standby.exited, 0);

  // npm is gone; the question is whether the node process it started is too.
  const beatsAtExit = standby.events().filter((e) => e === 'beat').length;
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(
    standby.events().filter((e) => e === 'beat').length,
    beatsAtExit,
    'the grandchild kept running and would hold the port on the next start',
  );
});

test('a script name that is not in the root package.json is refused at startup', async (t) => {
  const host = await fakeHost(t);
  const standby = startStandby(t, {
    root: npmRoot(t),
    host: host.url,
    startArgs: ['--npm-script', 'definitely-not-there'],
  });

  assert.equal(await standby.exited, 1);
  assert.match(standby.stderr(), /no "definitely-not-there" script/);
  assert.match(standby.stderr(), /found: dev/);
});

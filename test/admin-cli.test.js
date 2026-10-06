import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

import { createHost } from '../src/host/server.js';
import { AuthService } from '../src/host/auth/service.js';
import { AuthStore } from '../src/host/auth/store.js';
import { TunnelAgent } from '../src/agent/agent.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';
import { fetchJson, HttpError } from '../src/common/http.js';
import { loadSession, saveSession } from '../src/admin/session.js';

// The CLI as an operator runs it: a subprocess, against a real host, with no
// token in the environment. Driving the entrypoint is the point — the bug this
// file exists for was in the hand-off *between* commands (a session printed,
// copied, pasted onto the wrong prompt), which no in-process test reaches.

const RUN = fileURLToPath(new URL('../src/admin/run.js', import.meta.url));
const BOOTSTRAP = 'bootstrap-token-long-enough-for-tests';
const PASSWORD = 'a-perfectly-fine-password';
const EMAIL = 'owner@example.test';
const IDLE_LOAD = { snapshot: () => ({ cpus: 1, busy: 0, loadAverage1: 0, loadFactor: 0 }) };

async function startHost() {
  const auth = new AuthService({ store: new AuthStore({ path: null }), bootstrapToken: BOOTSTRAP });
  await auth.load();
  const host = createHost({ auth });
  await new Promise((resolve) => host.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${host.server.address().port}`;

  const { body: invite } = await fetchJson(`${url}/invites`, {
    method: 'POST',
    token: BOOTSTRAP,
    body: { email: EMAIL, scopes: 'admin' },
  });
  await fetchJson(`${url}/invites/redeem`, {
    method: 'POST',
    body: { token: invite.token, password: PASSWORD },
  });
  return { ...host, url };
}

/** Runs the CLI with a clean environment: no token, a private session file. */
async function cli(args, { url, sessionFile, stdin = '', env = {} }) {
  const cwd = await mkdtemp(join(tmpdir(), 'alpha-admin-cwd-'));
  const child = spawn(process.execPath, [RUN, ...args], {
    cwd, // no .env here, so nothing on the test machine leaks in
    env: {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      ALPHA_HOST_URL: url,
      ALPHA_ADMIN_SESSION_FILE: sessionFile,
      ALPHA_MUSIC_BRIDGE_URL: 'http://127.0.0.1:9', // discard port: nothing answers
      ...env,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.stdin.end(stdin);
  const code = await new Promise((resolve) => child.on('close', resolve));
  return { code, stdout, stderr };
}

const sessionPath = async () => join(await mkdtemp(join(tmpdir(), 'alpha-admin-session-')), 'session.json');

test('login saves the session, later commands use it, and the token is never printed', async (t) => {
  const host = await startHost();
  t.after(() => host.close());
  const sessionFile = await sessionPath();

  const before = await cli(['whoami'], { url: host.url, sessionFile });
  assert.equal(before.code, 1);
  assert.match(before.stderr, /Not signed in\. Run `node src\/admin\/run\.js login --email/);

  const login = await cli(['login', '--email', EMAIL], { url: host.url, sessionFile, stdin: `${PASSWORD}\n` });
  assert.equal(login.code, 0, login.stderr);
  assert.match(login.stdout, /Signed in as owner@example\.test/);
  assert.match(login.stdout, /saved: /);
  assert.doesNotMatch(login.stdout + login.stderr, /alpha_ses_/, 'the token must not be printed');

  const saved = JSON.parse(await readFile(sessionFile, 'utf8'));
  assert.equal(saved.host, host.url);
  assert.match(saved.token, /^alpha_ses_/);
  if (process.platform !== 'win32') {
    assert.equal((await stat(sessionFile)).mode & 0o777, 0o600, 'only its owner may read it');
  }

  const whoami = await cli(['whoami'], { url: host.url, sessionFile });
  assert.equal(whoami.code, 0, whoami.stderr);
  assert.match(whoami.stdout, /scopes: .*admin|scopes: \*/);
});

test('logout ends the session on the host, not just on disk', async (t) => {
  const host = await startHost();
  t.after(() => host.close());
  const sessionFile = await sessionPath();

  await cli(['login', '--email', EMAIL], { url: host.url, sessionFile, stdin: `${PASSWORD}\n` });
  const { token } = JSON.parse(await readFile(sessionFile, 'utf8'));

  const out = await cli(['logout'], { url: host.url, sessionFile });
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /the session is ended on the host/);
  assert.equal(existsSync(sessionFile), false);
  // A copy of the token taken before logout no longer works anywhere.
  await assert.rejects(
    fetchJson(`${host.url}/me`, { token }),
    (error) => error instanceof HttpError && error.status === 401,
  );
  const again = await cli(['logout'], { url: host.url, sessionFile });
  assert.equal(again.code, 0);
  assert.match(again.stdout, /nothing to end/);
});

test('a saved session that the host no longer accepts says to sign in again', async (t) => {
  const host = await startHost();
  t.after(() => host.close());
  const sessionFile = await sessionPath();
  saveSession(
    { host: host.url, token: 'alpha_ses_0123456789abcdef.not-a-real-secret', email: EMAIL, expiresAt: Date.now() + 60_000 },
    { ALPHA_ADMIN_SESSION_FILE: sessionFile },
  );
  const out = await cli(['agents'], { url: host.url, sessionFile });
  assert.equal(out.code, 1);
  assert.match(out.stderr, /saved sign-in is no longer accepted.*Run `login` again/);
});

test('a session is only used for the host that issued it, and not once expired', async () => {
  const sessionFile = await sessionPath();
  const env = { ALPHA_ADMIN_SESSION_FILE: sessionFile };
  saveSession({ host: 'http://a:1', token: 'alpha_ses_aa.bb', expiresAt: Date.now() + 60_000 }, env);
  assert.equal(loadSession('http://a:1', { env })?.token, 'alpha_ses_aa.bb');
  assert.equal(loadSession('http://b:1', { env }), null);
  assert.equal(loadSession('http://a:1', { env, now: Date.now() + 120_000 }), null);
  await writeFile(sessionFile, 'not json');
  assert.equal(loadSession('http://a:1', { env }), null);
});

test('an environment token still wins over a saved session', async (t) => {
  const host = await startHost();
  t.after(() => host.close());
  const sessionFile = await sessionPath();
  saveSession(
    { host: host.url, token: 'alpha_ses_0123456789abcdef.stale', expiresAt: Date.now() + 60_000 },
    { ALPHA_ADMIN_SESSION_FILE: sessionFile },
  );
  const out = await cli(['whoami'], { url: host.url, sessionFile, env: { ALPHA_ADMIN_TOKEN: BOOTSTRAP } });
  assert.equal(out.code, 0, out.stderr);
});

/** A worker offering codex.exec without needing Codex installed. */
function startCodexAgent(t, url, run) {
  return startAgentOffering(t, url, 'codex.exec', run);
}

/** A worker offering one task type, run by the function given. */
async function startAgentOffering(t, url, type, run) {
  // The bootstrap credential has no user of its own, so the key goes to the
  // owner created in startHost().
  const { body: users } = await fetchJson(`${url}/users`, { token: BOOTSTRAP });
  const { body: key } = await fetchJson(`${url}/keys`, {
    method: 'POST',
    token: BOOTSTRAP,
    body: { userId: users.users[0].id, scopes: 'agent', name: 'codex-laptop' },
  });
  const agent = new TunnelAgent({
    loadSampler: IDLE_LOAD,
    hostUrl: url,
    token: key.token,
    name: 'jacks-laptop',
    pollWaitMs: 500,
    handlers: new HandlerRegistry([{ type, run }]),
  });
  const running = agent.start();
  t.after(async () => {
    await agent.stop();
    await running;
  });
  for (let i = 0; i < 100; i += 1) {
    const { body } = await fetchJson(`${url}/agents`, { token: BOOTSTRAP });
    if (body.agents.some((a) => a.name === 'jacks-laptop')) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('agent never attached');
}

const codexAnswer = (output) => async () => ({ output, truncated: false, stderr: '', exitCode: 0, durationMs: 5 });

test('codex prints the answer itself, not just an exit code', async (t) => {
  const host = await startHost();
  t.after(() => host.close());
  await startCodexAgent(t, host.url, codexAnswer('thinking...\nbridged\n'));
  const out = await cli(['codex', '--agent', 'jacks-laptop', '--prompt', 'say bridged'], {
    url: host.url,
    sessionFile: await sessionPath(),
    env: { ALPHA_ADMIN_TOKEN: BOOTSTRAP },
  });
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /--- answer ---\n {2}\| thinking\.\.\.\n {2}\| bridged/);
});

test('coord --action Ack carries the event id and stage to the coordination handler', async (t) => {
  const host = await startHost();
  t.after(() => host.close());
  const seen = [];
  await startAgentOffering(t, host.url, 'alpha.coordination', async (payload) => {
    seen.push(payload);
    return { action: payload.action, exitCode: 0, stdout: 'acknowledged', stderr: '' };
  });
  const env = { ALPHA_ADMIN_TOKEN: BOOTSTRAP };
  const id = '0123456789abcdef0123456789abcdef';

  const out = await cli(
    ['coord', '--action', 'Ack', '--actor', 'claude', '--event-id', id, '--stage', 'accepted', '--message', 'accepted: on it'],
    { url: host.url, sessionFile: await sessionPath(), env },
  );
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(seen, [{ action: 'Ack', actor: 'claude', message: 'accepted: on it', eventId: id, stage: 'accepted' }]);

  const missing = await cli(['coord', '--action', 'Ack', '--actor', 'claude'], {
    url: host.url,
    sessionFile: await sessionPath(),
    env,
  });
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr + missing.stdout, /requires --event-id/);
  assert.equal(seen.length, 1, 'an Ack with no event id is never queued');
});

test('doctor lists every problem at once and exits 1', async (t) => {
  const host = await startHost();
  t.after(() => host.close());
  const out = await cli(['doctor'], {
    url: host.url,
    sessionFile: await sessionPath(),
    env: { ALPHA_ADMIN_TOKEN: BOOTSTRAP },
  });
  assert.equal(out.code, 1);
  assert.match(out.stdout, /ok {4}coordinator up/);
  assert.match(out.stdout, /ok {4}signed in as/);
  assert.match(out.stdout, /FIX {3}no agents attached/);
  assert.match(out.stdout, /FIX {3}nobody offers codex\.exec/);
  assert.match(out.stdout, /FIX {3}nobody offers alpha\.music/);
  assert.match(out.stdout, /FIX {3}music bridge not answering/);
  assert.match(out.stdout, /4 things to fix\./);
});

test('doctor says how to sign in, and when the coordinator is down, says that instead', async () => {
  const host = await startHost();
  const sessionFile = await sessionPath();
  const signedOut = await cli(['doctor'], { url: host.url, sessionFile });
  assert.equal(signedOut.code, 1);
  assert.match(signedOut.stdout, /FIX {3}not signed in\n {8}-> node src\/admin\/run\.js login --email/);
  await host.close();
  const down = await cli(['doctor'], { url: host.url, sessionFile });
  assert.equal(down.code, 1);
  assert.match(down.stdout, /FIX {3}coordinator not answering/);
});

test('doctor --agent asks Codex there and reports the reply, with the bridge up', async (t) => {
  const host = await startHost();
  t.after(() => host.close());
  await startCodexAgent(t, host.url, codexAnswer('bridged'));
  const bridge = http.createServer((req, res) => {
    res.writeHead(req.url === '/music/healthz' ? 200 : 404, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => bridge.close(resolve)));

  const out = await cli(['doctor', '--agent', 'jacks-laptop'], {
    url: host.url,
    sessionFile: await sessionPath(),
    env: { ALPHA_ADMIN_TOKEN: BOOTSTRAP, ALPHA_MUSIC_BRIDGE_URL: `http://127.0.0.1:${bridge.address().port}` },
  });
  assert.match(out.stdout, /ok {4}codex\.exec offered by jacks-laptop/);
  assert.match(out.stdout, /ok {4}music bridge answering/);
  assert.match(out.stdout, /ok {4}Codex on jacks-laptop answered in \d+s: bridged/);
  // alpha.music is still missing, and that is the only thing to fix.
  assert.match(out.stdout, /1 thing to fix\./);
  assert.equal(out.code, 1);
});

test('doctor --agent names a timed-out Codex call and the fix for it', async (t) => {
  const host = await startHost();
  t.after(() => host.close());
  const { ProtocolError } = await import('../src/common/protocol.js');
  await startCodexAgent(t, host.url, async () => {
    throw new ProtocolError('Codex did not answer within 900000 ms.', { status: 504, code: 'timeout' });
  });
  const out = await cli(['doctor', '--agent', 'jacks-laptop'], {
    url: host.url,
    sessionFile: await sessionPath(),
    env: { ALPHA_ADMIN_TOKEN: BOOTSTRAP },
  });
  assert.match(out.stdout, /FIX {3}Codex on jacks-laptop: timeout: Codex did not answer/);
  assert.match(out.stdout, /git pull and restart its agent/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHost } from '../src/host/server.js';
import { AuthService } from '../src/host/auth/service.js';
import { AuthStore } from '../src/host/auth/store.js';
import { MessageStore } from '../src/host/messages.js';
import { cloudflareReport } from '../src/host/cloudflare.js';
import { fetchJson, HttpError } from '../src/common/http.js';

const BOOTSTRAP = 'bootstrap-token-long-enough-for-tests';
const PASSWORD = 'a-perfectly-fine-password';

async function startHost() {
  const auth = new AuthService({ store: new AuthStore({ path: null }), bootstrapToken: BOOTSTRAP });
  await auth.load();
  const host = createHost({ auth, messages: new MessageStore({ path: null }) });
  await new Promise((resolve) => host.server.listen(0, '127.0.0.1', resolve));
  const { port } = host.server.address();
  return { ...host, auth, url: `http://127.0.0.1:${port}` };
}

const rejectsWith = (status) => (error) => error instanceof HttpError && error.status === status;

async function makeUser(url, { email, scopes }) {
  const { body: created } = await fetchJson(`${url}/invites`, {
    method: 'POST',
    token: BOOTSTRAP,
    body: { email, scopes },
  });
  const { body: redeemed } = await fetchJson(`${url}/invites/redeem`, {
    method: 'POST',
    body: { token: created.token, password: PASSWORD, name: email.split('@')[0] },
  });
  return { user: redeemed.user, key: redeemed.token };
}

test('GET /dashboard serves the HUD shell as HTML, unauthenticated', async () => {
  const host = await startHost();
  try {
    const res = await fetch(`${host.url}/dashboard`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.match(html, /ALPHA CONTROL ROOM/);
    assert.match(html, /CrowPanel/);
    // Root path serves the same shell.
    const root = await fetch(`${host.url}/`);
    assert.equal(root.status, 200);
  } finally {
    await host.close();
  }
});

test('GET /cloudflare/report says "not configured" when no path is set', async () => {
  const saved = process.env.ALPHA_CLOUDFLARE_REPORT;
  delete process.env.ALPHA_CLOUDFLARE_REPORT;
  const host = await startHost();
  try {
    const { body } = await fetchJson(`${host.url}/cloudflare/report`, { token: BOOTSTRAP });
    assert.equal(body.configured, false);
    assert.match(body.note, /ALPHA_CLOUDFLARE_REPORT/);
  } finally {
    await host.close();
    if (saved === undefined) delete process.env.ALPHA_CLOUDFLARE_REPORT;
    else process.env.ALPHA_CLOUDFLARE_REPORT = saved;
  }
});

test('cloudflareReport() reads a configured JSON file and carries its timestamp', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alpha-cf-'));
  const path = join(dir, 'report.json');
  await writeFile(path, JSON.stringify({ generatedAt: '2026-10-01T00:00:00.000Z', requests: 1234, status: 'ok' }));
  const out = await cloudflareReport({ path });
  assert.equal(out.configured, true);
  assert.equal(out.report.requests, 1234);
  assert.equal(out.generatedAt, '2026-10-01T00:00:00.000Z');

  const missing = await cloudflareReport({ path: join(dir, 'nope.json') });
  assert.equal(missing.configured, true);
  assert.match(missing.error, /not found/);
});

test('GET /cloudflare/report requires agents:read', async () => {
  const host = await startHost();
  try {
    // keys:write alone does not include agents:read.
    const { key } = await makeUser(host.url, { email: 'narrow@example.com', scopes: ['keys:write'] });
    await assert.rejects(
      fetchJson(`${host.url}/cloudflare/report`, { token: key }),
      rejectsWith(403),
    );
  } finally {
    await host.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHost } from '../src/host/server.js';
import { AuthService } from '../src/host/auth/service.js';
import { AuthStore } from '../src/host/auth/store.js';
import { MessageStore } from '../src/host/messages.js';
import { fetchJson, HttpError } from '../src/common/http.js';

const BOOTSTRAP = 'bootstrap-token-long-enough-for-tests';
const PASSWORD = 'a-perfectly-fine-password';

async function startHost({ messagePath = null } = {}) {
  const auth = new AuthService({
    store: new AuthStore({ path: null }),
    bootstrapToken: BOOTSTRAP,
  });
  await auth.load();

  const host = createHost({ auth, messages: new MessageStore({ path: messagePath }) });
  await new Promise((resolve) => host.server.listen(0, '127.0.0.1', resolve));
  const { port } = host.server.address();
  return { ...host, auth, url: `http://127.0.0.1:${port}` };
}

const call = (url, path, opts = {}) => fetchJson(`${url}${path}`, opts);

const rejectsWith = (status) => (error) => error instanceof HttpError && error.status === status;

/** Creates a user with the given scopes, returning their id and API key. */
async function makeUser(url, { email, scopes }) {
  const { body: created } = await call(url, '/invites', {
    method: 'POST',
    token: BOOTSTRAP,
    body: { email, scopes },
  });
  const { body: redeemed } = await call(url, '/invites/redeem', {
    method: 'POST',
    body: { token: created.token, password: PASSWORD, name: email.split('@')[0] },
  });
  return { user: redeemed.user, key: redeemed.token };
}

test('a fresh host seeds a welcome note for jack, from alpha', async () => {
  const host = await startHost();
  try {
    const { body } = await call(host.url, '/messages/jack', { token: BOOTSTRAP });
    assert.equal(body.recipient, 'jack');
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].to, 'jack');
    assert.equal(body.messages[0].from, 'alpha');
    assert.equal(body.messages[0].read, false);
    assert.match(body.messages[0].body, /jack/i);
  } finally {
    await host.close();
  }
});

test('recipient names are case-insensitive', async () => {
  const host = await startHost();
  try {
    await call(host.url, '/messages', {
      method: 'POST',
      token: BOOTSTRAP,
      body: { to: 'Jack', subject: 'Hi', body: 'second note' },
    });
    const { body } = await call(host.url, '/messages/jack', { token: BOOTSTRAP });
    assert.equal(body.messages.length, 2);
    // Newest first.
    assert.equal(body.messages[0].subject, 'Hi');
  } finally {
    await host.close();
  }
});

test('writing a note requires users:write', async () => {
  const host = await startHost();
  try {
    const { key } = await makeUser(host.url, { email: 'viewer@example.com', scopes: 'viewer' });
    await assert.rejects(
      call(host.url, '/messages', {
        method: 'POST',
        token: key,
        body: { to: 'jack', body: 'nope' },
      }),
      rejectsWith(403),
    );
  } finally {
    await host.close();
  }
});

test('reading another inbox requires users:read, but your own never does', async () => {
  const host = await startHost();
  try {
    const { user, key } = await makeUser(host.url, { email: 'alice@example.com', scopes: 'viewer' });

    // Alpha (bootstrap/admin) writes alice a note under her own name.
    await call(host.url, '/messages', {
      method: 'POST',
      token: BOOTSTRAP,
      body: { to: user.name, subject: 'For you', body: 'hello alice' },
    });

    // Alice reads her own inbox with only viewer scopes.
    const { body: mine } = await call(host.url, '/messages', { token: key });
    assert.equal(mine.messages.length, 1);
    assert.equal(mine.unread, 1);
    assert.equal(mine.messages[0].subject, 'For you');

    // But she cannot read jack's inbox without users:read.
    await assert.rejects(call(host.url, '/messages/jack', { token: key }), rejectsWith(403));
  } finally {
    await host.close();
  }
});

test('a recipient can mark their own note read, but not anyone else\'s', async () => {
  const host = await startHost();
  try {
    const { user, key } = await makeUser(host.url, { email: 'bob@example.com', scopes: 'viewer' });
    const { body: posted } = await call(host.url, '/messages', {
      method: 'POST',
      token: BOOTSTRAP,
      body: { to: user.name, subject: 'ping', body: 'read me' },
    });

    const { body: marked } = await call(host.url, `/messages/${posted.message.id}/read`, {
      method: 'POST',
      token: key,
    });
    assert.equal(marked.message.read, true);

    // The seeded jack note is not in bob's inbox, so he cannot mark it read.
    const { body: jack } = await call(host.url, '/messages/jack', { token: BOOTSTRAP });
    await assert.rejects(
      call(host.url, `/messages/${jack.messages[0].id}/read`, { method: 'POST', token: key }),
      rejectsWith(404),
    );
  } finally {
    await host.close();
  }
});

test('messages persist across a restart, and the seed is not duplicated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alpha-messages-'));
  const messagePath = join(dir, 'messages.json');

  const first = await startHost({ messagePath });
  try {
    await call(first.url, '/messages', {
      method: 'POST',
      token: BOOTSTRAP,
      body: { to: 'jack', subject: 'persisted', body: 'still here after reboot' },
    });
  } finally {
    await first.close();
  }

  // The file is real JSON on disk.
  const onDisk = JSON.parse(await readFile(messagePath, 'utf8'));
  assert.equal(onDisk.messages.filter((m) => m.to === 'jack').length, 2);

  const second = await startHost({ messagePath });
  try {
    const { body } = await call(second.url, '/messages/jack', { token: BOOTSTRAP });
    // Still 2 — the welcome seed did not fire again on the second boot.
    assert.equal(body.messages.length, 2);
    assert.ok(body.messages.some((m) => m.subject === 'persisted'));
  } finally {
    await second.close();
  }
});

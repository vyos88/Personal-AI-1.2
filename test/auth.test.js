import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHost } from '../src/host/server.js';
import { AuthService, UserStatus } from '../src/host/auth/service.js';
import { AuthStore } from '../src/host/auth/store.js';
import { TunnelAgent } from '../src/agent/agent.js';
import { normalizeScopes, hasScope, SCOPES } from '../src/host/auth/scopes.js';
import { hashPassword, verifyPassword } from '../src/host/auth/passwords.js';
import { generateToken, parseToken, secretMatches } from '../src/host/auth/tokens.js';
import { fetchJson, HttpError } from '../src/common/http.js';

const BOOTSTRAP = 'bootstrap-token-long-enough-for-tests';
const PASSWORD = 'a-perfectly-fine-password';

async function startHost({ storePath = null } = {}) {
  const auth = new AuthService({
    store: new AuthStore({ path: storePath }),
    bootstrapToken: BOOTSTRAP,
  });
  await auth.load();

  const host = createHost({ auth });
  await new Promise((resolve) => host.server.listen(0, '127.0.0.1', resolve));
  const { port } = host.server.address();
  return { ...host, auth, url: `http://127.0.0.1:${port}` };
}

const call = (url, path, { token, ...rest } = {}) =>
  fetchJson(`${url}${path}`, { token, ...rest });

/** Creates a user by inviting and redeeming, returning their id and key. */
async function inviteAndRedeem(url, { email, scopes, token = BOOTSTRAP }) {
  const { body: created } = await call(url, '/invites', {
    method: 'POST',
    token,
    body: { email, scopes },
  });
  const { body: redeemed } = await call(url, '/invites/redeem', {
    method: 'POST',
    body: { token: created.token, password: PASSWORD },
  });
  return { invite: created.invite, inviteToken: created.token, user: redeemed.user, key: redeemed.token };
}

const rejectsWith = (status) => (error) => error instanceof HttpError && error.status === status;

// ---------------------------------------------------------------- primitives

test('password hashing round-trips and rejects wrong input', async () => {
  const stored = await hashPassword(PASSWORD);
  assert.match(stored, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword(PASSWORD, stored), true);
  assert.equal(await verifyPassword('not-the-password', stored), false);
  // A malformed record must fail closed rather than throw.
  assert.equal(await verifyPassword(PASSWORD, 'garbage'), false);
  assert.equal(await verifyPassword(PASSWORD, 'scrypt$1$1$1$$'), false);
});

test('password hashes are salted, so equal passwords store differently', async () => {
  const a = await hashPassword(PASSWORD);
  const b = await hashPassword(PASSWORD);
  assert.notEqual(a, b);
  assert.equal(await verifyPassword(PASSWORD, a), true);
  assert.equal(await verifyPassword(PASSWORD, b), true);
});

test('short passwords are refused', async () => {
  await assert.rejects(() => hashPassword('short'), /at least 12 characters/);
});

test('tokens parse, verify, and never store their secret', () => {
  const { token, id, secretHash } = generateToken('key');
  const parsed = parseToken(token);

  assert.equal(parsed.kind, 'key');
  assert.equal(parsed.id, id);
  assert.equal(secretMatches(parsed.secret, secretHash), true);
  assert.equal(secretMatches('wrong-secret', secretHash), false);
  // The stored hash must not contain the secret itself.
  assert.ok(!secretHash.includes(parsed.secret));
  assert.equal(parseToken('not-a-token'), null);
  assert.equal(parseToken(''), null);
});

test('scope normalization handles presets, "*", and rejects unknowns', () => {
  assert.deepEqual(normalizeScopes('*'), [SCOPES.ADMIN]);
  assert.deepEqual(normalizeScopes(['admin', 'tasks:read']), [SCOPES.ADMIN]);
  assert.deepEqual(normalizeScopes('agent'), [SCOPES.AGENT_CONNECT]);
  assert.deepEqual(normalizeScopes('tasks:read,tasks:write').sort(), ['tasks:read', 'tasks:write']);
  assert.throws(() => normalizeScopes(['nope']), /unknown scope/);
  assert.throws(() => normalizeScopes([]), /non-empty/);
});

test('admin implies every scope', () => {
  assert.equal(hasScope([SCOPES.ADMIN], SCOPES.USERS_WRITE), true);
  assert.equal(hasScope([SCOPES.TASKS_READ], SCOPES.USERS_WRITE), false);
  assert.equal(hasScope([SCOPES.TASKS_READ], SCOPES.TASKS_READ), true);
});

// ------------------------------------------------------------- invite flow

test('an invite can be created, previewed, and redeemed exactly once', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  const { body: created } = await call(host.url, '/invites', {
    method: 'POST',
    token: BOOTSTRAP,
    body: { email: 'Newcomer@Example.com', scopes: 'operator' },
  });

  assert.equal(created.invite.email, 'newcomer@example.com'); // normalized
  assert.equal(created.invite.status, 'pending');
  assert.ok(created.token.startsWith('alpha_inv_'));
  assert.ok(created.redeemUrl.includes('/invites/redeem'));

  // Preview needs no credential — the token is the credential.
  const { body: preview } = await call(host.url, '/invites/preview', {
    method: 'POST',
    body: { token: created.token },
  });
  assert.equal(preview.email, 'newcomer@example.com');
  assert.deepEqual(preview.scopes, ['agents:read', 'keys:write', 'tasks:cancel', 'tasks:read', 'tasks:write']);

  const { body: redeemed } = await call(host.url, '/invites/redeem', {
    method: 'POST',
    body: { token: created.token, password: PASSWORD, name: 'Newcomer' },
  });
  assert.equal(redeemed.user.email, 'newcomer@example.com');
  assert.equal(redeemed.user.status, UserStatus.ACTIVE);
  assert.ok(redeemed.token.startsWith('alpha_key_'));

  // Single use: a second redemption of the same token must fail.
  await assert.rejects(
    () => call(host.url, '/invites/redeem', {
      method: 'POST',
      body: { token: created.token, password: PASSWORD },
    }),
    rejectsWith(410),
  );
});

test('the invite plaintext token is never persisted', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'alpha-auth-'));
  const storePath = join(dir, 'auth.json');
  const host = await startHost({ storePath });
  t.after(() => host.close());

  const { body: created } = await call(host.url, '/invites', {
    method: 'POST',
    token: BOOTSTRAP,
    body: { email: 'secret@example.com', scopes: 'viewer' },
  });

  const raw = await readFile(storePath, 'utf8');
  const secret = parseToken(created.token).secret;
  assert.ok(!raw.includes(secret), 'invite secret must not appear in the store');
  assert.ok(!raw.includes(created.token), 'invite token must not appear in the store');
});

test('a redeemed password is never persisted in plaintext', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'alpha-auth-'));
  const storePath = join(dir, 'auth.json');
  const host = await startHost({ storePath });
  t.after(() => host.close());

  await inviteAndRedeem(host.url, { email: 'pw@example.com', scopes: 'viewer' });

  const raw = await readFile(storePath, 'utf8');
  assert.ok(!raw.includes(PASSWORD), 'password must not appear in the store');
  assert.ok(raw.includes('scrypt$'), 'a scrypt hash should be stored instead');
});

test('an expired invite cannot be redeemed', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  const { body: created } = await call(host.url, '/invites', {
    method: 'POST',
    token: BOOTSTRAP,
    body: { email: 'slow@example.com', scopes: 'viewer', expiresInMs: 1 },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(
    () => call(host.url, '/invites/redeem', {
      method: 'POST',
      body: { token: created.token, password: PASSWORD },
    }),
    rejectsWith(410),
  );
});

test('a revoked invite cannot be redeemed', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  const { body: created } = await call(host.url, '/invites', {
    method: 'POST',
    token: BOOTSTRAP,
    body: { email: 'revoked@example.com', scopes: 'viewer' },
  });
  await call(host.url, `/invites/${created.invite.id}`, { method: 'DELETE', token: BOOTSTRAP });

  await assert.rejects(
    () => call(host.url, '/invites/redeem', {
      method: 'POST',
      body: { token: created.token, password: PASSWORD },
    }),
    rejectsWith(410),
  );
});

test('a tampered invite token is rejected', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  const { body: created } = await call(host.url, '/invites', {
    method: 'POST',
    token: BOOTSTRAP,
    body: { email: 'tamper@example.com', scopes: 'viewer' },
  });

  // Same id, different secret.
  const parsed = parseToken(created.token);
  const forged = `alpha_inv_${parsed.id}.${'A'.repeat(parsed.secret.length)}`;
  await assert.rejects(
    () => call(host.url, '/invites/preview', { method: 'POST', body: { token: forged } }),
    rejectsWith(404),
  );
});

// ------------------------------------------------------------------- scopes

test('a key is confined to its scopes', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  const { key } = await inviteAndRedeem(host.url, { email: 'viewer@example.com', scopes: 'viewer' });

  // viewer has tasks:read but not tasks:write.
  const { body: tasks } = await call(host.url, '/tasks', { token: key });
  assert.deepEqual(tasks.tasks, []);

  await assert.rejects(
    () => call(host.url, '/tasks', { method: 'POST', token: key, body: { type: 'echo' } }),
    rejectsWith(403),
  );
  await assert.rejects(() => call(host.url, '/users', { token: key }), rejectsWith(403));
});

test('a non-admin cannot grant scopes it does not hold', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  // Give someone invites:write but nothing else administrative.
  const { key } = await inviteAndRedeem(host.url, {
    email: 'inviter@example.com',
    scopes: ['invites:write', 'tasks:read'],
  });

  // They may pass on tasks:read...
  const { body: ok } = await call(host.url, '/invites', {
    method: 'POST',
    token: key,
    body: { email: 'downstream@example.com', scopes: ['tasks:read'] },
  });
  assert.deepEqual(ok.invite.scopes, ['tasks:read']);

  // ...but not mint an admin, which would be a straight privilege escalation.
  await assert.rejects(
    () => call(host.url, '/invites', {
      method: 'POST',
      token: key,
      body: { email: 'escalate@example.com', scopes: 'admin' },
    }),
    rejectsWith(403),
  );
});

test('narrowing a user\'s scopes immediately narrows their existing keys', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  const { user, key } = await inviteAndRedeem(host.url, {
    email: 'narrow@example.com',
    scopes: 'operator',
  });

  // The key works for writes to begin with.
  await call(host.url, '/tasks', { method: 'POST', token: key, body: { type: 'echo' } });

  await call(host.url, `/users/${user.id}/scopes`, {
    method: 'POST',
    token: BOOTSTRAP,
    body: { scopes: ['tasks:read'] },
  });

  // Same key, no new login: the write is now refused.
  await assert.rejects(
    () => call(host.url, '/tasks', { method: 'POST', token: key, body: { type: 'echo' } }),
    rejectsWith(403),
  );
  const { body: stillReads } = await call(host.url, '/tasks', { token: key });
  assert.ok(Array.isArray(stillReads.tasks));
});

// -------------------------------------------------------------- revocation

test('disabling a user kills every key they hold at once', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  const { user, key } = await inviteAndRedeem(host.url, {
    email: 'disabled@example.com',
    scopes: 'operator',
  });

  const { body: second } = await call(host.url, '/keys', {
    method: 'POST',
    token: key,
    body: { name: 'second key' },
  });

  await call(host.url, `/users/${user.id}/status`, {
    method: 'POST',
    token: BOOTSTRAP,
    body: { status: 'disabled' },
  });

  for (const credential of [key, second.token]) {
    await assert.rejects(() => call(host.url, '/tasks', { token: credential }), rejectsWith(401));
  }

  // Re-enabling restores them — disable is a switch, not a delete.
  await call(host.url, `/users/${user.id}/status`, {
    method: 'POST',
    token: BOOTSTRAP,
    body: { status: 'active' },
  });
  const { status } = await call(host.url, '/tasks', { token: key });
  assert.equal(status, 200);
});

test('revoking one key leaves the user\'s other keys working', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  const { key } = await inviteAndRedeem(host.url, { email: 'keys@example.com', scopes: 'operator' });
  const { body: extra } = await call(host.url, '/keys', {
    method: 'POST',
    token: key,
    body: { name: 'laptop agent', scopes: ['tasks:read'] },
  });

  await call(host.url, `/keys/${extra.key.id}`, { method: 'DELETE', token: key });

  await assert.rejects(() => call(host.url, '/tasks', { token: extra.token }), rejectsWith(401));
  const { status } = await call(host.url, '/tasks', { token: key });
  assert.equal(status, 200);
});

test('an expired key stops authenticating', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  const { key } = await inviteAndRedeem(host.url, { email: 'exp@example.com', scopes: 'operator' });
  const { body: shortLived } = await call(host.url, '/keys', {
    method: 'POST',
    token: key,
    body: { name: 'brief', expiresInMs: 1 },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(() => call(host.url, '/tasks', { token: shortLived.token }), rejectsWith(401));
});

// ------------------------------------------------------------------- login

test('login issues a session and rejects a wrong password', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  await inviteAndRedeem(host.url, { email: 'login@example.com', scopes: 'operator' });

  const { body: session } = await call(host.url, '/auth/login', {
    method: 'POST',
    body: { email: 'login@example.com', password: PASSWORD },
  });
  assert.ok(session.token.startsWith('alpha_ses_'));
  assert.ok(session.expiresAt > Date.now());

  const { body: me } = await call(host.url, '/me', { token: session.token });
  assert.equal(me.label, 'login@example.com');

  await assert.rejects(
    () => call(host.url, '/auth/login', {
      method: 'POST',
      body: { email: 'login@example.com', password: 'wrong-password-here' },
    }),
    rejectsWith(401),
  );
});

test('login does not reveal whether an account exists', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  await inviteAndRedeem(host.url, { email: 'real@example.com', scopes: 'viewer' });

  const attempts = await Promise.allSettled([
    call(host.url, '/auth/login', {
      method: 'POST',
      body: { email: 'real@example.com', password: 'wrong-password-here' },
    }),
    call(host.url, '/auth/login', {
      method: 'POST',
      body: { email: 'ghost@example.com', password: 'wrong-password-here' },
    }),
  ]);

  // Same status and same message for both, so neither is distinguishable.
  const [known, unknown] = attempts.map((entry) => entry.reason);
  assert.equal(known.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(known.body.message, unknown.body.message);
});

test('changing a password revokes sessions but keeps API keys', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  const { key } = await inviteAndRedeem(host.url, { email: 'rotate@example.com', scopes: 'operator' });
  const { body: session } = await call(host.url, '/auth/login', {
    method: 'POST',
    body: { email: 'rotate@example.com', password: PASSWORD },
  });

  await call(host.url, '/me/password', {
    method: 'POST',
    token: session.token,
    body: { currentPassword: PASSWORD, newPassword: 'a-brand-new-password' },
  });

  // The session is gone...
  await assert.rejects(() => call(host.url, '/me', { token: session.token }), rejectsWith(401));
  // ...but a running agent's API key survives on purpose.
  const { status } = await call(host.url, '/tasks', { token: key });
  assert.equal(status, 200);
});

test('changing a password requires the current one', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  const { key } = await inviteAndRedeem(host.url, { email: 'pw2@example.com', scopes: 'operator' });
  await assert.rejects(
    () => call(host.url, '/me/password', {
      method: 'POST',
      token: key,
      body: { currentPassword: 'not-it-at-all', newPassword: 'another-good-password' },
    }),
    rejectsWith(403),
  );
});

// ------------------------------------------------------------- agent plane

test('an agent authenticates with a scoped key and runs work', async (t) => {
  const host = await startHost();

  const { user, key: ownerKey } = await inviteAndRedeem(host.url, {
    email: 'fleet@example.com',
    scopes: ['agent:connect', 'tasks:read', 'tasks:write', 'keys:write'],
  });
  const { body: agentKey } = await call(host.url, '/keys', {
    method: 'POST',
    token: ownerKey,
    body: { userId: user.id, name: 'laptop', scopes: 'agent' },
  });

  const agent = new TunnelAgent({
    hostUrl: host.url,
    token: agentKey.token,
    name: 'scoped-laptop',
    pollWaitMs: 1_000,
  });
  const running = agent.start();
  t.after(async () => {
    await agent.stop();
    await running;
    await host.close();
  });

  const { body: created } = await call(host.url, '/tasks', {
    method: 'POST',
    token: ownerKey,
    body: { type: 'echo', payload: { scoped: true } },
  });

  const deadline = Date.now() + 10_000;
  let finished;
  while (Date.now() < deadline) {
    const { body } = await call(host.url, `/tasks/${created.id}`, { token: ownerKey });
    if (body.status === 'succeeded' || body.status === 'failed') {
      finished = body;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(finished?.status, 'succeeded');
  assert.deepEqual(finished.result.echoed, { scoped: true });

  // The agent key alone must not be able to queue work.
  await assert.rejects(
    () => call(host.url, '/tasks', { method: 'POST', token: agentKey.token, body: { type: 'echo' } }),
    rejectsWith(403),
  );
});

test('a key without agent:connect cannot register an agent', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  const { key } = await inviteAndRedeem(host.url, { email: 'noagent@example.com', scopes: 'viewer' });

  await assert.rejects(
    () => call(host.url, '/agent/register', {
      method: 'POST',
      token: key,
      body: { protocolVersion: 1, name: 'sneaky', capabilities: ['echo'] },
    }),
    rejectsWith(403),
  );
});

// ------------------------------------------------------------- persistence

test('users, keys and invites survive a host restart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'alpha-auth-'));
  const storePath = join(dir, 'auth.json');

  const first = await startHost({ storePath });
  const { user, key } = await inviteAndRedeem(first.url, {
    email: 'persist@example.com',
    scopes: 'operator',
  });
  await first.close();

  // A brand new process-equivalent: fresh store, fresh service, same file.
  const second = await startHost({ storePath });
  t.after(() => second.close());

  const { body: users } = await call(second.url, '/users', { token: BOOTSTRAP });
  assert.equal(users.users.length, 1);
  assert.equal(users.users[0].id, user.id);

  // The key issued before the restart still authenticates.
  const { body: me } = await call(second.url, '/me', { token: key });
  assert.equal(me.userId, user.id);
});

test('a corrupt store fails loudly instead of starting empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alpha-auth-'));
  const storePath = join(dir, 'auth.json');
  await writeFile(storePath, '{ this is not json');

  const service = new AuthService({ store: new AuthStore({ path: storePath }) });
  // Silently starting empty would un-revoke every revoked credential and lock
  // out every real user, so this must throw.
  await assert.rejects(() => service.load(), /not valid JSON/);
});

test('store writes are atomic and leave no partial file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'alpha-auth-'));
  const storePath = join(dir, 'auth.json');
  const host = await startHost({ storePath });
  t.after(() => host.close());

  // Fire several mutations concurrently; chained writes must not interleave.
  await Promise.all(
    ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'].map((email) =>
      call(host.url, '/invites', { method: 'POST', token: BOOTSTRAP, body: { email, scopes: 'viewer' } }),
    ),
  );

  const raw = await readFile(storePath, 'utf8');
  const parsed = JSON.parse(raw); // throws if a partial write landed
  assert.equal(Object.keys(parsed.invites).length, 4);
});

// ---------------------------------------------------------------- bootstrap

test('the bootstrap token has admin scope and no user', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  const { body: me } = await call(host.url, '/me', { token: BOOTSTRAP });
  assert.equal(me.kind, 'bootstrap');
  assert.equal(me.userId, null);
  assert.deepEqual(me.scopes, [SCOPES.ADMIN]);
});

test('the bootstrap credential cannot change a password', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  await assert.rejects(
    () => call(host.url, '/me/password', {
      method: 'POST',
      token: BOOTSTRAP,
      body: { currentPassword: 'x', newPassword: 'a-good-long-password' },
    }),
    rejectsWith(400),
  );
});

test('a host with no bootstrap token accepts only issued keys', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'alpha-auth-'));
  const storePath = join(dir, 'auth.json');

  const seeded = await startHost({ storePath });
  const { key } = await inviteAndRedeem(seeded.url, { email: 'only@example.com', scopes: 'operator' });
  await seeded.close();

  // Restart with the bootstrap credential removed, as the README advises.
  const auth = new AuthService({ store: new AuthStore({ path: storePath }), bootstrapToken: null });
  await auth.load();
  const host = createHost({ auth });
  await new Promise((resolve) => host.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${host.server.address().port}`;
  t.after(() => host.close());

  await assert.rejects(() => call(url, '/users', { token: BOOTSTRAP }), rejectsWith(401));
  const { status } = await call(url, '/tasks', { token: key });
  assert.equal(status, 200);
});

test('unauthenticated and malformed credentials are refused', async (t) => {
  const host = await startHost();
  t.after(() => host.close());

  for (const token of [undefined, 'nonsense', 'alpha_key_zz.zz', 'alpha_inv_00.aa']) {
    await assert.rejects(() => call(host.url, '/tasks', { token }), rejectsWith(401));
  }
});

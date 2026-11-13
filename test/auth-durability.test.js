import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AuthStore } from '../src/host/auth/store.js';

test('a failed disk flush preserves the last credential snapshot; a later save recovers', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'alpha-auth-durable-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'auth.json');
  const store = await new AuthStore({ path }).load();
  await store.mutate(data => { data.apiKeys.revoked = { revoked: true }; });
  const before = await readFile(path, 'utf8');

  const probe = await open(join(dir, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const flush = t.mock.method(prototype, 'sync', async () => {
    throw Object.assign(new Error('simulated storage flush failure'), { code: 'EIO' });
  });
  store.data.users.newUser = { enabled: false };
  try {
    await assert.rejects(store.save(), /storage flush failure/);
    assert.equal(await readFile(path, 'utf8'), before);
    const reopened = await new AuthStore({ path }).load();
    assert.equal(reopened.data.apiKeys.revoked.revoked, true);
    assert.equal(reopened.data.users.newUser, undefined);
  } finally {
    flush.mock.restore();
  }

  await store.save();
  const recovered = await new AuthStore({ path }).load();
  assert.equal(recovered.data.apiKeys.revoked.revoked, true);
  assert.equal(recovered.data.users.newUser.enabled, false);
});

test('a zero-filled store is retained and refused, even with a valid leftover temporary file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'alpha-auth-zero-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'auth.json');
  const file = await open(path, 'w');
  await file.writeFile(Buffer.alloc(4035));
  await file.close();
  const leftover = await new AuthStore({ path: `${path}.tmp` }).load();
  await leftover.save();
  await assert.rejects(new AuthStore({ path }).load(), /not valid JSON/);
  assert.deepEqual(await readFile(path), Buffer.alloc(4035));
});

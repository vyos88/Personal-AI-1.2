// The admin CLI, driven as the real entrypoint against a real host — what an
// operator types, read the way an operator reads it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createHost } from '../src/host/server.js';
import { AgentRegistry } from '../src/host/registry.js';
import { fetchJson } from '../src/common/http.js';
import { AGENT_SILENT_MS } from '../src/common/protocol.js';

const run = promisify(execFile);
const TOKEN = 'test-token-that-is-long-enough';
const ADMIN = resolve(fileURLToPath(new URL('../src/admin/run.js', import.meta.url)));

async function startHost(registry) {
  const host = createHost({ token: TOKEN, registry });
  await new Promise((r) => host.server.listen(0, '127.0.0.1', r));
  return { ...host, url: `http://127.0.0.1:${host.server.address().port}` };
}

async function admin(url, ...args) {
  // An empty working directory, so a developer's own .env cannot point the
  // CLI at a real host.
  const cwd = mkdtempSync(join(tmpdir(), 'alpha-admin-'));
  try {
    const env = { ...process.env, ALPHA_HOST_URL: url, ALPHA_ADMIN_TOKEN: TOKEN };
    const { stdout } = await run(process.execPath, [ADMIN, ...args], { cwd, env });
    return stdout;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const register = (url, name) =>
  fetchJson(`${url}/agent/register`, {
    method: 'POST',
    token: TOKEN,
    body: { protocolVersion: 1, capabilities: ['echo'], name },
  });

test('alpha-admin agents marks a machine that has stopped heartbeating', async (t) => {
  let clock = Date.now();
  const registry = new AgentRegistry({ now: () => clock });
  const host = await startHost(registry);
  t.after(() => host.close());

  await register(host.url, 'laptop');
  await register(host.url, 'desktop');

  let out = await admin(host.url, 'agents');
  assert.match(out, /laptop/);
  assert.doesNotMatch(out, /!/, 'nothing is marked while both are talking');

  clock += AGENT_SILENT_MS + 5_000;
  const desktop = registry.list().find((a) => a.name === 'desktop');
  registry.touch(desktop.id);

  out = await admin(host.url, 'agents');
  const rows = out.split('\n');
  assert.match(rows.find((r) => r.startsWith('laptop')), /\d+s !/);
  assert.doesNotMatch(rows.find((r) => r.startsWith('desktop')), /!/);
  assert.match(out, /not heard from in over two heartbeats: laptop\./);

  // --json is the raw rows, flag included.
  const json = JSON.parse(await admin(host.url, 'agents', '--json'));
  assert.deepEqual(
    Object.fromEntries(json.map((a) => [a.name, a.stale])),
    { laptop: true, desktop: false },
  );
});

// Making a machine the coordinator after the old one is gone. The script is
// driven as a subprocess against a temp checkout, and it proves itself with
// the real coordinator and agent entrypoints, so a pass here is a real attach.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { setEnvKeys, readEnvKey, addToList } from '../scripts/move-coordinator-here.mjs';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCRIPT = join(REPO, 'scripts', 'move-coordinator-here.mjs');

function freePort() {
  return new Promise((done) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

async function checkout() {
  const root = await mkdtemp(join(tmpdir(), 'move-coord-'));
  await symlink(join(REPO, 'src'), join(root, 'src'), 'dir');
  return root;
}

function run(root, args, input = '') {
  return new Promise((done) => {
    const child = spawn(process.execPath, [SCRIPT, '--root', root, '--loopback-only', ...args], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.stdin.end(input);
    child.on('exit', (code) => done({ code, out }));
  });
}

test('setEnvKeys replaces, removes and appends while keeping every other line', () => {
  const body = '# agent\nALPHA_HOST_URL=http://100.81.6.91:8787\nALPHA_BOOTSTRAP_TOKEN=x\nALPHA_RENDER_ROOT=C:\\r\n';
  const out = setEnvKeys(body, {
    ALPHA_HOST_URL: 'http://127.0.0.1:8787',
    ALPHA_BOOTSTRAP_TOKEN: null,
    ALPHA_HOST_PORT: '8787',
    ALPHA_TUNNEL_TOKEN: null,
  });
  assert.equal(out, '# agent\nALPHA_HOST_URL=http://127.0.0.1:8787\nALPHA_RENDER_ROOT=C:\\r\nALPHA_HOST_PORT=8787\n');
  assert.equal(readEnvKey(out, 'ALPHA_RENDER_ROOT'), 'C:\\r');
  assert.equal(readEnvKey(out, 'ALPHA_MISSING'), null);
});

test('addToList adds a handler once and keeps the ones already there', () => {
  assert.equal(addToList('alpha-render', 'alpha-coordination'), 'alpha-render,alpha-coordination');
  assert.equal(addToList('alpha-coordination, x', 'alpha-coordination'), 'alpha-coordination,x');
  assert.equal(addToList('a,b,a', 'c'), 'a,b,c');
  assert.equal(addToList(null, 'alpha-coordination'), 'alpha-coordination');
});

test('with no store it makes one, repoints the agent and proves the attach; a second run keeps the store', async (t) => {
  const root = await checkout();
  t.after(() => rm(root, { recursive: true, force: true }));
  const port = await freePort();
  await writeFile(join(root, '.env.agent'), [
    'ALPHA_HOST_URL=http://100.81.6.91:8787',
    'ALPHA_AGENT_KEY=alpha_key_dead.from-the-old-coordinator',
    'ALPHA_AGENT_NAME=laptop-41-v2',
    'ALPHA_AGENT_MEMORY_RESERVE_MB=64',
    '',
  ].join('\n'));

  const refused = await run(root, ['--port', String(port)]);
  assert.equal(refused.code, 1);
  assert.match(refused.out, /--email/);

  const first = await run(root, ['--port', String(port), '--email', 'owner@example.com'], 'a-long-enough-password\n');
  assert.equal(first.code, 0, first.out);
  assert.ok(existsSync(join(root, 'data', 'auth.json')));
  assert.match(first.out, /agent attached/);
  const adminKey = /^\s*(alpha_\w+_\S+)\s*$/m.exec(first.out)?.[1];
  assert.ok(adminKey, first.out);

  const env = await readFile(join(root, '.env'), 'utf8');
  assert.equal(readEnvKey(env, 'ALPHA_HOST_URL'), `http://127.0.0.1:${port}`);
  assert.equal(readEnvKey(env, 'ALPHA_HOST_BIND'), '127.0.0.1');
  assert.equal(readEnvKey(env, 'ALPHA_BOOTSTRAP_TOKEN'), null);

  const agentEnv = await readFile(join(root, '.env.agent'), 'utf8');
  assert.equal(readEnvKey(agentEnv, 'ALPHA_HOST_URL'), `http://127.0.0.1:${port}`);
  assert.equal(readEnvKey(agentEnv, 'ALPHA_AGENT_NAME'), 'laptop-41-v2');
  assert.equal(readEnvKey(agentEnv, 'ALPHA_AGENT_MEMORY_RESERVE_MB'), '64');
  const agentKey = readEnvKey(agentEnv, 'ALPHA_AGENT_KEY');
  assert.notEqual(agentKey, 'alpha_key_dead.from-the-old-coordinator');

  // Nothing may be left listening: keeping it up is the service's job.
  await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`));

  // The second run also turns on the coordination handler, so the receipt can
  // go to Alpha's tunnel from this machine.
  const alpha = join(root, 'alpha');
  await mkdir(join(alpha, 'scripts'), { recursive: true });
  await writeFile(join(alpha, 'scripts', 'alpha_coordination_tunnel.ps1'), '# stub\n');
  const second = await run(root, ['--port', String(port), '--alpha-root', alpha]);
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /alpha\.coordination/);
  assert.match(second.out, /keeping .*1 user\(s\)/);
  assert.doesNotMatch(second.out, /admin key/i);
  const after = await readFile(join(root, '.env.agent'), 'utf8');
  assert.equal(readEnvKey(after, 'ALPHA_AGENT_KEY'), agentKey, 'a kept store keeps the agent key');
  assert.equal(readEnvKey(after, 'ALPHA_EXTRA_HANDLERS'), 'alpha-coordination');
  assert.equal(readEnvKey(after, 'ALPHA_REPO_ROOT'), alpha);
});

test('refuses to run beside a coordinator that is already up', async (t) => {
  const root = await checkout();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { createServer: createHttp } = await import('node:http');
  const server = createHttp((req, res) => res.end('{"ok":true}')).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  await writeFile(join(root, '.env.agent'), 'ALPHA_HOST_URL=http://x\n');
  const result = await run(root, ['--port', String(server.address().port)]);
  assert.equal(result.code, 1);
  assert.match(result.out, /already answers/);
  assert.ok(!existsSync(join(root, '.env')), 'nothing written');
});

test('an environment variable that would override .env.agent stops the move before anything is written', async (t) => {
  const root = await checkout();
  t.after(() => rm(root, { recursive: true, force: true }));
  const alpha = join(root, 'alpha');
  await mkdir(join(alpha, 'scripts'), { recursive: true });
  await writeFile(join(alpha, 'scripts', 'alpha_coordination_tunnel.ps1'), '# stub\n');
  const before = 'ALPHA_HOST_URL=http://100.81.6.91:8787\nALPHA_EXTRA_HANDLERS=alpha-coordination\n';
  await writeFile(join(root, '.env.agent'), before);
  const port = await freePort();
  const result = await new Promise((done) => {
    const child = spawn(process.execPath, [SCRIPT, '--root', root, '--loopback-only', '--port', String(port),
      '--email', 'owner@example.com', '--alpha-root', alpha], {
      cwd: root,
      env: { ...process.env, ALPHA_EXTRA_HANDLERS: 'alpha-render,alpha-devices' },
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('exit', (code) => done({ code, out }));
  });
  assert.equal(result.code, 1);
  assert.match(result.out, /ALPHA_EXTRA_HANDLERS is set in this machine's environment/);
  // The list it names keeps what the environment offered, so removing the
  // variable does not lose a handler.
  assert.match(result.out, /ALPHA_EXTRA_HANDLERS=alpha-coordination,alpha-render,alpha-devices/);
  assert.equal(await readFile(join(root, '.env.agent'), 'utf8'), before);
  assert.ok(!existsSync(join(root, '.env')));
  assert.ok(!existsSync(join(root, 'data', 'auth.json')), 'no store created');
});

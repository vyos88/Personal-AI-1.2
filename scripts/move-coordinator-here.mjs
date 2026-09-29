#!/usr/bin/env node
/**
 * Make this machine the coordinator, when the machine that used to be it is
 * gone.
 *
 * docs/COORDINATOR_MIGRATION.md is the runbook for a planned move, with the
 * old host still there to copy from. This is the unplanned version: vyos88
 * left the tailnet and took the only coordinator with it, so every agent was
 * dialling an address nothing answers. Steps 4, 5 and 5b of that runbook, plus
 * the one it could assume away — there may be no accounts store to bring.
 *
 *   - data/auth.json present: it is kept, every key in the fleet stays valid,
 *     and no bootstrap token is written (the runbook's reason still holds).
 *   - absent: a fresh store with one admin and a key for this machine's agent,
 *     the way setup-host.mjs makes one, but without overwriting .env.agent —
 *     this machine already has an agent configured, and its handlers and name
 *     are not this script's to reset.
 *
 * Then it proves the result with the real entrypoints: the coordinator from
 * the .env it wrote, and the agent from the .env.agent it edited, attached
 * once under a throwaway instance id so the agent already running here is not
 * superseded. It starts nothing permanently; keeping the coordinator up is a
 * service, and the commands for that are printed at the end.
 */

import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { fetchJson } from '../src/common/http.js';
import { promptSecret } from '../src/common/prompt.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `
move-coordinator-here — run the coordinator on this machine and point its agent at it

  node scripts/move-coordinator-here.mjs [--alpha-root C:\\path\\to\\alpha]

Options
  --tailnet-ip <ip>   Address the other machines reach. Default: tailscale ip -4
  --loopback-only     Bind 127.0.0.1 alone (no other machine can attach)
  --port <n>          Coordinator port. Default 8787
  --email <e>         Admin account to create. Required only when there is no
                      data/auth.json to keep
  --alpha-root <p>    Alpha working copy on this machine. Enables the
                      coordination handler on this agent, so receipts can be
                      posted to Alpha's tunnel from here
  --root <dir>        alpha-tunnel checkout to configure. Default: this one
  --help              This message

The password for a new admin is prompted for, never taken as an argument.
`.trim();

const say = (line) => process.stdout.write(`${line}\n`);
const ok = (text) => say(`  ok  ${text}`);
const note = (text) => say(`      ${text}`);

function die(message) {
  process.stderr.write(`\nMove failed: ${message}\n`);
  process.exit(1);
}

/**
 * Sets keys in a dotenv body, keeping every other line as it was. A value of
 * null removes the key. Keys not already present are appended.
 */
export function setEnvKeys(body, updates) {
  const seen = new Set();
  const lines = body.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (!match || !(match[1] in updates)) return [line];
    seen.add(match[1]);
    const value = updates[match[1]];
    return value === null ? [] : [`${match[1]}=${value}`];
  });
  while (lines.length && lines.at(-1) === '') lines.pop();
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key) && value !== null) lines.push(`${key}=${value}`);
  }
  return `${lines.join('\n')}\n`;
}

export function readEnvKey(body, key) {
  const match = new RegExp(`^\\s*${key}\\s*=(.*)$`, 'm').exec(body);
  return match ? match[1].trim() : null;
}

/** Adds a name to a comma-separated list unless it is already on it. */
export function addToList(list, name) {
  const items = (list ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return items.includes(name) ? items.join(',') : [...items, name].join(',');
}

function tailnetAddress() {
  let out;
  try {
    out = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8', timeout: 10_000 });
  } catch (error) {
    die(`could not ask Tailscale for this machine's address (${error.message}).\n` +
      '  Pass --tailnet-ip, or --loopback-only if no other machine needs to attach.');
  }
  const ip = out.split(/\s+/).find((s) => /^100\.\d+\.\d+\.\d+$/.test(s));
  if (!ip) die(`tailscale ip -4 did not print a tailnet address: ${out.trim() || '(nothing)'}`);
  return ip;
}

async function healthy(url) {
  try {
    const { body } = await fetchJson(`${url}/healthz`, { timeoutMs: 2_000 });
    return body?.ok === true;
  } catch {
    return false;
  }
}

function start(root, entry, env) {
  const child = spawn(process.execPath, [join(root, entry)], {
    cwd: root,
    env: { ...process.env, ALPHA_LOG_LEVEL: 'info', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.log = '';
  child.stdout.on('data', (chunk) => { child.log += chunk; });
  child.stderr.on('data', (chunk) => { child.log += chunk; });
  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((done) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 5_000);
    child.once('exit', () => { clearTimeout(timer); done(); });
  });
}

async function waitHealthy(url, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    if (await healthy(url)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Runs the real agent until it says it attached, or says why not. */
function attachOnce(root, timeoutMs = 25_000) {
  const agent = start(root, 'src/agent/index.js', {
    // Without this the check would supersede the agent already lending from
    // this machine, and the running one would stand down for good.
    ALPHA_AGENT_INSTANCE_ID: `inst_movecheck_${randomBytes(4).toString('hex')}`,
  });
  return new Promise((done) => {
    let settled = false;
    const finish = async (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const capabilities = /capabilities=(\[[^\]]*\])/.exec(agent.log)?.[1] ?? null;
      await stop(agent);
      done({ ...result, capabilities, log: agent.log });
    };
    const timer = setTimeout(() => finish({ attached: false, reason: 'timed out' }), timeoutMs);
    agent.stdout.on('data', () => {
      if (/registered with host/.test(agent.log)) finish({ attached: true });
      else if (/rejected the token/.test(agent.log)) finish({ attached: false, reason: 'the coordinator rejected this agent\'s key' });
    });
    agent.on('exit', (code) => finish({ attached: false, reason: `the agent exited with code ${code}` }));
  });
}

async function main() {
  let flags;
  try {
    ({ values: flags } = parseArgs({
      args: process.argv.slice(2),
      options: {
        'tailnet-ip': { type: 'string' },
        'loopback-only': { type: 'boolean' },
        port: { type: 'string' },
        email: { type: 'string' },
        'alpha-root': { type: 'string' },
        root: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    die(`${error.message}\n\n${USAGE}`);
  }
  if (flags.help) return say(USAGE);

  const root = resolve(flags.root ?? REPO);
  const port = Number.parseInt(flags.port ?? '8787', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) die('--port must be a valid port number');
  const local = `http://127.0.0.1:${port}`;
  const envPath = join(root, '.env');
  const agentEnvPath = join(root, '.env.agent');
  const storePath = join(root, 'data', 'auth.json');

  say('\nMoving the coordinator to this machine');

  // ------------------------------------------------------------ 1. checks
  say('\n[1] Checking');
  if (await healthy(local)) {
    die(`a coordinator already answers on ${local}.\n` +
      '  Stop it first (nssm stop alpha-coordinator, or close run-coordinator.cmd) and re-run.');
  }
  const tailnetIp = flags['loopback-only'] ? null : (flags['tailnet-ip'] ?? tailnetAddress());
  const binds = ['127.0.0.1', ...(tailnetIp ? [tailnetIp] : [])];
  ok(`will listen on ${binds.map((b) => `${b}:${port}`).join(' and ')}`);

  const agentEnv = existsSync(agentEnvPath) ? await readFile(agentEnvPath, 'utf8') : null;
  if (agentEnv === null) {
    die(`no .env.agent in ${root}.\n` +
      '  This script repoints an agent that is already set up. Set one up with\n' +
      '  scripts/setup-agent.mjs once the coordinator is running.');
  }
  const oldUrl = readEnvKey(agentEnv, 'ALPHA_HOST_URL');
  ok(`agent currently dials ${oldUrl ?? '(nothing set)'}`);

  let alphaRoot = null;
  if (flags['alpha-root']) {
    alphaRoot = resolve(flags['alpha-root']);
    const tunnel = join(alphaRoot, 'scripts', 'alpha_coordination_tunnel.ps1');
    if (!existsSync(tunnel)) die(`no coordination script at ${tunnel}`);
    ok(`Alpha working copy at ${alphaRoot}`);
  }

  // ------------------------------------------------------------- 2. store
  say('\n[2] Accounts store');
  let fresh = null;
  if (existsSync(storePath)) {
    let store;
    try {
      store = JSON.parse(await readFile(storePath, 'utf8'));
    } catch (error) {
      die(`${storePath} is not readable JSON (${error.message}).\n` +
        '  The coordinator would refuse it too. Restore it from a backup, or move it\n' +
        '  aside to start a fresh store.');
    }
    const users = Object.keys(store.users ?? {}).length;
    const keys = Object.keys(store.apiKeys ?? {}).length;
    ok(`keeping ${storePath}: ${users} user(s), ${keys} key(s) — every existing key stays valid`);
  } else {
    if (!flags.email) {
      die('there is no data/auth.json here, so this is a fresh store and needs an admin.\n' +
        '  Re-run with --email you@example.com. If a copy of the old auth.json survived\n' +
        `  (a USB backup, say), put it at ${storePath} first and every key is kept.`);
    }
    note('no data/auth.json — creating a fresh store; keys issued by the old coordinator are void');
    fresh = await createStore(root, port, flags.email, agentEnv);
    ok(`admin ${flags.email} created, and a key for this machine's agent`);
  }

  // -------------------------------------------------------- 3. .env files
  say('\n[3] Configuration');
  const env = existsSync(envPath) ? await readFile(envPath, 'utf8') : '';
  await writeFile(envPath, setEnvKeys(env, {
    ALPHA_HOST_PORT: String(port),
    ALPHA_HOST_BIND: binds.join(','),
    ALPHA_AUTH_STORE: './data/auth.json',
    // Loopback on the coordinator's own machine: a connection that never
    // leaves it should not break when Tailscale does (runbook step 5b).
    ALPHA_HOST_URL: local,
    ALPHA_BOOTSTRAP_TOKEN: null,
    ALPHA_TUNNEL_TOKEN: null,
  }), { mode: 0o600 });
  ok(`.env: coordinator on ${binds.join(',')}, tools talk to ${local}, no bootstrap token`);

  const agentUpdates = { ALPHA_HOST_URL: local };
  if (fresh) agentUpdates.ALPHA_AGENT_KEY = fresh.agentKey;
  if (alphaRoot) {
    agentUpdates.ALPHA_EXTRA_HANDLERS = addToList(readEnvKey(agentEnv, 'ALPHA_EXTRA_HANDLERS'), 'alpha-coordination');
    agentUpdates.ALPHA_REPO_ROOT = alphaRoot;
  }
  await writeFile(agentEnvPath, setEnvKeys(agentEnv, agentUpdates), { mode: 0o600 });
  ok(`.env.agent: ALPHA_HOST_URL ${oldUrl ?? '(unset)'} -> ${local}` +
    (fresh ? ', new agent key' : '') + (alphaRoot ? ', coordination handler on' : ''));

  // ------------------------------------------------------------ 4. verify
  say('\n[4] Proving it');
  const coordinator = start(root, 'src/host/index.js', {});
  try {
    if (!(await waitHealthy(local, coordinator))) {
      die(`the coordinator did not come up on ${local}.\n${coordinator.log}`);
    }
    ok(`coordinator healthy on ${local}`);
    if (tailnetIp) {
      if (await healthy(`http://${tailnetIp}:${port}`)) ok(`and on http://${tailnetIp}:${port}`);
      else die(`the coordinator is not answering on http://${tailnetIp}:${port}.\n${coordinator.log}`);
    }
    const result = await attachOnce(root);
    if (!result.attached) die(`this machine's agent did not attach: ${result.reason}.\n${result.log}`);
    ok(`this machine's agent attached, offering ${result.capabilities ?? '(see agent log)'}`);
    if (alphaRoot && !result.capabilities?.includes('alpha.coordination')) {
      die(`the agent attached without alpha.coordination.\n${result.log}`);
    }
  } finally {
    await stop(coordinator);
  }

  // ------------------------------------------------------------- 5. after
  const url = tailnetIp ? `http://${tailnetIp}:${port}` : local;
  say(`
Done. This machine is the coordinator; other machines reach it at ${url}.
Nothing is left running: keep the coordinator up as a service, and restart the
agent so it re-reads .env.agent.
`);
  if (fresh) {
    say(`Your admin key — shown once. Set it as ALPHA_ADMIN_TOKEN to use the CLI:

  ${fresh.adminKey}
`);
  }
  say(`Every OTHER machine: set ALPHA_HOST_URL=${url} in its .env.agent (and .env),
then restart its agent.${fresh ? ' Their old keys are void: give each one a new key\nwith  node src/admin/run.js issue-key --user ' + fresh.userId + ' --scopes agent --name <machine>' : ''}
`);
}

/** A fresh store: one admin and one agent key, via the coordinator's own API. */
async function createStore(root, port, email, agentEnv) {
  await mkdir(join(root, 'data'), { recursive: true });
  const bootstrapToken = randomBytes(32).toString('base64url');
  const url = `http://127.0.0.1:${port}`;
  // Loopback only and never written to disk: the window where a bootstrap
  // token is live should be this process, not a file someone forgets.
  const coordinator = start(root, 'src/host/index.js', {
    ALPHA_HOST_PORT: String(port),
    ALPHA_HOST_BIND: '127.0.0.1',
    ALPHA_BOOTSTRAP_TOKEN: bootstrapToken,
    ALPHA_AUTH_STORE: join(root, 'data', 'auth.json'),
  });
  try {
    if (!(await waitHealthy(url, coordinator))) die(`the coordinator did not start.\n${coordinator.log}`);
    const api = (path, options = {}) =>
      fetchJson(`${url}${path}`, { timeoutMs: 20_000, ...options }).then((r) => r.body);

    const invite = await api('/invites', { method: 'POST', token: bootstrapToken, body: { email, scopes: 'admin' } });
    const password = await promptSecret(`  Choose a password for ${email} (min 12 chars): `);
    if (process.stdin.isTTY && password !== (await promptSecret('  Confirm password: '))) {
      die('passwords did not match');
    }
    const redeemed = await api('/invites/redeem', { method: 'POST', body: { token: invite.token, password } });
    const name = readEnvKey(agentEnv, 'ALPHA_AGENT_NAME') || hostname();
    const issued = await api('/keys', {
      method: 'POST',
      token: redeemed.token,
      body: { userId: redeemed.user.id, name: `${name}-agent`, scopes: 'agent' },
    });
    return { adminKey: redeemed.token, agentKey: issued.token, userId: redeemed.user.id };
  } catch (error) {
    die(`creating the store failed: ${error.message}\n${coordinator.log}`);
  } finally {
    await stop(coordinator);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => die(error.stack ?? error.message));
}

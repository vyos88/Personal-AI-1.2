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
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { fetchJson } from '../src/common/http.js';
import { promptSecret } from '../src/common/prompt.js';
import { MIN_PASSWORD_LENGTH } from '../src/host/auth/passwords.js';

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

// die() throws instead of exiting: process.exit() skips every finally block,
// and the ones in this file stop the temporary coordinator. Exiting from
// inside them left it listening, with its bootstrap admin token live, and the
// next run then reported "a coordinator already answers".
class MoveError extends Error {}

function die(message) {
  throw new MoveError(message);
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
  return [...new Set([...items, name])].join(',');
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

/**
 * What data/auth.json holds. A store with no users is what an interrupted
 * fresh run leaves (the invite is saved before anyone redeems it); keeping it
 * would write a .env with no bootstrap token for a store nobody can sign in
 * to, and the coordinator refuses to start that way.
 */
async function storeState(storePath) {
  if (!existsSync(storePath)) return { kind: 'none' };
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
  return { kind: users ? 'keep' : 'empty', users, keys };
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

  const state = await storeState(storePath);

  // Both lists, file and environment, so moving the list into the file does
  // not quietly drop a handler this machine offers today.
  const extraHandlers = alphaRoot
    ? addToList([readEnvKey(agentEnv, 'ALPHA_EXTRA_HANDLERS'), process.env.ALPHA_EXTRA_HANDLERS].filter(Boolean).join(','), 'alpha-coordination')
    : null;
  const willWrite = {
    ALPHA_HOST_URL: local,
    ...(state.kind === 'keep' ? {} : { ALPHA_AGENT_KEY: '(new)' }),
    ...(alphaRoot ? { ALPHA_EXTRA_HANDLERS: extraHandlers, ALPHA_REPO_ROOT: alphaRoot } : {}),
  };
  // A variable set in this machine's environment beats both files, and the
  // agent would ignore the edit below without a word: the first run on
  // Laptop41 wrote alpha-coordination into .env.agent and attached without it.
  const overridden = Object.entries(willWrite)
    .filter(([key, value]) => process.env[key] !== undefined && process.env[key] !== value)
    .map(([key]) => key);
  if (overridden.length) {
    die(`${overridden.join(', ')} ${overridden.length > 1 ? 'are' : 'is'} set in this machine's environment, which overrides .env.agent.\n` +
      '  Remove it and open a new window, then re-run (nothing has been written):\n' +
      overridden.map((key) =>
        `    [Environment]::SetEnvironmentVariable('${key}', $null, 'Machine'); ` +
        `[Environment]::SetEnvironmentVariable('${key}', $null, 'User')`).join('\n') +
      (extraHandlers ? `\n  .env.agent will then carry ALPHA_EXTRA_HANDLERS=${extraHandlers}` : ''));
  }

  // ------------------------------------------------------------- 2. store
  say('\n[2] Accounts store');
  let fresh = null;
  if (state.kind === 'keep') {
    ok(`keeping ${storePath}: ${state.users} user(s), ${state.keys} key(s) — every existing key stays valid`);
  } else {
    if (state.kind === 'empty' && !flags.email) {
      die(`${storePath} has no users, so nobody can sign in to it - an earlier run stopped before\n` +
        '  the admin was created. Re-run with --email you@example.com to replace it; the old file\n' +
        '  is kept beside it, not deleted.');
    }
    if (!flags.email) {
      die('there is no data/auth.json here, so this is a fresh store and needs an admin.\n' +
        '  Re-run with --email you@example.com. If a copy of the old auth.json survived\n' +
        `  (a USB backup, say), put it at ${storePath} first and every key is kept.`);
    }
    // Asked before anything is created, so a password the store would refuse
    // ends the run with nothing written.
    const password = await promptSecret(`  Choose a password for ${flags.email} (min ${MIN_PASSWORD_LENGTH} chars): `);
    if (password.length < MIN_PASSWORD_LENGTH) {
      die(`the password must be at least ${MIN_PASSWORD_LENGTH} characters. Nothing was written.`);
    }
    if (process.stdin.isTTY && password !== (await promptSecret('  Confirm password: '))) {
      die('passwords did not match. Nothing was written.');
    }
    if (state.kind === 'empty') {
      const aside = `${storePath}.no-users-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await rename(storePath, aside);
      note(`${storePath} had no users (left by an earlier run that stopped) - moved to ${aside}`);
    }
    note('no usable data/auth.json — creating a fresh store; keys issued by the old coordinator are void');
    fresh = await createStore(root, port, flags.email, password, agentEnv);
    ok(`admin ${flags.email} created, and a key for this machine's agent`);
    // Printed here, not at the end: a later step can still fail, and a key
    // shown only on success was lost with the first run that did not reach it.
    say(`\n  Your admin key, shown once. Set it as ALPHA_ADMIN_TOKEN to use the CLI:\n\n  ${fresh.adminKey}\n`);
    note(`lost it? node src/admin/run.js login --email ${flags.email} gives a session token`);
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
    agentUpdates.ALPHA_EXTRA_HANDLERS = extraHandlers;
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
  say(`Every OTHER machine: set ALPHA_HOST_URL=${url} in its .env.agent (and .env),
then restart its agent.${fresh ? ' Their old keys are void: give each one a new key\nwith  node src/admin/run.js issue-key --user ' + fresh.userId + ' --scopes agent --name <machine>' : ''}
`);
}

/** A fresh store: one admin and one agent key, via the coordinator's own API. */
async function createStore(root, port, email, password, agentEnv) {
  await mkdir(join(root, 'data'), { recursive: true });
  const bootstrapToken = randomBytes(32).toString('base64url');
  const url = `http://127.0.0.1:${port}`;
  // Loopback only and never written to disk: the window where a bootstrap
  // token is live should be this process, not a file someone forgets.
  const storePath = join(root, 'data', 'auth.json');
  const coordinator = start(root, 'src/host/index.js', {
    ALPHA_HOST_PORT: String(port),
    ALPHA_HOST_BIND: '127.0.0.1',
    ALPHA_BOOTSTRAP_TOKEN: bootstrapToken,
    ALPHA_AUTH_STORE: storePath,
  });
  let made = false;
  try {
    if (!(await waitHealthy(url, coordinator))) die(`the coordinator did not start.\n${coordinator.log}`);
    const api = (path, options = {}) =>
      fetchJson(`${url}${path}`, { timeoutMs: 20_000, ...options }).then((r) => r.body);

    const invite = await api('/invites', { method: 'POST', token: bootstrapToken, body: { email, scopes: 'admin' } });
    const redeemed = await api('/invites/redeem', { method: 'POST', body: { token: invite.token, password } });
    const name = readEnvKey(agentEnv, 'ALPHA_AGENT_NAME') || hostname();
    const issued = await api('/keys', {
      method: 'POST',
      token: redeemed.token,
      body: { userId: redeemed.user.id, name: `${name}-agent`, scopes: 'agent' },
    });
    made = true;
    return { adminKey: redeemed.token, agentKey: issued.token, userId: redeemed.user.id };
  } catch (error) {
    if (error instanceof MoveError) throw error;
    die(`creating the store failed: ${error.message}\n${coordinator.log}`);
  } finally {
    await stop(coordinator);
    // The store did not exist before this function, so a failure removes
    // what it wrote: the invite is saved before the admin exists, and a store
    // with no users is one the next run could not start.
    if (!made) {
      await rm(storePath, { force: true });
      await rm(`${storePath}.tmp`, { force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`\nMove failed: ${error instanceof MoveError ? error.message : (error.stack ?? error.message)}\n`);
    // Every finally block has run by now, so nothing this run started is left.
    process.exit(1);
  });
}

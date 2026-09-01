#!/usr/bin/env node
/**
 * One-command provisioning for the Alpha host.
 *
 * Does steps 3-7 of docs/HOST_SETUP.md: generates a bootstrap token, writes
 * .env, starts the coordinator, creates an admin account, issues the agent a
 * key scoped to agent:connect, writes the agent's environment, proves the loop
 * end to end, then shuts everything down and prints the service commands.
 *
 * Written in Node rather than PowerShell so it runs identically on the Windows
 * host and can be tested on the machine it was written on. Node is already a
 * prerequisite for the project, so this adds no new dependency.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { fetchJson, HttpError } from '../src/common/http.js';
import { promptSecret } from '../src/common/prompt.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `
setup-host — provision the Alpha host coordinator and agent

  node scripts/setup-host.mjs --email you@example.com --alpha-root C:\\path\\to\\alpha

Options
  --email <e>        Admin account to create (required)
  --alpha-root <p>   Alpha working copy, the folder holding scripts\\ (required)
  --name <n>         Your display name
  --agent-name <n>   Name this agent shows as. Defaults to the machine hostname
  --port <n>         Coordinator port. Default 8787
  --bind <addr>      Coordinator bind address. Default 127.0.0.1
  --powershell <p>   Interpreter. Default powershell.exe
  --skip-coordination  Provision without enabling the coordination handler
  --force            Overwrite an existing .env
  --help             This message

The password is prompted for, never taken as an argument.
`.trim();

const OPTIONS = {
  email: { type: 'string' },
  'alpha-root': { type: 'string' },
  name: { type: 'string' },
  'agent-name': { type: 'string' },
  port: { type: 'string' },
  bind: { type: 'string' },
  powershell: { type: 'string' },
  'skip-coordination': { type: 'boolean' },
  force: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const style = {
  step: (n, text) => `\n\x1b[1m[${n}]\x1b[0m ${text}`,
  ok: (text) => `  \x1b[32m✓\x1b[0m ${text}`,
  warn: (text) => `  \x1b[33m!\x1b[0m ${text}`,
  info: (text) => `    ${text}`,
};

const say = (line) => process.stdout.write(`${line}\n`);

function die(message) {
  process.stderr.write(`\n\x1b[31mSetup failed:\x1b[0m ${message}\n`);
  process.exit(1);
}

/** Waits for the coordinator to answer, or gives up. */
async function waitForHealth(url, { timeoutMs = 20_000, child } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // A coordinator that died (port in use, bad store) will never become
    // healthy, so stop waiting the moment it exits rather than burning the
    // full timeout and then reporting something vague.
    if (child?.exitCode !== null && child?.exitCode !== undefined) return false;
    try {
      const { body } = await fetchJson(`${url}/healthz`, { timeoutMs: 2_000 });
      if (body?.ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Starts a child process and collects its output for diagnostics. */
function startProcess(entry, env, label) {
  const child = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.log = '';
  const capture = (chunk) => {
    child.log += chunk;
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('error', (error) => die(`could not start the ${label}: ${error.message}`));
  return child;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main() {
  let flags;
  try {
    ({ values: flags } = parseArgs({ args: process.argv.slice(2), options: OPTIONS }));
  } catch (error) {
    die(`${error.message}\n\n${USAGE}`);
  }

  if (flags.help) {
    say(USAGE);
    return;
  }

  const email = flags.email;
  const alphaRoot = flags['alpha-root'];
  const wantsCoordination = !flags['skip-coordination'];

  if (!email) die(`--email is required\n\n${USAGE}`);
  if (wantsCoordination && !alphaRoot) {
    die(`--alpha-root is required (or pass --skip-coordination)\n\n${USAGE}`);
  }

  const port = Number.parseInt(flags.port ?? '8787', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) die('--port must be a valid port number');
  const bind = flags.bind ?? '127.0.0.1';
  const hostUrl = `http://127.0.0.1:${port}`;

  say('\n\x1b[1mAlpha host setup\x1b[0m');

  // --------------------------------------------------------------- 1. checks
  say(style.step(1, 'Checking prerequisites'));

  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (major < 20) die(`Node 20 or newer is required, this is ${process.version}`);
  say(style.ok(`Node ${process.version}`));

  let resolvedAlphaRoot = null;
  let coordinationReady = false;
  if (wantsCoordination) {
    resolvedAlphaRoot = resolve(alphaRoot);
    if (!existsSync(resolvedAlphaRoot)) {
      die(`--alpha-root does not exist: ${resolvedAlphaRoot}`);
    }
    say(style.ok(`Alpha working copy at ${resolvedAlphaRoot}`));

    const script = join(resolvedAlphaRoot, 'scripts', 'alpha_coordination_tunnel.ps1');
    if (existsSync(script)) {
      say(style.ok('Found scripts/alpha_coordination_tunnel.ps1'));
      coordinationReady = true;
    } else {
      // Not fatal: provisioning still succeeds, the handler just cannot run
      // until the path is right. Better to say so than to fail everything.
      say(style.warn(`No coordination script at ${script}`));
      say(style.info('Provisioning continues. Set ALPHA_COORDINATION_SCRIPT if it lives elsewhere.'));
    }
  }

  // ----------------------------------------------------------------- 2. .env
  say(style.step(2, 'Writing coordinator configuration'));

  const envPath = join(ROOT, '.env');
  if (existsSync(envPath) && !flags.force) {
    die(`${envPath} already exists. Move it aside, or re-run with --force to overwrite it.`);
  }

  const bootstrapToken = randomBytes(32).toString('hex');
  const envBody = [
    '# Written by scripts/setup-host.mjs',
    `ALPHA_HOST_PORT=${port}`,
    `ALPHA_HOST_BIND=${bind}`,
    'ALPHA_AUTH_STORE=./data/auth.json',
    '',
    '# Break-glass credential. Setup removes this automatically once your admin',
    '# account exists — if you see it below, setup did not finish.',
    `ALPHA_BOOTSTRAP_TOKEN=${bootstrapToken}`,
    '',
  ].join('\n');
  await writeFile(envPath, envBody, { mode: 0o600 });
  say(style.ok(`Wrote ${envPath}`));

  // -------------------------------------------------------- 3. start the host
  say(style.step(3, 'Starting the coordinator'));

  // Refuse to adopt a coordinator this script did not start. Without this,
  // an already-running instance answers the health check, provisioning then
  // talks to a server that has never heard of our bootstrap token, and the
  // whole thing fails with a baffling 401 instead of naming the real problem.
  try {
    const { body } = await fetchJson(`${hostUrl}/healthz`, { timeoutMs: 2_000 });
    if (body?.ok) {
      die(
        `something is already listening on ${hostUrl}.\n` +
          '  That is probably a coordinator you started earlier, or the alpha-coordinator\n' +
          '  service. Stop it and re-run, or pass --port to provision on a different port.',
      );
    }
  } catch {
    // Nothing there, which is what we want.
  }

  const coordinator = startProcess(join(ROOT, 'src', 'host', 'index.js'), {
    ALPHA_HOST_PORT: String(port),
    // Bind to loopback while provisioning regardless of the final setting, so
    // the window where a bootstrap token is live is not also exposed.
    ALPHA_HOST_BIND: '127.0.0.1',
    ALPHA_BOOTSTRAP_TOKEN: bootstrapToken,
    ALPHA_AUTH_STORE: join(ROOT, 'data', 'auth.json'),
    ALPHA_LOG_LEVEL: 'warn',
  }, 'coordinator');

  let adminKey;
  let agentKey;
  let userId;

  try {
    if (!(await waitForHealth(hostUrl, { child: coordinator }))) {
      die(`the coordinator did not become healthy on ${hostUrl}.\n${coordinator.log}`);
    }
    say(style.ok(`Coordinator healthy on ${hostUrl}`));

    const api = (path, options = {}) =>
      fetchJson(`${hostUrl}${path}`, { timeoutMs: 20_000, ...options }).then((r) => r.body);

    // ------------------------------------------------------- 4. admin account
    say(style.step(4, `Creating the admin account for ${email}`));

    const invite = await api('/invites', {
      method: 'POST',
      token: bootstrapToken,
      body: { email, scopes: 'admin' },
    });
    say(style.ok('Invite created'));

    say('');
    const password = await promptSecret('  Choose a password for this account (min 12 chars): ');
    if (process.stdin.isTTY) {
      const again = await promptSecret('  Confirm password: ');
      if (password !== again) die('passwords did not match');
    }

    const redeemed = await api('/invites/redeem', {
      method: 'POST',
      body: { token: invite.token, password, name: flags.name },
    });
    adminKey = redeemed.token;
    userId = redeemed.user.id;
    say(style.ok(`Account created: ${redeemed.user.email} (${userId})`));

    // ---------------------------------------------------------- 5. agent key
    say(style.step(5, 'Issuing the agent its own key'));

    const issued = await api('/keys', {
      method: 'POST',
      token: adminKey,
      body: {
        userId,
        name: flags['agent-name'] ?? 'alpha-host-agent',
        scopes: 'agent',
      },
    });
    agentKey = issued.token;
    say(style.ok(`Key issued, scoped to ${issued.key.scopes.join(', ')} only`));

    // ------------------------------------------------------ 6. agent env file
    say(style.step(6, 'Writing agent configuration'));

    const agentEnvPath = join(ROOT, '.env.agent');
    const agentLines = [
      '# Written by scripts/setup-host.mjs — the agent process reads this.',
      `ALPHA_HOST_URL=${hostUrl}`,
      `ALPHA_AGENT_KEY=${agentKey}`,
      `ALPHA_AGENT_NAME=${flags['agent-name'] ?? ''}`,
    ];
    if (wantsCoordination) {
      agentLines.push(
        '',
        'ALPHA_EXTRA_HANDLERS=alpha-coordination',
        `ALPHA_REPO_ROOT=${resolvedAlphaRoot}`,
        `ALPHA_POWERSHELL=${flags.powershell ?? 'powershell.exe'}`,
      );
    }
    await writeFile(agentEnvPath, agentLines.join('\n') + '\n', { mode: 0o600 });
    say(style.ok(`Wrote ${agentEnvPath}`));

    // --------------------------------------------------------- 7. prove it
    say(style.step(7, 'Verifying the loop end to end'));

    const agentEnv = {
      ALPHA_HOST_URL: hostUrl,
      ALPHA_AGENT_KEY: agentKey,
      ALPHA_AGENT_NAME: flags['agent-name'] ?? 'alpha-host',
      ALPHA_LOG_LEVEL: 'warn',
    };
    if (wantsCoordination) {
      agentEnv.ALPHA_EXTRA_HANDLERS = 'alpha-coordination';
      agentEnv.ALPHA_REPO_ROOT = resolvedAlphaRoot;
      agentEnv.ALPHA_POWERSHELL = flags.powershell ?? 'powershell.exe';
    }

    const agent = startProcess(join(ROOT, 'src', 'agent', 'index.js'), agentEnv, 'agent');
    try {
      const deadline = Date.now() + 20_000;
      let attached = null;
      while (Date.now() < deadline && !attached) {
        const { agents } = await api('/agents', { token: adminKey });
        attached = agents[0] ?? null;
        if (!attached) await new Promise((r) => setTimeout(r, 250));
      }
      if (!attached) die(`the agent never attached.\n${agent.log}`);
      say(style.ok(`Agent attached: ${attached.name}`));
      say(style.info(`capabilities: ${attached.capabilities.join(', ')}`));

      if (wantsCoordination && !attached.capabilities.includes('alpha.coordination')) {
        die(`the agent attached without the coordination handler.\n${agent.log}`);
      }

      // An echo task proves dispatch and reporting without touching the real
      // coordination script — that first run should be yours, deliberately.
      const queued = await api('/tasks', {
        method: 'POST',
        token: adminKey,
        body: { type: 'echo', payload: { setup: true } },
      });
      let finished = null;
      const taskDeadline = Date.now() + 20_000;
      while (Date.now() < taskDeadline && !finished) {
        const task = await api(`/tasks/${queued.id}`, { token: adminKey });
        if (task.status === 'succeeded' || task.status === 'failed') finished = task;
        else await new Promise((r) => setTimeout(r, 200));
      }
      if (finished?.status !== 'succeeded') {
        die(`the round trip did not complete.\n${agent.log}`);
      }
      say(style.ok('Task dispatched, executed and reported back'));
    } finally {
      await stopProcess(agent);
    }
  } finally {
    await stopProcess(coordinator);
  }

  // ------------------------------------------- 8. remove the bootstrap token
  say(style.step(8, 'Removing the break-glass credential'));

  const written = await readFile(envPath, 'utf8');
  const cleaned = written
    .split('\n')
    .filter((line) => !line.startsWith('ALPHA_BOOTSTRAP_TOKEN='))
    .filter((line) => !line.startsWith('# Break-glass credential'))
    .filter((line) => !line.startsWith('# account exists'))
    .join('\n');
  await writeFile(envPath, cleaned, { mode: 0o600 });
  // It has done its job. Leaving it in place would keep an unscoped,
  // unattributable credential valid for as long as the file exists.
  say(style.ok('Bootstrap token removed from .env — issued keys are now the only way in'));

  await mkdir(join(ROOT, 'logs'), { recursive: true });

  const node = process.execPath;
  say(`
\x1b[1mDone.\x1b[0m Two credentials, both shown once:

  \x1b[1mYour admin key\x1b[0m (set as ALPHA_ADMIN_TOKEN to use the CLI)
    ${adminKey}

  \x1b[1mAgent key\x1b[0m (already written to .env.agent — no need to copy it)
    ${agentKey}

Store the admin key in a password manager now. It cannot be shown again.

\x1b[1mRun both processes\x1b[0m — in two terminals, to check it live:

    npm run host
    npm run agent

\x1b[1mOr install them as services\x1b[0m so they survive a reboot (needs NSSM):

    nssm install alpha-coordinator "${node}" "${join(ROOT, 'src', 'host', 'index.js')}"
    nssm set alpha-coordinator AppDirectory ${ROOT}
    nssm set alpha-coordinator AppStdout ${join(ROOT, 'logs', 'host.log')}
    nssm set alpha-coordinator AppStderr ${join(ROOT, 'logs', 'host.log')}

    nssm install alpha-agent "${node}" "${join(ROOT, 'src', 'agent', 'index.js')}"
    nssm set alpha-agent AppDirectory ${ROOT}
    nssm set alpha-agent AppStdout ${join(ROOT, 'logs', 'agent.log')}
    nssm set alpha-agent AppStderr ${join(ROOT, 'logs', 'agent.log')}

    nssm start alpha-coordinator
    nssm start alpha-agent
${
  wantsCoordination
    ? `
\x1b[1mBefore trusting the coordination handler\x1b[0m, confirm the script's real
contract — it was written without access to it. Run a read-only Status first:

    curl.exe -s -X POST ${hostUrl}/tasks ^
      -H "Authorization: Bearer <your admin key>" ^
      -H "content-type: application/json" ^
      -d "{\\"type\\":\\"alpha.coordination\\",\\"payload\\":{\\"action\\":\\"Status\\",\\"actor\\":\\"alpha-host\\"}}"

See "Verify the contract" in docs/HOST_SETUP.md.
`
    : ''
}${
    bind !== '127.0.0.1'
      ? `\n\x1b[33mNote:\x1b[0m .env binds the coordinator to ${bind}. Make sure that is a\nTailscale address and not a public interface.\n`
      : `\nThe coordinator is bound to 127.0.0.1. To reach it from the laptop, set\nALPHA_HOST_BIND to this machine's Tailscale address in .env — see step 8 of\ndocs/HOST_SETUP.md.\n`
  }`);
}

main().catch((error) => {
  if (error instanceof HttpError) {
    die(`HTTP ${error.status} from ${error.url}: ${error.body?.message ?? error.body?.error ?? ''}`);
  }
  die(error.stack ?? error.message);
});

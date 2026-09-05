#!/usr/bin/env node
/**
 * One-command provisioning for a worker machine — the laptop.
 *
 * The host has scripts/setup-host.mjs, which provisions the coordinator and
 * the agent that runs beside it. This is the other end: run it on the machine
 * that is lending the host its capacity, once someone with `keys:write` on the
 * host has issued this machine a key.
 *
 * It checks the host is reachable and the key is the right kind, works out how
 * much RAM to offer, writes .env.agent, then actually attaches for a moment to
 * prove the whole loop before telling you it worked.
 *
 * Node rather than a shell script, for the same reason as setup-host.mjs: it
 * runs identically on the Windows laptop and the Linux one, and Node is
 * already a prerequisite.
 */

import os from 'node:os';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { fetchJson, HttpError } from '../src/common/http.js';
import { promptSecret } from '../src/common/prompt.js';
import { SCOPES, hasScope } from '../src/host/auth/scopes.js';
import { memorySnapshot } from '../src/agent/memory.js';
import { LoadSampler, maxLoadFromEnv, concurrencyFromEnv } from '../src/agent/load.js';
import {
  PROTOCOL_VERSION,
  DEFAULT_MAX_LOAD,
  DEFAULT_AGENT_CONCURRENCY,
  MB,
} from '../src/common/protocol.js';
import { ALPHA_VERSION } from '../src/common/version.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `
setup-agent — attach this machine to the Alpha host as a worker

  node scripts/setup-agent.mjs --host http://100.x.y.z:8787 --key alpha_key_...

Options
  --host <url>        Where the coordinator is reachable from here (required)
  --key <k>           This machine's agent key. Prompted for if omitted
  --name <n>          Name this machine shows as. Defaults to the hostname
  --reserve-mb <n>    RAM kept for this machine. Default: a quarter of it,
                      between 512 and 4096
  --max-load <n>      Share of this machine's cores above which it stops
                      asking for work. Default: ${DEFAULT_MAX_LOAD}
  --concurrency <n>   Tasks to run at once here. Default: ${DEFAULT_AGENT_CONCURRENCY}
  --memstore          Also let the host park data in this machine's RAM
  --memstore-mb <n>   Budget for that store. Default: the agent's own default
  --capabilities <l>  Comma-separated task types to accept. Default: all
  --skip-verify       Write the configuration without attaching to prove it
  --force             Overwrite an existing .env.agent
  --help              This message

Ask for a key on the host with:
  npm run admin -- issue-key --user <userId> --scopes agent --name laptop
`.trim();

const OPTIONS = {
  host: { type: 'string' },
  key: { type: 'string' },
  name: { type: 'string' },
  'reserve-mb': { type: 'string' },
  'max-load': { type: 'string' },
  concurrency: { type: 'string' },
  memstore: { type: 'boolean' },
  'memstore-mb': { type: 'string' },
  capabilities: { type: 'string' },
  'skip-verify': { type: 'boolean' },
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
const mb = (bytes) => `${Math.round(bytes / MB)} MB`;

function die(message) {
  process.stderr.write(`\n\x1b[31mSetup failed:\x1b[0m ${message}\n`);
  process.exit(1);
}

// ------------------------------------------------------------ pure decisions

/**
 * What to hold back for this machine when nobody says.
 *
 * A quarter of RAM, floored at 512 MB so a small machine still keeps enough to
 * work in, and capped at 4 GB so a large one does not sit on most of itself.
 */
export function defaultReserveBytes(totalBytes) {
  const quarter = Math.floor(totalBytes / 4);
  return Math.min(Math.max(quarter, 512 * MB), 4096 * MB);
}

export function normalizeHostUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('--host is required, e.g. --host http://100.x.y.z:8787');
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`--host is not a URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`--host must be http or https, got ${url.protocol}`);
  }
  return url.origin;
}

export function parseMegabytes(value, field) {
  if (value === undefined) return null;
  const mbValue = Number(value);
  if (!Number.isFinite(mbValue) || mbValue < 0 || !Number.isInteger(mbValue)) {
    throw new Error(`${field} must be a whole number of MB, got ${JSON.stringify(value)}`);
  }
  return mbValue;
}

/** The .env.agent this machine will run with. */
export function renderAgentEnv({
  hostUrl,
  key,
  name = '',
  reserveMB,
  maxLoad = DEFAULT_MAX_LOAD,
  concurrency = DEFAULT_AGENT_CONCURRENCY,
  capabilities = '',
  memstore = false,
  memstoreMB = null,
}) {
  const lines = [
    '# Written by scripts/setup-agent.mjs — the agent process reads this first,',
    '# ahead of .env, and a real environment variable beats both.',
    `ALPHA_HOST_URL=${hostUrl}`,
    `ALPHA_AGENT_KEY=${key}`,
    `ALPHA_AGENT_NAME=${name}`,
    '',
    '# RAM kept for this machine. Everything above it is offered to the host.',
    `ALPHA_AGENT_MEMORY_RESERVE_MB=${reserveMB}`,
    '',
    '# The CPU half of the same bargain. Above this share of its own cores this',
    '# machine stops asking for work, so the next task goes to one with cores',
    '# free. It keeps heartbeating throughout and resumes when the load drops.',
    `ALPHA_AGENT_MAX_LOAD=${maxLoad}`,
    '',
    '# Tasks to run here at once. Raise it on a machine with cores to spare —',
    '# the ceiling above stops it overcommitting.',
    `ALPHA_AGENT_CONCURRENCY=${concurrency}`,
  ];
  if (capabilities) {
    lines.push('', '# Only these task types are accepted from the host.', `ALPHA_AGENT_CAPABILITIES=${capabilities}`);
  }
  if (memstore) {
    lines.push('', '# Lets the host park data in this machine\'s RAM by key.', 'ALPHA_EXTRA_HANDLERS=memstore');
    if (memstoreMB !== null) lines.push(`ALPHA_MEMSTORE_LIMIT_MB=${memstoreMB}`);
  }
  return lines.join('\n') + '\n';
}

/** Platform-appropriate "keep it running" instructions. */
export function serviceHint(platform, { node, root }) {
  const entry = join(root, 'src', 'agent', 'index.js');
  if (platform === 'win32') {
    return [
      'Keep it running across reboots (needs NSSM):',
      '',
      `    nssm install alpha-agent "${node}" "${entry}"`,
      `    nssm set alpha-agent AppDirectory ${root}`,
      `    nssm set alpha-agent AppStdout ${join(root, 'logs', 'agent.log')}`,
      '    nssm start alpha-agent',
    ].join('\n');
  }
  if (platform === 'darwin') {
    return [
      'Keep it running across reboots with a launchd agent:',
      '',
      `    ~/Library/LaunchAgents/com.alpha.agent.plist → ${node} ${entry}`,
      '    launchctl load -w ~/Library/LaunchAgents/com.alpha.agent.plist',
    ].join('\n');
  }
  return [
    'Keep it running across reboots with a user service:',
    '',
    '    systemctl --user edit --full --force alpha-agent.service',
    `      ExecStart=${node} ${entry}`,
    `      WorkingDirectory=${root}`,
    '    systemctl --user enable --now alpha-agent',
    '    loginctl enable-linger "$USER"   # so it runs while logged out',
  ].join('\n');
}

// ------------------------------------------------------------------ the loop

/** Runs the real agent briefly and waits for it to say it attached. */
function attachOnce({ timeoutMs = 25_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(ROOT, 'src', 'agent', 'index.js')], {
      cwd: ROOT,
      // No env overrides: this proves .env.agent as written, not as imagined.
      env: { ...process.env, ALPHA_LOG_LEVEL: 'info' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let log = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      const hard = setTimeout(() => child.kill('SIGKILL'), 5_000);
      child.once('exit', () => clearTimeout(hard));
      resolvePromise({ ...result, log });
    };

    const timer = setTimeout(() => finish({ attached: false, reason: 'timed out' }), timeoutMs);

    const read = (chunk) => {
      log += chunk;
      if (/registered with host/.test(log)) finish({ attached: true });
      // Fail fast on the two the operator can actually act on, rather than
      // watching the agent back off and retry until the timeout.
      else if (/rejected the token/.test(log)) finish({ attached: false, reason: 'the host rejected this key' });
      else if (/insufficient_scope/.test(log)) finish({ attached: false, reason: 'this key lacks agent:connect' });
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', (error) => finish({ attached: false, reason: error.message }));
    child.on('exit', (code) => {
      if (code !== 0) finish({ attached: false, reason: `the agent exited with code ${code}` });
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

  let hostUrl;
  let reserveOverrideMB;
  let memstoreMB;
  let maxLoad;
  let concurrency;
  try {
    hostUrl = normalizeHostUrl(flags.host);
    reserveOverrideMB = parseMegabytes(flags['reserve-mb'], '--reserve-mb');
    memstoreMB = parseMegabytes(flags['memstore-mb'], '--memstore-mb');
    // Same parsers the agent itself uses, so a value setup accepts is one the
    // agent will start with — rather than one it rejects on first run.
    maxLoad = maxLoadFromEnv(flags['max-load'], DEFAULT_MAX_LOAD);
    concurrency = concurrencyFromEnv(flags.concurrency, DEFAULT_AGENT_CONCURRENCY);
  } catch (error) {
    die(`${error.message}\n\n${USAGE}`);
  }
  if (memstoreMB !== null && !flags.memstore) {
    die('--memstore-mb only means something with --memstore');
  }

  const name = flags.name ?? os.hostname();

  // Checked before anything else asks for a key or touches the network: a
  // re-run should fail on the second line, not after the operator has typed
  // a credential.
  const envPath = join(ROOT, '.env.agent');
  if (existsSync(envPath) && !flags.force) {
    die(`${envPath} already exists. Move it aside, or re-run with --force to overwrite it.`);
  }

  say('\n\x1b[1mAlpha worker setup\x1b[0m — lending this machine to the host');

  // --------------------------------------------------------------- 1. checks
  say(style.step(1, 'Checking this machine'));

  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (major < 20) die(`Node 20 or newer is required, this is ${process.version}`);
  say(style.ok(`Node ${process.version} on ${process.platform}`));

  const total = os.totalmem();
  const reserveBytes =
    reserveOverrideMB === null ? defaultReserveBytes(total) : reserveOverrideMB * MB;
  if (reserveBytes >= total) {
    die(`--reserve-mb ${reserveOverrideMB} is all of this machine's ${mb(total)}; nothing would be offered`);
  }
  const snapshot = memorySnapshot({ reserveBytes });
  say(style.ok(`${mb(total)} of RAM, ${mb(snapshot.freeBytes)} available right now`));
  say(style.info(`keeping ${mb(reserveBytes)} for this machine, offering ${mb(snapshot.offerableBytes)}`));
  if (snapshot.offerableBytes === 0) {
    say(style.warn('nothing to offer at the moment — the host will use it once memory frees up'));
  }

  // The CPU side of what this machine is lending. Shown here because the whole
  // point of the ceiling is that an operator can see what it will do: a laptop
  // already over it will attach, heartbeat, and quite correctly decline work
  // until it quietens down — which looks like a broken setup if unexplained.
  const load = new LoadSampler().snapshot();
  const asPercent = (value) => `${Math.round(value * 100)}%`;
  say(style.ok(`${load.cpus} cores, running ${concurrency} task${concurrency === 1 ? '' : 's'} at a time`));
  if (load.loadFactor === null) {
    say(style.info(`standing aside above ${asPercent(maxLoad)} load (not measurable yet on this machine)`));
  } else {
    say(style.info(`load ${asPercent(load.loadFactor)} now; standing aside above ${asPercent(maxLoad)}`));
    if (load.loadFactor >= maxLoad) {
      say(style.warn('this machine is over the ceiling right now, so it will attach but decline work'));
      say(style.info('that is the feature working — it takes work again as soon as the load drops'));
    }
  }
  if (load.loadAverage1 === null) {
    // Worth saying on Windows: os.loadavg() is [0,0,0] there, so the whole
    // picture comes from sampled CPU ticks and cannot exceed 100%.
    say(style.info('no load average on this platform; load comes from sampled CPU ticks'));
  }

  // ----------------------------------------------------------- 2. reach host
  say(style.step(2, `Reaching the host at ${hostUrl}`));

  let health;
  try {
    ({ body: health } = await fetchJson(`${hostUrl}/healthz`, { timeoutMs: 10_000 }));
  } catch (error) {
    die(
      `could not reach ${hostUrl}: ${error.message}\n` +
        '  Check the coordinator is running, that ALPHA_HOST_BIND covers the address\n' +
        '  you are dialling, and that this machine is on the same Tailscale network.',
    );
  }
  if (!health?.ok) die(`${hostUrl} answered, but not as a coordinator`);
  say(style.ok(`Coordinator answering, protocol ${health.protocolVersion}`));
  if (health.protocolVersion !== PROTOCOL_VERSION) {
    die(
      `the host speaks protocol ${health.protocolVersion}, this checkout speaks ${PROTOCOL_VERSION}.\n` +
        '  Update this machine to the host\'s version before attaching.',
    );
  }
  // Same protocol, different release: the agent will attach and work, so this
  // is a warning rather than a stop — but it is exactly the drift that makes
  // one machine behave unlike the other, so say it plainly.
  if (!health.version) {
    say(style.warn(`host does not report a version; this machine is ${ALPHA_VERSION}`));
  } else if (health.version === ALPHA_VERSION) {
    say(style.ok(`Both machines on Alpha ${ALPHA_VERSION}`));
  } else {
    say(style.warn(`host runs Alpha ${health.version}, this machine runs ${ALPHA_VERSION}`));
    say(style.info('git pull on whichever machine is behind so both run the same version'));
  }

  // ------------------------------------------------------------ 3. the key
  say(style.step(3, 'Checking this machine\'s key'));

  const key = flags.key ?? (await promptSecret('  Agent key for this machine: '));
  if (!key) die(`no key given.\n\n${USAGE}`);

  let me;
  try {
    ({ body: me } = await fetchJson(`${hostUrl}/me`, { token: key, timeoutMs: 10_000 }));
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      die(
        'the host does not accept this key. It may be revoked, expired, or from another host.\n' +
          '  Issue a fresh one there:\n' +
          '    npm run admin -- issue-key --user <userId> --scopes agent --name laptop',
      );
    }
    die(`could not check the key: ${error.message}`);
  }
  if (!hasScope(me.scopes, SCOPES.AGENT_CONNECT)) {
    die(
      `this key is "${me.label}" with scopes ${me.scopes.join(', ')} — no agent:connect,\n` +
        '  so it cannot attach as a worker. Issue one scoped to `agent` instead.',
    );
  }
  say(style.ok(`Accepted as ${me.label} (${me.scopes.join(', ')})`));
  if (me.scopes.length > 1) {
    // Not fatal, but a worker key that can also queue work or read users is a
    // wider credential than this machine needs to do its job.
    say(style.warn('this key can do more than attach; a key scoped to `agent` alone is safer here'));
  }

  // ----------------------------------------------------------- 4. write .env
  say(style.step(4, 'Writing this machine\'s configuration'));

  await writeFile(
    envPath,
    renderAgentEnv({
      hostUrl,
      key,
      name,
      reserveMB: Math.round(reserveBytes / MB),
      maxLoad,
      concurrency,
      capabilities: flags.capabilities ?? '',
      memstore: Boolean(flags.memstore),
      memstoreMB,
    }),
    { mode: 0o600 },
  );
  say(style.ok(`Wrote ${envPath}`));
  say(style.info('it holds this machine\'s key — it is gitignored, keep it that way'));

  // -------------------------------------------------------------- 5. prove it
  if (flags['skip-verify']) {
    say(style.step(5, 'Skipping the attach check as asked'));
  } else {
    say(style.step(5, 'Attaching, to prove the whole loop'));
    const result = await attachOnce();
    if (!result.attached) {
      die(`the agent did not attach (${result.reason}).\n${result.log}`);
    }
    say(style.ok(`Attached to the host as "${name}"`));
    const offered = /offerableMB=(\d+)/.exec(result.log);
    if (offered) say(style.info(`offering ${offered[1]} MB of RAM to the host`));
  }

  say(`
\x1b[1mDone.\x1b[0m Start lending:

    npm run agent

Then, from the host or anywhere with an operator key:

    npm run admin -- agents                       # this machine: RAM, load, tasks running
    npm run admin -- task --type sysinfo --min-memory-mb 1024${
      flags.memstore
        ? `
    npm run admin -- mem --action stats           # the store on this machine`
        : ''
    }

${serviceHint(process.platform, { node: process.execPath, root: ROOT })}
`);
}

// Importable for its decisions, runnable as a script — but only when it *is*
// the script, so a test importing it does not provision anything.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (error instanceof HttpError) {
      die(`HTTP ${error.status} from ${error.url}: ${error.body?.message ?? error.body?.error ?? ''}`);
    }
    die(error.stack ?? error.message);
  });
}

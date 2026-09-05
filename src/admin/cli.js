import { parseArgs } from 'node:util';

import { fetchJson, HttpError } from '../common/http.js';
import { loadEnv } from '../common/env.js';
import { promptSecret } from '../common/prompt.js';
import { ALPHA_VERSION } from '../common/version.js';

loadEnv();

const HOST = (process.env.ALPHA_HOST_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const TOKEN =
  process.env.ALPHA_ADMIN_TOKEN ??
  process.env.ALPHA_BOOTSTRAP_TOKEN ??
  process.env.ALPHA_TUNNEL_TOKEN;

const USAGE = `
alpha-admin — manage users, invites and keys on the Alpha host

  Host:  ALPHA_HOST_URL      (default http://127.0.0.1:8787)
  Auth:  ALPHA_ADMIN_TOKEN   (or ALPHA_BOOTSTRAP_TOKEN on a fresh install)

Invites
  invite --email <e> --scopes <s> [--expires-days <n>]   Create an invite
  invites [--status pending|redeemed|expired|revoked]    List invites
  revoke-invite <inviteId>                               Revoke before redemption
  redeem --token <t> [--name <n>]                        Redeem (prompts for password)

Users
  users                                                  List users
  disable-user <userId>                                  Revoke all access at once
  enable-user <userId>                                   Restore access
  set-scopes <userId> --scopes <s>                       Replace a user's scopes

Keys
  issue-key --user <userId> [--scopes <s>] [--name <n>] [--expires-days <n>]
  keys [--user <userId>]                                 List keys
  revoke-key <keyId>                                     Revoke one credential

Tasks
  task --type <t> [--payload <json>] [--min-memory-mb <n>] [--no-wait]
                                                         Queue a task, await result
  coord --action <a> [--actor <n>] [--message <m>] [--paths <a,b>]
                                                         Drive the coordination tunnel
  tasks [--status queued|leased|succeeded|failed]        List recent tasks

  agents                                                 List attached agents, their free RAM, CPU load and version
  stats                                                  Fleet summary: queue, capacity, how work is spread

Borrowed memory
  mem --action stats                                     Store usage on the agent
  mem --action put --key <k> --value <json> [--ttl-ms <n>]
  mem --action get|delete --key <k>
  mem --action keys [--prefix <p>]
  mem --action clear

Session
  login --email <e>                                      Prompts for password
  whoami                                                 Show the current principal
  scopes                                                 List scopes and presets
  version                                                Compare this checkout's version with the host's

Scopes may be a comma-separated list, or a preset: admin, operator, agent, viewer.
"--scopes admin" (or "*") grants everything, including issuing credentials.
`.trim();

function fail(message, { usage = false } = {}) {
  process.stderr.write(`${message}\n${usage ? `\n${USAGE}\n` : ''}`);
  process.exit(1);
}

async function api(path, { method = 'GET', body, anonymous = false } = {}) {
  if (!anonymous && !TOKEN) {
    fail('No credential. Set ALPHA_ADMIN_TOKEN (or ALPHA_BOOTSTRAP_TOKEN on a fresh install).');
  }
  try {
    const { body: result } = await fetchJson(`${HOST}${path}`, {
      method,
      body,
      token: anonymous ? undefined : TOKEN,
      timeoutMs: 20_000,
    });
    return result;
  } catch (error) {
    if (error instanceof HttpError) {
      const detail = error.body?.message ?? error.body?.error ?? '';
      fail(`${method} ${path} failed: HTTP ${error.status}${detail ? ` — ${detail}` : ''}`);
    }
    fail(`${method} ${path} failed: ${error.message}`);
  }
}

/** Polls a queued task until it reaches a terminal state. */
async function awaitTask(taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await api(`/tasks/${taskId}`);
    if (last.status !== 'queued' && last.status !== 'leased') return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail(
    `task ${taskId} was still ${last?.status ?? 'pending'} after ${Math.round(timeoutMs / 1000)}s.\n` +
      'If it never left "queued", no attached agent offers that type — check `alpha-admin agents`.',
  );
}

/** Renders a finished task, giving coordination results their own shape. */
function reportTask(task, flags) {
  if (flags.json) {
    process.stdout.write(JSON.stringify(task, null, 2) + '\n');
    return;
  }
  process.stdout.write(`Task ${task.id} — ${task.status} (attempt ${task.attempts})\n`);

  const result = task.result;
  if (result && typeof result === 'object' && 'exitCode' in result) {
    process.stdout.write(`  exit code: ${result.exitCode}\n`);
    if (result.stdout?.trim()) {
      process.stdout.write(`\n  --- stdout ---\n${indent(result.stdout)}\n`);
    }
    if (result.stderr?.trim()) {
      process.stdout.write(`\n  --- stderr ---\n${indent(result.stderr)}\n`);
    }
    if (result.exitCode !== 0) {
      // The task ran fine; the script itself said no. Worth spelling out,
      // because "succeeded" next to a non-zero exit code reads as a mistake.
      process.stdout.write(
        `\n  The task ran; the script exited ${result.exitCode}. ` +
          'That is the tunnel answering, not a failure to run it.\n',
      );
    }
    return;
  }

  if (task.error) process.stdout.write(`  error: ${task.error.message}\n`);
  if (result !== null && result !== undefined) {
    process.stdout.write(`  result: ${JSON.stringify(result, null, 2)}\n`);
  }
}

const indent = (text) => text.trimEnd().split('\n').map((line) => `  | ${line}`).join('\n');

function table(rows, columns) {
  if (rows.length === 0) {
    process.stdout.write('(none)\n');
    return;
  }
  const widths = columns.map((col) =>
    Math.max(col.header.length, ...rows.map((row) => String(col.value(row) ?? '').length)),
  );
  const line = (cells) => cells.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  ');
  process.stdout.write(line(columns.map((c) => c.header)) + '\n');
  process.stdout.write(widths.map((w) => '-'.repeat(w)).join('  ') + '\n');
  for (const row of rows) process.stdout.write(line(columns.map((c) => c.value(row))) + '\n');
}

const mb = (bytes) => (Number.isFinite(bytes) ? `${Math.round(bytes / (1024 * 1024))}M` : '-');

// Share of the machine's cores in use, as a percentage. "-" means the agent
// has not reported load, or its last report went stale — which the host reads
// as unknown, not as idle.
const load = (agent) =>
  Number.isFinite(agent.loadFactor) ? `${Math.round(agent.loadFactor * 100)}%` : '-';

const when = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '-');
const days = (value) => (value === undefined ? undefined : Number(value) * 24 * 60 * 60 * 1_000);

const OPTIONS = {
  email: { type: 'string' },
  scopes: { type: 'string' },
  name: { type: 'string' },
  user: { type: 'string' },
  token: { type: 'string' },
  status: { type: 'string' },
  'expires-days': { type: 'string' },
  type: { type: 'string' },
  payload: { type: 'string' },
  action: { type: 'string' },
  actor: { type: 'string' },
  message: { type: 'string' },
  paths: { type: 'string' },
  'lease-ms': { type: 'string' },
  'min-memory-mb': { type: 'string' },
  key: { type: 'string' },
  value: { type: 'string' },
  prefix: { type: 'string' },
  'ttl-ms': { type: 'string' },
  'no-wait': { type: 'boolean' },
  timeout: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    fail(error.message, { usage: true });
  }
  const { values: flags, positionals } = parsed;
  const command = positionals[0];

  if (!command || flags.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const emit = (label, value) => {
    if (flags.json) process.stdout.write(JSON.stringify(value, null, 2) + '\n');
    else process.stdout.write(`${label}\n`);
  };

  switch (command) {
    case 'invite':
    case 'bootstrap-admin': {
      if (!flags.email) fail(`${command} requires --email`);
      const scopes = command === 'bootstrap-admin' ? 'admin' : flags.scopes;
      if (!scopes) fail('invite requires --scopes (e.g. --scopes operator, or --scopes admin)');

      const result = await api('/invites', {
        method: 'POST',
        body: { email: flags.email, scopes, expiresInMs: days(flags['expires-days']) },
      });

      if (flags.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return;
      }
      process.stdout.write(
        `Invite created for ${result.invite.email}\n` +
          `  scopes:   ${result.invite.scopes.join(', ')}\n` +
          `  expires:  ${when(result.invite.expiresAt)}\n` +
          `  id:       ${result.invite.id}\n\n` +
          `Send them this token. It is shown once and cannot be retrieved again:\n\n` +
          `  ${result.token}\n\n` +
          `They redeem it with:\n` +
          `  ALPHA_HOST_URL=${HOST} npm run admin -- redeem --token '${result.token}'\n\n` +
          `Revoke it any time before redemption:\n` +
          `  npm run admin -- revoke-invite ${result.invite.id}\n`,
      );
      return;
    }

    case 'invites': {
      const { invites } = await api(
        `/invites${flags.status ? `?status=${encodeURIComponent(flags.status)}` : ''}`,
      );
      if (flags.json) return emit('', invites);
      table(invites, [
        { header: 'ID', value: (i) => i.id },
        { header: 'EMAIL', value: (i) => i.email },
        { header: 'SCOPES', value: (i) => i.scopes.join(',') },
        { header: 'STATUS', value: (i) => i.status },
        { header: 'EXPIRES', value: (i) => when(i.expiresAt) },
      ]);
      return;
    }

    case 'revoke-invite': {
      if (!positionals[1]) fail('revoke-invite requires an invite id');
      const result = await api(`/invites/${positionals[1]}`, { method: 'DELETE' });
      emit(`Invite ${result.invite.id} revoked (${result.invite.email}).`, result);
      return;
    }

    case 'redeem': {
      if (!flags.token) fail('redeem requires --token');
      const preview = await api('/invites/preview', {
        method: 'POST',
        anonymous: true,
        body: { token: flags.token },
      });
      process.stdout.write(
        `Invite for ${preview.email}\n  scopes: ${preview.scopes.join(', ')}\n` +
          `  expires: ${when(preview.expiresAt)}\n\n`,
      );

      const password = await promptSecret('Choose a password (min 12 chars): ');
      if (process.stdin.isTTY) {
        const again = await promptSecret('Confirm password: ');
        if (password !== again) fail('passwords did not match');
      }

      const result = await api('/invites/redeem', {
        method: 'POST',
        anonymous: true,
        body: { token: flags.token, password, name: flags.name },
      });
      if (flags.json) return emit('', result);
      process.stdout.write(
        `\nAccount created for ${result.user.email}\n` +
          `  userId: ${result.user.id}\n` +
          `  scopes: ${result.user.scopes.join(', ')}\n\n` +
          `Your API key — shown once, store it somewhere safe:\n\n  ${result.token}\n\n` +
          `Use it as ALPHA_ADMIN_TOKEN for this CLI, or ALPHA_AGENT_KEY for a worker.\n`,
      );
      return;
    }

    case 'task':
    case 'coord':
    case 'mem': {
      let type;
      let payload;

      if (command === 'mem') {
        // The laptop's RAM, addressed by key. `stats` is the harmless default,
        // so `mem` on its own answers "how much is being held over there?".
        type = flags.type ?? 'memory.store';
        payload = { action: flags.action ?? 'stats' };
        if (flags.key) payload.key = flags.key;
        if (flags.prefix) payload.prefix = flags.prefix;
        if (flags['ttl-ms']) payload.ttlMs = Number.parseInt(flags['ttl-ms'], 10);
        if (flags.value !== undefined) {
          try {
            payload.value = JSON.parse(flags.value);
          } catch (error) {
            fail(`--value is not valid JSON: ${error.message}`);
          }
        }
        if (payload.action === 'put' && payload.value === undefined) {
          fail('mem --action put requires --value <json>');
        }
      } else if (command === 'coord') {
        if (!flags.action) fail('coord requires --action (Init, Claim, Post, Release or Status)');
        type = flags.type ?? 'alpha.coordination';
        payload = {
          action: flags.action,
          actor: flags.actor ?? process.env.ALPHA_COORDINATION_ACTOR,
        };
        if (flags.message) payload.message = flags.message;
        if (flags.paths) {
          payload.paths = flags.paths.split(',').map((entry) => entry.trim()).filter(Boolean);
        }
        if (!payload.actor) fail('coord requires --actor (or set ALPHA_COORDINATION_ACTOR)');
      } else {
        if (!flags.type) fail('task requires --type');
        type = flags.type;
        try {
          payload = flags.payload ? JSON.parse(flags.payload) : {};
        } catch (error) {
          fail(`--payload is not valid JSON: ${error.message}`);
        }
      }

      const body = { type, payload };
      if (flags['lease-ms']) body.leaseMs = Number.parseInt(flags['lease-ms'], 10);
      if (flags['min-memory-mb']) body.minMemoryMB = Number.parseInt(flags['min-memory-mb'], 10);

      const queued = await api('/tasks', { method: 'POST', body });

      if (!queued.agentAvailable) {
        // Not fatal — it runs as soon as a capable agent attaches — but silence
        // here is how you end up staring at a task that never moves.
        process.stderr.write(
          queued.memoryAvailable === false
            ? `warning: an agent offers "${type}", but none has ${body.minMemoryMB} MB free ` +
              'right now. The task is queued until one does.\n'
            : `warning: no attached agent currently offers "${type}". The task is queued.\n`,
        );
      }
      if (flags['no-wait']) {
        emit(`Queued ${queued.id} (${queued.status}).`, queued);
        return;
      }

      const timeoutMs = Number.parseInt(flags.timeout ?? '60', 10) * 1_000;
      reportTask(await awaitTask(queued.id, timeoutMs), flags);
      return;
    }

    case 'tasks': {
      const { tasks } = await api(
        `/tasks?limit=20${flags.status ? `&status=${encodeURIComponent(flags.status)}` : ''}`,
      );
      if (flags.json) return emit('', tasks);
      table(tasks, [
        { header: 'ID', value: (t) => t.id },
        { header: 'TYPE', value: (t) => t.type },
        { header: 'STATUS', value: (t) => t.status },
        { header: 'TRIES', value: (t) => t.attempts },
        { header: 'CREATED', value: (t) => when(t.createdAt) },
      ]);
      return;
    }

    case 'agents': {
      const { agents, hostVersion } = await api('/agents');
      if (flags.json) return emit('', agents);
      const drifted = agents.filter((a) => a.version && a.version !== hostVersion);
      table(agents, [
        { header: 'NAME', value: (a) => a.name },
        { header: 'PRINCIPAL', value: (a) => a.principal ?? '-' },
        // A machine on another release still works — the protocol gate passed —
        // but it is running different code, so mark it rather than hide it.
        { header: 'VERSION', value: (a) => (a.version ? (a.version === hostVersion ? a.version : `${a.version} *`) : '-') },
        { header: 'CAPABILITIES', value: (a) => a.capabilities.join(',') },
        { header: 'RAM', value: (a) => mb(a.memory?.totalBytes) },
        // What is left to place work against: offered, minus what the tasks
        // this agent is already holding have claimed.
        { header: 'FREE', value: (a) => mb(a.availableBytes) },
        { header: 'HELD', value: (a) => mb(a.reservedBytes) },
        // The other half of placement. CPU is the reason work goes to one
        // laptop rather than the other when both have RAM to spare, so it
        // belongs next to the memory columns rather than behind --json.
        { header: 'CPU', value: (a) => load(a) },
        { header: 'RUN', value: (a) => a.inFlight ?? 0 },
        { header: 'IDLE', value: (a) => `${Math.round(a.idleMs / 1000)}s` },
      ]);
      if (drifted.length) {
        emit(
          `\n* not the host's version (${hostVersion}). Update ` +
            `${drifted.map((a) => a.name).join(', ')} so every machine runs the same version.`,
        );
      }
      return;
    }

    // The fleet at a glance. The question it exists to answer is the one you
    // ask when work feels slow: is it piling onto one machine, or are they
    // genuinely all busy? `busiest` next to `idlest` is what says which.
    case 'stats': {
      const stats = await api('/stats');
      if (flags.json) return emit('', stats);

      const pct = (value) => (Number.isFinite(value) ? `${Math.round(value * 100)}%` : '-');
      emit(`Alpha ${stats.version} — ${stats.agents} agent(s) attached`);
      emit(`  capabilities   ${stats.capabilities.join(', ') || '(none)'}`);
      emit(`  queue          ${stats.queue.pending} pending, ${stats.queue.waiters} agent(s) waiting`);
      emit(`  offered RAM    ${mb(stats.memory.offeredBytes)}${
        stats.memory.blockedTasks ? `, ${stats.memory.blockedTasks} task(s) waiting on memory` : ''
      }`);

      const load = stats.load ?? {};
      emit(
        `  load           busiest ${pct(load.busiest)}, idlest ${pct(load.idlest)}, ` +
          `${load.tasksInFlight ?? 0} task(s) running`,
      );
      if (load.unknown) emit(`                 ${load.unknown} agent(s) not reporting load`);

      // The whole point of showing the two together, spelled out rather than
      // left to the reader.
      if (Number.isFinite(load.busiest) && Number.isFinite(load.idlest)) {
        if (load.busiest - load.idlest > 0.4) {
          emit('\n  Work is not spread evenly — one machine is far busier than another.');
        } else if (load.idlest > 0.85) {
          emit('\n  Every machine is near capacity. Another worker is the only thing that helps.');
        }
      }
      return;
    }

    // Answers "are we both on the same version?" from whichever machine you
    // happen to be sitting at, without needing a key that can read /agents.
    case 'version': {
      const health = await fetchJson(`${HOST}/healthz`, { timeoutMs: 10_000 })
        .then((r) => r.body)
        .catch(() => null);
      const hostVersion = health?.version ?? null;
      if (flags.json) return emit('', { version: ALPHA_VERSION, hostVersion, host: HOST });
      emit(`This checkout: ${ALPHA_VERSION}`);
      if (!hostVersion) {
        emit(`Host ${HOST}: unreachable, or too old to report a version.`);
      } else if (hostVersion === ALPHA_VERSION) {
        emit(`Host ${HOST}: ${hostVersion} — both machines run the same version.`);
      } else {
        emit(
          `Host ${HOST}: ${hostVersion} — this machine has drifted.\n` +
            '  git pull on whichever machine is behind so both run the same version.',
        );
      }
      return;
    }

    case 'users': {
      const { users } = await api('/users');
      if (flags.json) return emit('', users);
      table(users, [
        { header: 'ID', value: (u) => u.id },
        { header: 'EMAIL', value: (u) => u.email },
        { header: 'SCOPES', value: (u) => u.scopes.join(',') },
        { header: 'STATUS', value: (u) => u.status },
        { header: 'LAST LOGIN', value: (u) => when(u.lastLoginAt) },
      ]);
      return;
    }

    case 'disable-user':
    case 'enable-user': {
      if (!positionals[1]) fail(`${command} requires a user id`);
      const status = command === 'disable-user' ? 'disabled' : 'active';
      const result = await api(`/users/${positionals[1]}/status`, { method: 'POST', body: { status } });
      emit(
        `User ${result.user.email} is now ${result.user.status}.` +
          (status === 'disabled' ? ' Every key they hold stopped working immediately.' : ''),
        result,
      );
      return;
    }

    case 'set-scopes': {
      if (!positionals[1]) fail('set-scopes requires a user id');
      if (!flags.scopes) fail('set-scopes requires --scopes');
      const result = await api(`/users/${positionals[1]}/scopes`, {
        method: 'POST',
        body: { scopes: flags.scopes },
      });
      emit(`User ${result.user.email} now has: ${result.user.scopes.join(', ')}`, result);
      return;
    }

    case 'issue-key': {
      if (!flags.user) fail('issue-key requires --user <userId>');
      const result = await api('/keys', {
        method: 'POST',
        body: {
          userId: flags.user,
          name: flags.name,
          scopes: flags.scopes,
          expiresInMs: days(flags['expires-days']),
        },
      });
      if (flags.json) return emit('', result);
      process.stdout.write(
        `Key issued: ${result.key.fingerprint}\n` +
          `  scopes:  ${result.key.scopes.join(', ')}\n` +
          `  expires: ${when(result.key.expiresAt)}\n\n` +
          `Shown once:\n\n  ${result.token}\n\n` +
          `Revoke with: npm run admin -- revoke-key ${result.key.id}\n`,
      );
      return;
    }

    case 'keys': {
      const { keys } = await api(`/keys${flags.user ? `?userId=${encodeURIComponent(flags.user)}` : ''}`);
      if (flags.json) return emit('', keys);
      table(keys, [
        { header: 'ID', value: (k) => k.id },
        { header: 'KIND', value: (k) => k.kind },
        { header: 'NAME', value: (k) => k.name },
        { header: 'SCOPES', value: (k) => k.scopes.join(',') },
        { header: 'LAST USED', value: (k) => when(k.lastUsedAt) },
        { header: 'REVOKED', value: (k) => (k.revokedAt ? when(k.revokedAt) : '-') },
      ]);
      return;
    }

    case 'revoke-key': {
      if (!positionals[1]) fail('revoke-key requires a key id');
      const result = await api(`/keys/${positionals[1]}`, { method: 'DELETE' });
      emit(`Key ${result.key.fingerprint} revoked.`, result);
      return;
    }

    case 'login': {
      if (!flags.email) fail('login requires --email');
      const password = await promptSecret('Password: ');
      const result = await api('/auth/login', {
        method: 'POST',
        anonymous: true,
        body: { email: flags.email, password },
      });
      if (flags.json) return emit('', result);
      process.stdout.write(
        `Signed in as ${result.user.email}\n` +
          `  scopes:  ${result.user.scopes.join(', ')}\n` +
          `  expires: ${when(result.expiresAt)}\n\n` +
          `Session token:\n\n  ${result.token}\n`,
      );
      return;
    }

    case 'whoami': {
      const me = await api('/me');
      if (flags.json) return emit('', me);
      process.stdout.write(
        `${me.label} (${me.kind})\n  userId: ${me.userId ?? '-'}\n  scopes: ${me.scopes.join(', ')}\n`,
      );
      return;
    }

    case 'scopes': {
      const result = await api('/scopes');
      if (flags.json) return emit('', result);
      process.stdout.write(`Scopes:\n${result.scopes.map((s) => `  ${s}`).join('\n')}\n\nPresets:\n`);
      for (const [name, list] of Object.entries(result.presets)) {
        process.stdout.write(`  ${name.padEnd(9)} ${list.join(', ')}\n`);
      }
      return;
    }

    default:
      fail(`unknown command: ${command}`, { usage: true });
  }
}

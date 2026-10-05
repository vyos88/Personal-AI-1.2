import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { fetchJson, HttpError } from '../common/http.js';
import { loadEnv } from '../common/env.js';
import { promptSecret } from '../common/prompt.js';
import { ALPHA_VERSION } from '../common/version.js';
import { clearSession, loadSession, saveSession } from './session.js';

loadEnv();

const HOST = (process.env.ALPHA_HOST_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
// Long enough for a real Codex call, and inside validateTaskInput's hour ceiling.
const CODEX_LEASE_MS = 600_000;
const ENV_TOKEN =
  process.env.ALPHA_ADMIN_TOKEN ??
  process.env.ALPHA_BOOTSTRAP_TOKEN ??
  process.env.ALPHA_TUNNEL_TOKEN;
// A variable always wins; otherwise the session `login` saved for this host.
// Read per call rather than once, so `login` and `logout` take effect for the
// rest of the same process (doctor runs several requests).
const currentToken = () => ENV_TOKEN ?? loadSession(HOST)?.token;
const tokenIsSaved = () => !ENV_TOKEN && Boolean(loadSession(HOST));
const MUSIC_BRIDGE_URL = (process.env.ALPHA_MUSIC_BRIDGE_URL ?? 'http://127.0.0.1:8790').replace(/\/+$/, '');

const USAGE = `
alpha-admin — manage users, invites and keys on the Alpha host

  Host:  ALPHA_HOST_URL      (default http://127.0.0.1:8787)
  Auth:  \`login\` once (the session is saved for this user until it expires),
         or ALPHA_ADMIN_TOKEN (or ALPHA_BOOTSTRAP_TOKEN on a fresh install)

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
  reset-password <userId> [--new-password <p>]           Recover an account with no working password;
                                                         prints a one-time temporary password if you don't supply one

Keys
  issue-key --user <userId> [--scopes <s>] [--name <n>] [--expires-days <n>]
  keys [--user <userId>]                                 List keys
  revoke-key <keyId>                                     Revoke one credential

Tasks
  task --type <t> [--payload <json>] [--min-memory-mb <n>] [--agent <n>] [--no-wait]
                                                         Queue a task, await result
                                                         --agent runs it on that machine and no other
                                                         (the NAME from \`agents\`), e.g. renders on the host
  coord --action <a> [--actor <n>] [--message <m>] [--paths <a,b>]
                                                         Drive the coordination tunnel
  codex --prompt <text> | --prompt-file <f> [--agent <n>] [--no-wait]
                                                         Ask Codex on that machine and read its answer
                                                         (leases and waits 10 minutes; needs codex.exec there)
  tasks [--status queued|leased|succeeded|failed]        List recent tasks

  agents                                                 List attached agents, their free RAM, CPU load and version
  pause --agent <n> [--reason <text>]                    Offer that machine no new work (it finishes what it runs)
  resume --agent <n>                                     Lift a pause; an admin's pause needs an admin
  pauses                                                 List paused machines
  stats                                                  Fleet summary: queue, capacity, how work is spread

Borrowed memory
  mem --action stats                                     Store usage on the agent
  mem --action put --key <k> --value <json> [--ttl-ms <n>]
  mem --action get|delete --key <k>
  mem --action keys [--prefix <p>]
  mem --action clear

Health
  doctor [--agent <n>]                                   One pass over everything: coordinator, sign-in,
                                                         agents, who offers Codex and music, the music
                                                         bridge; --agent also asks Codex there to reply

Session
  login --email <e>                                      Prompts for password; saves the session for this user
  logout                                                 Ends the saved session on the host and forgets it
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
  const token = anonymous ? undefined : currentToken();
  if (!anonymous && !token) {
    fail(
      'Not signed in. Run `node src/admin/run.js login --email <your email>` once ' +
        '(or set ALPHA_ADMIN_TOKEN, or ALPHA_BOOTSTRAP_TOKEN on a fresh install).',
    );
  }
  try {
    const { body: result } = await fetchJson(`${HOST}${path}`, {
      method,
      body,
      token,
      timeoutMs: 20_000,
    });
    return result;
  } catch (error) {
    if (error instanceof HttpError && error.status === 401 && !anonymous && tokenIsSaved()) {
      fail('Your saved sign-in is no longer accepted (expired or ended). Run `login` again.');
    }
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
    // codex.exec reports its answer as `output`, not `stdout`; without this the
    // command printed an exit code and never the answer it was run for.
    if (typeof result.output === 'string' && result.output.trim()) {
      process.stdout.write(
        `\n  --- answer${result.truncated ? ' (tail; truncated)' : ''} ---\n${indent(result.output)}\n`,
      );
    }
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
  prompt: { type: 'string' },
  'prompt-file': { type: 'string' },
  action: { type: 'string' },
  actor: { type: 'string' },
  message: { type: 'string' },
  paths: { type: 'string' },
  'lease-ms': { type: 'string' },
  'min-memory-mb': { type: 'string' },
  agent: { type: 'string' },
  key: { type: 'string' },
  value: { type: 'string' },
  prefix: { type: 'string' },
  'ttl-ms': { type: 'string' },
  'new-password': { type: 'string' },
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
    case 'codex':
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
      } else if (command === 'codex') {
        // The other coding agent, asked a question. `--prompt-file` is not a
        // convenience: these prompts are messages between agents, they run to
        // paragraphs, and a shell that ate a backtick or a newline would change
        // what was asked without saying so.
        if (flags.prompt && flags['prompt-file']) {
          fail('codex takes --prompt or --prompt-file, not both');
        }
        let prompt = flags.prompt;
        if (flags['prompt-file']) {
          try {
            prompt = readFileSync(flags['prompt-file'], 'utf8');
          } catch (error) {
            fail(`could not read --prompt-file: ${error.message}`);
          }
        }
        if (!prompt || prompt.trim() === '') {
          fail('codex requires --prompt <text> or --prompt-file <path>');
        }
        type = flags.type ?? 'codex.exec';
        payload = { prompt };
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
      // Codex thinks for minutes, and DEFAULT_LEASE_MS is 60s: left alone, the
      // host reclaims the task mid-answer and requeues it forever. Same footgun
      // `alpha.render` documents, so this command does not leave it to be
      // remembered. `--lease-ms` above still wins.
      else if (command === 'codex') body.leaseMs = CODEX_LEASE_MS;
      if (flags['min-memory-mb']) body.minMemoryMB = Number.parseInt(flags['min-memory-mb'], 10);
      // The machine this has to run on, by name. For work that is only real on
      // one box — a render needs the GPU and the generator beside it, wherever
      // else the handler happens to be enabled.
      if (flags.agent) body.targetAgent = flags.agent;

      const queued = await api('/tasks', { method: 'POST', body });

      if (!queued.agentAvailable) {
        // Not fatal — it runs as soon as a capable agent attaches — but silence
        // here is how you end up staring at a task that never moves.
        // Three reasons a task sits there, and saying the wrong one sends an
        // operator looking at the wrong machine.
        const pinnedTo = body.targetAgent;
        let reason;
        if (queued.targetAttached === false) {
          reason =
            `warning: no attached agent is called "${pinnedTo}". The task is queued until that ` +
            'machine attaches — check `agents` for the names in use.\n';
        } else if (queued.memoryAvailable === false) {
          reason = pinnedTo
            ? `warning: "${pinnedTo}" offers "${type}" but has no ${body.minMemoryMB} MB to spare ` +
              'right now. The task is queued until it does.\n'
            : `warning: an agent offers "${type}", but none has ${body.minMemoryMB} MB free ` +
              'right now. The task is queued until one does.\n';
        } else {
          reason = pinnedTo
            ? `warning: "${pinnedTo}" is attached but does not offer "${type}". The task is queued.\n`
            : `warning: no attached agent currently offers "${type}". The task is queued.\n`;
        }
        process.stderr.write(reason);
      }
      if (flags['no-wait']) {
        emit(`Queued ${queued.id} (${queued.status}).`, queued);
        return;
      }

      // A codex task is leased for ten minutes because answers take minutes;
      // waiting only the default 60s gave up on calls that were running fine.
      const defaultWaitS = command === 'codex' ? String(body.leaseMs / 1_000) : '60';
      const timeoutMs = Number.parseInt(flags.timeout ?? defaultWaitS, 10) * 1_000;
      reportTask(await awaitTask(queued.id, timeoutMs), flags);
      return;
    }

    case 'tasks': {
      const { tasks } = await api(
        `/tasks?limit=20${flags.status ? `&status=${encodeURIComponent(flags.status)}` : ''}`,
      );
      if (flags.json) return emit('', tasks);
      // Only shown when something is actually pinned, so the usual listing
      // stays the width it was.
      const pinned = tasks.some((t) => t.targetAgent);
      table(tasks, [
        { header: 'ID', value: (t) => t.id },
        { header: 'TYPE', value: (t) => t.type },
        ...(pinned ? [{ header: 'FOR', value: (t) => t.targetAgent ?? '-' }] : []),
        { header: 'STATUS', value: (t) => t.status },
        { header: 'TRIES', value: (t) => t.attempts },
        // Next to TRIES on purpose: a queued task with tries flat and declines
        // climbing is being refused, not waiting for a free machine.
        { header: 'DECLINED', value: (t) => t.declines ?? 0 },
        { header: 'CREATED', value: (t) => when(t.createdAt) },
      ]);
      return;
    }

    case 'agents': {
      const { agents, hostVersion } = await api('/agents');
      if (flags.json) return emit('', agents);
      const drifted = agents.filter((a) => a.version && a.version !== hostVersion);
      // Two machines may legitimately attach under one name — a laptop set up
      // by copying the first one's configuration is the usual way it happens —
      // and two identical rows are worse than a long one. Mark only the names
      // that actually collide, so the common case stays as it was.
      const shared = new Set(
        agents.map((a) => a.name).filter((name, i, all) => all.indexOf(name) !== i),
      );
      const nameOf = (a) =>
        shared.has(a.name) ? `${a.name} (${(a.instanceId ?? a.id).slice(-6)})` : a.name;
      table(agents, [
        { header: 'NAME', value: nameOf },
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
        // A machine that has missed two heartbeats is marked, not hidden: the
        // host keeps its row (and may still place on it) until the stale sweep,
        // and a dead laptop that read as attached is exactly what this is for.
        { header: 'IDLE', value: (a) => `${Math.round(a.idleMs / 1000)}s${a.stale ? ' !' : ''}` },
        { header: 'STATE', value: (a) => (a.paused ? 'PAUSED' : 'ok') },
      ]);
      const silent = agents.filter((a) => a.stale);
      if (silent.length) {
        emit(
          `\n! not heard from in over two heartbeats: ${silent.map(nameOf).join(', ')}. ` +
            'Still listed until the host drops it; check the machine is running.',
        );
      }
      if (drifted.length) {
        emit(
          `\n* not the host's version (${hostVersion}). Update ` +
            `${drifted.map((a) => a.name).join(', ')} so every machine runs the same version.`,
        );
      }
      if (shared.size) {
        emit(
          `\n${[...shared].map((name) => `"${name}"`).join(', ')} names more than one machine ` +
            '(the suffix is each machine\'s own id). Set ALPHA_AGENT_NAME on one of them.',
        );
      }
      return;
    }

    case 'pause':
    case 'resume': {
      if (!flags.agent) fail(`${command} requires --agent <name>`, { usage: true });
      const result = await api(`/agents/${command}`, {
        method: 'POST',
        body: command === 'pause' ? { name: flags.agent, reason: flags.reason } : { name: flags.agent },
      });
      if (flags.json) return emit('', result);
      if (command === 'pause') {
        const p = result.pause;
        emit(`${p.name} paused${p.creatorHold ? ' (admin hold: only an admin can resume it)' : ''}` +
          `${p.attached ? '' : ' - not attached right now; the pause applies when it attaches'}`);
      } else {
        emit(`${result.resumed} resumed${result.dispatched ? `, ${result.dispatched} queued task(s) handed out` : ''}`);
      }
      return;
    }

    case 'pauses': {
      const { pauses } = await api('/agents/pauses');
      if (flags.json) return emit('', pauses);
      if (!pauses.length) return emit('No machine is paused.');
      table(pauses, [
        { header: 'NAME', value: (p) => p.name },
        { header: 'BY', value: (p) => p.by },
        { header: 'HOLD', value: (p) => (p.creatorHold ? 'admin' : '-') },
        { header: 'ATTACHED', value: (p) => (p.attached ? 'yes' : 'no') },
        { header: 'SINCE', value: (p) => new Date(p.at).toISOString().slice(0, 16) },
        { header: 'REASON', value: (p) => p.reason || '-' },
      ]);
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

    case 'reset-password': {
      if (!positionals[1]) fail('reset-password requires a user id');
      const result = await api(`/users/${positionals[1]}/password/reset`, {
        method: 'POST',
        body: flags['new-password'] ? { newPassword: flags['new-password'] } : {},
      });
      if (flags.json) return emit('', result);
      process.stdout.write(`Password reset for ${result.user.email}. Every existing session was ended.\n`);
      if (result.temporaryPassword) {
        process.stdout.write(
          `\nTemporary password (shown once, cannot be retrieved again):\n\n  ${result.temporaryPassword}\n\n` +
            `Have them log in with it and set their own.\n`,
        );
      }
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
      const saved = saveSession({
        host: HOST,
        token: result.token,
        email: result.user.email,
        expiresAt: result.expiresAt,
      });
      if (flags.json) return emit('', result);
      // The token is not printed: it is saved, and every later command uses it.
      // Printing it is how it ends up pasted somewhere it should not be.
      process.stdout.write(
        `Signed in as ${result.user.email}\n` +
          `  scopes:  ${result.user.scopes.join(', ')}\n` +
          `  expires: ${when(result.expiresAt)}\n` +
          `  saved:   ${saved} (later commands use it; \`logout\` ends it)\n`,
      );
      if (ENV_TOKEN) {
        process.stderr.write(
          'note: ALPHA_ADMIN_TOKEN (or another token variable) is set in this shell and wins over ' +
            'the saved session.\n',
        );
      }
      return;
    }

    case 'logout': {
      const saved = loadSession(HOST);
      if (!saved) {
        clearSession();
        emit(`Not signed in to ${HOST}; nothing to end.`, { ended: false });
        return;
      }
      // Revoke on the host first: deleting only the file would leave a live
      // credential behind wherever else it was copied.
      const id = /^alpha_[a-z]+_([0-9a-f]+)\./.exec(saved.token)?.[1];
      let ended = false;
      if (id) {
        try {
          await fetchJson(`${HOST}/keys/${id}`, { method: 'DELETE', token: saved.token, timeoutMs: 20_000 });
          ended = true;
        } catch (error) {
          // Already expired or revoked: the host refuses it, which is the goal.
          if (error instanceof HttpError && error.status === 401) ended = true;
          else process.stderr.write(`warning: could not end the session on the host: ${error.message}\n`);
        }
      }
      clearSession();
      emit(
        ended
          ? `Signed out of ${HOST}; the session is ended on the host.`
          : `Forgot the saved session, but the host could not be told; it expires ${when(saved.expiresAt)}.`,
        { ended },
      );
      return;
    }

    case 'doctor': {
      process.exitCode = await doctor(flags);
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

/**
 * One pass over everything an operator otherwise checks by hand, in the order
 * that each step depends on the last: is the coordinator up, does it accept
 * this sign-in, who is attached, does anyone offer Codex and music, is the
 * music bridge on this machine answering — and, with --agent, does Codex on
 * that machine actually reply. It never stops at the first problem: a morning
 * check is only useful if it lists everything that is wrong at once.
 *
 * Returns the exit code: 0 when nothing needed a person, 1 otherwise.
 */
async function doctor(flags) {
  const lines = [];
  let problems = 0;
  const ok = (text) => lines.push(`  ok    ${text}`);
  const bad = (text, fix) => {
    problems += 1;
    lines.push(`  FIX   ${text}`);
    if (fix) lines.push(`        -> ${fix}`);
  };
  const info = (text) => lines.push(`        ${text}`);
  const flush = () => {
    const out = lines.splice(0);
    if (!flags.json && out.length) process.stdout.write(out.join('\n') + '\n');
  };
  const report = { host: HOST, checks: [] };
  const get = async (path) => {
    const token = currentToken();
    try {
      return { body: (await fetchJson(`${HOST}${path}`, { token, timeoutMs: 15_000 })).body };
    } catch (error) {
      return { error };
    }
  };

  if (!flags.json) process.stdout.write(`Alpha tunnel doctor — ${HOST}\n`);

  // 1. The coordinator. /healthz needs no credential, so this answers even
  // when nothing else will.
  const health = await fetchJson(`${HOST}/healthz`, { timeoutMs: 10_000 }).then(
    (r) => r.body,
    (error) => ({ error }),
  );
  if (health?.error) {
    bad(
      `coordinator not answering (${health.error.message})`,
      'start it: node src/host/index.js — or check ALPHA_HOST_URL points at it',
    );
    report.checks.push({ check: 'coordinator', ok: false });
    flush();
    if (flags.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return 1;
  }
  ok(`coordinator up, version ${health.version ?? 'unknown'}${health.version && health.version !== ALPHA_VERSION ? ` (this checkout: ${ALPHA_VERSION})` : ''}`);
  report.checks.push({ check: 'coordinator', ok: true, version: health.version ?? null });

  // 2. The sign-in.
  if (!currentToken()) {
    bad('not signed in', 'node src/admin/run.js login --email <your email>');
    report.checks.push({ check: 'signin', ok: false });
    flush();
    if (flags.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return 1;
  }
  const me = await get('/me');
  if (me.error) {
    const expired = me.error instanceof HttpError && me.error.status === 401;
    bad(
      expired ? 'sign-in refused (expired or ended)' : `could not check sign-in (${me.error.message})`,
      expired ? 'node src/admin/run.js login --email <your email>' : undefined,
    );
    report.checks.push({ check: 'signin', ok: false });
    flush();
    if (flags.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return 1;
  }
  ok(`signed in as ${me.body.label} (${me.body.scopes.join(', ')})${ENV_TOKEN ? '' : ', saved session'}`);
  report.checks.push({ check: 'signin', ok: true, label: me.body.label });

  // 3. Who is attached.
  const listed = await get('/agents');
  const agents = listed.body?.agents ?? [];
  if (listed.error) {
    bad(`could not list agents (${listed.error.message})`, 'this sign-in needs the agents:read scope');
  } else if (agents.length === 0) {
    bad('no agents attached', 'start one on each laptop: node scripts/keep-agent.mjs');
  } else {
    ok(`${agents.length} agent${agents.length === 1 ? '' : 's'} attached`);
    for (const a of agents) {
      const drift = a.version && listed.body.hostVersion && a.version !== listed.body.hostVersion;
      info(`${a.name}  ${a.capabilities.join(', ') || '(no capabilities)'}${drift ? `  [version ${a.version}, host ${listed.body.hostVersion}: git pull there]` : ''}`);
    }
  }
  report.checks.push({ check: 'agents', ok: agents.length > 0, agents: agents.map((a) => ({ name: a.name, capabilities: a.capabilities })) });

  // 4. Coverage for the two things people ask for by name.
  const offering = (type) => agents.filter((a) => a.capabilities.includes(type)).map((a) => a.name);
  for (const [type, fix] of [
    ['codex.exec', 'on the Codex laptop: add codex-exec to ALPHA_EXTRA_HANDLERS in .env.agent and restart its agent; its log says why if it declines (docs/CODEX_BRIDGE.md)'],
    ['alpha.music', 'on the music machine: add alpha-music,alpha-music-audio to ALPHA_EXTRA_HANDLERS in .env.agent and restart its agent (docs/HANDOFF_LAPTOP41_2026-09-30.md §3); add alpha-music-stems too for vocal removal (needs scripts/requirements-stems.txt)'],
  ]) {
    const names = offering(type);
    if (names.length) ok(`${type} offered by ${names.join(', ')}`);
    else bad(`nobody offers ${type}`, fix);
    report.checks.push({ check: type, ok: names.length > 0, agents: names });
  }

  // 5. The music bridge, which runs beside the coordinator and is reached by
  // Alpha's Music Creator. Its health route needs no credential.
  const bridge = await fetchJson(`${MUSIC_BRIDGE_URL}/music/healthz`, { timeoutMs: 5_000 }).then(
    () => true,
    () => false,
  );
  if (bridge) ok(`music bridge answering at ${MUSIC_BRIDGE_URL}`);
  else bad(`music bridge not answering at ${MUSIC_BRIDGE_URL}`, 'node scripts/music-bridge.mjs (needs ALPHA_MUSIC_BRIDGE_TOKEN in .env)');
  report.checks.push({ check: 'music-bridge', ok: bridge, url: MUSIC_BRIDGE_URL });

  // 6. Optionally, a real round trip to Codex on a named machine.
  if (flags.agent) {
    const target = agents.find((a) => a.name === flags.agent);
    if (!target) {
      bad(`no agent called "${flags.agent}" is attached`, `names in use: ${agents.map((a) => a.name).join(', ') || 'none'}`);
      report.checks.push({ check: 'codex-ping', ok: false });
    } else if (!target.capabilities.includes('codex.exec')) {
      bad(`"${flags.agent}" is attached but does not offer codex.exec`, 'see the codex.exec line above');
      report.checks.push({ check: 'codex-ping', ok: false });
    } else {
      flush();
      if (!flags.json) process.stdout.write(`  ...   asking Codex on ${flags.agent} to reply (up to ${CODEX_LEASE_MS / 60_000} min)\n`);
      const answer = await pingCodex(flags.agent);
      if (answer.ok) ok(`Codex on ${flags.agent} answered in ${Math.round(answer.ms / 1000)}s: ${answer.text}`);
      else bad(`Codex on ${flags.agent}: ${answer.text}`, answer.fix);
      report.checks.push({ check: 'codex-ping', ok: answer.ok, detail: answer.text });
    }
  }

  lines.push('', problems ? `${problems} thing${problems === 1 ? '' : 's'} to fix.` : 'All good.');
  flush();
  report.problems = problems;
  if (flags.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return problems ? 1 : 0;
}

/** Queues a one-word Codex prompt on `agentName` and waits for the answer. */
async function pingCodex(agentName) {
  const started = Date.now();
  let task;
  try {
    ({ body: task } = await fetchJson(`${HOST}/tasks`, {
      method: 'POST',
      token: currentToken(),
      timeoutMs: 20_000,
      body: {
        type: 'codex.exec',
        payload: { prompt: 'Reply with the single word: bridged' },
        leaseMs: CODEX_LEASE_MS,
        targetAgent: agentName,
      },
    }));
  } catch (error) {
    return { ok: false, text: `could not queue the task (${error.message})` };
  }
  const deadline = started + CODEX_LEASE_MS + 30_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    let current;
    try {
      ({ body: current } = await fetchJson(`${HOST}/tasks/${task.id}`, { token: currentToken(), timeoutMs: 15_000 }));
    } catch {
      continue;
    }
    if (current.status === 'succeeded') {
      const text = String(current.result?.output ?? '').trim().split('\n').pop()?.slice(0, 120) || '(empty)';
      return { ok: true, ms: Date.now() - started, text };
    }
    if (current.status === 'failed') {
      const code = current.error?.code;
      const fixes = {
        timeout: `on ${agentName}: git pull and restart its agent (an older handler left Codex waiting on stdin), or raise ALPHA_CODEX_TIMEOUT_MS`,
        codex_failed: `on ${agentName}: run \`codex exec --sandbox read-only -- "say hello"\` by hand; usually Codex is signed out or rate limited`,
        not_configured: `on ${agentName}: Codex CLI not found; set ALPHA_CODEX to its full path`,
        codex_silent: `on ${agentName}: Codex exited without answering; run it by hand to see why`,
      };
      return {
        ok: false,
        text: `${code ?? 'failed'}: ${String(current.error?.message ?? '').slice(0, 300)}`,
        fix: fixes[code],
      };
    }
  }
  return {
    ok: false,
    text: `no answer within ${Math.round(CODEX_LEASE_MS / 60_000)} min (task ${task.id} left queued)`,
    fix: `node src/admin/run.js tasks — then check ${agentName}'s agent log`,
  };
}

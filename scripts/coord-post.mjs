#!/usr/bin/env node
/**
 * Posts one message to Alpha's coordination log from this machine, through the
 * same handler the tunnel uses (src/agent/handlers/alpha-coordination.js), so
 * the actor rule, the length limit, the root and script checks and the exact
 * argv are the ones already pinned by its tests.
 *
 * Why it exists: a cloud session cannot reach the coordinator, and on
 * 2026-10-08 neither laptop's Claude session could post either (one out of
 * its allowance, one offline), so reports meant for Alpha sat in the tunnel's
 * docs where Alpha does not look. The autopilot runs this for a queued
 * {"do":"coord-post","message":"...","actor":"..."}.
 *
 *   node scripts/coord-post.mjs --message-b64 <base64 utf-8> [--actor name] [--env <.env.agent>]
 *
 * The message arrives base64-encoded so no quoting between the autopilot and
 * here can split it into extra arguments. The root comes from ALPHA_REPO_ROOT
 * (this machine's .env.agent, as for the agent itself). A root that does not
 * exist is refused, never created: the coordination log and its claims live
 * there, and an empty one in its place would read as a log with no history.
 *
 * Exit: the coordination script's own exit code; 1 when refused.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from '../src/agent/handlers/alpha-coordination.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MAX_POST = 2_000;

/** Decodes and tidies a message: printable text and newlines, at most MAX_POST characters. */
export function decodeMessage(b64) {
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error('--message-b64 must be base64');
  const text = Buffer.from(b64, 'base64').toString('utf8');
  // Control characters other than newline and tab would reach a log a person reads.
  const clean = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (!clean) throw new Error('the message is empty');
  if (clean.length > MAX_POST) throw new Error(`the message is ${clean.length} characters; at most ${MAX_POST}`);
  return clean;
}

export async function post({ messageB64, actor = 'tunnel-session', envFile = join(ROOT, '.env.agent') }) {
  const message = decodeMessage(messageB64);
  // The agent's own configuration; a variable already set wins, as for the agent.
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  return run({ action: 'Post', actor, message });
}

async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--message-b64') args.messageB64 = argv[++i];
    else if (argv[i] === '--actor') args.actor = argv[++i];
    else if (argv[i] === '--env') args.envFile = resolve(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  const result = await post(args);
  const said = `${result.stdout}`.trim().split(/\r?\n/).slice(-5).join('\n');
  process.stdout.write(`posted to Alpha's coordination log as ${result.actor}: exit ${result.exitCode}\n${said ? `${said}\n` : ''}`);
  return Number(result.exitCode) || 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      const root = process.env.ALPHA_REPO_ROOT;
      const note = /does not exist/.test(error.message) ? ' (not created: the coordination log and its claims live there)' : '';
      process.stdout.write(`REFUSED: ${error.message}${note}${root ? ` [ALPHA_REPO_ROOT=${root}]` : ''}\n`);
      process.exitCode = 1;
    },
  );
}

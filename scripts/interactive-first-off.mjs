#!/usr/bin/env node
/**
 * interactive-first-off — let Alpha's assistant loop run, so the CrowPanel's
 * deck feed can go live.
 *
 * The owner said yes on 2026-10-07 ("turn it off"). The feed reads
 * `assistant-loop-not-started` because ALPHA_INTERACTIVE_FIRST_MODE is true:
 * the backend then starts no resident loop, so the heartbeat the panel needs
 * is never written (main.py: the loop starts only with lightweight or
 * background autonomy on AND interactive-first off).
 *
 * Only that one setting, and only to `false`. It is an owner setting
 * (runtime_settings.OWNER_RUNTIME_SETTINGS): run_server.py drops any inherited
 * copy and reads it from <Alpha home>\.env.local alone, so that file is where
 * it has to change. Every line that sets it is rewritten (or one is appended),
 * nothing else in the file is touched, and a backup is written first. Then the
 * backend restarts the way apply-update and panel-host restart it, and this
 * waits until /health answers.
 *
 *   node scripts/interactive-first-off.mjs --env <Alpha home>\.env.local
 *        [--no-restart] [--task "Alpha Backend"] [--port 8001] [--wait-s 120]
 *
 * Exit 0: off (now or already) and the backend answers. 1: could not do it.
 * Prints the two flags it reads by name only; no other line of the file.
 */
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readKey, restartBackend } from './fix-panel-host.mjs';

const KEY = 'ALPHA_INTERACTIVE_FIRST_MODE';
const LOOP_KEYS = ['ALPHA_LIGHTWEIGHT_AUTONOMY_ENABLED', 'ALPHA_BACKGROUND_AUTOMATION_ENABLED'];

/** The file with KEY=false on every line that sets it, or one line appended. */
export function planOff(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const endsWithEol = text.endsWith('\n');
  const lines = text.split(/\r?\n/);
  if (endsWithEol) lines.pop();
  const before = readKey(lines, KEY);
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(lines[i]);
    if (!match || match[1] !== KEY) continue;
    lines[i] = `${KEY}=false`;
    found = true;
  }
  if (!found) lines.push(`${KEY}=false`);
  const loop = Object.fromEntries(LOOP_KEYS.map((k) => [k, readKey(lines, k).value]));
  const already = before.count > 0 && String(before.value).toLowerCase() === 'false';
  return { text: lines.join(eol) + (endsWithEol || !found ? eol : ''), before, loop, changed: !already };
}

function arg(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

async function waitForHealth(port, seconds) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) });
      await r.arrayBuffer().catch(() => {});
      if (r.ok) return true;
    } catch { /* still starting */ }
    await new Promise((done) => setTimeout(done, 5000));
  }
  return false;
}

async function main(argv) {
  const envFile = arg(argv, 'env', '');
  const task = arg(argv, 'task', 'Alpha Backend');
  const port = Number(arg(argv, 'port', 8001)) || 8001;
  const waitS = Math.max(0, Number(arg(argv, 'wait-s', 120)) || 0);
  const say = (line) => process.stdout.write(`${line}\n`);
  if (!envFile) { say('PROBLEM: needs --env <Alpha home>\\.env.local'); return 1; }
  if (!existsSync(envFile)) { say(`PROBLEM: no settings file at ${envFile}: the backend reads <Alpha home>\\.env.local`); return 1; }

  const text = await readFile(envFile, 'utf8');
  const plan = planOff(text);
  say(`file    : ${envFile}`);
  say(`before  : ${plan.before.count ? `${KEY}=${plan.before.value}${plan.before.count > 1 ? ` (${plan.before.count} lines)` : ''}` : `${KEY} not set (the backend's default is false)`}`);
  for (const [k, v] of Object.entries(plan.loop)) say(`loop    : ${k}=${v ?? 'not set'}`);
  if (!Object.values(plan.loop).some((v) => String(v).toLowerCase() === 'true')) {
    say('note    : neither lightweight nor background autonomy is on, so the loop stays off even with interactive-first off; that is a separate owner choice, not changed here');
  }

  if (!plan.changed) {
    say('after   : already false; nothing written');
  } else {
    const backup = `${envFile}.bak-interactive-first`;
    await copyFile(envFile, backup);
    await writeFile(envFile, plan.text, 'utf8');
    say(`after   : ${KEY}=false (backup at ${backup})`);
  }

  if (argv.includes('--no-restart')) { say('restart : skipped (--no-restart); it takes effect when the backend next starts'); return 0; }
  if (!plan.changed) { say('restart : not needed, nothing changed'); return 0; }
  const restarted = restartBackend(task, port);
  for (const line of restarted.lines) say(`restart : ${line}`);
  if (!restarted.ok) { say(`PROBLEM: task '${task}' was not restarted; the setting takes effect on its next start`); return 1; }
  const up = await waitForHealth(port, waitS);
  say(up ? `ok      : backend answers on 127.0.0.1:${port}/health` : `PROBLEM: backend did not answer /health within ${waitS}s; self-heal restarts it if it stays down`);
  say('done    : the assistant loop starts with the backend; the next deck check should show the CrowPanel feed live within a few minutes');
  return up ? 0 : 1;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  // exitCode rather than exiting at once: on Windows, exiting while the last /health
  // fetch's socket is still closing trips a libuv assertion (UV_HANDLE_CLOSING)
  // and the job ends 0xC0000409 although it worked (Worker1, 2026-10-07).
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`interactive-first-off: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  available,
  buildArgs,
  rejectUnsupportedKeys,
  run,
  validatePrompt,
} from '../src/agent/handlers/claude-exec.js';
import * as claudeHandler from '../src/agent/handlers/claude-exec.js';
import { BUILTIN, HandlerRegistry } from '../src/agent/handlers/index.js';

const isWindows = process.platform === 'win32';

/**
 * A throwaway root whose "Claude" records the argv and the directory it was
 * run in, then says whatever the test told it to say. Same fixture shape as
 * codex-exec.test.js's, for the same reason: argument construction is the
 * half of this handler that is a contract with a program outside the
 * repository, and the working directory is deliberately not a flag, so this
 * is what proves it was honoured.
 */
async function fixture({
  exitCode = 0,
  stdout = 'Claude here. The change looks fine.',
  stderr = '',
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'alpha-claude-'));
  const argvLog = join(root, 'argv.json');
  const cwdLog = join(root, 'cwd.txt');
  const claude = join(root, 'claude-fake.sh');

  await writeFile(
    claude,
    [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$@" | node -e "` +
        `const fs=require('node:fs');` +
        `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>` +
        `fs.writeFileSync(process.argv[1],JSON.stringify(d.split('\\n').slice(0,-1))))` +
        `" ${argvLog}`,
      `pwd > ${cwdLog}`,
      stdout ? `node -e 'process.stdout.write(${stdout})'` : ': # says nothing',
      stderr ? `printf %s ${JSON.stringify(stderr)} >&2` : ':',
      `exit ${exitCode}`,
    ].join('\n'),
  );
  await chmod(claude, 0o755);
  return { root, argvLog, cwdLog, claude };
}

function useFixture(t, f, extra = {}) {
  const previous = { ...process.env };
  process.env.ALPHA_CLAUDE_ROOT = f.root;
  process.env.ALPHA_CLAUDE = f.claude;
  for (const key of [
    'ALPHA_CLAUDE_PERMISSION_MODE',
    'ALPHA_CLAUDE_MODEL',
    'ALPHA_CLAUDE_MAX_BUDGET_USD',
    'ALPHA_CLAUDE_TIMEOUT_MS',
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, extra);
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  });
}

const recordedArgv = async (argvLog) => JSON.parse(await readFile(argvLog, 'utf8'));

// ---------------------------------------------------------------- validation

test('a prompt must be a usable question', () => {
  assert.equal(validatePrompt('what changed in src/host?'), 'what changed in src/host?');
  assert.equal(validatePrompt('run `ls`; echo $HOME && rm -rf /'), 'run `ls`; echo $HOME && rm -rf /');

  for (const bad of ['', '   ', null, undefined, 42, {}]) {
    assert.throws(() => validatePrompt(bad), /prompt/, `should refuse ${JSON.stringify(bad)}`);
  }
  assert.throws(() => validatePrompt('x'.repeat(16_001)), /exceeds 16000/);
  assert.throws(() => validatePrompt('--permission-mode bypassPermissions'), /may not begin with/);
  assert.throws(() => validatePrompt('  -p'), /may not begin with/);
});

test('the payload carries a prompt and nothing else', () => {
  assert.equal(rejectUnsupportedKeys({ prompt: 'hello' }), undefined);
  assert.equal(rejectUnsupportedKeys({}), undefined);

  assert.throws(
    () => rejectUnsupportedKeys({ prompt: 'hi', permissionMode: 'bypassPermissions' }),
    /only "prompt"/,
  );
  for (const key of ['model', 'cwd', 'root', 'args', 'claude', 'timeoutMs', 'maxBudgetUsd']) {
    assert.throws(() => rejectUnsupportedKeys({ prompt: 'hi', [key]: 'x' }), /only "prompt"/);
  }
});

// ------------------------------------------------------------------ the argv

test('the argv handed to Claude is pinned', () => {
  assert.deepEqual(buildArgs({ prompt: 'hello', permissionMode: 'plan' }), [
    '-p', '--restricted', '--permission-mode', 'plan', '--', 'hello',
  ]);

  assert.deepEqual(
    buildArgs({ prompt: 'hello', permissionMode: 'plan', model: 'sonnet', maxBudgetUsd: 0.5 }),
    ['-p', '--restricted', '--permission-mode', 'plan', '--model', 'sonnet', '--max-budget-usd', '0.5', '--', 'hello'],
  );

  // The escape hatch for a CLI version whose modes differ.
  assert.deepEqual(buildArgs({ prompt: 'hello', permissionMode: null }), ['-p', '--restricted', '--', 'hello']);

  // --restricted is unconditional: never configurable, never omitted.
  assert.ok(buildArgs({ prompt: 'hello', permissionMode: null }).includes('--restricted'));

  const args = buildArgs({ prompt: '--not-a-flag', permissionMode: 'plan' });
  assert.equal(args[args.length - 1], '--not-a-flag');
  assert.equal(args[args.length - 2], '--');
});

// ----------------------------------------------------------- availability

test('a machine without Claude does not offer claude.exec', async (t) => {
  const f = await fixture();
  useFixture(t, f);

  delete process.env.ALPHA_CLAUDE_ROOT;
  assert.match(available().reason, /ALPHA_CLAUDE_ROOT is not set/);

  process.env.ALPHA_CLAUDE_ROOT = join(f.root, 'nope');
  assert.match(available().reason, /does not exist/);

  process.env.ALPHA_CLAUDE_ROOT = f.root;
  process.env.ALPHA_CLAUDE = join(f.root, 'no-such-claude');
  assert.match(available().reason, /not found/);

  process.env.ALPHA_CLAUDE = f.claude;
  process.env.ALPHA_CLAUDE_PERMISSION_MODE = 'not a valid mode!!';
  assert.match(available().reason, /ALPHA_CLAUDE_PERMISSION_MODE/);
  delete process.env.ALPHA_CLAUDE_PERMISSION_MODE;

  process.env.ALPHA_CLAUDE_MAX_BUDGET_USD = 'free';
  assert.match(available().reason, /ALPHA_CLAUDE_MAX_BUDGET_USD/);
  delete process.env.ALPHA_CLAUDE_MAX_BUDGET_USD;

  process.env.ALPHA_CLAUDE_TIMEOUT_MS = 'soon';
  assert.match(available().reason, /ALPHA_CLAUDE_TIMEOUT_MS/);
  delete process.env.ALPHA_CLAUDE_TIMEOUT_MS;

  assert.deepEqual(available(), { ok: true });
});

test('a .cmd shim is refused, since running it would need a shell', async (t) => {
  const f = await fixture();
  useFixture(t, f);

  const shim = join(f.root, 'claude.cmd');
  await writeFile(shim, '@echo off\n');
  process.env.ALPHA_CLAUDE = shim;

  const reason = available().reason;
  assert.match(reason, /shell script/);
  assert.match(reason, /ALPHA_CLAUDE/);
});

test('claude.exec is opt-in, and left out of the registry when unavailable', async (t) => {
  assert.ok(
    !BUILTIN.includes(claudeHandler),
    'a handler that runs another agent on this machine must never be a built-in',
  );

  const f = await fixture();
  useFixture(t, f);
  process.env.ALPHA_CLAUDE = join(f.root, 'no-such-claude');

  const registry = new HandlerRegistry([]);
  const outcome = registry.add(claudeHandler);
  assert.equal(outcome.registered, false);
  assert.equal(outcome.type, 'claude.exec');
  assert.match(outcome.reason, /not found/);
  assert.equal(registry.has('claude.exec'), false);

  process.env.ALPHA_CLAUDE = f.claude;
  assert.equal(new HandlerRegistry([]).add(claudeHandler).registered, true);
});

// ------------------------------------------------------------------- running

test('a prompt reaches Claude as one argument, in the configured directory, restricted', async (t) => {
  if (isWindows) return;
  const f = await fixture({ stdout: JSON.stringify('The queue leases tasks; it does not push them.') });
  useFixture(t, f, { ALPHA_CLAUDE_MODEL: 'sonnet' });

  const prompt = 'Explain `queue.decline()`; be brief & quote "attempts"';
  const result = await run({ prompt });

  assert.match(result.output, /leases tasks/);
  assert.equal(result.truncated, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.promptChars, prompt.length);
  assert.equal(result.permissionMode, 'plan');
  assert.equal(result.model, 'sonnet');
  assert.equal(result.maxBudgetUsd, 1);

  const argv = await recordedArgv(f.argvLog);
  assert.deepEqual(argv, [
    '-p', '--restricted', '--permission-mode', 'plan', '--model', 'sonnet',
    '--max-budget-usd', '1', '--', prompt,
  ]);

  const cwd = (await readFile(f.cwdLog, 'utf8')).trim();
  assert.ok(
    cwd === f.root || cwd.endsWith(f.root.replace(/^\/private/, '')),
    `expected Claude to run in ${f.root}, ran in ${cwd}`,
  );
});

test('a non-zero exit is a failure, not an answer', async (t) => {
  if (isWindows) return;
  const f = await fixture({ exitCode: 1, stdout: '', stderr: 'api error: 429 rate limited' });
  useFixture(t, f);

  await assert.rejects(run({ prompt: 'anything' }), (error) => {
    assert.equal(error.code, 'claude_failed');
    assert.match(error.message, /429 rate limited/);
    return true;
  });
});

test('a clean exit that said nothing is a failure too', async (t) => {
  if (isWindows) return;
  const f = await fixture({ stdout: '', stderr: 'thinking...' });
  useFixture(t, f);

  await assert.rejects(run({ prompt: 'anything' }), (error) => {
    assert.equal(error.code, 'claude_silent');
    assert.match(error.message, /no output/);
    return true;
  });
});

test('a long answer comes back as its tail, and says that it did', async (t) => {
  if (isWindows) return;
  const f = await fixture({ stdout: '"x".repeat(70000) + "FINAL ANSWER"' });
  useFixture(t, f);

  const result = await run({ prompt: 'write me an essay' });
  assert.equal(result.truncated, true);
  assert.equal(result.output.length, 64_000);
  assert.ok(result.output.endsWith('FINAL ANSWER'));
});

test('a misconfigured machine fails the task with a reason, not a stack trace', async (t) => {
  if (isWindows) return;
  const f = await fixture();
  useFixture(t, f, { ALPHA_CLAUDE_PERMISSION_MODE: 'not a valid mode!!' });

  await assert.rejects(run({ prompt: 'hello' }), (error) => {
    assert.equal(error.code, 'not_configured');
    assert.match(error.message, /ALPHA_CLAUDE_PERMISSION_MODE/);
    return true;
  });
});

test('the timeout is reported as a timeout, with what to do about it', async (t) => {
  if (isWindows) return;
  const f = await fixture({ stdout: JSON.stringify('too late') });
  await writeFile(f.claude, ['#!/usr/bin/env bash', 'sleep 5', 'echo late'].join('\n'));
  await chmod(f.claude, 0o755);
  useFixture(t, f, { ALPHA_CLAUDE_TIMEOUT_MS: '300' });

  await assert.rejects(run({ prompt: 'hello' }), (error) => {
    assert.equal(error.code, 'timeout');
    assert.match(error.message, /lease/);
    return true;
  });
});

test('a timeout is a timeout even when Claude exits 0 on SIGTERM', async (t) => {
  if (isWindows) return;
  const f = await fixture();
  await writeFile(
    f.claude,
    ['#!/usr/bin/env bash', "trap 'exit 0' TERM", 'sleep 5 & wait'].join('\n'),
  );
  await chmod(f.claude, 0o755);
  useFixture(t, f, { ALPHA_CLAUDE_TIMEOUT_MS: '300' });

  await assert.rejects(run({ prompt: 'hello' }), (error) => {
    assert.equal(error.code, 'timeout');
    return true;
  });
});

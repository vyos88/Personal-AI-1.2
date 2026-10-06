import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  available,
  buildArgs,
  rejectUnsupportedKeys,
  run,
  validatePrompt,
} from '../src/agent/handlers/codex-exec.js';
import * as codexHandler from '../src/agent/handlers/codex-exec.js';
import { BUILTIN, HandlerRegistry } from '../src/agent/handlers/index.js';

const isWindows = process.platform === 'win32';

/**
 * A throwaway root whose "Codex" records the argv and the directory it was run
 * in, then says whatever the test told it to say.
 *
 * Recording the argv is the point, exactly as it is for the render fixture:
 * argument construction is the half of this handler that is a contract with a
 * program outside the repository. Recording the *cwd* matters for the same
 * reason in reverse — the working directory is deliberately not a flag, so the
 * only thing proving Codex runs where it was configured to is this.
 */
async function fixture({
  exitCode = 0,
  stdout = 'Codex here. The change looks fine.',
  stderr = '',
  gitRepo = true,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'alpha-codex-'));
  if (gitRepo) await mkdir(join(root, '.git'), { recursive: true });

  const argvLog = join(root, 'argv.json');
  const cwdLog = join(root, 'cwd.txt');
  const codex = join(root, 'codex-fake.sh');

  await writeFile(
    codex,
    [
      '#!/usr/bin/env bash',
      // "$@" keeps every argument exactly as received, one line each, so a
      // prompt full of quotes and semicolons is visible here as one argument.
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
  await chmod(codex, 0o755);
  return { root, argvLog, cwdLog, codex };
}

/**
 * Points the handler at a fixture for the duration of one test.
 *
 * On Windows a fake Codex would have to be a `.cmd`, which this handler refuses
 * on purpose (a shell is what turns a prompt into syntax), so that branch
 * asserts on buildArgs and the validation rather than on a live run.
 */
function useFixture(t, f, extra = {}) {
  const previous = { ...process.env };
  process.env.ALPHA_CODEX_ROOT = f.root;
  process.env.ALPHA_CODEX = f.codex;
  for (const key of [
    'ALPHA_CODEX_SANDBOX',
    'ALPHA_CODEX_MODEL',
    'ALPHA_CODEX_SKIP_GIT_CHECK',
    'ALPHA_CODEX_TIMEOUT_MS',
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
  // Metacharacters are data: there is no shell between here and the process.
  assert.equal(validatePrompt('run `ls`; echo $HOME && rm -rf /'), 'run `ls`; echo $HOME && rm -rf /');

  for (const bad of ['', '   ', null, undefined, 42, {}]) {
    assert.throws(() => validatePrompt(bad), /prompt/, `should refuse ${JSON.stringify(bad)}`);
  }
  assert.throws(() => validatePrompt('x'.repeat(16_001)), /exceeds 16000/);
  // A prompt a CLI would read as a flag is refused even though buildArgs puts
  // it after `--`.
  assert.throws(() => validatePrompt('--sandbox danger-full-access'), /may not begin with/);
  assert.throws(() => validatePrompt('  -s workspace-write'), /may not begin with/);
});

test('the payload carries a prompt and nothing else', () => {
  assert.equal(rejectUnsupportedKeys({ prompt: 'hello' }), undefined);
  assert.equal(rejectUnsupportedKeys({}), undefined);

  // Refused rather than dropped: someone who sent this should be told it meant
  // nothing, not left believing the sandbox widened.
  assert.throws(
    () => rejectUnsupportedKeys({ prompt: 'hi', sandbox: 'danger-full-access' }),
    /only "prompt"/,
  );
  for (const key of ['model', 'cwd', 'root', 'args', 'codex', 'timeoutMs']) {
    assert.throws(() => rejectUnsupportedKeys({ prompt: 'hi', [key]: 'x' }), /only "prompt"/);
  }
});

// ------------------------------------------------------------------ the argv

test('the argv handed to Codex is pinned', () => {
  // The contract with a CLI that lives outside this repository. If it changes,
  // this expectation and buildArgs change together.
  assert.deepEqual(buildArgs({ prompt: 'hello', sandbox: 'read-only' }), [
    'exec',
    '--sandbox',
    'read-only',
    '--',
    'hello',
  ]);

  assert.deepEqual(
    buildArgs({ prompt: 'hello', sandbox: 'workspace-write', model: 'gpt-5-codex' }),
    ['exec', '--sandbox', 'workspace-write', '--model', 'gpt-5-codex', '--', 'hello'],
  );

  // The escape hatch for a CLI version that takes no sandbox flag.
  assert.deepEqual(buildArgs({ prompt: 'hello', sandbox: null }), ['exec', '--', 'hello']);

  assert.deepEqual(buildArgs({ prompt: 'hello', sandbox: null, skipGitCheck: true }), [
    'exec',
    '--skip-git-repo-check',
    '--',
    'hello',
  ]);

  // The prompt is always last, and always after the separator.
  const args = buildArgs({ prompt: '--not-a-flag', sandbox: 'read-only' });
  assert.equal(args[args.length - 1], '--not-a-flag');
  assert.equal(args[args.length - 2], '--');
});

// ----------------------------------------------------------- availability

test('a machine without Codex does not offer codex.exec', async (t) => {
  const f = await fixture();
  useFixture(t, f);

  delete process.env.ALPHA_CODEX_ROOT;
  assert.match(available().reason, /ALPHA_CODEX_ROOT is not set/);

  process.env.ALPHA_CODEX_ROOT = join(f.root, 'nope');
  assert.match(available().reason, /does not exist/);

  process.env.ALPHA_CODEX_ROOT = f.root;
  process.env.ALPHA_CODEX = join(f.root, 'no-such-codex');
  assert.match(available().reason, /not found/);

  process.env.ALPHA_CODEX = f.codex;
  process.env.ALPHA_CODEX_SANDBOX = 'Danger Full Access';
  assert.match(available().reason, /ALPHA_CODEX_SANDBOX/);
  delete process.env.ALPHA_CODEX_SANDBOX;

  process.env.ALPHA_CODEX_TIMEOUT_MS = 'soon';
  assert.match(available().reason, /ALPHA_CODEX_TIMEOUT_MS/);
  delete process.env.ALPHA_CODEX_TIMEOUT_MS;

  assert.deepEqual(available(), { ok: true });
});

test('a root that is not a checkout is refused, because Codex would refuse it', async (t) => {
  const f = await fixture({ gitRepo: false });
  useFixture(t, f);

  // The failure this catches looks like a broken handler from the far end: every
  // task fails, on a machine that has Codex installed and working.
  assert.match(available().reason, /not a git checkout/);

  process.env.ALPHA_CODEX_SKIP_GIT_CHECK = '1';
  assert.deepEqual(available(), { ok: true });
});

test('a .cmd shim is refused, since running it would need a shell', async (t) => {
  const f = await fixture();
  useFixture(t, f);

  const shim = join(f.root, 'codex.cmd');
  await writeFile(shim, '@echo off\n');
  process.env.ALPHA_CODEX = shim;

  const reason = available().reason;
  assert.match(reason, /shell script/);
  // The remedy has to be in the reason: this is a configuration fix, and the
  // reason is the only place anyone sees it.
  assert.match(reason, /ALPHA_CODEX/);
});

test('codex.exec is opt-in, and left out of the registry when unavailable', async (t) => {
  assert.ok(
    !BUILTIN.includes(codexHandler),
    'a handler that runs another agent on this machine must never be a built-in',
  );

  const f = await fixture();
  useFixture(t, f);
  process.env.ALPHA_CODEX = join(f.root, 'no-such-codex');

  const registry = new HandlerRegistry([]);
  const outcome = registry.add(codexHandler);
  assert.equal(outcome.registered, false);
  assert.equal(outcome.type, 'codex.exec');
  assert.match(outcome.reason, /not found/);
  assert.equal(registry.has('codex.exec'), false);

  process.env.ALPHA_CODEX = f.codex;
  assert.equal(new HandlerRegistry([]).add(codexHandler).registered, true);
});

// ------------------------------------------------------------------- running

test('a prompt reaches Codex as one argument, in the configured directory', async (t) => {
  if (isWindows) return; // see useFixture
  const f = await fixture({ stdout: JSON.stringify('The queue leases tasks; it does not push them.') });
  useFixture(t, f, { ALPHA_CODEX_MODEL: 'gpt-5-codex' });

  const prompt = 'Explain `queue.decline()`; be brief & quote "attempts"';
  const result = await run({ prompt });

  assert.match(result.output, /leases tasks/);
  assert.equal(result.truncated, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.promptChars, prompt.length);
  assert.equal(result.sandbox, 'read-only');
  assert.equal(result.model, 'gpt-5-codex');

  const argv = await recordedArgv(f.argvLog);
  assert.deepEqual(argv, [
    'exec',
    '--sandbox',
    'read-only',
    '--model',
    'gpt-5-codex',
    '--',
    prompt,
  ]);

  // The working directory is not a flag, so this is what proves it was honoured.
  const cwd = (await readFile(f.cwdLog, 'utf8')).trim();
  assert.ok(
    cwd === f.root || cwd.endsWith(f.root.replace(/^\/private/, '')),
    `expected Codex to run in ${f.root}, ran in ${cwd}`,
  );
});

test('a non-zero exit is a failure, not an answer', async (t) => {
  if (isWindows) return;
  const f = await fixture({ exitCode: 1, stdout: '', stderr: 'stream error: 429 rate limited' });
  useFixture(t, f);

  await assert.rejects(run({ prompt: 'anything' }), (error) => {
    assert.equal(error.code, 'codex_failed');
    assert.match(error.message, /429 rate limited/);
    return true;
  });
});

test('a clean exit that said nothing is a failure too', async (t) => {
  if (isWindows) return;
  // The same refusal alpha.render makes for a Blender that exits 0 having
  // written no image: there is no answer here to hand back.
  const f = await fixture({ stdout: '', stderr: 'thinking...' });
  useFixture(t, f);

  await assert.rejects(run({ prompt: 'anything' }), (error) => {
    assert.equal(error.code, 'codex_silent');
    assert.match(error.message, /no output/);
    return true;
  });
});

test('a long answer comes back as its tail, and says that it did', async (t) => {
  if (isWindows) return;
  const f = await fixture({
    stdout: '"x".repeat(70000) + "FINAL ANSWER"',
  });
  useFixture(t, f);

  const result = await run({ prompt: 'write me an essay' });
  assert.equal(result.truncated, true);
  assert.equal(result.output.length, 64_000);
  // The answer is at the end of a transcript, which is why the tail is what is
  // kept.
  assert.ok(result.output.endsWith('FINAL ANSWER'));
});

test('a misconfigured machine fails the task with a reason, not a stack trace', async (t) => {
  if (isWindows) return;
  const f = await fixture();
  useFixture(t, f, { ALPHA_CODEX_SANDBOX: 'not a mode' });

  await assert.rejects(run({ prompt: 'hello' }), (error) => {
    assert.equal(error.code, 'not_configured');
    assert.match(error.message, /ALPHA_CODEX_SANDBOX/);
    return true;
  });
});

test('the timeout is reported as a timeout, with what to do about it', async (t) => {
  if (isWindows) return;
  const f = await fixture({ stdout: JSON.stringify('too late') });
  // A fake that sleeps past its ceiling.
  await writeFile(f.codex, ['#!/usr/bin/env bash', 'sleep 5', 'echo late'].join('\n'));
  await chmod(f.codex, 0o755);
  useFixture(t, f, { ALPHA_CODEX_TIMEOUT_MS: '300' });

  await assert.rejects(run({ prompt: 'hello' }), (error) => {
    assert.equal(error.code, 'timeout');
    // The lease is the other half of the fix and is easy to forget.
    assert.match(error.message, /lease/);
    return true;
  });
});

test('stdin is closed, because codex exec reads a piped stdin to EOF', async (t) => {
  if (isWindows) return;
  const f = await fixture();
  // Like the real CLI: when stdin is not a terminal, read it to EOF before
  // answering. Left open, this never returns and the task times out.
  await writeFile(
    f.codex,
    ['#!/usr/bin/env bash', 'cat > /dev/null', 'echo "STDOUT OK"'].join('\n'),
  );
  await chmod(f.codex, 0o755);
  useFixture(t, f, { ALPHA_CODEX_TIMEOUT_MS: '5000' });

  const result = await run({ prompt: 'hello' });
  assert.match(result.output, /STDOUT OK/);
});

test('a timeout is a timeout even when Codex exits 0 on SIGTERM', async (t) => {
  if (isWindows) return;
  const f = await fixture();
  // The real CLI traps SIGTERM and exits cleanly with nothing on stdout.
  await writeFile(
    f.codex,
    ['#!/usr/bin/env bash', "trap 'exit 0' TERM", 'sleep 5 & wait'].join('\n'),
  );
  await chmod(f.codex, 0o755);
  useFixture(t, f, { ALPHA_CODEX_TIMEOUT_MS: '300' });

  await assert.rejects(run({ prompt: 'hello' }), (error) => {
    assert.equal(error.code, 'timeout');
    return true;
  });
});

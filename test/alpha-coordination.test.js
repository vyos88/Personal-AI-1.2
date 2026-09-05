import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import {
  ALLOWED_ACTIONS,
  buildArgs,
  run,
  validateAction,
  validateActor,
  validatePaths,
} from '../src/agent/handlers/alpha-coordination.js';

const isWindows = process.platform === 'win32';

// A PowerShell literal, single-quoted so nothing inside it is expanded.
const psLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * Builds a throwaway Alpha working copy with a "PowerShell" that records the
 * argv it was handed. That is what makes these assertions meaningful: argument
 * construction, validation and refusal behaviour are exactly the parts that
 * must not be guessed at.
 *
 * The recorder differs by platform, because a shebang script is not runnable
 * as an interpreter on Windows: chmod is a no-op there, CreateProcess will not
 * execute an extensionless file, and Node refuses .cmd/.bat without
 * `shell: true` -- which would re-parse the very argument boundaries these
 * tests exist to pin. So Windows drives the *real* powershell.exe and makes
 * the coordination script itself the recorder. That checks strictly more than
 * the stub did: it proves real PowerShell hands a `-File` script the arguments
 * buildArgs assumes, including a message full of shell metacharacters
 * arriving as one argv entry.
 *
 * `argvPrefix` is what the recorder sees *before* `-Action`. The POSIX stub
 * stands in for the interpreter and so observes the leading `-NoProfile
 * -ExecutionPolicy Bypass -File <script>`; a real PowerShell consumes those
 * itself and the script sees only what follows. They are still pinned on
 * Windows -- by the buildArgs test above, and by the script running at all.
 */
async function fixture({ exitCode = 0, stderr = '' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'alpha-repo-'));
  await mkdir(join(root, 'scripts'), { recursive: true });
  const scriptPath = join(root, 'scripts', 'alpha_coordination_tunnel.ps1');
  const argvLog = join(root, 'argv.json');

  if (isWindows) {
    // WriteAllText avoids the BOM that Set-Content -Encoding UTF8 emits on
    // Windows PowerShell 5.1, which JSON.parse would choke on. The join
    // builds the array by hand because ConvertTo-Json unrolls a one-element
    // array into a bare scalar.
    await writeFile(
      scriptPath,
      `$items = @($args | ForEach-Object { $_ | ConvertTo-Json -Compress })
[System.IO.File]::WriteAllText(${psLiteral(argvLog)}, '[' + ($items -join ',') + ']')
[Console]::Out.Write('stub ok')
${stderr ? `[Console]::Error.Write(${psLiteral(stderr)})\n` : ''}exit ${exitCode}
`,
    );
    return { root, stub: 'powershell.exe', argvLog, scriptPath, argvPrefix: [] };
  }

  await writeFile(scriptPath, '# stub\n');
  const stub = join(root, 'fake-powershell');
  // Records argv as JSON, so a test can assert on exact argument boundaries.
  await writeFile(
    stub,
    `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write('stub ok');
${stderr ? `process.stderr.write(${JSON.stringify(stderr)});\n` : ''}// Set the code rather than calling process.exit(), which would not wait for
// those writes to flush when stdout is a pipe.
process.exitCode = ${exitCode};
`,
  );
  await chmod(stub, 0o755);

  return {
    root,
    stub,
    argvLog,
    scriptPath,
    argvPrefix: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
  };
}

function withEnv(vars, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return (async () => fn())().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

// ------------------------------------------------------------- validation

test('only allowlisted actions are accepted', () => {
  for (const action of ALLOWED_ACTIONS) assert.equal(validateAction(action), action);
  assert.throws(() => validateAction('Delete'), /unsupported action/);
  assert.throws(() => validateAction('post'), /unsupported action/); // case matters
  assert.throws(() => validateAction(undefined), /unsupported action/);
});

test('actor names are constrained to something legible', () => {
  assert.equal(validateActor('claude-cowork'), 'claude-cowork');
  assert.equal(validateActor('claude.remote_1'), 'claude.remote_1');
  assert.throws(() => validateActor(''), /must be 1-64 characters/);
  assert.throws(() => validateActor('has space'), /must be 1-64 characters/);
  assert.throws(() => validateActor('-leading-dash'), /must be 1-64 characters/);
  assert.throws(() => validateActor('x'.repeat(65)), /must be 1-64 characters/);
});

test('paths must stay inside the working copy', () => {
  const root = '/srv/alpha';
  assert.deepEqual(validatePaths(['software/backend/main.py'], root), ['software/backend/main.py']);
  // Windows separators are normalized, since the host is Windows.
  assert.deepEqual(validatePaths(['software\\backend\\main.py'], root), ['software/backend/main.py']);
  assert.deepEqual(validatePaths(undefined, root), []);

  assert.throws(() => validatePaths(['../../etc/passwd'], root), /traverse upward/);
  assert.throws(() => validatePaths(['/etc/passwd'], root), /repo-relative/);
  assert.throws(() => validatePaths(['C:\\Windows\\System32'], root), /repo-relative/);
  assert.throws(() => validatePaths([''], root), /non-empty string/);
  assert.throws(() => validatePaths('not-an-array', root), /must be an array/);
  assert.throws(() => validatePaths(Array(65).fill('a.txt'), root), /at most 64/);
});

test('argv places each value in its own slot, never a command string', () => {
  const args = buildArgs({
    script: 'C:\\alpha\\scripts\\alpha_coordination_tunnel.ps1',
    action: 'Post',
    actor: 'claude-cowork',
    // Shell metacharacters that would be catastrophic if interpolated.
    message: 'Retro receipt; rm -rf / && echo "pwned" `whoami`',
    paths: ['software/backend/main.py', 'memory/knowledge/pack.json'],
  });

  assert.deepEqual(args.slice(0, 5), [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'C:\\alpha\\scripts\\alpha_coordination_tunnel.ps1',
  ]);
  // The whole message is one argv entry — not split, not quoted, not escaped.
  assert.ok(args.includes('Retro receipt; rm -rf / && echo "pwned" `whoami`'));
  // Paths arrive as ONE comma-joined token, the form PowerShell reliably
  // binds to a [string[]] parameter when invoked through -File.
  assert.deepEqual(args.slice(args.indexOf('-Paths')), [
    '-Paths',
    'software/backend/main.py,memory/knowledge/pack.json',
  ]);
});

test('a path containing a comma is refused rather than silently split', () => {
  assert.throws(() => validatePaths(['software/a,b.py'], '/srv/alpha'), /must not contain a comma/);
});

test('a message-less Post is refused, but Init needs no message', async () => {
  const { root, stub } = await fixture();
  await withEnv({ ALPHA_REPO_ROOT: root, ALPHA_POWERSHELL: stub }, async () => {
    await assert.rejects(
      () => run({ action: 'Post', actor: 'claude-remote' }),
      /"message" is required for the Post action/,
    );
    const result = await run({ action: 'Init', actor: 'claude-remote' });
    assert.equal(result.action, 'Init');
  });
});

// ------------------------------------------------------------- invocation

test('a real invocation passes exactly the expected argv', async () => {
  const { root, stub, argvLog, argvPrefix } = await fixture();

  const result = await withEnv({ ALPHA_REPO_ROOT: root, ALPHA_POWERSHELL: stub }, () =>
    run({
      action: 'Post',
      actor: 'claude-cowork',
      // Shell metacharacters again, because this path is the one that reaches
      // a real interpreter: the whole message must arrive as one argv entry.
      message: 'Retro receipt; rm -rf / && echo "pwned" `whoami`',
      paths: ['software/backend/main.py'],
    }),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'stub ok');
  assert.deepEqual(result.paths, ['software/backend/main.py']);

  const argv = JSON.parse(await readFile(argvLog, 'utf8'));
  assert.deepEqual(argv, [
    ...argvPrefix,
    '-Action',
    'Post',
    '-Actor',
    'claude-cowork',
    '-Message',
    'Retro receipt; rm -rf / && echo "pwned" `whoami`',
    '-Paths',
    'software/backend/main.py',
  ]);
});

test('a non-zero exit is reported as data, not thrown', async () => {
  const { root, stub } = await fixture({ exitCode: 3, stderr: 'claim refused' });

  const result = await withEnv({ ALPHA_REPO_ROOT: root, ALPHA_POWERSHELL: stub }, () =>
    run({ action: 'Claim', actor: 'claude-remote', paths: ['software/backend/main.py'] }),
  );

  // A refused claim is a legitimate outcome of the tunnel, so the task should
  // succeed while reporting what happened.
  assert.equal(result.exitCode, 3);
  assert.match(result.stderr, /claim refused/);
});

// ---------------------------------------------------------- configuration

test('a missing ALPHA_REPO_ROOT is a clear configuration error', async () => {
  await withEnv({ ALPHA_REPO_ROOT: undefined }, async () => {
    await assert.rejects(() => run({ action: 'Status', actor: 'x' }), /ALPHA_REPO_ROOT is not set/);
  });
});

test('a missing coordination script is reported, not silently skipped', async () => {
  const { root, stub } = await fixture();
  await withEnv(
    {
      ALPHA_REPO_ROOT: root,
      ALPHA_POWERSHELL: stub,
      ALPHA_COORDINATION_SCRIPT: 'scripts/does_not_exist.ps1',
    },
    async () => {
      await assert.rejects(() => run({ action: 'Status', actor: 'x' }), /coordination script not found/);
    },
  );
});

test('the script cannot be pointed outside the working copy', async () => {
  const { root, stub } = await fixture();
  await withEnv(
    {
      ALPHA_REPO_ROOT: root,
      ALPHA_POWERSHELL: stub,
      ALPHA_COORDINATION_SCRIPT: '../../../etc/passwd',
    },
    async () => {
      await assert.rejects(() => run({ action: 'Status', actor: 'x' }), /must live inside ALPHA_REPO_ROOT/);
    },
  );
});

test('a missing PowerShell gives an actionable message', async () => {
  const { root } = await fixture();
  await withEnv(
    { ALPHA_REPO_ROOT: root, ALPHA_POWERSHELL: join(root, 'nope') },
    async () => {
      await assert.rejects(() => run({ action: 'Status', actor: 'x' }), /PowerShell not found/);
    },
  );
});

test('the handler is not registered by default', async () => {
  const { HandlerRegistry } = await import('../src/agent/handlers/index.js');
  const registry = new HandlerRegistry();
  // Running an external program must be opted into explicitly on the host.
  assert.equal(registry.has('alpha.coordination'), false);
  assert.deepEqual(registry.types(), ['echo', 'sysinfo']);
});

// ------------------------------------------------- opt-in via configuration

/** Runs the agent entrypoint as a subprocess and collects its output. */
function spawnAgent(env, { waitFor, timeoutMs = 15_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ['src/agent/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ALPHA_AGENT_KEY: 'irrelevant-but-present',
        // Port 1 refuses instantly, so the agent never actually attaches.
        ALPHA_HOST_URL: 'http://127.0.0.1:1',
        ALPHA_LOG_LEVEL: 'info',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    const done = (exitCode) => {
      child.kill('SIGKILL');
      clearTimeout(timer);
      resolvePromise({ output, exitCode });
    };
    const onChunk = (chunk) => {
      output += chunk;
      if (waitFor && output.includes(waitFor)) done(null);
    };

    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('exit', (code) => done(code));
    const timer = setTimeout(() => done(null), timeoutMs);
  });
}

test('ALPHA_EXTRA_HANDLERS registers the handler without editing source', async () => {
  const { root, stub } = await fixture();
  const { output } = await spawnAgent(
    {
      ALPHA_EXTRA_HANDLERS: 'alpha-coordination',
      ALPHA_REPO_ROOT: root,
      ALPHA_POWERSHELL: stub,
    },
    { waitFor: 'handlers available' },
  );

  assert.match(output, /registered extra handler/);
  assert.match(output, /alpha\.coordination/);
});

test('a handler name that could escape the handlers directory is refused', async () => {
  for (const name of ['../../etc/passwd', '/abs/path', 'Bad_Name', './nested']) {
    const { output, exitCode } = await spawnAgent({ ALPHA_EXTRA_HANDLERS: name });
    assert.equal(exitCode, 1, `expected "${name}" to be refused`);
    assert.match(output, /invalid handler name/);
  }
});

test('an unknown handler name fails fast rather than starting degraded', async () => {
  const { output, exitCode } = await spawnAgent({ ALPHA_EXTRA_HANDLERS: 'does-not-exist' });
  assert.equal(exitCode, 1);
  assert.match(output, /could not load handler/);
});

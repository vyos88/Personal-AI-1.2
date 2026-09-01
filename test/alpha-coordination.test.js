import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ALLOWED_ACTIONS,
  buildArgs,
  run,
  validateAction,
  validateActor,
  validatePaths,
} from '../src/agent/handlers/alpha-coordination.js';

/**
 * Builds a throwaway Alpha working copy with a stub "PowerShell" that records
 * the argv it was handed. That is what makes these assertions meaningful: the
 * real .ps1 is not available here, but argument construction, validation and
 * refusal behaviour are exactly the parts that must not be guessed at.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'alpha-repo-'));
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'alpha_coordination_tunnel.ps1'), '# stub\n');

  const argvLog = join(root, 'argv.json');
  const stub = join(root, 'fake-powershell');
  // Records argv as JSON, so a test can assert on exact argument boundaries.
  await writeFile(
    stub,
    `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write('stub ok');
`,
  );
  await chmod(stub, 0o755);

  return { root, stub, argvLog };
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
  const { root, stub, argvLog } = await fixture();

  const result = await withEnv({ ALPHA_REPO_ROOT: root, ALPHA_POWERSHELL: stub }, () =>
    run({
      action: 'Post',
      actor: 'claude-cowork',
      message: 'Retro receipt: wired the interaction pack into Alpha.',
      paths: ['software/backend/main.py'],
    }),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'stub ok');
  assert.deepEqual(result.paths, ['software/backend/main.py']);

  const argv = JSON.parse(await readFile(argvLog, 'utf8'));
  assert.deepEqual(argv, [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(root, 'scripts', 'alpha_coordination_tunnel.ps1'),
    '-Action',
    'Post',
    '-Actor',
    'claude-cowork',
    '-Message',
    'Retro receipt: wired the interaction pack into Alpha.',
    '-Paths',
    'software/backend/main.py',
  ]);
});

test('a non-zero exit is reported as data, not thrown', async () => {
  const { root } = await fixture();
  const failing = join(root, 'failing-powershell');
  await writeFile(failing, '#!/usr/bin/env node\nprocess.stderr.write("claim refused");\nprocess.exit(3);\n');
  await chmod(failing, 0o755);

  const result = await withEnv({ ALPHA_REPO_ROOT: root, ALPHA_POWERSHELL: failing }, () =>
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

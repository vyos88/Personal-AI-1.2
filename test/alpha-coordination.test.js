import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHost } from '../src/host/server.js';
import { TunnelAgent } from '../src/agent/agent.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';
import { fetchJson } from '../src/common/http.js';

import {
  ACK_STAGES,
  ALLOWED_ACTIONS,
  buildArgs,
  configuredActions,
  requireOffered,
  run,
  statusEvidence,
  validateAck,
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
async function fixture({ exitCode = 0, stderr = '', stdout = 'stub ok' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'alpha-repo-'));
  await mkdir(join(root, 'scripts'), { recursive: true });
  const scriptPath = join(root, 'scripts', 'alpha_coordination_tunnel.ps1');
  const argvLog = join(root, 'argv.json');

  const outputPath = join(root, 'output.txt');
  await writeFile(outputPath, stdout);
  if (isWindows) {
    // WriteAllText avoids the BOM that Set-Content -Encoding UTF8 emits on
    // Windows PowerShell 5.1, which JSON.parse would choke on. The join
    // builds the array by hand because ConvertTo-Json unrolls a one-element
    // array into a bare scalar.
    await writeFile(
      scriptPath,
      `$items = @($args | ForEach-Object { $_ | ConvertTo-Json -Compress })
[System.IO.File]::WriteAllText(${psLiteral(argvLog)}, '[' + ($items -join ',') + ']')
[Console]::Out.Write([System.IO.File]::ReadAllText(${psLiteral(outputPath)}))
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
process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(outputPath)}));
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

test('a large real PowerShell status retains its validated summary and complete stdout', async () => {
  const snapshot = {
    schema: 'alpha.coordination.status.v1', generated_at: '2026-10-08T09:00:00Z',
    tunnel_identity: { host_id: 'worker1', workspace_id: 'different-install' },
    claims: { 'software/backend/main.py': { actor: 'claude', state: 'current' } },
    claims_lifecycle: { records: 1, current: 1, details: [{ path: 'software/backend/main.py' }] },
    recent_events: [{ message: 'x'.repeat(20_000) }],
  };
  const raw = JSON.stringify(snapshot);
  const { root, stub } = await fixture({ stdout: raw, stderr: 'y'.repeat(17_000) });
  await withEnv({ ALPHA_REPO_ROOT: root, ALPHA_POWERSHELL: stub }, async () => {
    const result = await run({ action: 'Status', actor: 'codex' });
    assert.equal(result.exitCode, 0);
    assert.equal(result.sourceRoot, root);
    assert.equal(result.stdout, raw);
    assert.equal(result.stdoutTruncated, false);
    assert.equal(result.statusComplete, true);
    assert.equal(result.stderrTruncated, true);
    assert.equal(result.statusError, null);
    assert.deepEqual(result.status.claims, snapshot.claims);
    assert.equal(result.status.claimsLifecycle.current, 1);
    assert.equal(result.status.tunnelIdentity.workspace_id, 'different-install');
    assert.equal(result.status.claimsComplete, true);
  });
});

test('malformed or missing status evidence never becomes an empty ownership result', () => {
  for (const raw of ['tail of JSON}', '{}', '{"schema":"alpha.coordination.status.v1"}']) {
    const result = statusEvidence(raw);
    assert.equal(result.status, null);
    assert.match(result.statusError, /ownership is unknown/);
  }
  const result = statusEvidence('\uFEFF' + JSON.stringify({
    schema: 'alpha.coordination.status.v1', claims: {}, claims_lifecycle: {},
  }));
  assert.equal(result.status.claimsLifecycle.current, undefined);
  assert.equal(result.status.tunnelIdentity, null);
});

test('bounded status claims explicitly report incomplete lists and retain exact counts', () => {
  const claims = Object.fromEntries(Array.from({ length: 65 }, (_, i) => ['file' + i, { actor: 'claude' }]));
  const result = statusEvidence(JSON.stringify({
    schema: 'alpha.coordination.status.v1', claims,
    claims_lifecycle: { records: 65, current: 65, details: Object.keys(claims).map(path => ({ path })) },
  }));
  assert.equal(result.status.claimEntries, 65);
  assert.equal(Object.keys(result.status.claims).length, 64);
  assert.equal(result.status.claimsComplete, false);
  assert.equal(result.status.lifecycleDetailsComplete, false);
  assert.equal(result.status.claimsLifecycle.current, 65);
});

test('a failed status command never attaches parsed ownership evidence', async () => {
  const { root, stub } = await fixture({ exitCode: 1, stdout: JSON.stringify({
    schema: 'alpha.coordination.status.v1', claims: {}, claims_lifecycle: { current: 0 },
  }) });
  await withEnv({ ALPHA_REPO_ROOT: root, ALPHA_POWERSHELL: stub }, async () => {
    const result = await run({ action: 'Status', actor: 'codex' });
    assert.equal(result.exitCode, 1);
    assert.equal(result.status, undefined);
  });
});

// ------------------------------------------------------------- validation

test('only allowlisted actions are accepted', () => {
  for (const action of ALLOWED_ACTIONS) assert.equal(validateAction(action), action);
  assert.throws(() => validateAction('Delete'), /unsupported action/);
  assert.throws(() => validateAction('post'), /unsupported action/); // case matters
  assert.throws(() => validateAction(undefined), /unsupported action/);
});

test('ALPHA_COORDINATION_ACTIONS narrows the actions, and unset means all of them', () => {
  assert.deepEqual(configuredActions(undefined), ALLOWED_ACTIONS);
  assert.deepEqual(configuredActions(''), ALLOWED_ACTIONS);
  assert.deepEqual(configuredActions(' Post , Ack,Status,Post '), ['Post', 'Ack', 'Status']);
  // A typo must not leave a standby taking claims, or taking nothing quietly.
  assert.throws(() => configuredActions('Post,claim'), /"claim", which is not one of/);
  assert.throws(() => configuredActions('Post,Delete'), /"Delete"/);
  assert.throws(() => configuredActions(' , '), /names no action/);
});

test('an action this agent was configured not to take is refused with the reason', () => {
  const offered = configuredActions('Post,Ack,Status');
  assert.equal(requireOffered('Post', offered), 'Post');
  assert.throws(
    () => requireOffered('Claim', offered),
    (error) =>
      error.code === 'action_not_offered' &&
      /takes only Post, Ack, Status/.test(error.message) &&
      /Claim waits for the main coordination agent/.test(error.message),
  );
  // Every allowed action passes when nothing narrows the list.
  for (const action of ALLOWED_ACTIONS) assert.equal(requireOffered(action, configuredActions('')), action);
});

test('a narrowed agent refuses Claim before running anything, and still posts', async () => {
  const { root, stub, argvLog } = await fixture();
  await withEnv(
    { ALPHA_REPO_ROOT: root, ALPHA_POWERSHELL: stub, ALPHA_COORDINATION_ACTIONS: 'Post,Ack,Status' },
    async () => {
      await assert.rejects(
        () => run({ action: 'Claim', actor: 'claude', paths: ['a.txt'] }),
        /takes only Post, Ack, Status/,
      );
      await assert.rejects(() => readFile(argvLog), { code: 'ENOENT' });
      const result = await run({ action: 'Post', actor: 'claude', message: 'standby note' });
      assert.equal(result.exitCode, 0);
    },
  );
});

test('available() reports a bad ALPHA_COORDINATION_ACTIONS instead of offering the type', async () => {
  const { available } = await import('../src/agent/handlers/alpha-coordination.js');
  const { root, stub } = await fixture();
  await withEnv(
    { ALPHA_REPO_ROOT: root, ALPHA_POWERSHELL: stub, ALPHA_COORDINATION_ACTIONS: 'Post,Relase' },
    async () => {
      const verdict = available();
      assert.equal(verdict.ok, false);
      assert.match(verdict.reason, /"Relase"/);
    },
  );
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

const HANDOFF_ID = '0123456789abcdef0123456789abcdef';

test('Ack needs the event id it answers, and only a stage the script knows', () => {
  assert.deepEqual(validateAck('Ack', HANDOFF_ID, undefined), { eventId: HANDOFF_ID, stage: null });
  for (const stage of ACK_STAGES) {
    assert.deepEqual(validateAck('Ack', HANDOFF_ID, stage), { eventId: HANDOFF_ID, stage });
  }
  assert.throws(() => validateAck('Ack', undefined, undefined), /Ack requires "eventId"/);
  assert.throws(() => validateAck('Ack', HANDOFF_ID.toUpperCase(), undefined), /Ack requires "eventId"/);
  assert.throws(() => validateAck('Ack', `${HANDOFF_ID}; rm -rf /`, undefined), /Ack requires "eventId"/);
  assert.throws(() => validateAck('Ack', HANDOFF_ID, 'done'), /unsupported stage "done"/);
  assert.throws(() => validateAck('Ack', HANDOFF_ID, 'Accepted'), /unsupported stage/); // case matters
});

test('eventId and stage are refused on every action but Ack, not dropped', () => {
  assert.deepEqual(validateAck('Post', undefined, undefined), { eventId: null, stage: null });
  assert.throws(() => validateAck('Post', HANDOFF_ID, undefined), /only accepted with the Ack action/);
  assert.throws(() => validateAck('Status', undefined, 'tested'), /only accepted with the Ack action/);
});

test('Ack argv names the event, and passes -Stage only when one was given', () => {
  const base = { script: 'C:\\alpha\\scripts\\alpha_coordination_tunnel.ps1', action: 'Ack', actor: 'claude', paths: [] };
  const staged = buildArgs({ ...base, message: 'accepted: claiming files', eventId: HANDOFF_ID, stage: 'accepted' });
  assert.deepEqual(staged.slice(staged.indexOf('-Action')), [
    '-Action', 'Ack', '-Actor', 'claude', '-Message', 'accepted: claiming files',
    '-EventId', HANDOFF_ID, '-Stage', 'accepted',
  ]);
  // A plain Ack names no stage. (A script from before Alpha PR #59 has no
  // -Stage either; it ignores it rather than refusing, which was checked
  // against that script, not assumed here.)
  const plain = buildArgs({ ...base, eventId: HANDOFF_ID });
  assert.deepEqual(plain.slice(plain.indexOf('-Action')), ['-Action', 'Ack', '-Actor', 'claude', '-EventId', HANDOFF_ID]);
  assert.equal(plain.includes('-Stage'), false);
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

test('a real Ack invocation passes exactly the expected argv', async () => {
  const { root, stub, argvLog, argvPrefix } = await fixture();

  const result = await withEnv({ ALPHA_REPO_ROOT: root, ALPHA_POWERSHELL: stub }, () =>
    run({
      action: 'Ack',
      actor: 'claude',
      eventId: HANDOFF_ID,
      stage: 'tested',
      message: 'tested: node --test test/alpha-coordination.test.js; all passed',
    }),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.eventId, HANDOFF_ID);
  assert.equal(result.stage, 'tested');
  const argv = JSON.parse(await readFile(argvLog, 'utf8'));
  assert.deepEqual(argv, [
    ...argvPrefix,
    '-Action',
    'Ack',
    '-Actor',
    'claude',
    '-Message',
    'tested: node --test test/alpha-coordination.test.js; all passed',
    '-EventId',
    HANDOFF_ID,
    '-Stage',
    'tested',
  ]);
});

test('an Ack with no event id never reaches the script', async () => {
  const { root, stub, argvLog } = await fixture();
  await withEnv({ ALPHA_REPO_ROOT: root, ALPHA_POWERSHELL: stub }, async () => {
    await assert.rejects(() => run({ action: 'Ack', actor: 'claude', stage: 'received' }), /Ack requires "eventId"/);
  });
  await assert.rejects(() => readFile(argvLog, 'utf8'), { code: 'ENOENT' });
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

test('a run aborted before it finished is a failure, not exit code 0', async () => {
  if (isWindows) return;
  const { root, stub } = await fixture();
  // Outlast the abort: a killed child reports code null, which `?? 0` used to
  // turn into a clean exit, so a run that never finished read as success.
  await writeFile(stub, '#!/usr/bin/env bash\nsleep 5\n');
  await chmod(stub, 0o755);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);

  await withEnv({ ALPHA_REPO_ROOT: root, ALPHA_POWERSHELL: stub }, () =>
    assert.rejects(
      run({ action: 'Status', actor: 'claude-remote' }, { signal: controller.signal }),
      (error) => error.code === 'coordination_killed',
    ),
  );
});

function largeStatus() {
  return { schema: 'alpha.coordination.status.v1', claims_lifecycle: {},
    claims: Object.fromEntries(Array.from({ length: 900 }, (_, i) =>
    [`software/file-${i}.js`, { actor: `owner-${i}`, note: 'Preserve this active owner and its work.' }])) };
}

test('Status preserves complete ownership JSON beyond the diagnostic tail', async () => {
  const status = largeStatus();
  const stdout = JSON.stringify(status);
  assert.ok(stdout.length > 16_000);
  const { root, stub } = await fixture({ stdout });
  const result = await withEnv({ ALPHA_REPO_ROOT: root, ALPHA_POWERSHELL: stub }, () =>
    run({ action: 'Status', actor: 'audit' }));
  assert.equal(result.statusComplete, true);
  assert.equal(result.stdoutTruncated, false);
  assert.equal(result.sourceRoot, root);
  assert.equal(result.statusError, null);
  assert.equal(result.status.claimEntries, 900);
  assert.equal(result.status.claimsComplete, false);
  assert.deepEqual(JSON.parse(result.stdout), status);
});

test('invalid, oversized and failed Status never claim complete ownership', async (t) => {
  for (const [name, stdout, exitCode, expected] of [
    ['malformed', 'x'.repeat(17_000) + '{"claims":', 0, 'invalid_status'],
    ['missing claims', '{}', 0, 'invalid_status'],
    ['array claims', '{"claims":[]}', 0, 'invalid_status'],
    ['missing lifecycle', '{"schema":"alpha.coordination.status.v1","claims":{}}', 0, 'invalid_status'],
    ['oversized escaped envelope', JSON.stringify({ schema: 'alpha.coordination.status.v1', claims: {}, claims_lifecycle: {}, note: '\\'.repeat(400_000) }), 0, 'status_too_large'],
    ['oversized structured summary', JSON.stringify({ schema: 'alpha.coordination.status.v1', claims: { file: { note: '\\'.repeat(400_000) } }, claims_lifecycle: {} }), 0, 'status_too_large'],
    ['nonzero script', JSON.stringify(largeStatus()), 3, 'script_failed'],
  ]) {
    await t.test(name, async () => {
      const { root, stub } = await fixture({ stdout, exitCode });
      const result = await withEnv({ ALPHA_REPO_ROOT: root, ALPHA_POWERSHELL: stub }, () =>
        run({ action: 'Status', actor: 'audit' }));
      assert.equal(result.statusComplete, false);
      assert.equal(result.statusCompletenessError, expected);
      assert.equal(result.exitCode, exitCode);
      assert.ok(result.stdout.length <= 16_000);
      assert.ok(Buffer.byteLength(JSON.stringify({ result }), 'utf8') < 1_000_000);
      if (name === 'oversized structured summary') {
        assert.equal(result.status, null);
        assert.match(result.statusError, /ownership is unknown/);
      }
    });
  }
});

test('a PowerShell BOM cannot make a complete status unreadable', async () => {
  const { root, stub } = await fixture({ stdout: '\uFEFF{"schema":"alpha.coordination.status.v1","claims":{},"claims_lifecycle":{}}' });
  const result = await withEnv({ ALPHA_REPO_ROOT: root, ALPHA_POWERSHELL: stub }, () =>
    run({ action: 'Status', actor: 'audit' }));
  assert.equal(result.statusComplete, true);
  assert.deepEqual(JSON.parse(result.stdout), { schema: 'alpha.coordination.status.v1', claims: {}, claims_lifecycle: {} });
});

test('ordinary coordination diagnostics retain the bounded tail with explicit truncation', async () => {
  const stdout = 'a'.repeat(20_000) + 'end';
  const { root, stub } = await fixture({ stdout });
  const result = await withEnv({ ALPHA_REPO_ROOT: root, ALPHA_POWERSHELL: stub }, () =>
    run({ action: 'Post', actor: 'audit', message: 'receipt' }));
  assert.equal(result.stdout, stdout.slice(-16_000));
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.statusComplete, undefined);
});

test('complete Status travels through a real leased task and result endpoint', { timeout: 30_000 }, async () => {
  const status = largeStatus();
  const { root, stub } = await fixture({ stdout: JSON.stringify(status) });
  await withEnv({ ALPHA_REPO_ROOT: root, ALPHA_POWERSHELL: stub }, async () => {
    const token = 'coordination-status-test-token';
    const host = createHost({ token });
    await new Promise(resolve => host.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${host.server.address().port}`;
    const agent = new TunnelAgent({ hostUrl: url, token, name: 'status-auditor', pollWaitMs: 500,
      handlers: new HandlerRegistry([{ type: 'alpha.coordination', run }]) });
    const running = agent.start();
    try {
      const { body: created } = await fetchJson(`${url}/tasks`, { method: 'POST', token,
        body: { type: 'alpha.coordination', maxAttempts: 1, payload: { action: 'Status', actor: 'audit' } } });
      let finished;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const { body } = await fetchJson(`${url}/tasks/${created.id}`, { token });
        if (!['queued', 'leased'].includes(body.status)) { finished = body; break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.ok(finished, 'original task must reach a terminal state');
      assert.equal(finished.status, 'succeeded');
      assert.equal(finished.attempts, 1);
      assert.equal(finished.result.statusComplete, true);
      assert.equal(finished.result.stdoutTruncated, false);
      assert.equal(finished.result.sourceRoot, root);
      assert.deepEqual(JSON.parse(finished.result.stdout), status);
    } finally {
      await agent.stop();
      await running;
      await host.close();
    }
  });
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
  assert.equal(registry.has('alpha.update'), false);
  assert.equal(registry.has('memory.store'), false);
  // Deliberately NOT an exhaustive list of what is registered. This test is
  // about what must not be here; pinning the whole list made it fail for any
  // new built-in that runs no external program, which is not its subject.
  for (const type of registry.types()) {
    assert.ok(typeof registry.get(type).run === 'function');
  }
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

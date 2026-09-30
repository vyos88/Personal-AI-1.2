// Every handler that drives an external program must refuse a machine that
// cannot run it, *before* the agent offers the type.
//
// Opt-in is not enough on its own, and that is the whole point of
// `available()`: `.env.agent` is copied from the host to a laptop, so the
// opt-in travels with it. The laptop then advertises the type, wins the task
// on free RAM, and fails it — with an attempt spent and a retry free to land
// right back there. `alpha.render` and `device.inventory` already refused that
// way; `alpha.coordination` and `alpha.update` did not, and a machine with no
// Alpha working copy on it advertised both.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HandlerRegistry } from '../src/agent/handlers/index.js';
import * as coordination from '../src/agent/handlers/alpha-coordination.js';
import * as update from '../src/agent/handlers/alpha-update.js';

/** Restores every env var these tests touch, whatever the test did to it. */
function withEnv(vars) {
  const before = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

test('an external-program handler with no root is never offered', () => {
  const restore = withEnv({ ALPHA_REPO_ROOT: null });
  try {
    const registry = new HandlerRegistry([]);
    for (const handler of [coordination, update]) {
      const result = registry.add(handler);
      assert.equal(result.registered, false, `${handler.type} was offered anyway`);
      assert.match(result.reason, /ALPHA_REPO_ROOT is not set/);
    }
    // The agent advertises what the registry holds, so nothing reaches the host.
    assert.deepEqual(registry.types(), []);
  } finally {
    restore();
  }
});

test('alpha.update is offered on a real git checkout, and not on a directory that is not one', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'avail-'));
  t.after(() => rm(base, { recursive: true, force: true }));

  const notARepo = join(base, 'plain');
  await mkdir(notARepo, { recursive: true });

  let restore = withEnv({ ALPHA_REPO_ROOT: notARepo });
  try {
    const answer = update.available();
    assert.equal(answer.ok, false);
    assert.match(answer.reason, /not a git working copy/);
  } finally {
    restore();
  }

  // This checkout is one, so the same call says yes.
  restore = withEnv({ ALPHA_REPO_ROOT: process.cwd() });
  try {
    assert.deepEqual(update.available(), { ok: true });
  } finally {
    restore();
  }
});

test('alpha.coordination refuses a root whose tunnel script is missing, then accepts one that has it', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'avail-coord-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, 'scripts'), { recursive: true });

  // available() resolves the interpreter the same way run() spawns it, so this
  // suite supplies one. It is never executed: whether PowerShell can drive the
  // tunnel is not knowable without running it, and run() reports that itself.
  const shell = join(base, 'stub-powershell');
  await writeFile(shell, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  let restore = withEnv({ ALPHA_REPO_ROOT: base, ALPHA_POWERSHELL: shell });
  try {
    const answer = coordination.available();
    assert.equal(answer.ok, false, 'offered a root with no tunnel script in it');
    assert.match(answer.reason, /coordination script not found/);
  } finally {
    restore();
  }

  await writeFile(join(base, 'scripts', 'alpha_coordination_tunnel.ps1'), '# stub\n');
  restore = withEnv({ ALPHA_REPO_ROOT: base, ALPHA_POWERSHELL: shell });
  try {
    assert.deepEqual(coordination.available(), { ok: true });
  } finally {
    restore();
  }
});

test('a machine without the interpreter is not offered the type', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'avail-exe-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, 'scripts'), { recursive: true });
  await writeFile(join(base, 'scripts', 'alpha_coordination_tunnel.ps1'), '# stub\n');

  let restore = withEnv({
    ALPHA_REPO_ROOT: base,
    ALPHA_POWERSHELL: join(base, 'no-such-shell'),
  });
  try {
    const shellAnswer = coordination.available();
    assert.equal(shellAnswer.ok, false);
    assert.match(shellAnswer.reason, /PowerShell not found/);
  } finally {
    restore();
  }

  // The root has to be a real checkout to reach the git check at all: the
  // working-copy question is asked first, and answers for itself.
  restore = withEnv({ ALPHA_REPO_ROOT: process.cwd(), ALPHA_GIT: join(base, 'no-such-git') });
  try {
    const gitAnswer = update.available();
    assert.equal(gitAnswer.ok, false);
    assert.match(gitAnswer.reason, /git not found/);
  } finally {
    restore();
  }
});

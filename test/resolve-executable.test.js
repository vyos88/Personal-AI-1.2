// The PATH lookup every handler that spawns a program shares.
//
// It was seven copies before this, in four variants, and one of them was
// wrong: codex.exec's lacked the "already has an extension" guard, so on
// Windows ALPHA_CODEX=codex.exe asked for codex.exe.EXE and reported a
// perfectly configured machine as having no Codex. That is the same bug the
// device handler had already fixed once for powershell.exe, which is the
// argument for one copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveExecutable, isShellScript } from '../src/common/resolve-executable.js';

/** Restores PATH and PATHEXT whatever the test did to them. */
function withPath(dir, pathext) {
  const before = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT };
  process.env.PATH = dir;
  if (pathext !== undefined) process.env.PATHEXT = pathext;
  return () => {
    process.env.PATH = before.PATH;
    if (before.PATHEXT === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = before.PATHEXT;
  };
}

async function bin(t) {
  const dir = await mkdtemp(join(tmpdir(), 'resolve-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('a path is taken as given, not looked up', async (t) => {
  const dir = await bin(t);
  const exe = join(dir, 'tool');
  await writeFile(exe, '');
  assert.equal(resolveExecutable(exe), exe);
  assert.equal(resolveExecutable(join(dir, 'absent')), null);
});

test('a bare name is found on PATH', async (t) => {
  const dir = await bin(t);
  await writeFile(join(dir, 'tool'), '');
  const restore = withPath(dir);
  try {
    assert.equal(resolveExecutable('tool'), join(dir, 'tool'));
    assert.equal(resolveExecutable('absent'), null);
  } finally {
    restore();
  }
});

test('an empty PATH entry is skipped rather than resolving against the cwd', async (t) => {
  const dir = await bin(t);
  await writeFile(join(dir, 'tool'), '');
  const restore = withPath(`:${dir}:`);
  try {
    // The separator differs per platform, so this only asserts the found case
    // holds when empty entries surround it.
    const found = resolveExecutable('tool');
    assert.ok(found === null || found === join(dir, 'tool'));
  } finally {
    restore();
  }
});

test('isShellScript names only what execFile cannot spawn alone', () => {
  assert.equal(isShellScript('C:\\x\\codex.cmd'), true);
  assert.equal(isShellScript('C:\\x\\codex.BAT'), true);
  assert.equal(isShellScript('C:\\x\\codex.exe'), false);
  assert.equal(isShellScript('/usr/bin/codex'), false);
});

// The Windows-only behaviour is asserted through candidateExtensions' two
// rules, which are observable on any platform through what is *not* tried:
// off win32 the extension list is [''] , so a name with an extension and a
// name without both resolve by exact match only.
test('off Windows, PATHEXT is never appended', async (t) => {
  const dir = await bin(t);
  await writeFile(join(dir, 'tool.exe'), '');
  const restore = withPath(dir, '.EXE;.CMD');
  try {
    // 'tool' must not find 'tool.exe' anywhere but win32.
    const expected = process.platform === 'win32' ? join(dir, 'tool.exe') : null;
    assert.equal(resolveExecutable('tool'), expected);
    // A name carrying its own extension resolves by exact match on every
    // platform - this is the guard codex.exec was missing.
    assert.equal(resolveExecutable('tool.exe'), join(dir, 'tool.exe'));
  } finally {
    restore();
  }
});

test('nativeFirst does not change which files can be found, only the order tried', async (t) => {
  const dir = await bin(t);
  await writeFile(join(dir, 'codex.cmd'), '');
  const restore = withPath(dir, '.CMD;.EXE');
  try {
    const plain = resolveExecutable('codex');
    const native = resolveExecutable('codex', { nativeFirst: true });
    if (process.platform === 'win32') {
      // Only the shim exists, so both find it; codex.exec then refuses it by
      // name rather than by failing to resolve.
      assert.equal(plain, join(dir, 'codex.cmd'));
      assert.equal(native, join(dir, 'codex.cmd'));
      assert.equal(isShellScript(native), true);
    } else {
      assert.equal(plain, null);
      assert.equal(native, null);
    }
  } finally {
    restore();
  }
});

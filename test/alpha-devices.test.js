// What is plugged into that laptop, asked from anywhere.
//
// The fleet could see a worker's RAM and CPU and nothing else, so "is the panel
// still plugged in, and on which COM port?" could only be answered by someone
// sitting at the machine. This handler makes it a task. It runs an external
// program, so what the tests are mostly about is the argv it builds and the
// arguments it refuses to build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, chmod, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  available,
  buildArgs,
  rejectArguments,
  run,
  type,
  description,
} from '../src/agent/handlers/alpha-devices.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';
import * as deviceHandler from '../src/agent/handlers/alpha-devices.js';
import { ProtocolError } from '../src/common/protocol.js';

const isWindows = process.platform === 'win32';
const ROOT = resolve(import.meta.dirname, '..');
const OUTPUT = resolve(ROOT, 'scripts/usb-inventory.json');

/**
 * A stub interpreter standing in for PowerShell: it records the argv it was
 * given and writes the inventory JSON the real script would write.
 */
async function stubInterpreter({ exitCode = 0, writeJson = true, json = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'alpha-devices-'));
  const argvLog = join(dir, 'argv.json');
  const stub = join(dir, 'pwsh-stub.sh');
  const payload =
    json ??
    {
      machine: 'JACKS-LAPTOP',
      collectedAt: '2026-09-15T04:00:00.000Z',
      usb: [
        { name: 'USB-SERIAL CH340', class: 'Ports', status: 'OK', vid: '1A86', pid: '7523' },
        { name: 'Unknown device', class: 'Other', status: 'Error', vid: null, pid: null },
      ],
      serialPorts: [{ port: 'COM3', name: 'USB-SERIAL CH340 (COM3)' }],
      avDevices: [],
    };

  await writeFile(
    stub,
    [
      '#!/usr/bin/env bash',
      // Record every argument, so a test can pin the argv exactly.
      `printf '%s\\n' "$@" > ${JSON.stringify(argvLog)}`,
      writeJson
        ? `cat > ${JSON.stringify(OUTPUT)} <<'JSON'\n${JSON.stringify(payload, null, 2)}\nJSON`
        : ': no json written',
      `exit ${exitCode}`,
    ].join('\n') + '\n',
  );
  await chmod(stub, 0o755);
  return { dir, stub, argvLog };
}

function useStub(t, stub) {
  const previous = process.env.ALPHA_POWERSHELL;
  process.env.ALPHA_POWERSHELL = stub;
  t.after(async () => {
    if (previous === undefined) delete process.env.ALPHA_POWERSHELL;
    else process.env.ALPHA_POWERSHELL = previous;
    // The stub writes into the checkout, exactly where the real script does.
    if (existsSync(OUTPUT)) await (await import('node:fs/promises')).rm(OUTPUT, { force: true });
  });
}

// ------------------------------------------------------------------ contract

test('the handler is a read-only inventory, by name and description', () => {
  assert.equal(type, 'device.inventory');
  assert.match(description, /read-only/i);
  assert.match(description, /no arguments/i);
});

test('it is not registered by default, because it runs an external program', () => {
  // The rule the repo keeps: a handler that starts a process is opt-in, so a
  // laptop that never asked for it cannot be handed this work.
  const registry = new HandlerRegistry();
  assert.equal(registry.has('device.inventory'), false);
});

test('the argv is pinned, and carries nothing but the script', () => {
  // -File makes PowerShell run the script rather than treat it as a command,
  // and -NoProfile keeps whatever is in the machine's profile out of it.
  assert.deepEqual(buildArgs({ script: 'C:\\tunnel\\scripts\\usb-inventory.ps1' }), [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'C:\\tunnel\\scripts\\usb-inventory.ps1',
  ]);
});

test('a payload is refused rather than ignored', async () => {
  // The script takes no arguments, so anything sent would silently do nothing.
  // A caller who sent `{ port: 'COM3' }` expecting it to mean something should
  // be told it did not.
  rejectArguments(undefined);
  rejectArguments(null);
  rejectArguments({});
  assert.throws(() => rejectArguments({ port: 'COM3' }), ProtocolError);
  assert.throws(() => rejectArguments({ port: 'COM3; shutdown /r' }), /would not reach it/);
  assert.throws(() => rejectArguments('COM3'), /takes no payload/);
  await assert.rejects(run({ anything: 1 }), /takes no arguments/);
});

// --------------------------------------------------------------- availability

test('a machine with no PowerShell does not offer to inventory devices', (t) => {
  const previous = process.env.ALPHA_POWERSHELL;
  t.after(() => {
    if (previous === undefined) delete process.env.ALPHA_POWERSHELL;
    else process.env.ALPHA_POWERSHELL = previous;
  });

  process.env.ALPHA_POWERSHELL = join(tmpdir(), 'no-such-powershell');
  const check = available();
  assert.equal(check.ok, false);
  assert.match(check.reason, /PowerShell not found/);

  // And the registry leaves it out rather than advertising a capability whose
  // every task would fail — the same rule alpha-render follows.
  const registry = new HandlerRegistry([]);
  const outcome = registry.add(deviceHandler);
  assert.equal(outcome.registered, false);
  assert.equal(registry.has('device.inventory'), false);
});

test('a machine that can run it offers it', async (t) => {
  if (isWindows) return;
  const { stub } = await stubInterpreter();
  useStub(t, stub);
  assert.deepEqual(available(), { ok: true });

  const registry = new HandlerRegistry([]);
  assert.equal(registry.add(deviceHandler).registered, true);
  assert.equal(registry.has('device.inventory'), true);
});

// ----------------------------------------------------------------- the report

test('it reports the COM port a board came back on, and what is broken', async (t) => {
  if (isWindows) return;
  const { stub, argvLog } = await stubInterpreter();
  useStub(t, stub);

  const result = await run({});

  // The argv the interpreter actually saw: nothing but the pinned script.
  const seen = (await readFile(argvLog, 'utf8')).trim().split('\n');
  assert.deepEqual(seen.slice(0, 4), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']);
  assert.equal(seen[4], resolve(ROOT, 'scripts/usb-inventory.ps1'));
  assert.equal(seen.length, 5);

  assert.equal(result.machine, 'JACKS-LAPTOP');
  // The script's own timestamp, not the handler's: the moment the devices were
  // read, which is what matters if the task waited in a queue.
  assert.equal(result.collectedAt, '2026-09-15T04:00:00.000Z');
  assert.deepEqual(result.serialPorts, [{ port: 'COM3', name: 'USB-SERIAL CH340 (COM3)' }]);
  assert.deepEqual(result.counts, { usb: 2, serialPorts: 1, avDevices: 0 });
  // Attached but not working is the actionable half of an inventory.
  assert.equal(result.notWorking.length, 1);
  assert.equal(result.notWorking[0].status, 'Error');
});

test('field names come from what the script writes, not from what reads well', async (t) => {
  // `serialPorts` is the script's name for it. Reading a plausible `ports`
  // instead returned an empty list on every machine, which looks like "nothing
  // attached" rather than like a bug — so this pins the real shape.
  if (isWindows) return;
  const { stub } = await stubInterpreter({
    json: {
      machine: 'HOST',
      collectedAt: 'now',
      usb: [],
      serialPorts: [{ port: 'COM7' }],
      avDevices: [{ name: 'Webcam' }],
    },
  });
  useStub(t, stub);

  const result = await run({});
  assert.deepEqual(result.serialPorts, [{ port: 'COM7' }]);
  assert.equal(result.counts.avDevices, 1);
});

test('an inventory that failed is not reported as an empty machine', async (t) => {
  if (isWindows) return;
  const { stub } = await stubInterpreter({ exitCode: 1, writeJson: false });
  useStub(t, stub);
  await assert.rejects(run({}), /the inventory exited 1/);
});

test('a clean exit that wrote nothing is a failure too', async (t) => {
  // Otherwise the task succeeds carrying whatever an earlier run left on disk,
  // which is a stale answer presented as a current one.
  if (isWindows) return;
  const { stub } = await stubInterpreter({ exitCode: 0, writeJson: false });
  useStub(t, stub);
  await assert.rejects(run({}), /wrote no scripts\/usb-inventory\.json/);
});

// ------------------------------------------------------ opt-in, over the wire

test('a machine opts in with ALPHA_EXTRA_HANDLERS, and then advertises it', async () => {
  if (isWindows) return;
  const { stub } = await stubInterpreter();
  const output = await new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ['src/agent/index.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        ALPHA_AGENT_KEY: 'irrelevant-but-present',
        ALPHA_HOST_URL: 'http://127.0.0.1:1',
        ALPHA_LOG_LEVEL: 'info',
        ALPHA_EXTRA_HANDLERS: 'alpha-devices',
        ALPHA_POWERSHELL: stub,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let seen = '';
    const done = () => {
      child.kill('SIGKILL');
      clearTimeout(timer);
      resolvePromise(seen);
    };
    const onChunk = (chunk) => {
      seen += chunk;
      if (seen.includes('starting host=')) done();
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('exit', done);
    const timer = setTimeout(done, 15_000);
  });

  const capabilities = /capabilities=(\[[^\]]*\])/.exec(output)?.[1] ?? '';
  assert.match(capabilities, /device\.inventory/);
});

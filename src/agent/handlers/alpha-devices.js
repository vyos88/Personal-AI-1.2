import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join, resolve, sep } from 'node:path';

import { ProtocolError } from '../../common/protocol.js';
import { deprioritize, taskPriorityFromEnv } from '../priority.js';

/**
 * Reports what is physically plugged into this machine, as a task.
 *
 * The fleet could see a laptop's RAM and CPU and nothing else, so "is the panel
 * still plugged in, and on which COM port?" could only be answered by someone
 * sitting at that laptop. That is the wrong shape for a machine that is
 * supposed to work unattended: a USB device that came back on a different COM
 * port after a replug is exactly the failure nobody notices until they are
 * standing in front of it.
 *
 * It wraps `scripts/usb-inventory.ps1`, which already exists and already
 * writes the JSON Alpha's device panels consume. This handler adds nothing to
 * what that script does — it just makes it askable from anywhere.
 *
 * It runs an external program, so it follows the rules alpha-coordination.js
 * set for that case, with one tightened further:
 *
 * - Pinned interpreter (ALPHA_POWERSHELL, default powershell.exe).
 * - Pinned script, which must resolve inside this checkout. Not configurable
 *   to an arbitrary path: the whole value here is that the thing being run is
 *   the script in the repository, which has been read.
 * - **No arguments at all.** alpha-coordination takes an allowlisted action
 *   and validated arguments because its script needs them. This one's script
 *   takes none, so a payload carrying anything is refused rather than ignored
 *   — a handler that passes payload data to a shell is a remote shell with
 *   extra steps, and the safest version of that is one with no path for data
 *   to travel at all.
 *
 * NOT registered by default. Enable it on machines with devices worth seeing:
 *   ALPHA_EXTRA_HANDLERS=alpha-devices
 */

export const type = 'device.inventory';

export const description =
  'Reports this machine\'s USB devices, serial/COM ports and capture hardware. Read-only; takes no arguments.';

const SCRIPT = 'scripts/usb-inventory.ps1';
const OUTPUT = 'scripts/usb-inventory.json';
const DEFAULT_TIMEOUT_MS = 120_000;

/** This checkout, which is the only place the script may come from. */
function repoRoot() {
  return resolve(new URL('../../..', import.meta.url).pathname);
}

function scriptPath() {
  const root = repoRoot();
  const script = resolve(root, SCRIPT);
  // Belt and braces: SCRIPT is a constant, so this cannot fail today. It is
  // here so that it still cannot escape if someone later makes it settable.
  if (script !== root && !script.startsWith(root + sep)) {
    throw new ProtocolError(`${SCRIPT} must live inside the checkout`, {
      status: 500,
      code: 'not_configured',
    });
  }
  if (!existsSync(script)) {
    throw new ProtocolError(`inventory script not found at ${script}`, {
      status: 500,
      code: 'not_configured',
    });
  }
  return script;
}

function interpreter() {
  return process.env.ALPHA_POWERSHELL ?? 'powershell.exe';
}

/**
 * Where a command would be found, or null. Same reasoning as alpha-render's:
 * `execFile` resolves a bare name against PATH, so a check that did not would
 * report a working machine as unable.
 */
function resolveExecutable(command) {
  if (command.includes('/') || command.includes(sep)) {
    return existsSync(command) ? command : null;
  }
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, command + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Whether this machine can answer the question at all.
 *
 * The script is PowerShell and reads Windows device APIs, so a Linux laptop
 * declines rather than advertising a capability whose every task would fail.
 */
export function available() {
  try {
    scriptPath();
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  const shell = interpreter();
  if (!resolveExecutable(shell)) {
    return {
      ok: false,
      reason: `PowerShell not found (${shell}). This inventory reads Windows device APIs; set ALPHA_POWERSHELL if it is installed elsewhere.`,
    };
  }
  return { ok: true };
}

/** The argv PowerShell is given. Exported so a test can pin it. */
export function buildArgs({ script }) {
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
}

/**
 * The payload must be empty. Not "unknown keys are ignored" — a caller that
 * sent `{ port: 'COM3; rm -rf' }` expecting it to mean something should be
 * told it meant nothing, rather than having it silently dropped.
 */
export function rejectArguments(payload) {
  if (payload === undefined || payload === null) return;
  if (typeof payload !== 'object') {
    throw new ProtocolError('device.inventory takes no payload');
  }
  const keys = Object.keys(payload);
  if (keys.length > 0) {
    throw new ProtocolError(
      `device.inventory takes no arguments; the inventory script accepts none, so ` +
        `${JSON.stringify(keys)} would not reach it`,
    );
  }
}

function timeoutMs() {
  const raw = process.env.ALPHA_DEVICE_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_MS;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ProtocolError(
      `ALPHA_DEVICE_TIMEOUT_MS must be a positive whole number of milliseconds (got ${raw})`,
      { status: 500, code: 'not_configured' },
    );
  }
  return value;
}

/**
 * The part of the inventory worth carrying back over the tunnel.
 *
 * Field names are the script's, verified against what it actually writes:
 * `machine`, `collectedAt`, `usb`, `serialPorts`, `avDevices`. Reading a
 * plausible-looking `ports` instead would have returned an empty list on every
 * machine and looked like "no devices attached" rather than a bug.
 */
function summarize(inventory) {
  const usb = Array.isArray(inventory?.usb) ? inventory.usb : [];
  const serialPorts = Array.isArray(inventory?.serialPorts) ? inventory.serialPorts : [];
  const avDevices = Array.isArray(inventory?.avDevices) ? inventory.avDevices : [];
  return {
    machine: inventory?.machine ?? null,
    // The script's own timestamp, not this handler's: it is the moment the
    // devices were read, which is the one that matters if the task waited in
    // a queue.
    collectedAt: inventory?.collectedAt ?? null,
    counts: { usb: usb.length, serialPorts: serialPorts.length, avDevices: avDevices.length },
    // The reason anyone asks: which COM port a board came back on after a
    // replug, because Windows renumbers them and whatever had the old number
    // saved will not find it.
    serialPorts,
    // Attached but not working - a missing driver, or a device that needs a
    // power cycle. The one part of an inventory that is actionable.
    notWorking: usb.filter((device) => device.status && device.status !== 'OK'),
  };
}

export async function run(payload, { signal, log } = {}) {
  rejectArguments(payload);
  const script = scriptPath();
  const shell = interpreter();
  const args = buildArgs({ script });

  log?.info?.('reading this machine\'s devices', {});

  const { code, stderr } = await new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      shell,
      args,
      {
        cwd: repoRoot(),
        signal,
        timeout: timeoutMs(),
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
      (error, out, err) => {
        if (error && error.code === 'ENOENT') {
          rejectPromise(
            new ProtocolError(`PowerShell not found (${shell}). Set ALPHA_POWERSHELL to its path.`, {
              status: 500,
              code: 'no_powershell',
            }),
          );
          return;
        }
        if (error && (error.killed || error.signal || error.code === 'ABORT_ERR')) {
          rejectPromise(
            new ProtocolError(
              `the inventory was killed before it finished (${error.signal ?? error.code})`,
              { status: 500, code: 'inventory_killed' },
            ),
          );
          return;
        }
        resolvePromise({ code: error?.code ?? 0, stdout: out ?? '', stderr: err ?? '' });
      },
    );

    // Below the machine's own work. See src/agent/priority.js: an external
    // program a task started must never be the reason its machine feels dead.
    deprioritize(child, { level: taskPriorityFromEnv(process.env.ALPHA_AGENT_TASK_PRIORITY) });
  });

  // The script is read-only and sets $ErrorActionPreference = 'SilentlyContinue',
  // so a non-zero exit means it did not get to the end — which means the JSON
  // beside it is either absent or from an earlier run. Either way this task
  // has no answer, and saying so beats returning a stale one.
  if (code !== 0) {
    throw new ProtocolError(
      `the inventory exited ${code}: ${stderr.trim().slice(-1_000)}`,
      { status: 500, code: 'inventory_failed' },
    );
  }

  const output = resolve(repoRoot(), OUTPUT);
  if (!existsSync(output)) {
    throw new ProtocolError(
      `the inventory exited 0 but wrote no ${OUTPUT}`,
      { status: 500, code: 'no_inventory' },
    );
  }

  let inventory;
  try {
    inventory = JSON.parse(readFileSync(output, 'utf8'));
  } catch (error) {
    throw new ProtocolError(`${OUTPUT} is not readable JSON: ${error.message}`, {
      status: 500,
      code: 'no_inventory',
    });
  }

  return { ...summarize(inventory), reportedAt: new Date().toISOString() };
}

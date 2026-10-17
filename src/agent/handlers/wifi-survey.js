import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join, sep } from 'node:path';

import { ProtocolError } from '../../common/protocol.js';

/**
 * Reports every WiFi access point this machine can currently hear.
 *
 * The fleet could already say how much RAM a machine had and what was plugged
 * into it; it could not say anything about where the machine *is* in radio
 * terms. That is the question behind "which room is this laptop in", "did the
 * panel lose the access point or the password", and "how much does that wall
 * cost us" — and the answer is a survey taken from the machine that is
 * standing there.
 *
 * **What this is not.** It does not see through walls. A laptop's WiFi chip
 * reports one number per access point — how strongly it hears it — and nothing
 * about what is between the two. Through-wall imaging needs channel state
 * information from specific chipsets, or radar. What this gives you is
 * attenuation: take the same survey in two rooms and the drop in dBm across
 * the pair is the wall, measured. That is a real wall scanner in the only
 * sense a WiFi card supports, and it is worth having; it is not an X-ray.
 *
 * It runs an external program, so it follows the rules alpha-coordination.js
 * set for that case, tightened the way alpha-devices.js tightens them:
 *
 * - Pinned executable: `netsh`, resolved against PATH (and PATHEXT on
 *   Windows) exactly as `execFile` will resolve it.
 * - Fixed argv. The command is a constant; nothing from the payload reaches it.
 * - **No arguments at all.** A payload carrying any key is refused rather than
 *   ignored, so `{ ssid: 'x"; shutdown /r' }` is told it meant nothing.
 *
 * NOT registered by default. Enable it on machines worth surveying from:
 *   ALPHA_EXTRA_HANDLERS=wifi-survey
 */

export const type = 'wifi.survey';

export const description =
  'Lists the WiFi access points this machine can hear, with BSSID, signal in dBm, band and channel. ' +
  'Signal strength only — it measures walls by attenuation between surveys, it does not see through them. ' +
  'Windows only; read-only; takes no arguments.';

const COMMAND = 'netsh';
const DEFAULT_TIMEOUT_MS = 30_000;

/** The argv netsh is given. Exported so a test can pin it. */
export function buildArgs() {
  return ['wlan', 'show', 'networks', 'mode=bssid'];
}

/**
 * Where a command would be found, or null.
 *
 * Same resolution `execFile` does, for the same reason alpha-render.js gives:
 * a check that only looked for the bare name would call `netsh` missing on
 * every Windows machine that has it, since there it is `netsh.exe`.
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
 * Whether this machine can take a survey at all.
 *
 * Asks exactly what `run()` asks, the same way: the same executable, resolved
 * the same. A machine that passes this and then fails the task is the failure
 * the check exists to prevent — and here the common case is a Linux or macOS
 * agent that took `wifi.survey` because ALPHA_EXTRA_HANDLERS was copied from a
 * Windows machine's .env.agent. It executes nothing: whether the WLAN service
 * is running and an adapter is present is not knowable without running the
 * survey, and `run()` reports that honestly.
 */
export function available() {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      reason:
        `wifi.survey drives ${COMMAND}, which is Windows-only; this machine is ${process.platform}`,
    };
  }
  if (!resolveExecutable(COMMAND)) {
    return { ok: false, reason: `${COMMAND} not found on PATH` };
  }
  return { ok: true };
}

/**
 * The payload must be empty. Not "unknown keys are ignored" — the argv is a
 * constant, so a caller who sent `{ ssid: 'home' }` expecting a filter should
 * be told it did nothing, rather than receiving every network and believing it
 * was filtered.
 */
export function rejectArguments(payload) {
  if (payload === undefined || payload === null) return;
  if (typeof payload !== 'object') {
    throw new ProtocolError('wifi.survey takes no payload');
  }
  const keys = Object.keys(payload);
  if (keys.length > 0) {
    throw new ProtocolError(
      `wifi.survey takes no arguments; the argv is fixed, so ${JSON.stringify(keys)} ` +
        `would not reach it`,
    );
  }
}

function timeoutMs() {
  const raw = process.env.ALPHA_WIFI_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_MS;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ProtocolError(
      `ALPHA_WIFI_TIMEOUT_MS must be a positive whole number of milliseconds (got ${raw})`,
      { status: 500, code: 'not_configured' },
    );
  }
  return value;
}

/**
 * Windows reports link quality as a percentage, not dBm, and the mapping it
 * uses is linear: 0% is -100 dBm and 100% is -50 dBm. Carrying both is worth
 * the two fields — the percentage is what the machine said, and dBm is the
 * unit every other radio tool speaks, so a survey can be compared with one
 * taken by anything else.
 */
export function dbmFromPercent(percent) {
  if (!Number.isFinite(percent)) return null;
  return Math.round(percent / 2 - 100);
}

const LABELS = {
  ssid: /^SSID\s+\d+\s*:\s?(.*)$/,
  authentication: /^\s*Authentication\s*:\s*(.+?)\s*$/,
  encryption: /^\s*Encryption\s*:\s*(.+?)\s*$/,
  bssid: /^\s*BSSID\s+\d+\s*:\s*(\S+)\s*$/,
  signal: /^\s*Signal\s*:\s*(\d+)\s*%\s*$/,
  radioType: /^\s*Radio type\s*:\s*(.+?)\s*$/,
  band: /^\s*Band\s*:\s*(.+?)\s*$/,
  channel: /^\s*Channel\s*:\s*(\d+)\s*$/,
};

/**
 * Turns netsh's report into networks and their radios.
 *
 * Exported because this, not the spawning, is the part that can be wrong: the
 * output is a human-readable table that has to be read by label.
 */
export function parseNetworks(stdout) {
  const networks = [];
  let network = null;
  let bssid = null;

  for (const line of String(stdout).split(/\r?\n/)) {
    const ssid = LABELS.ssid.exec(line);
    if (ssid) {
      const name = ssid[1].trim();
      // netsh writes an empty name for a network that does not broadcast one.
      // Recording it as hidden beats dropping it: an AP you can hear but not
      // name is still a radio in the room.
      network = { ssid: name === '' ? null : name, hidden: name === '', authentication: null, encryption: null, bssids: [] };
      bssid = null;
      networks.push(network);
      continue;
    }
    if (!network) continue;

    const radio = LABELS.bssid.exec(line);
    if (radio) {
      bssid = { bssid: radio[1].toLowerCase(), signalPercent: null, signalDbm: null, radioType: null, band: null, channel: null };
      network.bssids.push(bssid);
      continue;
    }

    const authentication = LABELS.authentication.exec(line);
    if (authentication) {
      network.authentication = authentication[1];
      continue;
    }
    const encryption = LABELS.encryption.exec(line);
    if (encryption) {
      network.encryption = encryption[1];
      continue;
    }

    if (!bssid) continue;

    const signal = LABELS.signal.exec(line);
    if (signal) {
      bssid.signalPercent = Number.parseInt(signal[1], 10);
      bssid.signalDbm = dbmFromPercent(bssid.signalPercent);
      continue;
    }
    const radioType = LABELS.radioType.exec(line);
    if (radioType) {
      bssid.radioType = radioType[1];
      continue;
    }
    const band = LABELS.band.exec(line);
    if (band) {
      bssid.band = band[1];
      continue;
    }
    const channel = LABELS.channel.exec(line);
    if (channel) {
      bssid.channel = Number.parseInt(channel[1], 10);
    }
  }

  return networks;
}

/**
 * What the survey is for, in the shape a caller can act on.
 *
 * `strongest` is the walk-the-building number: the same BSSID surveyed from
 * two places differs by the attenuation between them, and that difference is
 * the wall.
 */
export function summarize(networks) {
  const radios = networks.flatMap((n) =>
    n.bssids.map((b) => ({ ssid: n.ssid, hidden: n.hidden, ...b })),
  );
  const channels = {};
  for (const radio of radios) {
    if (radio.channel === null) continue;
    channels[radio.channel] = (channels[radio.channel] ?? 0) + 1;
  }
  return {
    counts: { networks: networks.length, radios: radios.length, hidden: networks.filter((n) => n.hidden).length },
    channels,
    strongest: radios
      .filter((r) => r.signalDbm !== null)
      .sort((a, b) => b.signalDbm - a.signalDbm)
      .slice(0, 10),
  };
}

export async function run(payload, { signal, log } = {}) {
  rejectArguments(payload);

  log?.info?.('surveying the WiFi this machine can hear', {});

  const { code, stdout, stderr } = await new Promise((resolvePromise, rejectPromise) => {
    execFile(
      COMMAND,
      buildArgs(),
      { signal, timeout: timeoutMs(), maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, out, err) => {
        if (error && error.code === 'ENOENT') {
          rejectPromise(
            new ProtocolError(`${COMMAND} not found; wifi.survey needs Windows`, {
              status: 500,
              code: 'no_netsh',
            }),
          );
          return;
        }
        if (error && (error.killed || error.signal || error.code === 'ABORT_ERR')) {
          rejectPromise(
            new ProtocolError(
              `the survey was killed before it finished (${error.signal ?? error.code})`,
              { status: 500, code: 'survey_killed' },
            ),
          );
          return;
        }
        resolvePromise({ code: error?.code ?? 0, stdout: out ?? '', stderr: err ?? '' });
      },
    );
  });

  if (code !== 0) {
    throw new ProtocolError(
      `${COMMAND} exited ${code}: ${(stderr || stdout).trim().slice(-1_000)}`,
      { status: 500, code: 'survey_failed' },
    );
  }

  const networks = parseNetworks(stdout);

  // A machine with WiFi switched off genuinely hears nothing, and netsh says
  // so in a line of its own. A machine whose Windows is not in English says
  // the same thing in words this parser does not know, and would otherwise
  // return the same empty list — "no networks here" when the truth is "this
  // handler could not read the answer". Only the first is a survey.
  if (networks.length === 0 && !/there are 0 networks|^SSID\s+\d+\s*:/im.test(stdout)) {
    throw new ProtocolError(
      `could not read ${COMMAND}'s output; it may be localised or its format may have changed. ` +
        `First 300 characters: ${stdout.trim().slice(0, 300)}`,
      { status: 500, code: 'survey_unreadable' },
    );
  }

  return {
    surveyedAt: new Date().toISOString(),
    machine: process.env.COMPUTERNAME ?? null,
    networks,
    ...summarize(networks),
  };
}

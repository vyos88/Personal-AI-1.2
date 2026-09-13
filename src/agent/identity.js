import { createHash } from 'node:crypto';
import os from 'node:os';

import { validateInstanceId } from '../common/protocol.js';

/**
 * Who this worker is, stably across restarts of it.
 *
 * The host needs to tell one worker coming back from another worker turning
 * up, and it cannot do that from the connection: every agent dials out, so a
 * restarted agent looks exactly like a brand new one. It registers, gets a
 * fresh agent id, and the registration the dead process left behind sits there
 * until the stale sweep — offering the same machine's RAM a second time,
 * covering the same capabilities, and showing up as a second row under the
 * same name. With one laptop that is obvious on sight. With two it is not, and
 * a fleet view that counts one machine twice is worse than no fleet view.
 *
 * So each agent reports an instance id, and the host keeps one registration
 * per instance. Two properties matter, and they pull in opposite directions:
 *
 * - **The same worker restarting must report the same id**, or there is nothing
 *   to recognise. That rules out anything generated per process.
 * - **Two workers must never report the same id**, or each registration evicts
 *   the other. That rules out writing it into configuration — `.env.agent` is
 *   copied from one machine to the next, which is exactly how a second laptop
 *   gets set up.
 *
 * Hence: derived from the machine, mixed with the name this worker runs under.
 * The machine part keeps a copied checkout from colliding with the machine it
 * was copied from; the name part keeps two agents deliberately run on one
 * machine (a test fleet, or one narrowed to a capability) as two workers rather
 * than two processes fighting over one registration.
 */
export function machineFingerprint({ env = process.env } = {}) {
  const cpus = os.cpus();
  return [
    os.hostname(),
    os.platform(),
    os.arch(),
    String(cpus.length),
    cpus[0]?.model ?? 'unknown-cpu',
    // Rounded to GB: the exact figure moves under a VM's balloon driver, and
    // an identity that drifts is an identity that recognises nothing.
    String(Math.round(os.totalmem() / 1024 ** 3)),
    userName(env),
  ].join('|');
}

function userName(env) {
  try {
    return os.userInfo().username;
  } catch {
    // No passwd entry for this uid — happens in containers. The env is a
    // weaker signal but the hostname is doing most of the work here anyway.
    return env.USER ?? env.USERNAME ?? 'unknown-user';
  }
}

/**
 * The instance id this machine reports, or an operator's override.
 *
 * `ALPHA_AGENT_INSTANCE_ID` exists for the one case the fingerprint cannot
 * separate: two machines that agree on every input to it — same hostname, same
 * model, same user. Setting it on one of them is the fix, and is why the id is
 * reported rather than inferred by the host.
 */
export function instanceIdFor({ name, env = process.env } = {}) {
  const override = env.ALPHA_AGENT_INSTANCE_ID?.trim();
  if (override) {
    try {
      return validateInstanceId(override);
    } catch (error) {
      throw new Error(`ALPHA_AGENT_INSTANCE_ID: ${error.message}`);
    }
  }
  const digest = createHash('sha256')
    .update(`${machineFingerprint({ env })}|${name ?? ''}`)
    .digest('hex')
    .slice(0, 16);
  return `inst_${digest}`;
}

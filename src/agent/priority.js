import os from 'node:os';

/**
 * Scheduling priority for the external programs a handler runs.
 *
 * Every host-side guard in this repo is about *whether* a machine should be
 * given a task. None of them is about what that task does to the machine once
 * it is running, and that gap is what makes a laptop unusable:
 *
 * - placement declines to *start* work on a busy machine, but a render already
 *   underway keeps every core for the next ten minutes;
 * - `ALPHA_AGENT_MAX_LOAD` stops the agent *asking* for more, which does
 *   nothing for the task in hand;
 * - `ALPHA_AGENT_CONCURRENCY` bounds tasks, not threads. One Blender is one
 *   task and still saturates the machine.
 *
 * The symptom is the desktop compositor losing its slice: the screen tears or
 * flickers, input lags, and the owner concludes the fleet is not worth being
 * part of. Blender's render threads are ordinary threads at ordinary priority,
 * so the scheduler has no reason to prefer the window manager over them.
 *
 * `os.setPriority` is the fix and it is in the standard library, so it costs no
 * dependency: on POSIX it is `nice`, on Windows it is the process priority
 * class. Below-normal is enough — the compositor and the owner's foreground
 * application both run at normal and preempt immediately — and it is deliberately
 * not `low`, which on Windows is IDLE_PRIORITY_CLASS and starves a render to a
 * crawl on any machine that is doing anything at all.
 *
 * **This is advisory, never load-bearing.** Lowering a priority can fail —
 * EPERM under a hardened policy, ESRCH if the child exited between spawn and
 * here — and a render that runs at normal priority is worse for the laptop but
 * still a correct render. Every failure here is logged and swallowed.
 */

export const DEFAULT_TASK_PRIORITY = 'below_normal';

// `low` and `idle` are the same thing and both names get typed. `off` leaves
// the child at whatever it inherited, which is what a machine dedicated to
// rendering wants — there is no desktop on it to protect.
const LEVELS = new Map([
  ['off', null],
  ['normal', os.constants.priority.PRIORITY_NORMAL],
  ['below_normal', os.constants.priority.PRIORITY_BELOW_NORMAL],
  ['low', os.constants.priority.PRIORITY_LOW],
  ['idle', os.constants.priority.PRIORITY_LOW],
]);

/** Accepts `below-normal`, `BELOW_NORMAL` and `below normal` as the same name. */
function normalise(value) {
  return String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * Reads ALPHA_AGENT_TASK_PRIORITY, falling back to the default.
 *
 * Throws on a name it does not know rather than quietly running at normal
 * priority: a typo here is invisible until someone's laptop is unusable again,
 * and the whole point of the setting is that nobody has to notice.
 */
export function taskPriorityFromEnv(value, fallback = DEFAULT_TASK_PRIORITY) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const name = normalise(value);
  if (!LEVELS.has(name)) {
    throw new Error(
      `task priority must be one of ${[...LEVELS.keys()].join(', ')} (got ${JSON.stringify(value)})`,
    );
  }
  return name;
}

/** The numeric priority a level name means, or null for `off`. */
export function priorityValue(level = DEFAULT_TASK_PRIORITY) {
  return LEVELS.get(normalise(level)) ?? null;
}

/**
 * Drops a freshly spawned child below the machine's own work.
 *
 * Takes the ChildProcess rather than a pid so a spawn that failed outright —
 * no pid at all — is a no-op instead of a crash inside the error path of
 * whatever went wrong.
 *
 * Children the child spawns afterwards inherit this: on POSIX the nice value
 * is inherited across fork, and on Windows a process is created in its
 * parent's priority class. That is what makes it worth applying to
 * `arduino-cli`, which does the compiling in subprocesses of its own.
 */
export function deprioritize(child, { level = DEFAULT_TASK_PRIORITY, log } = {}) {
  const priority = priorityValue(level);
  if (priority === null || !child?.pid) return false;

  try {
    os.setPriority(child.pid, priority);
    return true;
  } catch (error) {
    // Not a failure of the task. Say so once, at debug, and let the work run.
    log?.debug?.('could not lower the priority of the child process', {
      pid: child.pid,
      level,
      message: error.message,
    });
    return false;
  }
}

/**
 * How many threads a render may use, leaving the machine's owner a core.
 *
 * A below-normal Blender still asks for every core, and on a 4-core laptop
 * "preempted on all four" is a worse experience than "three cores busy, one
 * free". Priority decides who wins a contended core; this decides how many
 * cores are contended at all. Both, because either alone leaves the machine
 * noticeably worse than idle.
 *
 * 0 means Blender's own autodetect — every core — and is the honest way for a
 * dedicated render box to say it does not need the headroom.
 */
export function renderThreadsFromEnv(value, cpus = os.cpus().length) {
  const spare = Math.max(1, (Number.isFinite(cpus) && cpus > 0 ? cpus : 1) - 1);
  if (value === undefined || value === null || String(value).trim() === '') return spare;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1024) {
    throw new Error(
      `render threads must be a whole number between 0 and 1024, where 0 means ` +
        `"let Blender decide" (got ${JSON.stringify(value)})`,
    );
  }
  return parsed;
}

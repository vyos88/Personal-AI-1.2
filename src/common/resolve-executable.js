import { existsSync } from 'node:fs';
import { delimiter, extname, join, sep } from 'node:path';

/**
 * Where a command would be found, or null.
 *
 * `execFile` resolves a bare name against PATH, so every handler that spawns
 * one has to as well, or a perfectly configured machine reports the program
 * missing. Seven handlers each kept their own copy of this, which is the drift
 * CLAUDE.md warns about in the `alpha.render.inventory` note; they had already
 * drifted into four variants, one of them wrong (see `nativeFirst`).
 *
 * Two rules it always follows:
 *
 * - **A path is taken as given.** Anything containing a separator is not a PATH
 *   lookup at all, so it is either there or it is not.
 * - **A name that already carries an extension is looked up as written.**
 *   Appending PATHEXT to `powershell.exe` asks for `powershell.exe.EXE` and
 *   made every Windows machine report PowerShell as missing. That bug was
 *   fixed once in the device handler, and the fix is here so it cannot be
 *   missed by the next copy.
 */
export function resolveExecutable(command, { nativeFirst = false } = {}) {
  if (command.includes('/') || command.includes(sep)) {
    return existsSync(command) ? command : null;
  }
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    for (const extension of candidateExtensions(command, nativeFirst)) {
      const candidate = join(directory, command + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * `nativeFirst` puts `.exe` and friends ahead of `.cmd`/`.bat`.
 *
 * Only `codex.exec` asks for it, and for a reason specific to it: an npm
 * install puts a `.cmd` shim on PATH and the real binary beside it, and only
 * the binary can be spawned without a shell — which is the one thing that must
 * not stand between a payload and the process, since it is what turns a prompt
 * containing `&` or `|` from data into syntax. Taking whichever extension came
 * first would refuse a machine that is perfectly capable, on the evidence of a
 * shim sitting next to the binary.
 *
 * Everywhere else PATHEXT is honoured in the order the machine gives it.
 */
function candidateExtensions(command, nativeFirst) {
  if (process.platform !== 'win32' || extname(command)) return [''];
  const all = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  if (!nativeFirst) return all;
  return [...all.filter((extension) => !isShellScript(extension)), ...all.filter(isShellScript)];
}

/**
 * Whether a resolved path is a shell script rather than something `execFile`
 * can spawn on its own. Exported because the decision of what to do about one
 * belongs to the caller: `codex.exec` refuses it with the remedy, and nothing
 * else looks.
 */
export function isShellScript(path) {
  return /\.(cmd|bat)$/i.test(path);
}

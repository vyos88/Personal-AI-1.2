import { execFile } from 'node:child_process';

/**
 * Stops the child *and everything it started*.
 *
 * `npm run dev` is a wrapper: the server is its grandchild. Kill only the npm
 * process and the server keeps the port, so the restart this was meant to
 * perform fails to bind — which is the failure mode of every naive supervisor
 * of a script that launches something else.
 *
 * Shared by the two supervisors that start something with children of its
 * own: the standby (Alpha under npm) and the keeper (self-update under git).
 *
 * POSIX: the child must be spawned detached, so it leads its own process group and
 * a negative pid signals the whole group. Windows has no groups worth the name,
 * so `taskkill /T` walks the tree instead.
 */
export function killTree(child, { force }) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const args = ['/pid', String(child.pid), '/T'];
    if (force) args.push('/F');
    execFile('taskkill', args, { windowsHide: true }, () => {});
    return;
  }
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is already gone, or this platform refused it. The child
    // itself is still worth a try.
    try {
      child.kill(signal);
    } catch {
      /* already dead */
    }
  }
}

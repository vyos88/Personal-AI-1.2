import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { TERMINAL_STATUSES } from '../common/protocol.js';
import { createLogger } from '../common/log.js';

const log = createLogger('host:task-store');

const SCHEMA = 'alpha.tasks.v1';

/**
 * The queue's tasks on disk, so a coordinator restart does not forget them.
 *
 * Before this the queue lived only in a Map: a host that rebooted — and this
 * one has, five times in two days — dropped every queued task and every result
 * nobody had read yet, and an agent's "done" was acknowledged without anything
 * durable behind it.
 *
 * Unfinished tasks are always kept. Finished ones are kept up to
 * `retainFinished`, newest first, so the file stays small while results stay
 * readable across a restart.
 *
 * `path: null` makes a store that remembers nothing, which is what tests and a
 * `createHost` without one get.
 */
export class TaskStore {
  #writeChain = Promise.resolve();
  #writeQueued = false;

  constructor({ path = null, retainFinished = 500 } = {}) {
    this.path = path === null ? null : resolve(path);
    this.persistent = this.path !== null;
    this.retainFinished = retainFinished;
  }

  /** The tasks last saved, or an empty list when there is no file yet. */
  async load() {
    if (!this.persistent) return [];
    let raw;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        log.info('no existing task store, starting empty', { path: this.path });
        return [];
      }
      throw error;
    }
    const data = JSON.parse(raw);
    if (data?.schema !== SCHEMA || !Array.isArray(data.tasks)) {
      throw new Error(`${this.path} is not an ${SCHEMA} task store`);
    }
    return data.tasks;
  }

  /**
   * Persists whatever `snapshot()` returns when the write actually runs.
   *
   * Writes are chained, as in the auth store, so two saves cannot interleave
   * their temp files. They are also coalesced: while one write is waiting its
   * turn, further saves join it rather than queueing their own, and because the
   * snapshot is taken at write time that one write carries every change made
   * before it started. A burst of a hundred task updates costs two writes, not
   * a hundred.
   */
  save(snapshot) {
    if (!this.persistent) return Promise.resolve();
    if (this.#writeQueued) return this.#writeChain;
    this.#writeQueued = true;
    const run = () => {
      this.#writeQueued = false;
      return this.#writeNow(snapshot());
    };
    this.#writeChain = this.#writeChain.then(run, run);
    return this.#writeChain;
  }

  async #writeNow(tasks) {
    const open = tasks.filter((task) => !TERMINAL_STATUSES.has(task.status));
    const finished = tasks
      .filter((task) => TERMINAL_STATUSES.has(task.status))
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
      .slice(0, this.retainFinished);
    const payload = JSON.stringify({ schema: SCHEMA, savedAt: Date.now(), tasks: [...open, ...finished] });
    const tmp = `${this.path}.tmp`;
    await mkdir(dirname(this.path), { recursive: true });
    // Write-then-rename so a crash mid-write leaves the previous file intact.
    await writeFile(tmp, payload, { mode: 0o600 });
    await rename(tmp, this.path);
  }
}

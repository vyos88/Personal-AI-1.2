import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { TERMINAL_STATUSES } from '../common/protocol.js';
import { createLogger } from '../common/log.js';
import { summarizeResult } from './receipts.js';

const log = createLogger('host:journal');

export const TASK_JOURNAL_VERSION = 1;

/**
 * The largest result or finished-task payload kept whole, in bytes of JSON.
 *
 * Results are what a waiter comes back for after a restart — a music track's
 * `outputs`, a render's `recipe` — and those are a few hundred bytes. What is
 * over this is bulk: an `alpha.music.audio` slice is ~700 KB of base64, a
 * render carries 16 KB of Blender stdout. The journal is rewritten whole on
 * every change, so one kept slice would be rewritten hundreds of times, and a
 * full queue of them would be gigabytes of writes a minute.
 */
export const MAX_KEPT_BYTES = 8 * 1024;

/**
 * Payload keys that mark a task as carrying a credential. A task with one is
 * never written down: `alpha.panel`'s Provision carries a WiFi password, and
 * the rule in this repo is that secrets do not reach disk in the clear. Such a
 * task is forgotten by a restart, exactly as every task was before the
 * journal existed. Deliberately not `key`: that is a musical key and a
 * memstore key, and neither is a secret.
 */
const SECRET_KEY = /pass(word|phrase)?$|secret|token|credential|api[-_]?key|private[-_]?key/i;

/**
 * The queue, written down, so a coordinator restart is not a reset.
 *
 * The queue lives in one Map on purpose, and still does — this is not a second
 * queue, it is a copy of that Map taken whenever it changes. Restarting the
 * host used to forget every queued and running task, and the Music Creator had
 * to tell people "the tunnel no longer remembers this track".
 *
 * **A snapshot, not an append-only log.** Each write replaces the whole file
 * (write-then-rename, so a crash mid-write leaves the previous one intact).
 * That makes compaction free: the file only ever holds what the queue holds,
 * and the queue already forgets finished tasks after `FINISHED_TASK_RETENTION_MS`
 * or past `MAX_FINISHED_TASKS`. Writes coalesce: a change while a write is in
 * flight schedules at most one more, which reads the queue as it is *then*.
 * The cost is that a crash can lose the last change before it was written —
 * the same as the auth store and the receipt ledger.
 *
 * What is kept, and what is not:
 *
 * - Queued and leased tasks are kept whole, payload included — a task that
 *   cannot be run after the restart is not worth remembering. The payload is
 *   already bounded by the host's request body limit.
 * - Finished tasks keep their result if it is under `MAX_KEPT_BYTES`; over it,
 *   only what the receipt ledger keeps (`recipe`, `outputs`, `stats`), marked
 *   `resultTrimmed`. Their payload goes the same way, marked `payloadTrimmed`.
 * - A task whose payload names a credential is not written at all.
 *
 * Like the receipt ledger, a corrupt file does not stop the host: it is moved
 * aside, kept, and the queue starts empty — loudly. Refusing to start the
 * coordinator over it would turn a lost queue into a lost fleet.
 */
export class TaskJournal {
  #writeChain = Promise.resolve();
  #writeQueued = false;
  #source = null;

  /**
   * @param {object} options
   * @param {string|null} options.path Where to persist. `null` (or the
   *   environment value `off`) keeps nothing, for tests and for a host that
   *   prefers a queue that empties on restart.
   */
  constructor({ path = defaultJournalPath() } = {}) {
    const off = path === null || path === '' || String(path).toLowerCase() === 'off';
    this.path = off ? null : resolve(path);
    this.persistent = this.path !== null;
  }

  /** The tasks to restore, or an empty list for a fresh or unreadable file. */
  async load() {
    if (!this.persistent) return [];

    let raw;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        log.info('no task journal yet, starting with an empty queue', { path: this.path });
        return [];
      }
      // Unreadable is not corrupt: leave the file where it is for a person to
      // look at, and start empty rather than keep the coordinator down.
      log.error('could not read the task journal, starting with an empty queue', {
        path: this.path,
        message: error.message,
        code: error.code,
      });
      return [];
    }

    try {
      const parsed = JSON.parse(raw);
      if (parsed.version !== TASK_JOURNAL_VERSION) {
        throw new Error(`version ${parsed.version}, expected ${TASK_JOURNAL_VERSION}`);
      }
      const tasks = Array.isArray(parsed.tasks) ? parsed.tasks.filter(isTaskRecord) : [];
      log.info('task journal loaded', { path: this.path, tasks: tasks.length });
      return tasks;
    } catch (error) {
      const aside = `${this.path}.corrupt-${Date.now()}`;
      await rename(this.path, aside).catch(() => {});
      log.error('task journal unreadable, moved aside and starting with an empty queue', {
        path: this.path,
        movedTo: aside,
        message: error.message,
      });
      return [];
    }
  }

  /**
   * Asks for the queue to be written down. `snapshot` is called when the write
   * actually starts, not now, so a burst of changes costs one write.
   */
  schedule(snapshot) {
    if (!this.persistent) return Promise.resolve();
    this.#source = snapshot;
    if (this.#writeQueued) return this.#writeChain;
    this.#writeQueued = true;
    this.#writeChain = this.#writeChain.then(async () => {
      this.#writeQueued = false;
      try {
        await this.#writeNow(this.#source());
      } catch (error) {
        // A full disk must not turn into a failed request: the queue is still
        // right in memory, and the next change tries again.
        log.warn('could not write the task journal', { path: this.path, message: error.message });
      }
    });
    return this.#writeChain;
  }

  /** Resolves once every scheduled write has landed. */
  flush() {
    return this.#writeChain;
  }

  async #writeNow(tasks) {
    const records = [];
    for (const task of tasks) {
      const record = toRecord(task);
      if (record) records.push(record);
    }
    const tmp = `${this.path}.tmp`;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(tmp, JSON.stringify({ version: TASK_JOURNAL_VERSION, tasks: records }), {
      mode: 0o600,
    });
    await rename(tmp, this.path);
  }
}

/**
 * `ALPHA_TASK_JOURNAL` if set, otherwise `tasks.json` beside the auth store.
 *
 * Beside the auth store rather than at a fixed `./data/tasks.json`: a host is
 * only ever pointed at one data directory, and a test host with its auth store
 * in a temp directory then keeps its tasks there too, instead of leaving them
 * in the checkout for the next real coordinator to run.
 */
export function defaultJournalPath(authStorePath = process.env.ALPHA_AUTH_STORE ?? './data/auth.json') {
  return process.env.ALPHA_TASK_JOURNAL ?? join(dirname(authStorePath), 'tasks.json');
}

/** What of one task goes to disk, or null if it must not. */
export function toRecord(task) {
  if (carriesSecret(task.payload)) return null;
  const record = { ...task };
  if (!TERMINAL_STATUSES.has(task.status)) return record;

  if (jsonBytes(task.result) > MAX_KEPT_BYTES) {
    record.result = summarizeResult(task.result);
    record.resultTrimmed = true;
  }
  if (jsonBytes(task.payload) > MAX_KEPT_BYTES) {
    record.payload = null;
    record.payloadTrimmed = true;
  }
  return record;
}

export function carriesSecret(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return false;
  for (const [key, inner] of Object.entries(value)) {
    if (!Array.isArray(value) && SECRET_KEY.test(key)) return true;
    if (carriesSecret(inner, depth + 1)) return true;
  }
  return false;
}

function jsonBytes(value) {
  if (value === null || value === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isTaskRecord(entry) {
  return (
    entry &&
    typeof entry === 'object' &&
    typeof entry.id === 'string' &&
    typeof entry.type === 'string' &&
    typeof entry.status === 'string'
  );
}

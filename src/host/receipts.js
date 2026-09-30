import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { createLogger } from '../common/log.js';

const log = createLogger('host:receipts');

export const RECEIPT_STORE_VERSION = 1;

/**
 * How many receipts to keep. A render every fifteen minutes is ~96 a day, so
 * this is a couple of months of a busy fleet — enough to answer "how many did
 * we do last month" and small enough that the file stays readable and the
 * whole-file rewrite below stays cheap.
 */
export const DEFAULT_MAX_RECEIPTS = 5_000;

/**
 * A durable record of every task that finished.
 *
 * The queue is deliberately in memory — a queue that empties on reboot is an
 * inconvenience, and keeping it in one Map is what makes leasing simple. But
 * that also means the *answer* died with it: after a restart there was no way
 * to say how many renders ran last night, which species came back, or which
 * machine did them. "It rendered, and the image is on the host somewhere" is
 * not a record.
 *
 * So terminal tasks are appended here as they finish. This is a ledger, not a
 * second queue: nothing reads it to make a decision, it is append-only, and
 * losing it costs history rather than work.
 *
 * Two things it deliberately does differently from AuthStore:
 *
 * - **A corrupt file does not stop the host.** AuthStore refuses to start,
 *   because overwriting credentials silently un-revokes access. Receipts are
 *   the opposite trade: blocking the coordinator over a damaged history file
 *   is worse than losing the history. The bad file is moved aside, kept, and
 *   the ledger starts empty — loudly.
 * - **The result is trimmed, never stored whole.** `alpha.render` returns up
 *   to 8 KB of stdout and 8 KB of stderr; storing that per render is megabytes
 *   a day of Blender chatter in a file somebody is supposed to read. What is
 *   kept is what identifies the work and proves it landed.
 */
export class ReceiptStore {
  #receipts = [];
  #writeChain = Promise.resolve();
  #loaded = false;

  /**
   * @param {object} options
   * @param {string|null} options.path Where to persist. `null` is an in-memory
   *   ledger, for tests and for a host that has opted out of keeping history.
   * @param {number} options.maxReceipts Oldest are dropped past this.
   */
  constructor({
    path = process.env.ALPHA_RECEIPT_STORE ?? './data/receipts.json',
    maxReceipts = DEFAULT_MAX_RECEIPTS,
  } = {}) {
    this.path = path === null ? null : resolve(path);
    this.persistent = this.path !== null;
    this.maxReceipts = Math.max(1, maxReceipts);
  }

  get loaded() {
    return this.#loaded;
  }

  async load() {
    if (!this.persistent) {
      this.#loaded = true;
      return this;
    }

    let raw;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.#loaded = true;
        log.info('no existing receipt ledger, starting empty', { path: this.path });
        return this;
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(raw);
      if (parsed.version !== RECEIPT_STORE_VERSION) {
        throw new Error(`version ${parsed.version}, expected ${RECEIPT_STORE_VERSION}`);
      }
      this.#receipts = Array.isArray(parsed.receipts) ? parsed.receipts : [];
    } catch (error) {
      // Keep the damaged file — it may still be readable by hand, and it is
      // the only copy of whatever history it holds.
      const aside = `${this.path}.corrupt-${Date.now()}`;
      await rename(this.path, aside).catch(() => {});
      this.#receipts = [];
      log.error('receipt ledger unreadable, moved aside and starting empty', {
        path: this.path,
        movedTo: aside,
        message: error.message,
      });
    }

    this.#loaded = true;
    log.info('receipt ledger loaded', { path: this.path, receipts: this.#receipts.length });
    return this;
  }

  /**
   * Records a finished task. Returns the receipt, or null if the task is not
   * in a terminal state.
   *
   * `agentName` is passed in rather than looked up: a receipt outlives the
   * registration that ran the work, and an agent id means nothing once that
   * registration is gone. The name is what a person recognises.
   */
  record(task, { agentName = null } = {}) {
    if (!task || !TERMINAL.has(task.status)) return null;

    const receipt = {
      id: task.id,
      type: task.type,
      status: task.status,
      agentId: task.agentId ?? null,
      agent: agentName,
      attempts: task.attempts ?? 0,
      declines: task.declines ?? 0,
      createdAt: task.createdAt ?? null,
      finishedAt: task.finishedAt ?? null,
      durationMs:
        task.finishedAt && task.createdAt ? task.finishedAt - task.createdAt : null,
      error: task.error ? { message: task.error.message, code: task.error.code ?? null } : null,
      ...summarizeResult(task.result),
    };

    this.#receipts.push(receipt);
    if (this.#receipts.length > this.maxReceipts) {
      this.#receipts.splice(0, this.#receipts.length - this.maxReceipts);
    }
    this.save();
    return receipt;
  }

  /** Newest first, which is the order anybody asking "what just ran" wants. */
  list({ type = null, status = null, since = null, limit = 100 } = {}) {
    let out = this.#receipts;
    if (type) out = out.filter((r) => r.type === type);
    if (status) out = out.filter((r) => r.status === status);
    if (Number.isFinite(since)) out = out.filter((r) => (r.finishedAt ?? 0) >= since);
    return out.slice(-limit).reverse();
  }

  get size() {
    return this.#receipts.length;
  }

  /**
   * The proof-of-work answer: how many ran, how many landed, what came back.
   *
   * `species` is counted only for receipts that carry a recipe, so it stays
   * empty for a fleet that has never rendered rather than inventing a zero for
   * every name someone once mentioned.
   */
  summary({ since = null } = {}) {
    const rows = Number.isFinite(since)
      ? this.#receipts.filter((r) => (r.finishedAt ?? 0) >= since)
      : this.#receipts;

    const byType = {};
    const byStatus = {};
    const species = {};
    const machines = {};
    let outputs = 0;
    let bytes = 0;

    for (const receipt of rows) {
      byType[receipt.type] = (byType[receipt.type] ?? 0) + 1;
      byStatus[receipt.status] = (byStatus[receipt.status] ?? 0) + 1;
      if (receipt.agent) machines[receipt.agent] = (machines[receipt.agent] ?? 0) + 1;
      if (receipt.recipe?.species) {
        const name = receipt.recipe.species;
        species[name] = (species[name] ?? 0) + 1;
      }
      for (const file of receipt.outputs ?? []) {
        outputs += 1;
        bytes += Number.isFinite(file.bytes) ? file.bytes : 0;
      }
    }

    return {
      total: rows.length,
      byType,
      byStatus,
      species,
      machines,
      outputs,
      bytes,
      oldest: rows.length ? (rows[0].finishedAt ?? null) : null,
      newest: rows.length ? (rows[rows.length - 1].finishedAt ?? null) : null,
    };
  }

  /** Chained like AuthStore: overlapping writes otherwise rename half a file. */
  save() {
    if (!this.persistent) return Promise.resolve();
    this.#writeChain = this.#writeChain.then(
      () => this.#writeNow(),
      () => this.#writeNow(),
    );
    return this.#writeChain;
  }

  async #writeNow() {
    const payload = JSON.stringify(
      { version: RECEIPT_STORE_VERSION, receipts: this.#receipts },
      null,
      2,
    );
    const tmp = `${this.path}.tmp`;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(tmp, payload, { mode: 0o600 });
    await rename(tmp, this.path);
  }
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * What of a result is worth keeping forever.
 *
 * A render's `recipe` and `outputs` are exactly the two things that make the
 * work findable again — the recipe reproduces it, the outputs say where the
 * image landed and how big it is. `stdout`/`stderr` are dropped: they are the
 * bulk of the payload and the least re-readable part of it.
 *
 * Anything else keeps a small marker rather than the body, so a receipt for a
 * non-render task still says the task returned something without dragging an
 * arbitrary payload into the ledger.
 */
export function summarizeResult(result) {
  if (!result || typeof result !== 'object') return {};
  const out = {};
  if (result.recipe && typeof result.recipe === 'object') out.recipe = result.recipe;
  if (Array.isArray(result.outputs)) {
    out.outputs = result.outputs.map((file) => ({
      name: file?.name ?? null,
      path: file?.path ?? null,
      bytes: Number.isFinite(file?.bytes) ? file.bytes : null,
    }));
  }
  if (Number.isFinite(result.renderedInMs)) out.renderedInMs = result.renderedInMs;
  if (result.stats && typeof result.stats === 'object') out.stats = result.stats;
  return out;
}

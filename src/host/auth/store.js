import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { createLogger } from '../../common/log.js';

const log = createLogger('host:auth:store');

export const STORE_VERSION = 1;

function emptyData() {
  return { version: STORE_VERSION, users: {}, invites: {}, apiKeys: {} };
}

/**
 * JSON-file persistence for users, invites and API keys.
 *
 * Unlike the task queue, this data must survive a restart: a queue that
 * empties on reboot is an inconvenience, but credentials that vanish lock
 * everyone out and silently un-revoke nothing.
 */
export class AuthStore {
  #data = emptyData();
  #writeChain = Promise.resolve();
  #loaded = false;

  /**
   * @param {object} options
   * @param {string|null} options.path Where to persist. Pass `null` for an
   *   ephemeral in-memory store — used by tests, and never appropriate for a
   *   real host, where losing the file means losing every credential.
   */
  constructor({ path = process.env.ALPHA_AUTH_STORE ?? './data/auth.json' } = {}) {
    this.path = path === null ? null : resolve(path);
    this.persistent = this.path !== null;
  }

  get data() {
    if (!this.#loaded) throw new Error('AuthStore.load() must be awaited before use');
    return this.#data;
  }

  async load() {
    if (!this.persistent) {
      this.#data = emptyData();
      this.#loaded = true;
      return this;
    }

    let raw;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.#data = emptyData();
        this.#loaded = true;
        log.info('no existing auth store, starting empty', { path: this.path });
        return this;
      }
      throw error;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // Never fall back to an empty store here. Overwriting an unreadable
      // credential file would silently reinstate revoked access and lock out
      // every real user; a hard failure is the safe outcome.
      throw new Error(
        `auth store at ${this.path} is not valid JSON (${error.message}). ` +
          'Refusing to start rather than overwrite it — restore it from backup or move it aside.',
      );
    }

    if (parsed.version !== STORE_VERSION) {
      throw new Error(
        `auth store at ${this.path} has version ${parsed.version}, expected ${STORE_VERSION}`,
      );
    }

    this.#data = {
      version: STORE_VERSION,
      users: parsed.users ?? {},
      invites: parsed.invites ?? {},
      apiKeys: parsed.apiKeys ?? {},
    };
    this.#loaded = true;
    log.info('auth store loaded', {
      path: this.path,
      users: Object.keys(this.#data.users).length,
      invites: Object.keys(this.#data.invites).length,
      apiKeys: Object.keys(this.#data.apiKeys).length,
    });
    return this;
  }

  /**
   * Writes are chained rather than concurrent: two overlapping saves can
   * otherwise interleave their temp-file writes and rename a half-written
   * snapshot over the real one.
   */
  save() {
    if (!this.persistent) return Promise.resolve();
    this.#writeChain = this.#writeChain.then(
      () => this.#writeNow(),
      () => this.#writeNow(),
    );
    return this.#writeChain;
  }

  async #writeNow() {
    const payload = JSON.stringify(this.#data, null, 2);
    const tmp = `${this.path}.tmp`;
    await mkdir(dirname(this.path), { recursive: true });
    // Write-then-rename so a crash mid-write leaves the previous file intact;
    // rename is atomic within a filesystem.
    await writeFile(tmp, payload, { mode: 0o600 });
    await rename(tmp, this.path);
  }

  /** Applies a mutation and persists it, returning whatever the mutation returned. */
  async mutate(fn) {
    const result = fn(this.data);
    await this.save();
    return result;
  }
}

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createLogger } from '../common/log.js';

const log = createLogger('host:messages');

export const MESSAGE_STORE_VERSION = 1;

// Addressed to a name, lowercased, so "Jack", "jack" and a user whose login
// name is "jack" all resolve to the same inbox. Alpha writes a message to a
// person by their name; it does not need to know their internal user id.
export function normalizeRecipient(value) {
  return String(value ?? '').trim().toLowerCase();
}

function emptyData() {
  return { version: MESSAGE_STORE_VERSION, messages: [] };
}

/**
 * Personal messages, one inbox per named recipient.
 *
 * This is the store behind "Alpha writes everyone a note under their own
 * name": a message carries a `to` (the recipient's name), an optional `from`
 * (who wrote it — Alpha, by default), a short `subject`, a `body`, and whether
 * it has been read. It persists exactly like the auth store — a JSON file
 * written through a temp file and an atomic rename — because a note a person
 * has not read yet should survive a host restart.
 *
 * Node standard library only, in keeping with the rest of alpha-tunnel.
 */
export class MessageStore {
  #data = emptyData();
  #writeChain = Promise.resolve();
  #loaded = false;

  /**
   * @param {object} options
   * @param {string|null} options.path Where to persist. `null` is an ephemeral
   *   in-memory store, used by tests.
   */
  constructor({ path = process.env.ALPHA_MESSAGE_STORE ?? './data/messages.json' } = {}) {
    this.path = path === null ? null : resolve(path);
    this.persistent = this.path !== null;
  }

  get data() {
    if (!this.#loaded) throw new Error('MessageStore.load() must be awaited before use');
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
        log.info('no existing message store, starting empty', { path: this.path });
        return this;
      }
      throw error;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // Unlike credentials, a corrupt message file is not a lock-out, but
      // overwriting it would still silently destroy unread notes. Fail loudly
      // and let the operator move it aside, matching the auth store's stance.
      throw new Error(
        `message store at ${this.path} is not valid JSON (${error.message}). ` +
          'Refusing to start rather than overwrite it — restore it from backup or move it aside.',
      );
    }

    if (parsed.version !== MESSAGE_STORE_VERSION) {
      throw new Error(
        `message store at ${this.path} has version ${parsed.version}, expected ${MESSAGE_STORE_VERSION}`,
      );
    }

    this.#data = {
      version: MESSAGE_STORE_VERSION,
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    };
    this.#loaded = true;
    log.info('message store loaded', { path: this.path, messages: this.#data.messages.length });
    return this;
  }

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
    await writeFile(tmp, payload, { mode: 0o600 });
    await rename(tmp, this.path);
  }

  /** Every message addressed to `recipient`, newest first. */
  listFor(recipient) {
    const to = normalizeRecipient(recipient);
    return this.data.messages
      .filter((message) => message.to === to)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Distinct recipient names that have at least one message. */
  recipients() {
    return [...new Set(this.data.messages.map((message) => message.to))].sort();
  }

  /** Adds a message and persists it. Returns the stored record. */
  async add({ to, from = 'alpha', subject = '', body = '' }) {
    const recipient = normalizeRecipient(to);
    if (recipient === '') throw new Error('a message needs a recipient name ("to")');
    const message = {
      id: randomUUID(),
      to: recipient,
      from: String(from ?? 'alpha').trim() || 'alpha',
      subject: String(subject ?? '').slice(0, 200),
      body: String(body ?? '').slice(0, 4000),
      createdAt: Date.now(),
      read: false,
    };
    this.data.messages.push(message);
    await this.save();
    return message;
  }

  /**
   * Marks one message read, but only for its own recipient — a message id from
   * another inbox is treated as not found, so one person cannot flip another's
   * unread flag by guessing an id.
   */
  async markRead(id, recipient) {
    const to = normalizeRecipient(recipient);
    const message = this.data.messages.find((entry) => entry.id === id && entry.to === to);
    if (!message) return null;
    if (!message.read) {
      message.read = true;
      await this.save();
    }
    return message;
  }

  /**
   * Writes a first note to `recipient` once, and only when their inbox is
   * empty — so a restart does not pile up duplicate greetings. Returns the
   * seeded message, or null if they already had one.
   */
  async seedWelcome(recipient, { subject, body } = {}) {
    if (this.listFor(recipient).length > 0) return null;
    return this.add({
      to: recipient,
      from: 'alpha',
      subject: subject ?? 'Welcome from Alpha',
      body:
        body ??
        `Hi ${recipient}, this is Alpha. This is your personal message inbox on the ` +
          'tunnel host — notes meant just for you will show up here.',
    });
  }
}

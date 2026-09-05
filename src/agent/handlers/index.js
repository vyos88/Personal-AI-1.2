import * as echo from './echo.js';
import * as sysinfo from './sysinfo.js';
import { validateTaskType } from '../../common/protocol.js';

// Built-ins are deliberately read-only and side-effect free.
//
// There is intentionally no shell-exec handler here. Registering one turns the
// shared token into remote code execution on this machine, so that belongs in a
// handler you write and enable on purpose — see README, "Adding a handler".
const BUILTIN = [echo, sysinfo];

export class HandlerRegistry {
  #handlers = new Map();

  constructor(handlers = BUILTIN) {
    for (const handler of handlers) this.register(handler);
  }

  register(handler) {
    const type = validateTaskType(handler?.type);
    if (typeof handler.run !== 'function') {
      throw new Error(`handler "${type}" must export a run(payload, context) function`);
    }
    if (this.#handlers.has(type)) {
      throw new Error(`handler "${type}" is already registered`);
    }
    this.#handlers.set(type, handler);
    return this;
  }

  get(type) {
    return this.#handlers.get(type) ?? null;
  }

  has(type) {
    return this.#handlers.has(type);
  }

  types() {
    return [...this.#handlers.keys()].sort();
  }

  /**
   * RAM the registered handlers have already promised themselves here.
   *
   * A handler that holds a budget of its own — `memory.store` is the one that
   * does — would otherwise have that budget offered to the host as free at the
   * same time, and the host would place a memory-hungry task against RAM the
   * handler is about to fill. Optional, so a handler that exports nothing costs
   * nothing.
   */
  committedBytes() {
    let total = 0;
    for (const handler of this.#handlers.values()) {
      if (typeof handler.committedBytes !== 'function') continue;
      const bytes = handler.committedBytes();
      if (Number.isFinite(bytes) && bytes > 0) total += Math.floor(bytes);
    }
    return total;
  }

  describe() {
    return this.types().map((type) => ({
      type,
      description: this.#handlers.get(type).description ?? '',
    }));
  }
}

export { BUILTIN };

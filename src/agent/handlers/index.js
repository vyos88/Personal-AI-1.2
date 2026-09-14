import * as echo from './echo.js';
import * as grow from './grow.js';
import * as sysinfo from './sysinfo.js';
import { validateTaskType } from '../../common/protocol.js';

// Built-ins are deliberately read-only and side-effect free.
//
// There is intentionally no shell-exec handler here. Registering one turns the
// shared token into remote code execution on this machine, so that belongs in a
// handler you write and enable on purpose — see README, "Adding a handler".
// `grow` is pure arithmetic over its own payload: it reads nothing, writes
// nothing and starts no process, so it belongs here rather than behind
// ALPHA_EXTRA_HANDLERS.
const BUILTIN = [echo, grow, sysinfo];

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

  /**
   * Registers a handler unless the machine it is running on cannot do the
   * work, in which case it is left out and the caller is told why.
   *
   * A handler may export `available()` returning `{ ok, reason }`. The ones
   * that do are the ones that drive an external program — advertising
   * `alpha.render` on a laptop with no Blender means winning the render on
   * free RAM and then failing it, having spent an attempt, with the retry free
   * to land right back on the same machine. A capability is a promise, and
   * this is where a machine declines to make one it cannot keep.
   *
   * Registering stays unconditional (`register`) for handlers that can run
   * anywhere, which is every built-in: they start no process and open no
   * socket, so there is nothing for them to be unavailable for.
   */
  add(handler) {
    const check = typeof handler?.available === 'function' ? handler.available() : { ok: true };
    if (!check?.ok) {
      return { registered: false, type: handler?.type ?? null, reason: check?.reason ?? 'unavailable' };
    }
    this.register(handler);
    return { registered: true, type: handler.type, reason: null };
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

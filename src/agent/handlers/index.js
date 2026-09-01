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

  describe() {
    return this.types().map((type) => ({
      type,
      description: this.#handlers.get(type).description ?? '',
    }));
  }
}

export { BUILTIN };

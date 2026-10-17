import { TunnelAgent } from './agent.js';
import { HandlerRegistry } from './handlers/index.js';
import { fetchJson } from '../common/http.js';

// Artifact retrieval belongs beside the GPU that produced the file. No generic
// CPU, memory, music, device-control or coordination capability is offered here.
export const GPU_TYPES = Object.freeze([
  'alpha.render', 'alpha.render.inventory', 'alpha.image', 'alpha.image.file', 'alpha.singing.wake',
]);

export function gpuDemand(tasks, name, types = GPU_TYPES) {
  return tasks.filter((task) => task.status === 'queued'
    && types.includes(task.type)
    && (!task.targetAgent || task.targetAgent === name));
}

/** One scheduler pass: no persistent process when there is no queued GPU work. */
export async function runGpuDemand({
  hostUrl, queueToken, workerToken, name, handlers,
  idleMs = 30_000, checkMs = 1_000, pollWaitMs = 1_000,
  memoryReserveBytes = 2 * 1024 ** 3,
  maxLoad = 0.85,
  imageBackend = null, canStart = async () => ({ ok: true }), now = Date.now, log = () => {}, signal,
}) {
  if (!name || !Number.isFinite(idleMs) || idleMs <= 0 || !Number.isFinite(checkMs) || checkMs <= 0) {
    throw new Error('GPU worker needs a machine name and positive idle/check intervals');
  }
  const types = handlers.map((handler) => handler.type);
  if (!types.length || types.some((type) => !GPU_TYPES.includes(type))) {
    throw new Error('GPU worker may only offer GPU generation and its artifact handlers');
  }
  const { body } = await fetchJson(`${hostUrl.replace(/\/+$/, '')}/tasks?status=queued`, {
    token: queueToken, timeoutMs: 10_000, signal,
  });
  if (!Array.isArray(body?.tasks)) throw new Error('coordinator returned no task list');
  const demand = gpuDemand(body.tasks, name, types);
  if (!demand.length) {
    log({ state: 'asleep', reason: 'no-gpu-demand' });
    return { started: false, completed: 0 };
  }
  if (demand.some((task) => ['alpha.render', 'alpha.image', 'alpha.singing.wake'].includes(task.type))) {
    const admission = await canStart();
    if (!admission.ok) {
      log({ state: 'asleep', reason: 'waiting-for-resources', detail: admission.reason });
      return { started: false, completed: 0 };
    }
  }
  let lastBusy = now();
  let completed = 0;
  const registry = new HandlerRegistry([]);
  for (const handler of handlers) {
    registry.register({ ...handler, async run(payload, context) {
      lastBusy = now();
      try {
        if (handler.type === 'alpha.image' && imageBackend) await imageBackend.ensure(context.signal);
        return await handler.run(payload, context);
      } finally {
        completed++;
        lastBusy = now();
      }
    } });
  }
  const agent = new TunnelAgent({ hostUrl, token: workerToken, name,
    handlers: registry, capabilities: types, pollWaitMs,
    concurrency: 1, memoryReserveBytes, maxLoad,
  });
  let failure;
  let ended = false;
  const running = agent.start().catch((error) => { failure = error; }).finally(() => { ended = true; });
  log({ state: 'awake', capabilities: types });
  try {
    while (!ended) {
      await new Promise((resolve) => setTimeout(resolve, checkMs));
      // Reporting is part of inFlight. Stop only after the result was accepted,
      // never while a handler or a result request still owns the task lease.
      if (agent.inFlight > 0) lastBusy = now();
      if (signal?.aborted) break;
      if (agent.inFlight === 0 && now() - lastBusy >= idleMs) {
        if (imageBackend && await imageBackend.busy()) { lastBusy = now(); continue; }
        break;
      }
    }
  } finally {
    await agent.stop({ drainMs: 3_600_000 });
    await running;
    await imageBackend?.stop();
  }
  if (failure) throw failure;
  log({ state: 'asleep', reason: 'idle', completed });
  return { started: true, completed };
}

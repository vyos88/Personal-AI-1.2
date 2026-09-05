import os from 'node:os';

import { TunnelAgent } from './agent.js';
import { HandlerRegistry } from './handlers/index.js';
import { reserveFromEnv, memorySnapshot } from './memory.js';
import { LoadSampler, maxLoadFromEnv, concurrencyFromEnv } from './load.js';
import { MB, DEFAULT_MAX_LOAD, DEFAULT_AGENT_CONCURRENCY } from '../common/protocol.js';
import { loadEnv } from '../common/env.js';
import { createLogger } from '../common/log.js';

const log = createLogger('agent:main');

// .env.agent first: loadEnv never overwrites a value that is already set, so
// whichever file is read first wins. The agent's own file should take
// precedence over the shared .env, which belongs to the coordinator.
loadEnv('.env.agent');
loadEnv();

// An agent authenticates with its own API key — one issued to it, scoped to
// `agent:connect`, and revocable on its own without disturbing anyone else.
// ALPHA_TUNNEL_TOKEN still works so an existing deployment keeps running, but
// it is the shared break-glass credential and should be replaced by a key.
const token = process.env.ALPHA_AGENT_KEY || process.env.ALPHA_TUNNEL_TOKEN;
if (!token) {
  log.error(
    'no credential found. Set ALPHA_AGENT_KEY to a key issued for this agent:\n' +
      '  npm run admin -- issue-key --user <userId> --scopes agent --name "laptop"',
  );
  process.exit(1);
}
if (!process.env.ALPHA_AGENT_KEY && process.env.ALPHA_TUNNEL_TOKEN) {
  log.warn('using the shared ALPHA_TUNNEL_TOKEN; issue this agent its own ALPHA_AGENT_KEY');
}

const hostUrl = process.env.ALPHA_HOST_URL;
if (!hostUrl) {
  log.error('ALPHA_HOST_URL is not set. Point it at the coordinator, e.g. http://alpha-host:8787');
  process.exit(1);
}

const capabilities = (process.env.ALPHA_AGENT_CAPABILITIES ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

const handlers = new HandlerRegistry();

// Opt-in handlers, by module name from ./handlers. Kept out of the default set
// because some of them (alpha-coordination) run an external program, and that
// should be a deliberate per-machine decision — but a deployment shouldn't
// have to hand-edit source to make it, so it is configuration rather than a
// code change.
const extraHandlers = (process.env.ALPHA_EXTRA_HANDLERS ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

for (const name of extraHandlers) {
  // Restricted charset: this becomes an import specifier, so no traversal,
  // no absolute paths, no reaching outside the handlers directory.
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    log.error(`invalid handler name ${JSON.stringify(name)} in ALPHA_EXTRA_HANDLERS`);
    process.exit(1);
  }
  try {
    handlers.register(await import(`./handlers/${name}.js`));
    log.info('registered extra handler', { handler: name });
  } catch (error) {
    log.error(`could not load handler "${name}"`, { message: error.message });
    process.exit(1);
  }
}

// How much RAM this machine keeps for itself. Everything above it is offered
// to the host, which uses it to decide what work can be placed here.
let memoryReserveBytes;
try {
  memoryReserveBytes = reserveFromEnv(process.env.ALPHA_AGENT_MEMORY_RESERVE_MB);
} catch (error) {
  log.error(`ALPHA_AGENT_MEMORY_RESERVE_MB: ${error.message}`);
  process.exit(1);
}

// The CPU half of the same bargain. Above ALPHA_AGENT_MAX_LOAD this machine
// stops asking the host for work, so the next task lands on a laptop that has
// cores free instead of on whichever one happened to ask first.
let maxLoad;
let concurrency;
try {
  maxLoad = maxLoadFromEnv(process.env.ALPHA_AGENT_MAX_LOAD, DEFAULT_MAX_LOAD);
} catch (error) {
  log.error(`ALPHA_AGENT_MAX_LOAD: ${error.message}`);
  process.exit(1);
}
try {
  concurrency = concurrencyFromEnv(process.env.ALPHA_AGENT_CONCURRENCY, DEFAULT_AGENT_CONCURRENCY);
} catch (error) {
  log.error(`ALPHA_AGENT_CONCURRENCY: ${error.message}`);
  process.exit(1);
}

let agent;
try {
  agent = new TunnelAgent({
    hostUrl,
    token,
    name: process.env.ALPHA_AGENT_NAME || os.hostname(),
    capabilities: capabilities.length ? capabilities : undefined,
    handlers,
    memoryReserveBytes,
    maxLoad,
    concurrency,
  });
} catch (error) {
  log.error(error.message);
  process.exit(1);
}

log.info('handlers available', { handlers: handlers.describe() });

// Handlers holding a budget of their own — memory.store — take their headroom
// off the offer as well, so say so rather than leaving an operator wondering
// why a 16 GB laptop is lending less than its free memory.
const committedBytes = handlers.committedBytes();
const snapshot = memorySnapshot({ reserveBytes: memoryReserveBytes, committedBytes });
log.info('memory offered to the host', {
  totalMB: Math.round(snapshot.totalBytes / MB),
  availableMB: Math.round(snapshot.freeBytes / MB),
  reservedMB: Math.round(memoryReserveBytes / MB),
  handlerBudgetMB: Math.round(committedBytes / MB),
  offerableMB: Math.round(snapshot.offerableBytes / MB),
});

const load = new LoadSampler().snapshot();
log.info('cpu offered to the host', {
  cpus: load.cpus,
  loadFactor: load.loadFactor,
  maxLoad,
  concurrency,
  // Worth saying out loud on Windows, where os.loadavg() does not exist and
  // the whole picture comes from sampled CPU ticks.
  loadAverageAvailable: load.loadAverage1 !== null,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log.info('shutting down', { signal });
    agent.stop().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  });
}

agent.start().catch((error) => {
  log.error('agent exited', { message: error.message });
  process.exit(1);
});

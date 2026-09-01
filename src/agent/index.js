import os from 'node:os';

import { TunnelAgent } from './agent.js';
import { HandlerRegistry } from './handlers/index.js';
import { loadEnv } from '../common/env.js';
import { createLogger } from '../common/log.js';

const log = createLogger('agent:main');

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

let agent;
try {
  agent = new TunnelAgent({
    hostUrl,
    token,
    name: process.env.ALPHA_AGENT_NAME || os.hostname(),
    capabilities: capabilities.length ? capabilities : undefined,
    handlers,
  });
} catch (error) {
  log.error(error.message);
  process.exit(1);
}

log.info('handlers available', { handlers: handlers.describe() });

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

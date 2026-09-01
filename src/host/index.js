import { createHost } from './server.js';
import { AuthService } from './auth/service.js';
import { AuthStore } from './auth/store.js';
import { loadEnv } from '../common/env.js';
import { createLogger } from '../common/log.js';

const log = createLogger('host');

loadEnv();

const port = Number.parseInt(process.env.ALPHA_HOST_PORT ?? '8787', 10);
// Comma-separated. Default to loopback only; 0.0.0.0 puts the coordinator on
// every interface, so that has to be a deliberate choice rather than a default.
//
// Listing several specific addresses is the safe way to be reachable over a
// tailnet: keep 127.0.0.1 so an agent on this machine works even when Tailscale
// is down, and add the tailnet address for everyone else.
const binds = (process.env.ALPHA_HOST_BIND ?? '127.0.0.1')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

if (binds.length === 0) {
  log.error('ALPHA_HOST_BIND is set but empty');
  process.exit(1);
}

// The break-glass credential. It exists so there is a way to create the first
// real admin on a fresh install; once that admin exists it should be removed
// from the environment. It is optional — a host with users already in its
// store needs no bootstrap token at all.
const bootstrapToken = process.env.ALPHA_BOOTSTRAP_TOKEN ?? process.env.ALPHA_TUNNEL_TOKEN ?? null;

if (bootstrapToken && bootstrapToken.length < 16) {
  log.error('ALPHA_BOOTSTRAP_TOKEN must be at least 16 characters');
  process.exit(1);
}

const store = new AuthStore({ path: process.env.ALPHA_AUTH_STORE ?? './data/auth.json' });
const auth = new AuthService({ store, bootstrapToken });

try {
  await auth.load();
} catch (error) {
  log.error('could not load the auth store', { message: error.message });
  process.exit(1);
}

if (auth.userCount() === 0 && !bootstrapToken) {
  log.error(
    'no users exist and no ALPHA_BOOTSTRAP_TOKEN is set, so nothing could authenticate. ' +
      'Set ALPHA_BOOTSTRAP_TOKEN, start the host, and create your first admin with: ' +
      'npm run admin -- bootstrap-admin --email you@example.com',
  );
  process.exit(1);
}

const { servers, listen, close } = createHost({ auth });

try {
  await listen({ port, binds });
} catch (error) {
  if (error.code === 'EADDRINUSE') {
    log.error(`port ${port} is already in use — is a coordinator already running?`);
  } else if (error.code === 'EADDRNOTAVAIL') {
    log.error(
      `cannot bind ${error.address ?? 'that address'} — it is not an address on this machine. ` +
        'Check the Tailscale address with: tailscale ip -4',
    );
  } else {
    log.error('could not listen', { message: error.message, code: error.code });
  }
  process.exit(1);
}

log.info('coordinator listening', { binds, port, users: auth.userCount() });
if (binds.some((address) => address === '0.0.0.0' || address === '::')) {
  log.warn('bound to all interfaces — make sure this port is not exposed beyond your tunnel');
}
if (bootstrapToken && auth.userCount() > 0) {
  log.warn('bootstrap token is still active alongside real users — unset it when you are done');
}

for (const entry of servers) {
  entry.on('error', (error) => {
    log.error('server error', { message: error.message, code: error.code });
    process.exit(1);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log.info('shutting down', { signal });
    // close() releases parked long polls before waiting on the server, so this
    // returns promptly instead of hanging for the length of a poll.
    close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}

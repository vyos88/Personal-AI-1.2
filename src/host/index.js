import { createHost } from './server.js';
import { loadEnv } from '../common/env.js';
import { requireToken } from '../common/auth.js';
import { createLogger } from '../common/log.js';

const log = createLogger('host');

loadEnv();

let token;
try {
  token = requireToken();
} catch (error) {
  log.error(error.message);
  process.exit(1);
}

const port = Number.parseInt(process.env.ALPHA_HOST_PORT ?? '8787', 10);
// Default to loopback. Binding 0.0.0.0 puts the coordinator on every
// interface, so that has to be a deliberate choice, not a default.
const bind = process.env.ALPHA_HOST_BIND ?? '127.0.0.1';

const { server, close } = createHost({ token });

server.listen(port, bind, () => {
  log.info('coordinator listening', { bind, port });
  if (bind === '0.0.0.0' || bind === '::') {
    log.warn('bound to all interfaces — make sure this port is not exposed beyond your tunnel');
  }
});

server.on('error', (error) => {
  log.error('server error', { message: error.message, code: error.code });
  process.exit(1);
});

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

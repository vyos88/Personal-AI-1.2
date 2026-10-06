#!/usr/bin/env node
/**
 * Answers Alpha's AUTOMATIC1111 calls (`/sdapi/v1/txt2img`, `/sdapi/v1/sd-models`)
 * by rendering on whichever machine offering `alpha.image` is least busy. See
 * src/bridge/image.js for what it will and will not do.
 *
 * Run it on the machine Alpha runs on and point Alpha's IMAGE_GEN_URL at it:
 *
 *   node scripts/image-bridge.mjs        # then IMAGE_GEN_URL=http://127.0.0.1:7861
 *
 * Each rendering machine enables ALPHA_EXTRA_HANDLERS=alpha-image,alpha-image-file
 * and runs its own generator (ALPHA_IMAGE_BACKEND, see alpha-image.js). The
 * bridge's port is not 7860, so a local A1111 can keep that one.
 *
 * Configuration (.env beside the checkout, or the environment):
 *   ALPHA_HOST_URL             coordinator (default http://127.0.0.1:8787)
 *   ALPHA_IMAGE_BRIDGE_TOKEN   tunnel key with tasks:read, tasks:write and agents:read
 *                              (falls back to ALPHA_MUSIC_BRIDGE_TOKEN, then ALPHA_REPORT_TOKEN).
 *                              Mint one:
 *                              node src/admin/run.js issue-key --user <userId> --scopes tasks:read,tasks:write,agents:read --name image-bridge
 *                              Without agents:read it cannot pick the least busy machine and
 *                              falls back to the first named machine, or to placement.
 *   ALPHA_IMAGE_AGENT          "auto" (default: any machine offering alpha.image), a comma list
 *                              (e.g. worker1,host), or one machine name
 *   ALPHA_IMAGE_LEASE_MS       lease per image (default 600000; a render outlives 60s)
 *   ALPHA_IMAGE_BRIDGE_BIND    default 127.0.0.1
 *   ALPHA_IMAGE_BRIDGE_PORT    default 7861
 *   ALPHA_IMAGE_DIRECT_URL     this machine's own generator, for the calls that do not go
 *                              through the fleet (img2img, progress); default http://127.0.0.1:7860
 */

import { loadEnv } from '../src/common/env.js';
import { createImageBridge, DEFAULT_LEASE_MS } from '../src/bridge/image.js';

loadEnv();

const env = (name, fallback) => {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
};

const leaseMs = Number(env('ALPHA_IMAGE_LEASE_MS', DEFAULT_LEASE_MS));
const port = Number(env('ALPHA_IMAGE_BRIDGE_PORT', 7861));
const bind = env('ALPHA_IMAGE_BRIDGE_BIND', '127.0.0.1');
const hostUrl = env('ALPHA_HOST_URL', 'http://127.0.0.1:8787');
if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000) {
  console.error('ALPHA_IMAGE_LEASE_MS must be 1000-3600000 milliseconds');
  process.exit(1);
}
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error('ALPHA_IMAGE_BRIDGE_PORT must be a port number');
  process.exit(1);
}

let bridge;
try {
  bridge = createImageBridge({
    hostUrl,
    token: env('ALPHA_IMAGE_BRIDGE_TOKEN', env('ALPHA_MUSIC_BRIDGE_TOKEN', env('ALPHA_REPORT_TOKEN', null))),
    targetAgent: env('ALPHA_IMAGE_AGENT', 'auto'),
    directUrl: env('ALPHA_IMAGE_DIRECT_URL', 'http://127.0.0.1:7860'),
    leaseMs,
  });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

bridge.server.on('error', (error) => {
  console.error(`image bridge could not listen on ${bind}:${port}: ${error.message}`);
  process.exit(1);
});
bridge.server.listen(port, bind, () => {
  console.log(`image bridge on http://${bind}:${port}/sdapi/v1/ -> ${hostUrl} (machines: ${env('ALPHA_IMAGE_AGENT', 'auto')})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => bridge.server.close(() => process.exit(0)));
}

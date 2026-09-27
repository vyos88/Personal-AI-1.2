#!/usr/bin/env node
/**
 * Serves the Music Creator panel's Generate button: `/music/generate` and
 * `/music/tasks/:id`, backed by `alpha.music` tasks on the coordinator. See
 * src/bridge/music.js for what it will and will not do.
 *
 * Run it on the machine that serves Alpha's frontend, and route `/music/*` to
 * it from there (Alpha's backend, or the dev server's proxy).
 *
 *   node scripts/music-bridge.mjs
 *
 * Configuration (.env beside the checkout, or the environment):
 *   ALPHA_HOST_URL                 coordinator (default http://127.0.0.1:8787)
 *   ALPHA_MUSIC_BRIDGE_TOKEN       tunnel key with tasks:read and tasks:write. Mint one:
 *                                  node src/admin/run.js issue-key --user <userId> --scopes tasks:read,tasks:write --name music-bridge
 *   ALPHA_MUSIC_AGENT              machine that generates (targetAgent). Unset lets placement pick
 *   ALPHA_MUSIC_LEASE_MS           lease per track (default 600000; generation outlives 60s)
 *   ALPHA_MUSIC_BRIDGE_BIND        default 127.0.0.1
 *   ALPHA_MUSIC_BRIDGE_PORT        default 8790
 *   ALPHA_MUSIC_BRIDGE_CACHE       where fetched tracks are kept (default: the OS temp dir)
 */

import { loadEnv } from '../src/common/env.js';
import { createMusicBridge, DEFAULT_LEASE_MS } from '../src/bridge/music.js';

loadEnv();

const env = (name, fallback) => {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
};

const leaseMs = Number(env('ALPHA_MUSIC_LEASE_MS', DEFAULT_LEASE_MS));
const port = Number(env('ALPHA_MUSIC_BRIDGE_PORT', 8790));
const bind = env('ALPHA_MUSIC_BRIDGE_BIND', '127.0.0.1');
if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000) {
  console.error('ALPHA_MUSIC_LEASE_MS must be 1000-3600000 milliseconds');
  process.exit(1);
}

let bridge;
try {
  bridge = createMusicBridge({
    hostUrl: env('ALPHA_HOST_URL', 'http://127.0.0.1:8787'),
    token: env('ALPHA_MUSIC_BRIDGE_TOKEN', null),
    targetAgent: env('ALPHA_MUSIC_AGENT', null),
    leaseMs,
    ...(env('ALPHA_MUSIC_BRIDGE_CACHE', null) ? { cacheDir: env('ALPHA_MUSIC_BRIDGE_CACHE', null) } : {}),
  });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

bridge.server.on('error', (error) => {
  console.error(`music bridge could not listen on ${bind}:${port}: ${error.message}`);
  process.exit(1);
});
bridge.server.listen(port, bind, () => {
  console.log(`music bridge on http://${bind}:${port}/music/ -> ${env('ALPHA_HOST_URL', 'http://127.0.0.1:8787')}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => bridge.server.close(() => process.exit(0)));
}

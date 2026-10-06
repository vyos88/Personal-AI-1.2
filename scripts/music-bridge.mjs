#!/usr/bin/env node
/**
 * Serves the Music Creator panel's Generate button: `/music/generate` and
 * `/music/tasks/:id`, backed by `alpha.music` tasks on the coordinator, plus
 * the read-only `/music/recipes` (the ledger's music receipts) and
 * `/music/fleet` (machines offering alpha.music). See
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
 *                                  node src/admin/run.js issue-key --user <userId> --scopes tasks:read,tasks:write,agents:read --name music-bridge
 *                                  tasks:read also covers /music/recipes (the receipt ledger).
 *                                  agents:read is only for /music/fleet; leave it out and that
 *                                  one route answers 502 bridge_key_rejected, the rest still work.
 *   ALPHA_MUSIC_AGENT              machine that generates (targetAgent). "auto", or a comma list,
 *                                  spreads tracks over every machine offering alpha.music (the
 *                                  least busy one gets each track; needs agents:read). Unset lets placement pick
 *   ALPHA_MUSIC_LEASE_MS           lease per track (default 600000; generation outlives 60s)
 *   ALPHA_MUSIC_BRIDGE_BIND        default 127.0.0.1
 *   ALPHA_MUSIC_BRIDGE_PORT        default 8790
 *   ALPHA_MUSIC_BRIDGE_CACHE       where fetched tracks are kept (default: the OS temp dir)
 *   ALPHA_MUSIC_BRIDGE_CACHE_TRACKS  how many tracks it keeps (default 50; older ones are re-fetched)
 *
 * Subscriptions (all of these, or none: with none, every click generates):
 *   STRIPE_SECRET_KEY              sk_live_... / sk_test_... (Stripe Dashboard -> Developers -> API keys)
 *   STRIPE_PRICE_ID                price_... of the monthly Music Creator plan
 *   STRIPE_WEBHOOK_SECRET          whsec_... of the endpoint <ALPHA_PUBLIC_URL>/music/billing/webhook
 *   ALPHA_PUBLIC_URL               where people open Alpha, e.g. https://alpha-ai.uk
 *   ALPHA_MUSIC_COOKIE_SECRET      32+ random characters; changing it signs everyone out of their plan
 *   ALPHA_MUSIC_BILLING_STORE      accounts file (default: billing/music-accounts.json beside the checkout)
 *   ALPHA_MUSIC_FREE_TRACKS        free tracks per account per month (default 3)
 */

import { join } from 'node:path';

import { loadEnv } from '../src/common/env.js';
import { createBilling } from '../src/bridge/billing.js';
import { createMusicBridge, DEFAULT_LEASE_MS } from '../src/bridge/music.js';

loadEnv();

const env = (name, fallback) => {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
};

const leaseMs = Number(env('ALPHA_MUSIC_LEASE_MS', DEFAULT_LEASE_MS));
const port = Number(env('ALPHA_MUSIC_BRIDGE_PORT', 8790));
const bind = env('ALPHA_MUSIC_BRIDGE_BIND', '127.0.0.1');
// Checked here, not trusted: NaN would reach slice() as 0 and empty the cache.
const cacheTracks = env('ALPHA_MUSIC_BRIDGE_CACHE_TRACKS', null);
if (cacheTracks !== null && (!Number.isInteger(Number(cacheTracks)) || Number(cacheTracks) < 1)) {
  console.error('ALPHA_MUSIC_BRIDGE_CACHE_TRACKS must be a whole number, 1 or more');
  process.exit(1);
}
if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000) {
  console.error('ALPHA_MUSIC_LEASE_MS must be 1000-3600000 milliseconds');
  process.exit(1);
}

const BILLING_VARS = ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID', 'STRIPE_WEBHOOK_SECRET', 'ALPHA_PUBLIC_URL', 'ALPHA_MUSIC_COOKIE_SECRET'];
const billingWanted = BILLING_VARS.some((name) => env(name, null) !== null);
const freeTracks = Number(env('ALPHA_MUSIC_FREE_TRACKS', 3));

let bridge;
let billing = null;
try {
  if (billingWanted) {
    billing = createBilling({
      secretKey: env('STRIPE_SECRET_KEY', null),
      priceId: env('STRIPE_PRICE_ID', null),
      webhookSecret: env('STRIPE_WEBHOOK_SECRET', null),
      publicUrl: env('ALPHA_PUBLIC_URL', null),
      cookieSecret: env('ALPHA_MUSIC_COOKIE_SECRET', null),
      storePath: env('ALPHA_MUSIC_BILLING_STORE', join(process.cwd(), 'billing', 'music-accounts.json')),
      freeTracksPerMonth: freeTracks,
    });
  }
  bridge = createMusicBridge({
    billing,
    hostUrl: env('ALPHA_HOST_URL', 'http://127.0.0.1:8787'),
    token: env('ALPHA_MUSIC_BRIDGE_TOKEN', null),
    targetAgent: env('ALPHA_MUSIC_AGENT', null),
    leaseMs,
    ...(env('ALPHA_MUSIC_BRIDGE_CACHE', null) ? { cacheDir: env('ALPHA_MUSIC_BRIDGE_CACHE', null) } : {}),
    ...(cacheTracks !== null ? { cacheMaxTracks: Number(cacheTracks) } : {}),
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
  console.log(billing ? `subscriptions on: ${freeTracks} free tracks a month, then the Stripe plan` : 'subscriptions off: every click generates');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => bridge.server.close(() => process.exit(0)));
}

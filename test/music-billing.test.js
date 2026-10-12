// Music Creator plans: Alpha decides free or pro, the bridge counts the free
// allowance, and Upgrade goes to Alpha — against a real coordinator, a fake
// Alpha that answers /monetization/entitlements/music per session, and a fake
// Stripe that must never be asked to sell anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHost } from '../src/host/server.js';
import { createBilling, parseMusicPlan, stripeForm, verifyStripeSignature } from '../src/bridge/billing.js';
import { createMusicBridge } from '../src/bridge/music.js';

const TOKEN = 'test-token-that-is-long-enough';
const WEBHOOK_SECRET = 'whsec_test_secret';
const SETTINGS = { genre: 'Electronic', subgenre: 'Rollers', key: 'F minor', vocals: false, seed: 7, durationSec: 2 };
const LONG = { ...SETTINGS, durationSec: 120 };
const DAY_S = 24 * 3600;

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

/** Alpha's answers, as MUSIC_PLAN_MAPPING.md on alpha-full gives them. */
const ALPHA = {
  start: {
    schema: 'alpha.monetization.music-plan.v1', source: 'alpha', plan: 'free', long_tracks: false,
    alpha_plan: { id: 'start', name: 'Alpha Start' }, owner: false,
    upgrade_to: { id: 'plus', name: 'Alpha Plus', monthly_gbp: 19.99 },
  },
  plus: {
    schema: 'alpha.monetization.music-plan.v1', source: 'alpha', plan: 'pro', long_tracks: true,
    alpha_plan: { id: 'plus', name: 'Alpha Plus' }, owner: false, upgrade_to: null,
  },
};

/**
 * Alpha's backend, as far as the bridge uses it. `sessions` maps a bearer
 * token to [status, body]; `delayMs` holds every answer back.
 */
async function fakeAlpha(t, sessions = { 'start-session': [200, ALPHA.start], 'plus-session': [200, ALPHA.plus] }) {
  const calls = [];
  const state = { delayMs: 0, sessions };
  const server = createServer(async (req, res) => {
    calls.push({ method: req.method, path: req.url, auth: req.headers.authorization ?? null });
    if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const [status, body] = req.url === '/monetization/entitlements/music'
      ? (state.sessions[token] ?? [401, { detail: 'Not authenticated' }])
      : [404, { detail: 'Not Found' }];
    if (res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  const url = await listen(server);
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { url, calls, state };
}

/** Stripe, as far as the bridge's legacy webhook uses it. */
async function fakeStripe(t) {
  const calls = [];
  const subscriptions = {};
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls.push({ method: req.method, path: req.url, auth: req.headers.authorization, form: new URLSearchParams(raw) });
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const sub = /^\/v1\/subscriptions\/(.+)$/.exec(req.url);
    if (req.method === 'GET' && sub && subscriptions[sub[1]]) return reply(200, subscriptions[sub[1]]);
    return reply(404, { error: { message: 'No such thing' } });
  });
  const url = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url, calls, subscriptions };
}

async function setup(t, { hostUrl, freeTracksPerMonth = 2, now, alphaUrl, legacyStripe = false, alphaTimeoutMs, alphaCacheMs } = {}) {
  let coordinatorUrl = hostUrl;
  let host = null;
  if (!coordinatorUrl) {
    host = createHost({ token: TOKEN });
    coordinatorUrl = await listen(host.server);
    t.after(() => host.close());
  }
  const alpha = await fakeAlpha(t);
  const stripe = await fakeStripe(t);
  const warnings = [];
  const storePath = join(await mkdtemp(join(tmpdir(), 'music-billing-')), 'accounts.json');
  const billing = createBilling({
    alphaApiUrl: alphaUrl ?? alpha.url,
    cookieSecret: 'c'.repeat(40),
    publicUrl: 'https://alpha.example',
    storePath,
    freeTracksPerMonth,
    log: { warn: (message) => warnings.push(message) },
    ...(legacyStripe ? { secretKey: 'sk_test_123', webhookSecret: WEBHOOK_SECRET, priceId: 'price_music', stripeApi: stripe.url } : {}),
    ...(alphaTimeoutMs ? { alphaTimeoutMs } : {}),
    ...(alphaCacheMs !== undefined ? { alphaCacheMs } : {}),
    ...(now ? { now } : {}),
  });
  const { server } = createMusicBridge({ hostUrl: coordinatorUrl, token: TOKEN, billing });
  const url = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  // A browser: keeps the cookie it is given, and sends its Alpha session once signed in.
  let cookie = null;
  let session = null;
  const request = async (method, path, body, headers = {}) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...(session ? { authorization: `Bearer ${session}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: response.status, body: await response.json(), setCookie };
  };
  const webhook = (event, { secret = WEBHOOK_SECRET, at = Math.floor(Date.now() / 1000) } = {}) => {
    const raw = JSON.stringify(event);
    const signature = createHmac('sha256', secret).update(`${at}.${raw}`).digest('hex');
    return fetch(`${url}/music/billing/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': `t=${at},v1=${signature}` },
      body: raw,
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
  };
  const accountId = () => cookie.split('=')[1].split('.')[0];
  return {
    url, host, alpha, stripe, storePath, warnings, request, webhook, accountId,
    setCookie: (value) => { cookie = value; },
    signIn: (value) => { session = value; },
  };
}

test('a free account makes its monthly allowance of tracks, then is asked to upgrade', async (t) => {
  const env = await setup(t, { freeTracksPerMonth: 2 });

  const first = await env.request('GET', '/music/billing');
  assert.equal(first.status, 200);
  assert.match(first.setCookie, /^alpha_music_account=[^;]+; Path=\/music; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
  assert.deepEqual(
    { plan: first.body.plan, remaining: first.body.remaining, used: first.body.usedThisMonth },
    { plan: 'free', remaining: 2, used: 0 },
  );

  assert.equal((await env.request('POST', '/music/generate', SETTINGS)).status, 202);
  assert.equal((await env.request('POST', '/music/generate', SETTINGS)).status, 202);
  const third = await env.request('POST', '/music/generate', SETTINGS);
  assert.equal(third.status, 402);
  assert.equal(third.body.error, 'subscription_required');
  assert.equal(env.host.queue.list().filter((task) => task.type === 'alpha.music').length, 2);

  const after = await env.request('GET', '/music/billing');
  assert.equal(after.body.remaining, 0);
  assert.equal(after.setCookie, null, 'a known browser keeps its account');
});

test('a click the coordinator never takes, or bad settings, cost no free track', async (t) => {
  const env = await setup(t, { hostUrl: 'http://127.0.0.1:1', freeTracksPerMonth: 1 });
  assert.equal((await env.request('POST', '/music/generate', SETTINGS)).status, 502);
  assert.equal((await env.request('POST', '/music/generate', { ...SETTINGS, genre: 'Polka' })).status, 400);
  assert.equal((await env.request('GET', '/music/billing')).body.remaining, 1);
});

test('a forged or tampered cookie gets a fresh free account, not someone else\'s', async (t) => {
  const env = await setup(t);
  await env.request('GET', '/music/billing');
  const real = env.accountId();
  env.setCookie(`alpha_music_account=${real}.forgedmac`);
  const forged = await env.request('GET', '/music/billing');
  assert.ok(forged.setCookie, 'a new account was minted');
  assert.notEqual(env.accountId(), real);
});

test('Alpha says pro (Plus): unlimited tracks, long tracks too, and the panel is told why', async (t) => {
  const env = await setup(t, { freeTracksPerMonth: 1 });
  env.signIn('plus-session');
  const billing = (await env.request('GET', '/music/billing')).body;
  assert.equal(billing.plan, 'pro');
  assert.equal(billing.planSource, 'alpha');
  assert.equal(billing.longTracks, true);
  assert.equal(billing.remaining, null);
  assert.deepEqual(billing.alphaPlan, { id: 'plus', name: 'Alpha Plus' });
  for (let i = 0; i < 3; i++) assert.equal((await env.request('POST', '/music/generate', SETTINGS)).status, 202);
  assert.equal((await env.request('POST', '/music/generate', LONG)).status, 202, 'a Plus account may make a 120s track');
  assert.equal(env.alpha.calls[0].auth, 'Bearer plus-session', 'the listener\'s own session is what Alpha is asked with');
  assert.equal(env.alpha.calls[0].path, '/monetization/entitlements/music');
  assert.equal(env.alpha.calls.length, 1, 'one lookup, then the cached answer');
  assert.deepEqual(env.warnings, []);
});

test('Alpha says free (Start): the free allowance, no long tracks, and Upgrade names Alpha Plus', async (t) => {
  const env = await setup(t, { freeTracksPerMonth: 1 });
  env.signIn('start-session');
  const billing = (await env.request('GET', '/music/billing')).body;
  assert.equal(billing.plan, 'free');
  assert.equal(billing.planSource, 'alpha');
  assert.deepEqual(billing.upgradeTo, { id: 'plus', name: 'Alpha Plus', monthlyGbp: 19.99 });
  assert.equal(billing.upgradeUrl, 'https://alpha.example/#/hub/admin/subscriptions');

  const long = await env.request('POST', '/music/generate', LONG);
  assert.equal(long.status, 402, 'a Start account is refused a 120s track');
  assert.equal(long.body.error, 'long_tracks_need_pro');
  assert.match(long.body.message, /Alpha Plus/);
  assert.equal((await env.request('POST', '/music/generate', SETTINGS)).status, 202);
  const over = await env.request('POST', '/music/generate', SETTINGS);
  assert.equal(over.status, 402);
  assert.equal(over.body.error, 'subscription_required');
  assert.equal(env.host.queue.list().filter((task) => task.type === 'alpha.music').length, 1, 'the refused long track cost nothing');
});

test('Alpha down, failing, slow or answering nonsense: free with a warning, never pro', async (t) => {
  const down = await setup(t, { alphaUrl: 'http://127.0.0.1:1', freeTracksPerMonth: 1 });
  down.signIn('plus-session');
  const summary = (await down.request('GET', '/music/billing')).body;
  assert.deepEqual({ plan: summary.plan, source: summary.planSource }, { plan: 'free', source: 'fallback' });
  assert.equal((await down.request('POST', '/music/generate', LONG)).status, 402);
  assert.equal((await down.request('POST', '/music/generate', SETTINGS)).status, 202);
  assert.equal((await down.request('POST', '/music/generate', SETTINGS)).status, 402);
  assert.ok(down.warnings.length >= 1);
  assert.match(down.warnings[0], /could not get the plan from Alpha.*treating this listener as free/);

  const env = await setup(t, { alphaTimeoutMs: 200, alphaCacheMs: 0 });
  env.alpha.state.sessions = {
    broken: [500, { detail: 'boom' }],
    'wrong-shape': [200, { plan: 'pro' }],
    'not-a-plan': [200, { ...ALPHA.plus, plan: 'unlimited' }],
    'plus-session': [200, ALPHA.plus],
  };
  for (const session of ['broken', 'wrong-shape', 'not-a-plan', 'expired-session']) {
    env.signIn(session);
    assert.equal((await env.request('GET', '/music/billing')).body.plan, 'free', session);
  }
  env.signIn('plus-session');
  env.alpha.state.delayMs = 1_000;
  assert.equal((await env.request('GET', '/music/billing')).body.plan, 'free', 'slower than the timeout');
  assert.equal(env.warnings.length, 5);
  env.alpha.state.delayMs = 0;
  assert.equal((await env.request('GET', '/music/billing')).body.plan, 'pro', 'a failure is not cached');
});

test('no Alpha session: free, and Alpha is not asked', async (t) => {
  const env = await setup(t);
  const billing = (await env.request('GET', '/music/billing')).body;
  assert.deepEqual({ plan: billing.plan, source: billing.planSource }, { plan: 'free', source: 'anonymous' });
  assert.equal(env.alpha.calls.length, 0);
  assert.deepEqual(env.warnings, []);
});

test('Alpha\'s answer is cached briefly, per session', async (t) => {
  let clock = Date.now();
  const env = await setup(t, { now: () => clock, alphaCacheMs: 30_000 });
  env.signIn('plus-session');
  await env.request('GET', '/music/billing');
  await env.request('GET', '/music/billing');
  assert.equal(env.alpha.calls.length, 1);
  env.signIn('start-session');
  assert.equal((await env.request('GET', '/music/billing')).body.plan, 'free', 'another session is another lookup');
  assert.equal(env.alpha.calls.length, 2);
  env.signIn('plus-session');
  env.alpha.state.sessions['plus-session'] = [200, ALPHA.start];
  clock += 31_000;
  assert.equal((await env.request('GET', '/music/billing')).body.plan, 'free', 'a downgrade shows once the cache expires');
});

test('Upgrade and Manage go to Alpha\'s Subscriptions, never to Stripe', async (t) => {
  const env = await setup(t, { legacyStripe: true });
  env.signIn('start-session');
  const checkout = await env.request('POST', '/music/billing/checkout', {});
  assert.equal(checkout.status, 200);
  assert.equal(checkout.body.url, 'https://alpha.example/#/hub/admin/subscriptions');
  assert.deepEqual(checkout.body.upgradeTo, { id: 'plus', name: 'Alpha Plus', monthlyGbp: 19.99 });
  const portal = await env.request('POST', '/music/billing/portal', {});
  assert.equal(portal.body.url, 'https://alpha.example/#/hub/admin/subscriptions');
  env.signIn('plus-session');
  assert.equal((await env.request('POST', '/music/billing/checkout', {})).status, 409, 'already pro in Alpha');
  assert.equal(env.stripe.calls.length, 0, 'Stripe was never asked for a checkout or portal');
});

test('checkout refuses a cross-site form post', async (t) => {
  const env = await setup(t);
  const { status } = await env.request('POST', '/music/billing/checkout', 'a=1', { 'content-type': 'application/x-www-form-urlencoded' });
  assert.equal(status, 415);
});

test('a legacy Stripe subscription is recorded for migration but grants nothing', async (t) => {
  const env = await setup(t, { legacyStripe: true, freeTracksPerMonth: 0 });
  await env.request('GET', '/music/billing');
  env.stripe.subscriptions.sub_1 = { id: 'sub_1', customer: 'cus_1', status: 'active', cancel_at_period_end: false, items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 30 * DAY_S }] } };
  const delivered = await env.webhook({
    type: 'checkout.session.completed',
    data: { object: { mode: 'subscription', client_reference_id: env.accountId(), customer: 'cus_1', subscription: 'sub_1' } },
  });
  assert.deepEqual(delivered, { status: 200, body: { received: true } });
  assert.equal((await env.request('GET', '/music/billing')).body.plan, 'free');
  assert.equal((await env.request('POST', '/music/generate', SETTINGS)).status, 402);
  const saved = JSON.parse(await readFile(env.storePath, 'utf8'));
  assert.equal(saved.customers.cus_1, env.accountId());
  assert.equal(saved.accounts[env.accountId()].subscription.status, 'active');

  const forged = await env.webhook({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled' } } }, { secret: 'whsec_wrong' });
  assert.equal(forged.status, 400);
});

test('without the legacy Stripe settings there is no webhook', async (t) => {
  const env = await setup(t);
  assert.equal((await env.webhook({ type: 'checkout.session.completed', data: { object: {} } })).status, 404);
});

test('without billing configured, every click generates and the panel is told so', async (t) => {
  const host = createHost({ token: TOKEN });
  const hostUrl = await listen(host.server);
  t.after(() => host.close());
  const { server } = createMusicBridge({ hostUrl, token: TOKEN });
  const url = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`${url}/music/billing`);
  assert.deepEqual(await response.json(), { billingEnabled: false });
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await fetch(`${url}/music/billing/checkout`, { method: 'POST' })).status, 404);
});

test('billing refuses to start half-configured', () => {
  const base = { alphaApiUrl: 'http://127.0.0.1:8001', cookieSecret: 'c'.repeat(40), publicUrl: 'https://a', storePath: '/tmp/x' };
  assert.throws(() => createBilling({ cookieSecret: 'c'.repeat(40) }), /ALPHA_API_URL.*ALPHA_PUBLIC_URL/);
  assert.throws(() => createBilling({ ...base, cookieSecret: 'short' }), /at least 32/);
  assert.throws(() => createBilling({ ...base, secretKey: 'sk_test' }), /all or none.*STRIPE_WEBHOOK_SECRET/);
  assert.throws(() => createBilling({ ...base, alphaApiUrl: 'alpha.local' }), /http\(s\) URL/);
  assert.throws(() => createBilling({ ...base, alphaTimeoutMs: Number.NaN }), /TIMEOUT_MS/);
});

test('parseMusicPlan takes only Alpha\'s own answer, and only an exact "pro" is pro', () => {
  assert.equal(parseMusicPlan(ALPHA.plus).plan, 'pro');
  assert.equal(parseMusicPlan(ALPHA.start).plan, 'free');
  assert.equal(parseMusicPlan({ ...ALPHA.plus, schema: 'something.else' }), null);
  assert.equal(parseMusicPlan({ ...ALPHA.plus, source: 'stripe' }), null);
  assert.equal(parseMusicPlan({ ...ALPHA.plus, plan: 'PRO' }), null);
  assert.equal(parseMusicPlan(null), null);
});

test('Stripe helpers: nested form keys, and signature checks', () => {
  assert.equal(stripeForm({ a: 1, line_items: [{ price: 'p', quantity: 1 }], skip: null }).toString(), 'a=1&line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1');
  const at = 1_700_000_000;
  const good = createHmac('sha256', 'whsec').update(`${at}.{}`).digest('hex');
  assert.equal(verifyStripeSignature('{}', `t=${at},v1=bad,v1=${good}`, 'whsec', at * 1000), true);
  assert.equal(verifyStripeSignature('{ }', `t=${at},v1=${good}`, 'whsec', at * 1000), false);
  assert.equal(verifyStripeSignature('{}', `t=${at},v1=${good}`, 'whsec', (at + 301) * 1000), false);
  assert.equal(verifyStripeSignature('{}', undefined, 'whsec', at * 1000), false);
});

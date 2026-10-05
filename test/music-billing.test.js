// Music Creator subscriptions: the free allowance, Stripe Checkout, and the
// webhooks that turn a payment into unlimited tracks, against a real
// coordinator and a fake Stripe that records what it was asked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHost } from '../src/host/server.js';
import { createBilling, stripeForm, verifyStripeSignature } from '../src/bridge/billing.js';
import { createMusicBridge } from '../src/bridge/music.js';

const TOKEN = 'test-token-that-is-long-enough';
const WEBHOOK_SECRET = 'whsec_test_secret';
const SETTINGS = { genre: 'Electronic', subgenre: 'Rollers', key: 'F minor', vocals: false, seed: 7, durationSec: 2 };
const DAY_S = 24 * 3600;

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

/** Stripe, as far as the bridge uses it. `subscriptions` is what GET /v1/subscriptions/:id answers. */
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
    if (req.method === 'POST' && req.url === '/v1/checkout/sessions') return reply(200, { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' });
    if (req.method === 'POST' && req.url === '/v1/billing_portal/sessions') return reply(200, { url: 'https://billing.stripe.test/p_1' });
    const sub = /^\/v1\/subscriptions\/(.+)$/.exec(req.url);
    if (req.method === 'GET' && sub && subscriptions[sub[1]]) return reply(200, subscriptions[sub[1]]);
    return reply(404, { error: { message: 'No such thing' } });
  });
  const url = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url, calls, subscriptions };
}

async function setup(t, { hostUrl, freeTracksPerMonth = 2, now } = {}) {
  let coordinatorUrl = hostUrl;
  let host = null;
  if (!coordinatorUrl) {
    host = createHost({ token: TOKEN });
    coordinatorUrl = await listen(host.server);
    t.after(() => host.close());
  }
  const stripe = await fakeStripe(t);
  const storePath = join(await mkdtemp(join(tmpdir(), 'music-billing-')), 'accounts.json');
  const billing = createBilling({
    secretKey: 'sk_test_123',
    webhookSecret: WEBHOOK_SECRET,
    priceId: 'price_music',
    cookieSecret: 'c'.repeat(40),
    publicUrl: 'https://alpha.example',
    storePath,
    freeTracksPerMonth,
    stripeApi: stripe.url,
    ...(now ? { now } : {}),
  });
  const { server } = createMusicBridge({ hostUrl: coordinatorUrl, token: TOKEN, billing });
  const url = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  // A browser: keeps the cookie it is given.
  let cookie = null;
  const request = async (method, path, body, headers = {}) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
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
  return { url, host, stripe, storePath, request, webhook, accountId, setCookie: (value) => { cookie = value; } };
}

/** Pays for the current browser's account the way Stripe would tell the bridge. */
async function subscribe(env, { status = 'active', periodEnd = Math.floor(Date.now() / 1000) + 30 * DAY_S } = {}) {
  env.stripe.subscriptions.sub_1 = { id: 'sub_1', customer: 'cus_1', status, cancel_at_period_end: false, items: { data: [{ current_period_end: periodEnd }] } };
  return env.webhook({
    type: 'checkout.session.completed',
    data: { object: { mode: 'subscription', client_reference_id: env.accountId(), customer: 'cus_1', subscription: 'sub_1' } },
  });
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

test('Upgrade opens Stripe Checkout for the plan, tied to this account', async (t) => {
  const env = await setup(t);
  await env.request('GET', '/music/billing');
  const { status, body } = await env.request('POST', '/music/billing/checkout', {});
  assert.equal(status, 200);
  assert.equal(body.url, 'https://checkout.stripe.test/cs_1');

  const call = env.stripe.calls.find((c) => c.path === '/v1/checkout/sessions');
  assert.equal(call.auth, 'Bearer sk_test_123');
  assert.equal(call.form.get('mode'), 'subscription');
  assert.equal(call.form.get('line_items[0][price]'), 'price_music');
  assert.equal(call.form.get('line_items[0][quantity]'), '1');
  assert.equal(call.form.get('client_reference_id'), env.accountId());
  assert.equal(call.form.get('success_url'), 'https://alpha.example/?music_billing=success');
});

test('checkout refuses a cross-site form post', async (t) => {
  const env = await setup(t);
  const { status } = await env.request('POST', '/music/billing/checkout', 'a=1', { 'content-type': 'application/x-www-form-urlencoded' });
  assert.equal(status, 415);
  assert.equal(env.stripe.calls.length, 0);
});

test('a paid subscription means unlimited tracks until Stripe says it ended', async (t) => {
  const env = await setup(t, { freeTracksPerMonth: 1 });
  await env.request('GET', '/music/billing');
  assert.equal((await env.request('POST', '/music/generate', SETTINGS)).status, 202);
  assert.equal((await env.request('POST', '/music/generate', SETTINGS)).status, 402);

  assert.deepEqual(await subscribe(env), { status: 200, body: { received: true } });
  const pro = (await env.request('GET', '/music/billing')).body;
  assert.equal(pro.plan, 'pro');
  assert.equal(pro.remaining, null);
  assert.equal(pro.canManage, true);
  for (let i = 0; i < 3; i++) assert.equal((await env.request('POST', '/music/generate', SETTINGS)).status, 202);

  const portal = await env.request('POST', '/music/billing/portal', {});
  assert.equal(portal.body.url, 'https://billing.stripe.test/p_1');
  assert.equal(env.stripe.calls.at(-1).form.get('customer'), 'cus_1');

  assert.equal((await env.request('POST', '/music/billing/checkout', {})).status, 409, 'no second subscription');

  await env.webhook({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled' } } });
  assert.equal((await env.request('GET', '/music/billing')).body.plan, 'free');
  assert.equal((await env.request('POST', '/music/generate', SETTINGS)).status, 402);

  const saved = JSON.parse(await readFile(env.storePath, 'utf8'));
  assert.equal(saved.customers.cus_1, env.accountId());
});

test('a subscription past its paid period is not paid, even if the cancellation was missed', async (t) => {
  let clock = Date.now();
  const env = await setup(t, { freeTracksPerMonth: 0, now: () => clock });
  await env.request('GET', '/music/billing');
  await subscribe(env, { periodEnd: Math.floor(clock / 1000) + DAY_S });
  assert.equal((await env.request('GET', '/music/billing')).body.plan, 'pro');
  clock += 2 * DAY_S * 1000;
  assert.equal((await env.request('GET', '/music/billing')).body.plan, 'free');
});

test('webhooks without a valid, recent Stripe signature change nothing', async (t) => {
  const env = await setup(t);
  await env.request('GET', '/music/billing');
  assert.equal((await subscribe(env)).status, 200);
  const event = { type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled' } } };
  assert.equal((await env.webhook(event, { secret: 'whsec_wrong' })).status, 400);
  assert.equal((await env.webhook(event, { at: Math.floor(Date.now() / 1000) - 3600 })).status, 400);
  assert.equal((await env.request('GET', '/music/billing')).body.plan, 'pro');
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
  assert.throws(() => createBilling({ secretKey: 'sk_test', priceId: 'price_1' }), /STRIPE_WEBHOOK_SECRET.*ALPHA_MUSIC_COOKIE_SECRET/);
  assert.throws(
    () => createBilling({ secretKey: 's', webhookSecret: 'w', priceId: 'p', cookieSecret: 'short', publicUrl: 'https://a', storePath: '/tmp/x' }),
    /at least 32/,
  );
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

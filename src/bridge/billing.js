import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { ProtocolError } from '../common/protocol.js';

/**
 * Music Creator subscriptions, paid through Stripe.
 *
 * Every browser gets an account: a random id in a signed, HttpOnly cookie. A
 * free account may make `freeTracksPerMonth` tracks a calendar month (UTC);
 * past that, Generate answers 402 `subscription_required` and the panel offers
 * Upgrade. Upgrade opens Stripe Checkout for `priceId` with the account id as
 * `client_reference_id`; Stripe's webhook then ties the subscription to the
 * account, and every later subscription change arrives the same way. Nothing
 * the browser says about its plan is believed: the plan is only ever what
 * Stripe's signed webhooks and Stripe's own API said.
 *
 *   GET  /music/billing           → { billingEnabled, plan, usedThisMonth, remaining, ... }
 *   POST /music/billing/checkout  → { url }  (Stripe Checkout)
 *   POST /music/billing/portal    → { url }  (Stripe Billing Portal: cancel, change card)
 *   POST /music/billing/webhook   ← Stripe, verified with the endpoint's signing secret
 *
 * Accounts live in one JSON file, written whole and renamed into place, so a
 * crash mid-write leaves the previous file rather than half of one. That is
 * plenty for one bridge on one machine; it is not a database for many.
 *
 * What it does not do: let someone sign in on a second device. The account is
 * the cookie, so a subscriber on a new browser starts as free there. The
 * Billing Portal still lets them manage (and cancel) what they pay for.
 */

const COOKIE = 'alpha_music_account';
const ACCOUNT_ID = /^[A-Za-z0-9_-]{22}$/;
const MAX_WEBHOOK_BYTES = 512 * 1024;
const SIGNATURE_TOLERANCE_S = 300;
// past_due keeps access while Stripe retries the card; Stripe moves it to
// canceled or unpaid when it gives up, and that ends it.
const PAID_STATUSES = new Set(['active', 'trialing', 'past_due']);

function sign(secret, value) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

/** Stripe's form encoding: `a[b][0][c]=d`. */
export function stripeForm(value, prefix = '', out = new URLSearchParams()) {
  if (value === undefined || value === null) return out;
  if (typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) stripeForm(inner, prefix ? `${prefix}[${key}]` : key, out);
  } else {
    out.append(prefix, String(value));
  }
  return out;
}

/**
 * Checks a `Stripe-Signature` header the way Stripe documents it: HMAC-SHA256
 * of `${t}.${rawBody}` with the endpoint secret, any `v1` matching, and `t`
 * recent enough that a captured delivery cannot be replayed later.
 */
export function verifyStripeSignature(rawBody, header, secret, nowMs = Date.now()) {
  const parts = String(header ?? '').split(',').map((part) => part.trim().split('='));
  const timestamp = parts.find(([key]) => key === 't')?.[1];
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value ?? '');
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_S) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return signatures.some((candidate) => safeEqual(candidate, expected));
}

function monthOf(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 7);
}

/** When a subscription's paid period ends, wherever this API version puts it. */
function periodEnd(subscription) {
  return subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end ?? null;
}

export function createBilling({
  secretKey,
  webhookSecret,
  priceId,
  cookieSecret,
  publicUrl,
  storePath,
  freeTracksPerMonth = 3,
  stripeApi = 'https://api.stripe.com',
  fetch: fetchImpl = fetch,
  now = Date.now,
}) {
  const missing = Object.entries({
    STRIPE_SECRET_KEY: secretKey,
    STRIPE_WEBHOOK_SECRET: webhookSecret,
    STRIPE_PRICE_ID: priceId,
    ALPHA_MUSIC_COOKIE_SECRET: cookieSecret,
    ALPHA_PUBLIC_URL: publicUrl,
    ALPHA_MUSIC_BILLING_STORE: storePath,
  }).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`Music Creator billing needs ${missing.join(', ')}`);
  if (cookieSecret.length < 32) throw new Error('ALPHA_MUSIC_COOKIE_SECRET must be at least 32 characters');
  if (!Number.isInteger(freeTracksPerMonth) || freeTracksPerMonth < 0) {
    throw new Error('the free allowance must be a whole number of tracks, 0 or more');
  }
  const site = publicUrl.replace(/\/+$/, '');
  const secureCookie = site.startsWith('https://');

  let store = { accounts: {}, customers: {} };
  if (existsSync(storePath)) store = JSON.parse(readFileSync(storePath, 'utf8'));

  function save() {
    mkdirSync(dirname(storePath), { recursive: true });
    const partial = `${storePath}.tmp`;
    writeFileSync(partial, JSON.stringify(store, null, 2));
    renameSync(partial, storePath);
  }

  function record(accountId) {
    store.accounts[accountId] ??= { usage: { month: monthOf(now()), count: 0 }, customerId: null, subscription: null };
    const entry = store.accounts[accountId];
    if (entry.usage.month !== monthOf(now())) entry.usage = { month: monthOf(now()), count: 0 };
    return entry;
  }

  function isPaid(entry) {
    const subscription = entry.subscription;
    if (!subscription || !PAID_STATUSES.has(subscription.status)) return false;
    // A missed cancellation webhook must not mean free music forever.
    return subscription.currentPeriodEnd === null || subscription.currentPeriodEnd * 1000 > now();
  }

  /** The caller's account id, minting one (and its cookie) on a first visit. */
  function account(req, res) {
    const raw = readCookie(req, COOKIE);
    if (raw) {
      const [id, mac] = raw.split('.');
      if (ACCOUNT_ID.test(id ?? '') && mac && safeEqual(mac, sign(cookieSecret, id))) return id;
    }
    const id = randomBytes(16).toString('base64url');
    const attributes = ['Path=/music', 'HttpOnly', 'SameSite=Lax', `Max-Age=${2 * 365 * 24 * 3600}`];
    if (secureCookie) attributes.push('Secure');
    res.setHeader('set-cookie', `${COOKIE}=${id}.${sign(cookieSecret, id)}; ${attributes.join('; ')}`);
    return id;
  }

  /**
   * Takes one track from the account's allowance before the task is queued,
   * so two clicks at once cannot both spend the last free track. Returns the
   * refund to call if queueing then fails.
   */
  function reserve(accountId) {
    const entry = record(accountId);
    if (isPaid(entry)) return () => {};
    if (entry.usage.count >= freeTracksPerMonth) {
      throw new ProtocolError(
        `Free accounts make ${freeTracksPerMonth} tracks a month, and this month's are used. Upgrade for unlimited tracks.`,
        { status: 402, code: 'subscription_required' },
      );
    }
    entry.usage.count += 1;
    save();
    const month = entry.usage.month;
    return () => {
      if (entry.usage.month === month && entry.usage.count > 0) {
        entry.usage.count -= 1;
        save();
      }
    };
  }

  function summary(accountId) {
    const entry = record(accountId);
    const paid = isPaid(entry);
    return {
      billingEnabled: true,
      plan: paid ? 'pro' : 'free',
      freeTracksPerMonth,
      usedThisMonth: entry.usage.count,
      remaining: paid ? null : Math.max(0, freeTracksPerMonth - entry.usage.count),
      renewsAt: paid && entry.subscription.currentPeriodEnd ? new Date(entry.subscription.currentPeriodEnd * 1000).toISOString() : null,
      cancelAtPeriodEnd: paid ? Boolean(entry.subscription.cancelAtPeriodEnd) : false,
      canManage: Boolean(entry.customerId),
    };
  }

  async function stripe(method, path, params) {
    let response;
    try {
      response = await fetchImpl(`${stripeApi}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${secretKey}`,
          ...(params ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: params ? stripeForm(params).toString() : undefined,
      });
    } catch (error) {
      throw new ProtocolError(`could not reach Stripe: ${error.message}`, { status: 502, code: 'stripe_unreachable' });
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ProtocolError(`Stripe refused: ${body?.error?.message ?? `HTTP ${response.status}`}`, { status: 502, code: 'stripe_error' });
    }
    return body;
  }

  function applySubscription(accountId, subscription) {
    const entry = record(accountId);
    entry.subscription = {
      id: subscription.id,
      status: subscription.status,
      currentPeriodEnd: periodEnd(subscription),
      cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    };
  }

  async function onEvent(event) {
    const object = event?.data?.object ?? {};
    if (event.type === 'checkout.session.completed' && object.mode === 'subscription') {
      const accountId = object.client_reference_id;
      if (!ACCOUNT_ID.test(accountId ?? '') || !object.customer || !object.subscription) return;
      const entry = record(accountId);
      entry.customerId = object.customer;
      store.customers[object.customer] = accountId;
      // The session says which subscription, not what state it is in; ask.
      const subscriptionId = typeof object.subscription === 'string' ? object.subscription : object.subscription.id;
      applySubscription(accountId, await stripe('GET', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`));
      save();
      return;
    }
    if (event.type?.startsWith('customer.subscription.')) {
      // Unknown customers are someone else's product on the same Stripe
      // account, or a subscription whose checkout event has not arrived yet;
      // that event fetches the current state itself, so nothing is lost.
      const accountId = store.customers[object.customer];
      if (!accountId) return;
      const current = store.accounts[accountId]?.subscription;
      if (current && current.id !== object.id && event.type === 'customer.subscription.deleted') return;
      applySubscription(accountId, object);
      save();
    }
  }

  async function readRaw(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_WEBHOOK_BYTES) throw new ProtocolError('webhook body too large', { status: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /** A browser-made POST must be JSON, which a cross-site form cannot send without CORS. */
  function requireJson(req) {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      throw new ProtocolError('send this as application/json', { status: 415, code: 'bad_content_type' });
    }
  }

  async function handle(req, res, pathname, send) {
    if (req.method === 'POST' && pathname === '/music/billing/webhook') {
      const raw = await readRaw(req);
      if (!verifyStripeSignature(raw, req.headers['stripe-signature'], webhookSecret, now())) {
        return send(res, 400, { error: 'bad_signature' });
      }
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: 'bad_json' });
      }
      await onEvent(event);
      return send(res, 200, { received: true });
    }
    if (req.method === 'GET' && pathname === '/music/billing') {
      return send(res, 200, summary(account(req, res)));
    }
    if (req.method === 'POST' && pathname === '/music/billing/checkout') {
      requireJson(req);
      const accountId = account(req, res);
      const entry = record(accountId);
      if (isPaid(entry)) return send(res, 409, { error: 'already_subscribed', message: 'This account already has unlimited tracks.' });
      const session = await stripe('POST', '/v1/checkout/sessions', {
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        client_reference_id: accountId,
        ...(entry.customerId ? { customer: entry.customerId } : {}),
        success_url: `${site}/?music_billing=success`,
        cancel_url: `${site}/?music_billing=cancelled`,
        allow_promotion_codes: true,
      });
      return send(res, 200, { url: session.url });
    }
    if (req.method === 'POST' && pathname === '/music/billing/portal') {
      requireJson(req);
      const entry = record(account(req, res));
      if (!entry.customerId) return send(res, 409, { error: 'no_subscription', message: 'This account has never subscribed.' });
      const session = await stripe('POST', '/v1/billing_portal/sessions', { customer: entry.customerId, return_url: `${site}/` });
      return send(res, 200, { url: session.url });
    }
    return send(res, 404, { error: 'not_found' });
  }

  return { account, reserve, summary, handle };
}

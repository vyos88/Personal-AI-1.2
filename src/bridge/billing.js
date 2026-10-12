import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { ProtocolError } from '../common/protocol.js';

/**
 * Music Creator plans. Alpha decides them; the bridge counts free tracks.
 *
 * V decided on 2026-10-05 that Alpha's own plans (Start, Plus, Pro, Power) are
 * the source of truth, so the bridge asks Alpha which plan a listener has —
 * `GET <alphaApiUrl>/monetization/entitlements/music`, with the listener's own
 * `Authorization` header passed through — and uses its `plan` ("free" or
 * "pro") and `long_tracks`. The mapping lives in Alpha (MUSIC_PLAN_MAPPING.md
 * on alpha-full): no plan or Start is free, Plus and above or the owner is pro.
 *
 * Fails closed: no Alpha session, Alpha unreachable, slower than
 * `alphaTimeoutMs`, an error status or an answer in another shape all mean
 * "free" (with a warning for everything but a missing session). Never "pro".
 * A good answer is cached for `alphaCacheMs` per session, so a burst of clicks
 * is one lookup; failures are not cached, so Alpha coming back is seen at once.
 *
 * Every browser still gets an account: a random id in a signed, HttpOnly
 * cookie. That account is what the free allowance is counted against —
 * `freeTracksPerMonth` tracks a calendar month (UTC) — because Alpha does not
 * count tracks. Past that, Generate answers 402 `subscription_required`; a
 * free listener asking for a track over `longTrackSec` gets 402
 * `long_tracks_need_pro`.
 *
 *   GET  /music/billing           → { billingEnabled, plan, planSource, upgradeTo, upgradeUrl, ... }
 *   POST /music/billing/checkout  → { url }  Alpha's Subscriptions page (no Stripe Checkout)
 *   POST /music/billing/portal    → { url }  Alpha's Subscriptions page (no Stripe Portal)
 *   POST /music/billing/webhook   ← Stripe, only while the legacy Stripe settings are present
 *
 * The bridge's own Stripe plan no longer grants anything. If the old Stripe
 * settings are still configured, the webhook keeps recording what Stripe says
 * into the accounts file, so whoever paid the bridge directly can be found and
 * moved to an Alpha plan; that record is never read to decide a plan.
 *
 * Accounts live in one JSON file, written whole and renamed into place, so a
 * crash mid-write leaves the previous file rather than half of one.
 */

const COOKIE = 'alpha_music_account';
const ACCOUNT_ID = /^[A-Za-z0-9_-]{22}$/;
const MAX_WEBHOOK_BYTES = 512 * 1024;
const SIGNATURE_TOLERANCE_S = 300;
const MUSIC_PLAN_SCHEMA = 'alpha.monetization.music-plan.v1';
const MAX_CACHED_PLANS = 1000;
const FREE_PLAN = Object.freeze({ plan: 'free', longTracks: false, alphaPlan: null, owner: false, upgradeTo: null });

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

/**
 * Alpha's answer from `/monetization/entitlements/music`, in the bridge's
 * words, or null for anything that is not one. Only an exact "pro" is pro.
 */
export function parseMusicPlan(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.schema !== MUSIC_PLAN_SCHEMA || body.source !== 'alpha') return null;
  if (body.plan !== 'pro' && body.plan !== 'free') return null;
  const upgrade = body.upgrade_to && typeof body.upgrade_to === 'object' ? body.upgrade_to : null;
  return {
    plan: body.plan,
    longTracks: body.long_tracks === true,
    alphaPlan: body.alpha_plan ?? null,
    owner: body.owner === true,
    upgradeTo: upgrade ? { id: upgrade.id ?? null, name: upgrade.name ?? null, monthlyGbp: upgrade.monthly_gbp ?? null } : null,
  };
}

/** When a subscription's paid period ends, wherever this API version puts it. */
function periodEnd(subscription) {
  return subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end ?? null;
}

export function createBilling({
  cookieSecret,
  publicUrl,
  storePath,
  alphaApiUrl,
  // Where Upgrade and Manage send people: Alpha's Subscriptions page.
  upgradeUrl = null,
  alphaTimeoutMs = 3_000,
  alphaCacheMs = 30_000,
  freeTracksPerMonth = 3,
  // Tracks longer than this need Alpha's `long_tracks` (Plus and above).
  longTrackSec = 60,
  // Legacy: the bridge's own Stripe plan. Optional, and grants nothing; with
  // all three set, the webhook keeps recording subscriptions (see above).
  secretKey = null,
  webhookSecret = null,
  priceId = null,
  stripeApi = 'https://api.stripe.com',
  fetch: fetchImpl = fetch,
  now = Date.now,
  log = console,
}) {
  const missing = Object.entries({
    ALPHA_API_URL: alphaApiUrl,
    ALPHA_MUSIC_COOKIE_SECRET: cookieSecret,
    ALPHA_PUBLIC_URL: publicUrl,
    ALPHA_MUSIC_BILLING_STORE: storePath,
  }).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`Music Creator billing needs ${missing.join(', ')}`);
  const stripeSettings = { STRIPE_SECRET_KEY: secretKey, STRIPE_WEBHOOK_SECRET: webhookSecret, STRIPE_PRICE_ID: priceId };
  const stripeMissing = Object.entries(stripeSettings).filter(([, value]) => !value).map(([name]) => name);
  if (stripeMissing.length > 0 && stripeMissing.length < 3) {
    throw new Error(`the legacy Stripe settings are all or none; missing ${stripeMissing.join(', ')}`);
  }
  const legacyStripe = stripeMissing.length === 0;
  if (cookieSecret.length < 32) throw new Error('ALPHA_MUSIC_COOKIE_SECRET must be at least 32 characters');
  if (!Number.isInteger(freeTracksPerMonth) || freeTracksPerMonth < 0) {
    throw new Error('the free allowance must be a whole number of tracks, 0 or more');
  }
  if (!/^https?:\/\//i.test(alphaApiUrl)) throw new Error('ALPHA_API_URL must be an http(s) URL');
  if (!Number.isInteger(alphaTimeoutMs) || alphaTimeoutMs < 100 || alphaTimeoutMs > 60_000) {
    throw new Error('ALPHA_MUSIC_PLAN_TIMEOUT_MS must be 100-60000 milliseconds');
  }
  if (!Number.isInteger(alphaCacheMs) || alphaCacheMs < 0) throw new Error('ALPHA_MUSIC_PLAN_CACHE_MS must be 0 or more milliseconds');
  const site = publicUrl.replace(/\/+$/, '');
  const alphaBase = alphaApiUrl.replace(/\/+$/, '');
  const upgradeTarget = upgradeUrl || `${site}/#/hub/admin/subscriptions`;
  const secureCookie = site.startsWith('https://');
  // sha256(Authorization) -> { at, plan }. Keyed by a digest so the cache
  // never holds a session token itself.
  const planCache = new Map();

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

  /**
   * The listener's plan, as Alpha says it. Never throws, and never answers
   * "pro" unless Alpha did, for this session, within `alphaCacheMs`.
   */
  async function planFor(req) {
    const authorization = String(req.headers.authorization ?? '').trim();
    // No Alpha session on the request: nothing to ask Alpha about.
    if (!/^Bearer\s+\S+$/i.test(authorization)) return { ...FREE_PLAN, source: 'anonymous' };
    const key = createHash('sha256').update(authorization).digest('base64url');
    const cached = planCache.get(key);
    if (cached && now() - cached.at < alphaCacheMs) return cached.plan;
    planCache.delete(key);

    let plan;
    try {
      const response = await fetchImpl(`${alphaBase}/monetization/entitlements/music`, {
        headers: { authorization, accept: 'application/json' },
        signal: AbortSignal.timeout(alphaTimeoutMs),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      plan = parseMusicPlan(body);
      if (!plan) throw new Error('the answer is not an alpha.monetization.music-plan.v1');
    } catch (error) {
      log.warn?.(`music bridge: could not get the plan from Alpha (${error.message}); treating this listener as free`);
      return { ...FREE_PLAN, source: 'fallback' };
    }
    plan = { ...plan, source: 'alpha' };
    planCache.set(key, { at: now(), plan });
    // Oldest first: Map keeps insertion order.
    while (planCache.size > MAX_CACHED_PLANS) planCache.delete(planCache.keys().next().value);
    return plan;
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
   * so two clicks at once cannot both spend the last free track (the check and
   * the spend run with no await between them). Returns the refund to call if
   * queueing then fails.
   */
  async function reserve(accountId, req, recipe = {}) {
    const plan = await planFor(req);
    if (Number(recipe.durationSec) > longTrackSec && !plan.longTracks) {
      const name = plan.upgradeTo?.name ?? 'a higher Alpha plan';
      throw new ProtocolError(
        `Tracks over ${longTrackSec}s need ${name}. Upgrade in Alpha's Subscriptions.`,
        { status: 402, code: 'long_tracks_need_pro' },
      );
    }
    const entry = record(accountId);
    if (plan.plan === 'pro') return () => {};
    if (entry.usage.count >= freeTracksPerMonth) {
      throw new ProtocolError(
        `Free accounts make ${freeTracksPerMonth} tracks a month, and this month's are used. Upgrade your Alpha plan for unlimited tracks.`,
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

  async function summary(accountId, req) {
    const plan = await planFor(req);
    const entry = record(accountId);
    const pro = plan.plan === 'pro';
    return {
      billingEnabled: true,
      plan: plan.plan,
      planSource: plan.source,
      alphaPlan: plan.alphaPlan,
      longTracks: plan.longTracks,
      longTrackSec,
      freeTracksPerMonth,
      usedThisMonth: entry.usage.count,
      remaining: pro ? null : Math.max(0, freeTracksPerMonth - entry.usage.count),
      // Renewal and cancellation are Alpha's to show now.
      renewsAt: null,
      cancelAtPeriodEnd: false,
      canManage: pro,
      upgradeTo: plan.upgradeTo,
      upgradeUrl: upgradeTarget,
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
      if (!legacyStripe) return send(res, 404, { error: 'not_found' });
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
      return send(res, 200, await summary(account(req, res), req));
    }
    // Upgrade and Manage both go to Alpha: one thing to buy, bought there.
    // Neither touches Stripe, so neither can grant a plan from here.
    if (req.method === 'POST' && pathname === '/music/billing/checkout') {
      requireJson(req);
      account(req, res);
      const plan = await planFor(req);
      if (plan.plan === 'pro') return send(res, 409, { error: 'already_subscribed', message: 'Your Alpha plan already has unlimited tracks.' });
      return send(res, 200, { url: upgradeTarget, upgradeTo: plan.upgradeTo, source: 'alpha' });
    }
    if (req.method === 'POST' && pathname === '/music/billing/portal') {
      requireJson(req);
      account(req, res);
      return send(res, 200, { url: upgradeTarget, source: 'alpha' });
    }
    return send(res, 404, { error: 'not_found' });
  }

  return { account, planFor, reserve, summary, handle };
}

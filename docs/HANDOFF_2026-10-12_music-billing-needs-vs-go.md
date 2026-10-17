# Handoff: music-bridge billing change needs V's go, not a merge

## What it is

Two paired PRs, both well-tested and technically mergeable, that move who
decides a Music Creator listener's plan (free vs. pro/long-tracks) from the
music bridge's own Stripe subscription to Alpha's own entitlements:

- [Personal-AI-1.2#274](https://github.com/vyos88/Personal-AI-1.2/pull/274)
  — "music bridge: take the plan from Alpha, not the bridge's own Stripe
  plan." `src/bridge/billing.js` gains `planFor(req)`, which asks Alpha's
  `GET /monetization/entitlements/music` instead of trusting its own Stripe
  webhook/Checkout. Upgrade and Manage now point at Alpha's Subscriptions
  page instead of Stripe. Tests: full suite 0 failures (pro/free/down/
  slow/bad-shape/401 cases, caching, legacy-webhook-grants-nothing).
- [Alpha#95](https://github.com/vyos88/Alpha/pull/95) — the frontend half:
  `musicCreatorApi.js` sends the signed-in person's Alpha session
  (`Authorization: Bearer`) to the bridge so it has something to ask Alpha
  about. Without this, #274 alone treats every listener as free. Tests:
  476 pass, build clean.

## Why this session isn't merging either

**Both PR bodies say so themselves, explicitly and in bold:** "Merging this
deploys to V's Host laptop. Do not merge without V's go." This isn't a
style question or a flaky test — it's a monetization/billing policy change
with a real consequence #274's own body names:

> Anyone currently paying the bridge's Stripe plan drops to free once this
> deploys, unless they also hold an Alpha Plus+ plan. They are listed in
> `billing/music-accounts.json` and need migrating, or their bridge
> subscription cancelling.

That's a decision about real paying customers' access, and a live deploy to
the Host laptop — squarely the "security/business tradeoff, needs human
judgment" case this check's own instructions carve out, not something to
wave through on green tests.

## What's needed

V's go-ahead, plus (per #274's own "Open before going live" note) either
migrating or cancelling the bridge-side Stripe subscribers in
`billing/music-accounts.json` before or immediately after the deploy, so
paying listeners don't silently drop to free. Once that's settled, merge
#274 and Alpha#95 together — #95 alone does nothing yet since #274 hasn't
landed, and #274 alone leaves every listener free since the frontend isn't
sending a session yet.

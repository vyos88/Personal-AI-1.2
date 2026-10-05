# Handoff: a billing/monetization cluster just landed on Alpha, ready for review

**Written by:** automated hourly handoff check, 2026-10-05 22:28 UTC
**Status:** two PRs ready (non-draft) for a merge decision; two more drafted
behind them. None of this is merged. This session flagged rather than
merged, since billing and premium-feature gating are exactly the kind of
change that needs a person's judgment, however well-tested.

## Ready now (non-draft)

- **[vyos88/Alpha#47](https://github.com/vyos88/Alpha/pull/47)** — "Show the
  owner how many users and subscriptions there are." Adds a read-only
  summary to the Subscriptions page: account/subscriber counts, states
  (active/trial/awaiting payment/past due/cancelled), plan tiers, and
  monthly value. Owner-only (`require_owner`), reads the billing ledger,
  writes nothing. 32 backend + 425 frontend tests passing per its own report.

- **[vyos88/Alpha#24](https://github.com/vyos88/Alpha/pull/24)** — "Gate
  premium features by plan, starting with long Music Creator tracks."
  **Directly affects the Music Creator**: without Alpha Plus or above, the
  2-minute track length is disabled in the panel with an upgrade prompt.
  Adds `backend/entitlements.py` (reads billing state, never writes it) and
  a `require_feature()` 402 dependency for other routes to use later. Its
  own body is explicit that **enforcement isn't wired up yet** — Generate
  still goes to the alpha-tunnel music bridge, which doesn't check
  entitlements, so right now this only changes what the UI prompts, not
  what a user can actually queue. 41 backend + 410 frontend tests passing
  per its report.

## Drafted, stacked behind the above (not yet ready)

- **[vyos88/Alpha#61](https://github.com/vyos88/Alpha/pull/61)** (draft,
  based on #24's branch) — adds `GET /monetization/entitlements/music` so
  the music bridge can ask Alpha itself what a listener's plan unlocks,
  replacing the bridge's own separate Stripe "pro" plan. Says explicitly
  this follows a decision from the owner on 2026-10-05 that Alpha's plans
  are the source of truth. The matching change on this repo's side
  (alpha-tunnel) is listed as a separate task, not done here.

- **[vyos88/Alpha#60](https://github.com/vyos88/Alpha/pull/60)** (draft) —
  a written failover plan (one new doc, no code) for keeping
  `alpha.coordination` records flowing if Laptop41/Worker1 goes down, with
  Host taking over `Post`/`Ack`/`Status` only until it's back. Docs-only,
  likely safe once marked ready, but still draft.

## Also new, not yet reviewed

- **[vyos88/Personal-AI-1.2#106](https://github.com/vyos88/Personal-AI-1.2/pull/106)**
  (draft) — "docs: getting Claude handoffs live on Worker1
  (HANDOFF_2026-10-05f)."

## What a person needs to do

1. Decide on #47 and #24 — both claim to be read-only against billing and
   well-tested, but they're real money/plan-gating logic touching a live
   product; that decision belongs to the owner, not an automated pass.
2. If #24 merges, #61 can be rebased onto `alpha-full` and reviewed next.
3. Nothing here is urgent in the sense of a live outage — #24's own body
   says the gate isn't enforced server-side yet, so no user's access
   changes until a further step ships.

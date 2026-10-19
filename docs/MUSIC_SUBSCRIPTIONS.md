# Music Creator plans — they come from Alpha

V decided on 2026-10-05 that Alpha's own plans (Start, Plus, Pro, Power) are
the source of truth, including for the Music Creator. The music bridge
(`scripts/music-bridge.mjs`) no longer sells anything: it asks Alpha which
plan the listener has and counts the free allowance. The mapping itself lives
in Alpha (`docs/MUSIC_PLAN_MAPPING.md` on `alpha-full`):

| Alpha plan | Music Creator | Tracks over 60s |
|---|---|---|
| none, Alpha Start | free | no |
| Alpha Plus, Pro, Power, owner | pro | yes |

With none of the settings below, nothing changes: every click generates.

## How it works

- On Generate and on `GET /music/billing`, the bridge calls
  `GET <ALPHA_API_URL>/monetization/entitlements/music` with the listener's
  own `Authorization` header and uses Alpha's `plan` and `long_tracks`. A good
  answer is reused for `ALPHA_MUSIC_PLAN_CACHE_MS` (30s) per session.
- **It fails closed.** No Alpha session on the request, Alpha down, slower than
  `ALPHA_MUSIC_PLAN_TIMEOUT_MS` (3s), an error status or an unexpected answer
  all mean *free*, with a warning in the bridge's log. Never *pro*.
- A free listener makes `ALPHA_MUSIC_FREE_TRACKS` tracks a month (default 3),
  counted per browser in a signed cookie (Alpha does not count tracks), and
  is refused tracks over 60s (`long_tracks_need_pro`).
- **Upgrade** and **Manage subscription** (`/music/billing/checkout` and
  `/portal`) answer with Alpha's Subscriptions page
  (`ALPHA_MUSIC_UPGRADE_URL`, default
  `<ALPHA_PUBLIC_URL>/#/hub/admin/subscriptions`) and Alpha's `upgrade_to`.
  They no longer open Stripe Checkout or the Billing Portal.

**Needs Alpha's frontend to send the session.** The panel's calls to
`/music/*` must carry the signed-in user's `Authorization: Bearer ...` header
for the bridge to see a plan; without it every listener is free.

## On the Alpha host

In the bridge's `.env` (never commit it):

```
ALPHA_API_URL=http://127.0.0.1:8001
ALPHA_PUBLIC_URL=https://alpha-ai.uk
ALPHA_MUSIC_COOKIE_SECRET=<32+ random characters>
ALPHA_MUSIC_FREE_TRACKS=3
```

Restart the bridge. It should print
`plans on: from Alpha at http://127.0.0.1:8001; 3 free tracks a month on the free plan`.

## The old Stripe plan (legacy)

Don't configure a Stripe key in the bridge for new setups: payment goes
through Alpha's checkout. If `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` and
`STRIPE_WEBHOOK_SECRET` are already set, they can stay: the webhook keeps
recording subscriptions into `billing/music-accounts.json` so anyone who paid
the bridge directly can be found and moved to an Alpha plan, but that record
no longer grants anything. Cancel the bridge's Stripe product once those
subscribers have moved.

## Checking it end to end

1. Signed in as a Start account: *free*, a 120s track is refused, Upgrade
   opens Alpha's Subscriptions page.
2. Signed in as a Plus account: unlimited tracks, 120s allowed.
3. Stop Alpha's backend: the panel shows *free* and the bridge logs
   `could not get the plan from Alpha`.

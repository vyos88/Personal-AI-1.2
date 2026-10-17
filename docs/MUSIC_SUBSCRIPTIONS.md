# Music Creator subscriptions — turning them on

The music bridge (`scripts/music-bridge.mjs`) can charge for the Music
Creator: every browser gets a few free tracks a month, and a monthly Stripe
plan unlocks unlimited tracks. With none of the settings below, nothing
changes: every click generates, as before.

## How it works

- Each browser gets an account in a signed cookie. No sign-up form.
- A free account makes `ALPHA_MUSIC_FREE_TRACKS` tracks a month (default 3).
  The next Generate click is refused with *Upgrade for unlimited tracks*, and
  the panel shows an **Upgrade** button.
- Upgrade opens Stripe Checkout. Card details go to Stripe only and never
  reach Alpha.
- Stripe's signed webhook tells the bridge the payment went through. From then
  on, that account is unlimited until Stripe says the subscription ended.
- **Manage subscription** opens Stripe's Billing Portal, where people cancel or
  change their card.

**Known limit:** the account is the cookie. A subscriber who opens Alpha in a
different browser starts as free there. Linking plans to Alpha's own login is
the next step if that matters.

## One-time setup in Stripe (about 10 minutes)

Do this in **test mode** first (the toggle in the Stripe Dashboard), then
repeat it in live mode with the live keys.

1. **Product and price:** Product catalogue → Add product, e.g.
   "Alpha Music Creator", recurring monthly price. Copy the price id
   (`price_...`).
2. **API key:** Developers → API keys → the secret key (`sk_test_...`), or
   better, a restricted key with write access to Checkout Sessions, Customer
   portal and read access to Subscriptions.
3. **Webhook:** Developers → Webhooks → Add endpoint
   `https://alpha-ai.uk/music/billing/webhook`, with the events
   `checkout.session.completed`, `customer.subscription.updated` and
   `customer.subscription.deleted`. Copy its signing secret (`whsec_...`).
4. **Customer portal:** Settings → Billing → Customer portal → turn it on and
   allow cancelling.

## On the Alpha host

Add to the bridge's `.env` (never commit it):

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PRICE_ID=price_...
STRIPE_WEBHOOK_SECRET=whsec_...
ALPHA_PUBLIC_URL=https://alpha-ai.uk
ALPHA_MUSIC_COOKIE_SECRET=<32+ random characters>
ALPHA_MUSIC_FREE_TRACKS=3
```

A cookie secret in PowerShell:
`-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 48 | % {[char]$_})`

Restart the bridge. It should print
`subscriptions on: 3 free tracks a month, then the Stripe plan`. If only some
of the settings are present, it refuses to start and names the missing ones.

`/music/billing/webhook` has to be reachable from the internet, through the
same route that already sends `/music/*` to the bridge. Accounts are kept in
`billing/music-accounts.json` beside the checkout (git-ignored). Back it up:
it is the record of who has paid.

## Checking it end to end (test mode)

1. Open the Music Creator. It should show *3 of 3 free tracks left this month*.
2. Generate until it asks you to upgrade, then click **Upgrade**.
3. Pay with Stripe's test card `4242 4242 4242 4242` (any future date, any CVC).
4. Back in Alpha, the plan line reads *Unlimited tracks · renews ...*.
5. **Manage subscription** → cancel → once the period ends, it goes back to free.

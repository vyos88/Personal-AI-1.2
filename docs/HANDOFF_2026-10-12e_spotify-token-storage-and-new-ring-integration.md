# Handoff: two credential-handling PRs to review before merge

Found during the 2026-10-12 22:27 UTC hourly check. Both are on `vyos88/Alpha`,
both touch how Alpha holds other services' credentials, and both are left
unmerged for the same reason: this session doesn't decide security tradeoffs
or ship new credential-handling surfaces on its own judgment, however well
tested.

## vyos88/Alpha#109 — Spotify: encrypted token persistence + retry rework

https://github.com/vyos88/Alpha/pull/109

Real bug, real fix: today a backend restart drops the Spotify connection
because the refresh token lives in process memory only. This PR persists it
encrypted to `memory/local/.spotify_oauth.enc` (gitignored), the same pattern
`google_integration` already uses, and reworks token-refresh/retry/
error-surfacing logic (revoked tokens, rate limits, Premium-required, no
active device).

- 2322/2325 backend tests pass (3 failures are the usual container-only ones:
  speech-recognition binaries, DNS), 11 new tests fail against the old code
  (so they catch real bugs), frontend 506/506, `vite build` clean.
- **Not tested against a real Spotify account** — no credentials in this
  environment. The author's own suggested first check: connect once on the
  host, restart the backend, confirm the player still says connected.
- No secrets in the diff itself.

**Why flagged rather than merged:** it changes where and how a live
third-party OAuth secret is stored at rest (new encrypted-file persistence)
and the state machine around revocation/expiry for a production integration.
That is a security-relevant design choice (the `google_integration` pattern
it mirrors may be worth confirming is still the right one, and the new file
is unverified against a live account) rather than a bug fix mechanical enough
to wave through on tests alone.

## vyos88/Alpha#110 — Ring: new integration, unofficial API, takes the Ring password

https://github.com/vyos88/Alpha/pull/110

A brand-new integration (none existed). Read-only: device battery/online
state, and doorbell-press/motion history. Routes are owner-only. The PR's own
description is explicit about the two things worth independent eyes:

- Ring has no public API, so this drives Ring's own app-internal OAuth and
  `clients_api` endpoints — reverse-engineered, undocumented, and able to
  change or break without notice from Ring.
- Sign-in takes the account's actual Ring **email and password** (plus a 2FA
  code), sent once to Ring in the connect call. The PR states the password is
  "kept nowhere: not on disk, not in memory after the call, not in any
  response or log," and that the patch-history middleware logs only route
  and query string, never the body. The refresh token (not the password) is
  then persisted encrypted the same way Spotify's and Google's are.
- 18 new backend tests (against a fake Ring server) plus 4 frontend tests
  pass; 2325/2328 backend (same 3 container-only failures), frontend 508/508,
  `vite build` clean, and the panel was driven in Chromium against a fake
  backend at two viewport sizes with no errors.
- **Not tested against a real Ring account.**

**Why flagged rather than merged:** this is new functionality that takes a
real password for a real external account and talks to an API Ring doesn't
publish or support — the kind of integration worth a second set of eyes on
the password-handling claim specifically (even though the code and tests as
described look careful about it), and worth confirming V actually wants this
surface live before it reaches a production Alpha instance. The PR says "V
asked for it" but this session has no independent way to confirm that.

## Recommendation

Both look well-built from the diff and test descriptions, and neither
touches a live host directly from here (no action was taken on either). A
human (or V directly) reading the actual diff — especially Ring's
password-handling code path and whatever `google_integration`/`spotify
_integration`'s existing encrypted-storage pattern looks like already — before
either merges is the right amount of caution for credential-surface changes,
even ones this well-tested.

## Also still open, unchanged

- vyos88/Alpha#103 (memory/books rewrite) — still needs V's review, per
  `HANDOFF_2026-10-12d`.
- vyos88/Personal-AI-1.2#274 / vyos88/Alpha#95 (music-bridge billing pair) —
  still waiting on V's go.
- Laptop41's "two Alphas" split-brain line — the tunnel-side fix (#277) is
  merged but Worker1 hasn't picked it up yet; four untracked
  `scripts/worker1-*` paths are blocking its self-update on the machine
  itself. Machine-side fix only; nothing left to change in code.

# Handoff: the Alpha 2.0 release PR — a ship decision, not a code review

Found during the 2026-10-13 03:27 UTC hourly check.

## vyos88/Alpha#117 — "Alpha 2.0: working downloads, Android app, CI builds, regenerated Alpha-Server"

https://github.com/vyos88/Alpha/pull/117

594 files changed, +45776/-11243, 32 commits. This is a release, not a bug
fix or a feature slice:

- Unifies the version string to **2.0** everywhere (it was 1.03/1.02/1.10/0.1.0
  depending on where you looked), with a test pinning them together going
  forward.
- Fixes the Installation Center to actually serve built packages (it was
  pointing at a folder that never existed) and to offer the Android APK.
- Rewrites the Android app's connect flow (it never reached the backend
  before), removes a second, abandoned Android app folder, and adds CORS
  rules for the app's origins.
- Adds a full CI pipeline (`.github/workflows/alpha-build.yml`): web, Android
  APK, Windows installers, and a release job gated on a tag matching
  `ALPHA_RELEASE`.
- Regenerates `Alpha-Server` wholesale from `Alpha-Full` via a new sync
  script, rather than relying on hand-patching.
- Fixes a bundle-size budget regression that #114/#116 introduced.

Tests check out: 2460/2491 backend (3 environment-only failures, same as
elsewhere), 580/580 frontend, `vite build` and `audit-bundle.mjs` clean,
`actionlint` clean, no secrets in the diff.

**Why this is V's call, not this session's:**

- **The APK and Windows installers have not actually been built from this
  branch** — this environment can't reach Google's Android repo or build on
  Windows. The PR is explicit that CI is supposed to build them, but:
- **GitHub Actions has never successfully started a job in this repo** —
  every past run ended in `startup_failure` with 0 jobs, even for a workflow
  with no `uses:`. The PR asks V directly to check **Settings → Billing**
  (Actions minutes / spending limit) and **Settings → Actions → General →
  "Allow all actions and reusable workflows."** Nothing here can check or
  change billing or repo security settings.
- **Android release signing needs secrets added to the repo** before a
  signed release APK can be produced — a secrets decision, not a code one.
- This changes what gets served to real users as "the" Alpha app and
  installers — a distribution/shipping decision with real consequences if
  wrong, independent of how clean the diff and tests are.

**Recommendation:** the code itself looks sound from the diff and test
results, but this needs V to (a) decide this is the moment to ship 2.0,
(b) fix the GitHub Actions settings so CI can actually run, and (c) add the
Android signing secrets before a real release build is possible. None of
that is a code-review question this session can resolve.

## Also merged this session (routine, no action needed)

- Alpha#118 — tunnel-sync bookkeeping, records this handoff.

## Still open, unchanged

- Alpha#113 (new Execute/terminal feature), #103 (memory/books rewrite),
  #109 (Spotify token storage), #110 (new Ring integration) — all still
  await V's review, per the last three handoffs.
- Personal-AI-1.2#274 / Alpha#95 (music-bridge billing pair) — still waiting
  on V's go.
- Laptop41's "two Alphas" split-brain line — still open; Worker1 hasn't
  picked up the tunnel-side fix (#277) because four untracked
  `scripts/worker1-*` files are blocking its self-update on the machine
  itself.

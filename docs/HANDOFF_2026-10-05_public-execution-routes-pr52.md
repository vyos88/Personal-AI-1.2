# Handoff: a real, currently-open security exposure, fix pending in draft

**Written by:** automated hourly handoff check, 2026-10-05 02:27-03:27 UTC
**Status:** live security exposure — fix exists but is still draft, needs the
owner's review and decision to merge, not mine

## What's open right now

[vyos88/Alpha#52](https://github.com/vyos88/Alpha/pull/52) (draft) describes
and fixes a real code-execution exposure on the public `alpha-ai.uk` site.
Quoting its own summary: three backend routes run code taken straight from
the request body, reachable through Cloudflare's public proxy today because
nothing currently distinguishes a public request from a local/tailnet one on
these routes:

| Route | Runs |
|---|---|
| `POST /terminal/execute` | any PowerShell command |
| `POST /code/run` | a Python, JavaScript, PowerShell or Java snippet |
| `POST /code/handoff` | writes the payload to a file and runs it |

All three are owner-only today, but owner-only means "behind one password" —
the PR's own framing: "a stolen owner session anywhere on the internet was
code execution on Laptop41." That is a real, currently-live exposure on the
production site, not a hypothetical.

## Why this check isn't merging it

It's still marked **draft** by its own author, and this is a security
tradeoff — exactly the category this routine is scoped to flag rather than
act on, draft or not. The fix itself looks substantial and well-tested from
the PR body (`public_tunnel_guard.py`, a pre-auth middleware keyed off
Cloudflare's own `cf-connecting-ip`/`cf-ray` headers that a client can't
forge, a test suite pinning the decoded-path case so `/api/%74erminal/execute`
can't slip through a naive string match, and a reported 2126/22/0 on the full
backend suite) — but confirming that, marking it ready, and merging a
security fix is a decision for a person, not an automated pass.

## What a human needs to do

1. Read the PR: https://github.com/vyos88/Alpha/pull/52
2. Decide whether to mark it ready and merge it (it targets `alpha-full`,
   not `main` — the live frontend/backend branch), or ask its author for
   changes first.
3. Its own "Not done here" section flags two follow-ups worth deciding at
   the same time: other owner-only routes (`/code/*` scaffolding/build) that
   still answer the public site, and whether the Terminal's Execute tab
   should be reachable from the public site at all vs. only over Tailscale.

## Also from this pass

- No new non-draft PRs on either repo. Two new **draft** PRs appeared on
  `Alpha`: this one (#52) and #53 (Music Creator panel wired to the three
  routes `Personal-AI-1.2`#76/#70 added — remove-vocals button, fleet
  recipes, fleet status line). #53 is draft because it hasn't been rendered
  in a real browser yet; nothing to merge there either.
- `status/laptop41` (now correctly probing the Host at
  `100.93.104.24:8787` instead of loopback, confirming the coordinator move
  in `HANDOFF_2026-10-05b_host-move.md` is live and working): `worker1`
  shows attached with a succeeded `sysinfo` task on record. The four
  long-standing `NEEDS A PERSON` items (self-heal never registered, wrong
  frontend folder, dictionary bug, stale build) are still open — their run
  counters reset to 7 (since 02:56), consistent with the doctor's own state
  file being rewritten around the host-move probe fix, not with the
  underlying problems being new.

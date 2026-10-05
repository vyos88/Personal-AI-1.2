# Handoff — Music Creator, for whoever is at Laptop41

Written from a cloud session at the human's request. Same reason as every
other doc in this folder: a cloud container cannot reach the tailnet, so a
commit is the only channel that reliably gets from here to the host.

As of this commit, `main` is at `c4dc2fe` (alpha-tunnel) and `alpha-full`
(Alpha) has Music Creator ported into the real app (PR #16, merged). Full
test suite: **497/497** passing.

## 1. The one thing to check first

```powershell
cd <alpha-tunnel checkout>
git pull
node src/admin/run.js login --email <you>
node src/admin/run.js doctor --agent laptop41
```

This is new since 2026-10-01 (PR #65, merged). It answers, in plain language:
is the coordinator up, is this machine attached, does it offer `alpha.music`,
and does the bridge's `/music/healthz` answer. Run this before anything else
below — it will say exactly which step the bridge setup is stuck on.

## 2. What's merged and real right now

| Area | What | Where |
|---|---|---|
| Genre/subgenre/key taxonomy | 13 genres, 69 subgenres (incl. Rollers), 24 keys | alpha-tunnel `main` — `src/common/musicGenres.js` |
| `alpha.music` / `alpha.music.audio` handlers, `generate_music.py`, `music-bridge.mjs` | Generator + bridge | alpha-tunnel `main` — `src/agent/handlers/alpha-music*.js`, `scripts/` |
| Music Creator panel, wired into the real app | Chat Hub → Music Creator | Alpha `alpha-full` — `MusicCreatorPanel.jsx` (PR #16) |
| `/music/*` proxy, with a local-only guard | Blocks Cloudflare-routed requests (`cf-connecting-ip`/`cf-ray` → 403) | Alpha `alpha-full` — `vite.config.js` (PR #16, already done, don't redo it) |
| `doctor`/`login`/`logout` admin CLI | Checks coordinator, agents, `alpha.music`, bridge health in one command | alpha-tunnel `main` — `src/admin/run.js` (PR #65) |
| Self-heal control-URL fix, run-jobs recipe fixes, stale-agent flag | Bug fixes, no behavior change to the bridge itself | alpha-tunnel `main` (PRs #68, #69, #71 — merged this session) |

## 3. What is explicitly NOT done

- **No real (non-dry-run) MusicGen generation has happened anywhere, by
  anyone, as of this commit.** Nothing in any merged PR or receipt claims one.
- **The bridge's live status on Laptop41 is still unconfirmed from this side.**
  Run `doctor` above — that's the fastest way to find out, faster than
  re-walking the old punch list from `HANDOFF_LAPTOP41_2026-09-30.md`.
- **Skip step 8 of that old punch list if you're following it.** The
  `/music` proxy line it describes is already done correctly in `alpha-full`
  (PR #16, with the local-only guard). Adding it again by hand in a different
  `vite.config.js` is how you'd accidentally publish an unauthenticated music
  bridge to the public internet — `docs/AUDIT_2026-10-01.md` §"Corrections" (removed 2026-10-05; `git show 46f0adb:docs/AUDIT_2026-10-01.md`)
  has the detail if you want it.

## 4. Three PRs waiting on a decision, not merged by this session on purpose

- **alpha-tunnel #67 + Alpha #31** — Stripe subscriptions for Music Creator
  (free tracks/month, then a paid plan via Stripe Checkout/webhooks/Billing
  Portal). Tests pass, but this is a business decision (do you want to
  charge for this at all) plus new secrets to provision on the host
  (`STRIPE_PRICE_ID`, webhook signing secret). Needs the human, not a bot
  merge.
- **alpha-tunnel #70** — adds `GET /music/recipes` and `GET /music/fleet` to
  the bridge (recipe history, which machines offer `alpha.music`). Careful
  about scope and leakage, tests pass, but it's a new feature surface rather
  than a bug fix, so it's sitting for visibility rather than auto-merged.
- **alpha-tunnel #72** — makes the task queue survive a coordinator restart
  by journaling it to disk (`tasks.json`), with credential redaction and
  result-size trimming. This is exactly the fix for "the tunnel no longer
  remembers this track" after a restart, but it's a new persistent-data
  surface, so flagging it rather than merging it unattended.

If you're a person reading this: worth a look soon, especially #72, since it
fixes a real annoyance. If you're Claude or Codex reading this on the host:
these are explicitly **not** yours to merge without the human weighing in —
same reason, business/security tradeoffs.

## 5. Once the bridge is confirmed up

Test with `ALPHA_MUSIC_DRY_RUN=1` first (a click track, no model download),
confirm you hear it through the real panel, then unset the var for a real
generation. First real one downloads `facebook/musicgen-small` — needs
internet, one-time.

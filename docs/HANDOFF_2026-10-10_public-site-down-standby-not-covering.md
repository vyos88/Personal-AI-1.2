## Hourly alpha-tunnel handoff check — 2026-10-10, 01:14 pass

### New, more severe than the prior outage: the public site is fully down

Laptop41's report changed shape entirely this pass — it's now the
**standby** report format, not the usual 8-section one:

```
=== 0. Standby: Alpha serves from alpha-serv-01 ===
  role.json says standby since 2026-10-10T01:02:21 (alpha-standdown.ps1;
  the alpha-standup job serves Alpha here again)
  PROBLEM: https://alpha-ai.uk/ answers 530 and this machine is standby:
  nobody serves Alpha. If alpha-serv-01 stays down, queue alpha-standup here
  ok: no backend here (port 8001 free)
  ok: no site here (port 4173 free)
  ok: no connector here
  PROBLEM: automatic cover has not run for 13 min: its task 'Alpha Standby'
  is not running passes
```

Reading this against the prior passes in this window: Laptop41 had
apparently been **promoted** to serve Alpha at some point (it was running
backend/frontend/connector in every report since 18:00 UTC), then stood
itself back down at **01:02:21** expecting `alpha-serv-01` (the Host) to
resume serving. It hasn't — the public site returns **530** (Cloudflare:
origin unreachable), and with Laptop41 now standing down, **nobody is
serving Alpha at all.**

**Worse, the safety net that exists for exactly this isn't running:** the
scheduled task `Alpha Standby` — whose whole job, per `docs/HOST_DOWN.md`
and CLAUDE.md's "coming home happens between tasks" design, is to notice
the primary is still down and re-promote this machine — hasn't run a pass
in 13+ minutes. That's not a coincidence worth ignoring: the mechanism
meant to catch this exact failure mode (primary down, standby stood down
too early or the primary flapped back only briefly) is itself not
executing.

**This is the same underlying Host problem continuing, now with a visible
consequence.** The coordinator and image backend on the Host
(`laptop-gj8dfmlk`) have been down since 18:42:20 UTC yesterday (see
`HANDOFF_2026-10-09d_coordinator-and-image-backend-down.md`, now ~6.5
hours at last reading). This is very plausibly that same Host outage
finally taking the public site down too, once whatever had Laptop41
covering in the meantime let go.

**Why this needs a person:** two independent things need checking, both on
machines this session cannot reach — whether `alpha-serv-01` is actually
back up (the 530 says no), and why the `Alpha Standby` scheduled task on
Laptop41 stopped running passes. The doctor's own recommendation: "If
alpha-serv-01 stays down, queue alpha-standup here" — i.e., someone needs
to either bring the Host back, or deliberately re-promote Laptop41.

**Update (02:11 pass, ~70 min into this specific outage):** still down,
unchanged shape. One new detail: `role.json` now says "standby since
2026-10-10T01:54:25" — a later timestamp than the 01:02:21 first seen,
meaning the standdown marker moved forward at least once in between
(either a brief, unlogged promotion-and-standdown cycle, or the marker is
refreshed independent of an actual state change — not distinguishable from
here). What is unambiguous: "automatic cover has not run for 70 min" is
now a precise, repeated reading (open 3 runs since 01:41:23) rather than a
single early data point — the `Alpha Standby` task is not a flake, it is
not running at all. Not sending a second notification; same finding, same
fix, now with firmer evidence it isn't self-resolving.

### No new PRs this pass

Same set as before on both repos. Not re-deriving the Host outage detail
already in `HANDOFF_2026-10-09d`; this doc is specifically about the new
public-facing consequence and the standby-cover failure.

**Correction (Claude, cloud, 01:40 UTC): both readings above have known
causes, and neither is a fault to fix on Worker1.**
- *The role timestamp moved* because the stand-down ran again, three times,
  on purpose:
  - 00:02 UTC: the first stand-down;
  - 00:38 UTC: by hand;
  - 00:54 UTC: Codex's job `20261010-codex-0152-server-only-role`, which
    exited 0 (status/laptop41-autopilot 30b1dd3).

  The times in `role.json` are local (+01:00), so 01:54:25 is that last
  run. There was no promotion in between.
- *'Alpha Standby' is not running because it is disabled, and must stay
  so.* V's instruction, relayed by Codex at 00:53 UTC (control/laptop41
  3b002b9): alpha-serv-01 (100.70.101.6) is the sole server, and
  DESKTOP-41HPLCN stays a worker; no standby-install, no old Host. The
  doctor's "automatic cover has not run" line is therefore expected.
  Re-enabling the cover would go against V's word.
- *The fix for the 530 is alpha-serv-01's public connector* (cloudflared or
  its Cloudflare config). Its private `/health` already answers 200. That is
  V's and Codex's at alpha-serv-01. Worker1 covers only if V says "cover":
  `alpha-standup`, fixed in #251.

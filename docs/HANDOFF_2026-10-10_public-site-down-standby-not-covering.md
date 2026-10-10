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

### No new PRs this pass

Same set as before on both repos. Not re-deriving the Host outage detail
already in `HANDOFF_2026-10-09d`; this doc is specifically about the new
public-facing consequence and the standby-cover failure.

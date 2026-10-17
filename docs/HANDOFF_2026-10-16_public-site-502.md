### UPDATE (12:11 pass): 5th occurrence (a 404 this time), self-resolved again

The doctor's `20261016-121105` pass shows `+ fixed since last run:
https://alpha-ai.uk/ answers 404 and this machine is standby...` — another
blip, this time a 404 rather than 502, happened and recovered between the
10:11 check and this one. That is five self-resolving occurrences of this
same failure shape in one week. Still no fix pushed, site currently 200,
nothing newly actionable — the recurrence and the recommendation to check
alpha-serv-01's connector/backend directly were already raised above; not
repeating that notification, just keeping the record current.

### UPDATE (10:11 pass): happened again, self-resolved again (4th time this week)

The doctor's `20261016-101105` pass shows the same `+ fixed since last run:
https://alpha-ai.uk/ answers 502...` line again — meaning the site 502'd and
recovered at least once more between the 08:41 check and this one (exact
timing not caught live, since this session only polls once an hour). That
makes four self-resolving occurrences of this same failure shape in a single
week (one 404, three 502s). Still nothing actionable from this session —
no fix pushed, site currently 200 — but the growing frequency reinforces the
original recommendation: worth a person comparing alpha-serv-01's backend
and connector health directly rather than waiting for this to escalate past
"self-resolving."

### RESOLVED (08:41 pass): site is back to 200

The very next doctor pass (`20261016-084105`, 15 min later) reports
`ok: https://alpha-ai.uk/ answers 200, served from alpha-serv-01` and lists
the fix explicitly: `+ fixed since last run: https://alpha-ai.uk/ answers 502
and this machine is standby: nobody serves Alpha...`. So this was another
single-pass blip, same as the prior two this week — no fix was pushed from
this session, and nothing further is needed here right now. The repeated
pattern (three self-resolving incidents in a week) is still worth someone
looking at the connector/origin on `alpha-serv-01` when they have a moment,
but is not an active outage. Leaving the original write-up below as an
accurate record of what was seen at the time.

# Handoff: public site 502 on alpha-ai.uk (2026-10-16, 08:26 pass)

Laptop41's doctor (pass `20261016-082605`) reports:

```
=== 0. Standby: Alpha serves from alpha-serv-01 ===
  role.json says standby since 2026-10-11T01:57:18.6703212+01:00 (alpha-standdown.ps1;
  the alpha-standup job serves Alpha here again)
  PROBLEM: https://alpha-ai.uk/ answers 502 and this machine is standby:
  nobody serves Alpha. If alpha-serv-01 stays down, queue alpha-standup here
  PROBLEM: standby, but the backend runs here (pid 2180 pythonw.exe ...): two
  Alphas. Queue alpha-standdown again, or alpha-standup to serve here
  ok: no site here (port 4173 free)
  ok: no connector here
  PROBLEM: automatic cover last ran 9085 min ago and its task 'Alpha Standby'
  is not on this machine: nothing will run it again (queue standby-install,
  or stand this machine down)

=== SUMMARY ===
  this pass took 14s
  - NEEDS A PERSON - automatic cover last ran 9085 min ago ... (open 381 run(s),
  since 2026-10-11T04:41:17)
  - NEEDS A PERSON - standby, but the backend runs here ... (open 146 run(s),
  since 2026-10-14T16:26:24)
  - https://alpha-ai.uk/ answers 502 and this machine is standby: nobody
  serves Alpha. If alpha-serv-01 stays down, queue alpha-standup here (open
  1 run(s), since 2026-10-16T08:26:17)

=== RECOMMENDATIONS ===
  1. [new] An endpoint is down: compare section 1 (backend) and section 4
  (public); if only public fails and the origin is fine, the connector is the
  fault.
```

This is a **live, currently open** incident as of this pass -`alpha-ai.uk`
answers 502 right now, open only 1 run (since 08:26:17 UTC). This is the same
failure shape as prior similar incidents this month ((public site down while
Laptop41 is standby and therefore not serving, and nobody else visibly is
either): a 404 on 2026-10-14 that self-resolved on the very next pass, and a
502 blip caught only after-the-fact on the 06:26 pass on this same day
(which had already self-resolved by the time it was checked).

**The standing "automatic cover" / "Alpha Standby" and "two Alphas" lines are
not new and are not being re-flagged as problems.** Per earlier handoffs
(V's instruction, relayed by Codex): `alpha-serv-01` is the deliberate sole
server, Laptop41/Worker1 stays a worker, and the standby-cover task is
disabled on purpose. Those lines will keep appearing and are expected.

**What is new and needs a person**: `alpha-ai.uk` is answering 502 right now.
This is the third occurrence of this exact failure shape in a week (one 404,
two 502s). The previous ones each self-resolved within one 15-20 minute pass,
so this may do the same- but the recurrence itself (three times in a week) is
worth a person's attention: it suggests something on alpha-serv-01 or its
connector is flapping rather than a one-off. Per the doctor's own
recommendation: "compare section 1 (backend) and section 4 (public); if only
public fails and the origin is fine, the connector is the fault" - those
sections aren't in this standby-format report, so that comparison needs doing
on alpha-serv-01 itself or from a machine that can reach its tailnet. This
cloud session cannot reach it directly.

**This will be updated with resolution status on the next check.**

### No new PRs this pass

Same set as the rest of this window on both repos; nothing new to merge or
flag there.

## Hourly alpha-tunnel handoff check — 2026-10-11, 01:26 pass

### New, genuinely urgent: split-brain — two Alphas serving at once

Laptop41's report, after ~24 hours of clean standby (role.json standby since
2026-10-10T01:54:25, site 200 from alpha-serv-01 on every prior pass), now
shows:

```
PROBLEM: standby, but the backend runs here (pid 12564 python.exe ...): two
Alphas. Queue alpha-standdown again, or alpha-standup to serve here
PROBLEM: standby, but 1 cloudflared process(es) run here: alpha-ai.uk's
traffic is split between two machines
```

Both first-occurrence (open 1 run, since 2026-10-11T01:26:22). Laptop41's
`role.json` still says standby — nothing re-promoted it deliberately — but
its backend (port 8001, pid 12564) and a `cloudflared` process are both
running anyway. Combined with `alpha-serv-01` apparently still serving too
(the public site still answers 200), **this is exactly the split-brain
CLAUDE.md's standby section names as the one failure mode `--control-url`
and deliberate demotion exist to prevent**: "the machine cannot tell 'the
host is down' from 'I cannot reach the host'" — except here it's reversed,
a backend started on the standby *without* a role change, so two machines
may now be answering requests (and, with cloudflared running on both,
potentially routing public traffic) independently and inconsistently.

**Why this needs a person, not a merge:** this is a live-process state on a
machine this session cannot reach. Someone needs to check Laptop41 directly
— was the backend started by hand, by a stale scheduled task, or by
something re-promoting it without updating `role.json`? — and run
`alpha-standdown` again if Laptop41 should stay a worker, per the standing
instruction (V's 2026-10-10 relay via Codex, `control/laptop41` `3b002b9`:
alpha-serv-01 is the sole server).

### Also new this pass: CPU hold re-tripped (94%, open 1 run) — already
documented, not re-flagging on its own.

### 8 new PRs — the promised split of #99, materializing

PR #99 (flagged repeatedly in this window as too large to merge) is being
split exactly as its own branch's "split plan" measurement described two
checks ago: **#253–#260**, all draft, all single-concern, all against
current `main`, each with a full-suite verification table (923→924 or
→937 tests, 0 fail). Of note:

- **#256** ("Music: say what made each track") is the item
  `HANDOFF_2026-10-09b` asked for — adds `stats.engine` (cuda vs cpu) to
  music task results so the Worker1-vs-Host generation-speed question has
  an answer after the next `live-test --only music`.
- **#259** ("doctor: a disabled cover is a decision...") is the one that
  **closes the doctor's own `NEEDS A PERSON — automatic cover` line** this
  check has been reading as unresolved since ~01:41 yesterday — it teaches
  the doctor that a deliberately-disabled cover is a note, not a fault.

Both read as clean, well-tested, narrowly-scoped splits. Not merging any of
the 8 this pass — that's eight independent verification passes (clone,
merge main, full suite) this check hasn't yet done; flagging the set so the
next checks know to work through them rather than re-discovering them.

### Everything else

No other new docs on either repo this pass.

## Update — 05:11 pass: RESOLVED, and the split merged

**Split-brain resolved.** Laptop41's 05:11 pass shows `ok: no backend here
(port 8001 free)`, `ok: no connector here`, and the CPU hold is clear too
(`ok: CPU 63%`, down from the 94% above). Not a code fix: per
`docs/HANDOFF_2026-10-11b_cloud-claude-receipts.md` (a separate cloud
session working with V directly via Desktop Commander), the owner paused
Laptop41 — "every other Alpha task there \[was\] Stopped and Disabled
... matching the owner pause" — which is what took the backend and
cloudflared down, not a crash or a bug.

**New line in its place, and it's expected, not a fresh escalation:**

```
PROBLEM: automatic cover last ran 1690 min ago and its task 'Alpha Standby'
is not on this machine: nothing will run it again (queue standby-install,
or stand this machine down)
```

The doctor (per #259, merged this window) correctly treats "task not
installed at all" as a real PROBLEM distinct from "task installed but
disabled" (which is now a Note) — and a task the owner's pause removed
along with everything else on that machine is exactly "not installed".
Not re-flagging separately: it's one more consequence of the same
owner-directed pause `HANDOFF_2026-10-11b`'s "Needs V" section already
tracks, not an independent fault. Whether Laptop41 keeps standby duty is
the owner's call to make once the pause ends.

**The split merged.** All ten of #253–#262 (plus #256, merged earlier) are
in `main`, each independently verified (clone, merge main, full suite, 0
fail) before merging. #99 itself closed as superseded — nothing in it
isn't already in the ten.

**vyos88/Alpha, same window:** #90 (tunnel-cadence duplicate) closed as
superseded by `alpha-full`'s own `cf767bb`. #91 (tunnel-report anchor fix,
17/17 tests) merged to `alpha-full`.

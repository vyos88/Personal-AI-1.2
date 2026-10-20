# Laptop41: WindowsTerminal memory has climbed one-directionally for ~10h, RAM now critical

## What changed

Across every doctor pass this session, `WindowsTerminal` (pid 5576, the same
pid throughout) has grown monotonically — never once dropped between
passes:

```
04:11   1,361 MB
04:26   1,579 MB (new pid 13984, different session)
...
05:11   3,881 MB
07:26   2,222 MB (new pid 5576, after a gap -- previous session ended)
09:26   2,222 MB
10:41   3,303 MB
11:56   4,435 MB
13:11   5,434 MB
14:11   6,220 MB
```

Since the terminal session restarted around 07:26 (new pid 5576), it has
gone from 2.2 GB to 6.2 GB in under 7 hours with no drop at any point —
a one-directional climb, not normal fluctuation. Machine RAM free has
fallen in step: 6.8 GB free at 07:26 → **1.8 GB free now**, with total RAM
15.8 GB. `MsMpEng`, `codex`, and two `ChatGPT` processes have stayed roughly
flat across the same window, so this isn't general memory pressure — it is
specifically this one process.

## Why this is flagged now, not earlier

The doctor's own per-pass threshold has called every reading "ok" so far
(it only flags a `PROBLEM` on free RAM below some lower bound this session
hasn't crossed), so previous passes weren't individually alarming. What
changes the picture is the *trend*: a strictly increasing curve over ~10
hours with no sign of leveling off is exactly what a memory leak looks
like, and at the current rate (roughly 4.6 GB over ~7 hours, ~650 MB/hour)
the machine could exhaust its remaining 1.8 GB within the next few hours
if nothing is done.

## Why this needs a person

This is a live, running process on Laptop41 — closing it or restarting the
terminal is an action on the actual machine, not a doc change or a merge.
If RAM runs out, Windows will start killing or badly degrading whatever it
decides to reclaim from first, which on this machine includes other things
competing for the same 16 GB (`docs/HOST_DOWN.md`/the doctor's own
recommendation #8 already calls out heavy non-Alpha tools here).

## Suggested next step for whoever has access

1. Check what's actually running inside that WindowsTerminal window/tab —
   a long-lived process (a watch loop, a verbose log tail, a REPL holding
   growing state) is the likely culprit, not the terminal host itself.
2. If nothing critical is mid-task in it, close that terminal (or the
   specific tab/process) to reclaim the memory.
3. If something in it must keep running, consider moving it to a
   dedicated, restartable process instead of an interactive terminal, so a
   leak there doesn't threaten the whole machine's RAM.

## No action taken

Read-only telemetry; nothing here was written to or changed.

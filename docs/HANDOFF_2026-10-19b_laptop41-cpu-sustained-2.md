# Laptop41 CPU sustained at/above 90% for ~1h15m, second episode, 2026-10-19

## What changed

A second sustained-CPU episode, distinct from the one that opened at
`05:13:31` and cleared by `16:11:18` (reported fixed in this routine's
16:27 UTC tick). This one has been open since `2026-10-19T18:58:01`, is now
**6 consecutive passes** (~1h15m), and the doctor has already upgraded it
to `NEEDS A PERSON`:

```
NEEDS A PERSON - CPU 100% is at or above the 90% hold: no Alpha runs here,
so what it costs is this machine's own work -- the agent stops asking for
tunnel tasks over ALPHA_AGENT_MAX_LOAD, and the autopilot's passes and the
data copy run slow  (open 6 run(s), since 2026-10-19T18:58:01)
```

## Likely cause — less clear than last time

The first episode had an obvious explanation (an ESP32-S3 toolchain build,
`cc1plus`/`xtensa-esp32s3-elf-g++` x8 each). This one doesn't show the same
signature. Pass `20261019-201141`'s measured sample is thin — only 36.4% of
the machine accounted for:

```
msedge         15.1% CPU   3.41s  pid 12688
WindowsTerminal 10.7% CPU   2.42s  pid 888   (2,985 MB resident, up from
                                               1,361 MB two passes ago and
                                               1,998 MB one pass ago)
msedge          5.0% CPU   1.12s  pid 15484
...
146 process(es) could not be measured: svchost x77, WUDFHost x3, git x2,
conhost x2, csrss x2, fontdrvhost x2
```

`WindowsTerminal`'s resident memory has been climbing pass-over-pass
(1,361 MB → 1,998 MB → 2,985 MB) while its measured CPU share is modest —
that pattern (growing memory, not a single CPU hog) doesn't point at one
runaway compile the way last time's did. The `git x2` in the unmeasured
list is some local git activity on Laptop41 itself (not this routine's
own checks, which run against the tunnel's GitHub remote from a cloud
container with nothing on that machine) — possibly the self-update
checker or an autopilot pass; worth noting but not, on its own, enough CPU
to explain 100%. Nothing in the measured or named-but-unmeasured rows
obviously explains 100%.

## Why this is flagged rather than acted on

Same reasoning as the first episode: this machine's only queued work is
through the tunnel's agent, which backs off automatically over
`ALPHA_AGENT_MAX_LOAD` — nothing is breaking, and there's no code fix to
make from here. What's worth a person's awareness:

- Unlike last time, there's no obvious benign explanation (no visible
  parallel compile). Worth a direct look at the machine — Task Manager by
  CPU, not just memory, since the measured sample here is thin — to see
  what's actually spinning.
- `WindowsTerminal`'s growing memory footprint (now ~3 GB) alongside this
  may or may not be related; if it is a terminal pane running something
  heavy, that's the first place to look.

## No action taken

Read-only telemetry; nothing here was written to or changed. If the next
doctor pass (15-20 min) shows it cleared, no further action is needed.

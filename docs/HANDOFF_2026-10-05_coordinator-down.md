# Correction: the "coordinator down" alert below is expected, not a problem

**This doc's original claim was wrong — kept for history, corrected here.**

The original version of this file flagged `status/laptop41`'s
"no coordinator answering on 8787" as a new, unexplained outage needing a
person on Laptop41. A push notification went out saying the same thing.
That was a false alarm, and the real explanation was sitting in a PR that
merged minutes before this file was written but after this check had
already read the `docs/` listing:

**[`HANDOFF_2026-10-05b_host-move.md`](HANDOFF_2026-10-05b_host-move.md)**
(added by [Personal-AI-1.2#88](https://github.com/vyos88/Personal-AI-1.2/pull/88),
merged 2026-10-05 00:46:57 UTC) — the owner decided to move the coordinator
from Laptop41 to `laptop-gj8dfmlk` (now "Host"); Laptop41 becomes "Worker1"
and keeps Alpha itself. That doc says, verbatim, under "What a cloud session
can and cannot see":

> **Expect one false alarm.** The doctor's section 5 probes
> `http://127.0.0.1:8787/healthz` on the machine it runs on. After the move
> that check reports "no coordinator answering" on Worker1, because the
> coordinator is not supposed to run there any more. Until the doctor is
> taught to probe `ALPHA_HOST_URL` (BACKLOG item A-host-move), ignore that
> one line and read the peer report instead.

So: nothing is down. `status/laptop41`'s doctor is checking the wrong
address for the coordinator now that it has (intentionally) moved off that
machine, exactly as `HANDOFF_2026-10-05b_host-move.md` anticipated. The real
signal to watch is the 3-minute peer report (`peer-report.log` on both
laptops, Part E of that handoff) and `node src/admin/run.js coord --action
Status`, not the doctor's loopback-only port probe.

**What this session should have done differently:** re-read the `docs/`
directory listing fresh each pass rather than relying on one read from
earlier in the same check — the real explanation had already been merged by
the time this file's push notification went out, and a second look would
have caught it before alarming anyone.

**Open backlog item, already tracked:** `A-host-move` in `docs/BACKLOG.md`
— teach the doctor to probe `ALPHA_HOST_URL` instead of loopback once the
move is confirmed done, so this stops being a standing false alarm.

---

*Original (incorrect) content below, struck through for the record:*

~~The alpha-tunnel coordinator on Laptop41 just went down: port 8787 was
healthy an hour ago, now shows `nothing listening`. ... needs someone on
Laptop41 to start it.~~ — wrong; see the correction above.

# Handoff: a large memory/books rewrite to review, and a live split-brain on Laptop41

Two things found during the 2026-10-12 18:27 UTC hourly check that are outside
what this session should decide or act on alone.

## 1. vyos88/Alpha#103 — left unmerged, needs a human read

**"Memory, books and the reading agent: stop losing memory, stop reporting
reading that didn't happen"** — https://github.com/vyos88/Alpha/pull/103

This is a 2,960-line-addition, 37-file rewrite of the memory store's pruning,
locking, search-index and books/reading-agent honesty logic, requested
directly by V. It is well tested (2362/2370 backend, 77 new tests, 516/516
frontend; the 8 backend failures are environment-only and match `alpha-full`
without the PR) and the bug it describes is real and serious: the existing
maintenance prune was deleting Layer-2 user memories older than 7 days unless
their key contained book/curriculum/library — i.e. explicit "remember this"
memories, grounded memories, transcripts and conversation threads were being
silently discarded in production.

**Why this session did not merge it anyway:** scope and blast radius. This
touches the live memory store's data-retention behavior (what gets pruned,
how search indexing and conversation lookups work, how books are marked
"read"), deployed to the box real users' memory lives on. That is a
live-host-data-integrity change, not a "small, clearly-safe fix" — exactly the
class this routine is told to flag rather than merge on its own judgment, even
when tests pass. It deserves a human (or a session with more room to audit
each of the ~10 behavior changes individually) reading the diff before it
goes out, given the prune bug's history of already having destroyed real
memories silently once.

**Recommendation:** worth merging once reviewed — the prune-deletion bug alone
is worth fixing urgently — but review first rather than taking the author's
own tests as the only gate, given what is at stake if one of the other nine
changes has a similar edge case.

## 2. Laptop41: standby role, but a backend is running there — "two Alphas"

From `laptop41-doctor` at 2026-10-12 19:11 UTC (`status/laptop41`,
`reports/latest.txt`), a new PROBLEM line, first seen this pass (open 2 runs,
since 18:56:49 UTC):

> standby, but the backend runs here (pid 7828 python.exe:
> "C:\Users\Vyo\AppData\Local\Programs\Python\Python312\python.exe"
> C:/Users/Vyo/AppData/Local/AlphaPanelFeed/alpha_<redacted> --policy
> C:/Users/Vyo/AppData/Local/AlphaPanelFeed/policy.json --receipt
> C:/Users/Vyo/AppData/Local/AlphaPanelFeed/latest.json): two Alphas. Queue
> alpha-standdown again, or alpha-standup to serve here

Laptop41's `role.json` says standby since 2026-10-11T01:57:18+01:00 (Alpha is
served from `alpha-serv-01`), and the doctor's usual backend/site/connector
checks (port 8001, port 4173, cloudflared) are all clean. This new line is
a *different* process — `AlphaPanelFeed`'s own `python.exe`, not the main
`software/backend` process — but the doctor treats any backend process
running on a standby machine as a split-brain risk worth a PROBLEM line, and
CLAUDE.md's standby design is explicit that resolving split-brain needs a
decision at the machine, not a task through the tunnel (failover "cannot be
driven over the tunnel, because the coordinator is the thing that is down").

**This session cannot act on it** — no tailnet access from a cloud container,
and the doctor's own suggested remedies (`queue alpha-standdown again, or
alpha-standup to serve here`) are both live-host actions on Laptop41 itself.

**Recommendation:** someone with hands on Laptop41 (or the host-side session)
should check what `AlphaPanelFeed`'s `alpha_*` process actually is — it looks
like a separate panel-feed service rather than the main Alpha backend, so it
may be a false positive in the doctor's "two Alphas" check (worth checking
whether the doctor's backend-detection regex is matching on the wrong
process name) — or, if it genuinely is a second Alpha instance, run
`alpha-standdown` again on Laptop41 to clear it.

## Not needing action

- vyos88/Personal-AI-1.2#274 / vyos88/Alpha#95 (music-bridge billing pair):
  unchanged, still explicitly waiting on V's go per their own PR bodies.
- The "Alpha Standby task absent" PROBLEM line on Laptop41 continues
  climbing (open 155 runs as of this pass) — already covered in an earlier
  handoff as the expected consequence of the owner's deliberate pause of that
  machine's cover task; not re-flagging the same unchanged finding.
- A transient CPU spike to 97% on Laptop41 resolved itself within one pass
  (reported "+ fixed since last run"), consistent with the fluctuation
  pattern already seen several times this session.

## Merged this session (no action needed)

- Personal-AI-1.2#275, #276 — autopilot reporting fixes (stop spurious
  "change" commits; add age/OWED annotations to the live page).
- Alpha#101 — tunnel-sync bookkeeping (2-line `tunnel-sync.json` update).
- Alpha#102 — Brain deck fill-screen fix (hide overlay UI in fill screen;
  fix a double-handled drag between `OrbitControls` and the stage's own
  handler).
- Alpha#104 — serves `/recommendations/debug` (read-only diagnostic route)
  and removes the Elegoo firmware-upload button, which had no backing route
  and would have been a one-click hardware reflash with no way to test from
  a cloud session — consistent with the owner's standing "do not reflash or
  re-provision anything" rule.

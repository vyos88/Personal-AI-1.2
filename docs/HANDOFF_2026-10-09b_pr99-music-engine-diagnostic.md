## Music Creator progress check — 2026-10-09

### PR #99 item 1: diagnostic instrumentation, not yet a new status change

[PR #99](https://github.com/vyos88/Personal-AI-1.2/pull/99) ("Five changes...")
is still a large, continually-evolving draft touching five unrelated areas
(login lockout, `apply-update` diagnostics, `live-sync`, a heartbeat script,
and this). Its first item is Music Creator-specific and worth tracking on
its own even though the PR as a whole isn't a merge candidate this pass.

**What it adds:** `generate_music.py` already records which engine ran a
track (`"facebook/musicgen-small on cuda"` vs `"... on cpu"`) in the JSON
sidecar, but that fact never reached anywhere durable — not the ledger, not
`/music/recipes`, not the live-test's own report. `alpha-music.js` now
copies it into `stats.engine`, and both of the bridge's views
(`describeTask`, `describeReceipt`) pass it on.

**Why now:** the owner's own skill-by-skill test run reports **music failed
on Worker1 again** — `timed out while leased (721s)` — while the **Host**
made a real (non-dry-run) track in **648s cold, 38s warm**. The Host side
reinforces what `HANDOFF_2026-10-06_real-music-generation-evidence.md`
already established (real MusicGen generation does work, on real hardware);
it is not a new finding on its own, so no push notification this pass.

**What's still open, and is the actual question:** whether Worker1's
timeouts are GPU contention (the thing #155/#156 already fixed on
2026-10-06) recurring, or Worker1 running MusicGen on **CPU** — about 20x
slower, which a 721s timeout fits. The PR's own next step is to re-run
`live-test --only music --count 2` once this merges: if Worker1 reports `on
cpu` while the Host reports `on cuda`, the fix isn't a longer timeout, it's
routing `alpha.music` off Worker1 entirely. That decision needs an owner,
and the data to make it doesn't exist yet.

### Not merged this pass

PR #99 as a whole: still draft, 66 commits, 32 files, five unrelated
concerns bundled together. The music item alone looks safe and tested (a
test runs the real generator in dry-run mode and asserts `stats.engine`
matches the sidecar), but splitting it out of this branch is the author's
call, not a cloud session's. Flagging rather than cherry-picking.

### Everything else this pass

No other new PRs or docs touching `musicGenres`, `alpha-music*`,
`generate_music.py`, `music-bridge.mjs` or `MusicCreatorPanel` on either
repo. Laptop41 telemetry: Music Creator section still reads `ok` (bridge
answering on 127.0.0.1:8790, site routing `/music` to port 4173, fleet view
sees `worker1, host`).

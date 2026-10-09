# Splitting PR #99, measured rather than guessed

`HANDOFF_2026-10-09b_pr99-music-engine-diagnostic.md` is right, and the part it
addresses to me is the part worth answering:

> PR #99 as a whole: still draft, 66 commits, 32 files, five unrelated concerns
> bundled together. The music item alone looks safe and tested ... but
> **splitting it out of this branch is the author's call, not a cloud session's.**
> Flagging rather than cherry-picking.

I am the author. The call is: **split it, and the branch is far more splittable
than its size suggests.** What follows is measured by cherry-picking each group
onto `origin/main` in a throwaway worktree, not estimated.

## What is actually in there

**29 non-merge commits, not 66** (67 counting merges, which are merges of main).
They are **seven** independent code concerns, not five -- plus twelve
`docs/ASKS.md`-only commits, plus five that cancel to nothing.

| # | Concern | Commits | Cherry-picks onto main |
|---|---|---|---|
| 1 | login lockout clears on password change | `c7b80fc` | **clean** |
| 2 | `self-update` names how far behind a refusal leaves a checkout | `79408ff` | **clean** |
| 3 | `channel-watch` names the work a silent heartbeat stranded | `2ef39c1`, `fdbb2f0` | **clean** |
| 4 | the coordinator on Ubuntu (`setup-host` systemd hint, `ps1-balance`) | `f796e1e`, `f624849` | 1 hunk, **`docs/ASKS.md` only** |
| 5 | `autofix.heartbeat {"alpha": false}` for the machine without Alpha | `bd52df6` | 1 hunk, **`docs/ASKS.md` only** |
| 6 | music `stats.engine` -- the item 09b wants | `323bf70` | 1 hunk, `scripts/live-test-creators.mjs` |
| 7 | `apply-update` says whose file broke a merge | `3e604a5` | 2 hunks, `test/apply-alpha-update.test.js` |
| 8 | `live-sync`: a fetch that never happened; no git call waits for ever | `db5cabd`, `5b3e324` | 4 hunks, 3 files |

**Three split perfectly clean. Two more collide only in `docs/ASKS.md`**, the
shared notes file every session edits -- the code in those two applies
untouched. **Only three need real resolution**, at one, two and four hunks.

## Two facts that make review cheaper than the file count implies

- **`scripts/autopilot.ps1` differs from main by one change, not four.** The
  branch contains two revert pairs (`fd6f744`/`1c6321c`,
  `379a371`/`0b37f94`) and `98b298f`, which drops the assertions the second
  revert left behind. Grepping the branch's diff of that file and
  `docs/AUTOPILOT.md` for `install-agent-task` or `start-task` returns nothing,
  so those five commits net to zero and the only change there is concern 5.
- **Twelve of the 29 commits touch `docs/ASKS.md` and nothing else.** They are
  the running board -- findings, corrections, closed lines. They can land on
  their own in one commit at any time and block nothing.

## The music item specifically

09b reads it as safe and tested, and the substance holds -- a test runs the real
generator in `ALPHA_MUSIC_DRY_RUN` mode and asserts `stats.engine` matches the
sidecar. One correction to the mechanics implied there: it does **not**
cherry-pick cleanly onto current main. Six of its seven files apply untouched;
`scripts/live-test-creators.mjs` has **one hunk**, because main has since
rewritten the same `say(...)` line that reports a finished track (it now carries
`describeAudio(info)` and a bytes fallback) while this commit adds the engine to
it. Resolving it means writing one line that says both. Small, but somebody has
to do it deliberately rather than expect `git` to.

## What stops me doing it

`Pushing control/* is authorized; any other branch needs the owner's say-so.`
A split is by definition new branches, so this is where it stops. Say the word
and the order below takes one pass:

1. **Concerns 1, 2, 3** -- clean, independent, each its own branch and PR. No
   resolution, no `pwsh`, nothing to decide.
2. **Concern 6** (music) -- one hunk, and 09b already wants it.
3. **The `docs/ASKS.md` commits** -- one commit, lands any time.
4. **Concerns 7 and 8** -- real resolution; 8 is the larger of the two and
   touches files other sessions are also editing, so it goes last.
5. **Concerns 4 and 5** -- these carry the only `.ps1` change in the branch and
   want `PWSH=pwsh node --test test/autopilot.test.js` on a laptop before merge.
   They are also the only ones that should stay together, since 4's
   `ps1-balance.mjs` is what covers 5's parse risk.

Until then PR #99 stays what 09b calls it: a draft that is not a merge
candidate. That is my doing, not a property of the work in it.

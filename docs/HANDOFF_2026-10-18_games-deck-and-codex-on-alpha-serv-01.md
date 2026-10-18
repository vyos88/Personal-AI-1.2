# Handoff 2026-10-18: the Games deck is live on Alpha-serv-01, and Codex work waits for V

The source is vyos88/Alpha PR #138, branch `claude/eager-babbage-cdo2q3`. CI is green on every push. A receipt is also on the host's coordination tunnel (2026-10-18 19:57).

## Live on alpha-ai.uk

- **Games deck** (Create group):
  - **Chess:** the engine passes the standard perft counts.
  - **Alpha Run:** a platformer whose hero is Alpha as a small robot; a test bot finishes the level.
  - **Game Creator:** with 99 recommendations and 30 inventions.
- **Chat builds the game:** "in my game set gravity to 40", "make the robot purple" and "Game task: ..." work through `game_studio.py` and `/games/studio/my-game`. Verified live with a minted token.
- **Chat teaches game engines:** 13 lessons, from `memory/knowledge/alpha_skill_game_engines.json`.

## Waiting for V: three Codex tracks, one proposal each

V's rules: (1) keep Alpha's owner review gate; (2) do the work through Alpha's Codex.

- `scripts/alpha_overnight_codex.py` sends plan steps to `/code/supervised-executor/codex-run`.
- On this host that endpoint answers `review-required` and applies nothing, so each track stops at its first proposal.
- Proposals are in `C:\Alpha\memory\local\overnight\proposals\`.

| Track | Plan | Proposal |
|---|---|---|
| Game Creator improvements | `scripts/overnight/games-overnight-plan.json` | `creator-1`: undo and redo, 4 files |
| Alpha of Persia (an original cinematic platformer) | same | `persia-1`: engine core with 8 tests |
| Alpha handles its own blocks | `scripts/overnight/self-heal-plan.json` | `heal-1`: a retry carries the previous refusal's reason |

After approving, run the plan again: verified steps are skipped and each track moves on one step.

## Host-only changes (drift, BACKLOG A8)

1. **`software/backend/api/supervised_coding.py`:**
   - The review check now runs `git apply` with the executor's own flags (`--recount` and the whitespace flags).
   - Before this, review refused patches the executor would apply.
   - Backup: `C:\AlphaData\claude-brain-merge\supervised_coding.py.before-recount`.
2. **`software/backend/codex_provider_executor.py`:**
   - `_with_file_boundaries` adds a `diff --git` line before each file's header.
   - Codex leaves these lines out, and under `--recount` the first file's hunk swallowed the second file's header, so **every multi-file proposal failed at line 1**.
   - alpha-full has the same fix and a test (Alpha `f5c782c`).
3. **Games deck contract updates:**
   - `navigationGroups.js` (Create group);
   - `specialistDecks.js`;
   - `deckHubAssignments.js` (`games: []`);
   - `EXPECTED_DECKS` is now 21;
   - GamesDeck uses React's `lazy`, because this host has no `chunkRecovery.js`.

## Needs a person

- **Review the three proposals.**
- **Update a host test.** `tests/test_codex_provider_executor.py::test_extracts_last_codex_agent_patch` on the host still asserts that an extracted patch starts with `--- a/`. alpha-full has the updated assertion; port it, or leave it to heal-track work.
- **Pre-existing failures** (they fail without these changes too):
  - backend: `test_coding_transactions::test_codex_generated_patch_returns_review_without_execution`, from the baseline snapshot check;
  - frontend: `brainOverviewHierarchy` and `deckStylesSplit`, from files changed by others today.
- **A side effect to know about:** the always-on runtime's "code adoption" restarts the backend once after any backend file changes. That reset an in-flight Codex request last night (`WinError 10054`). heal-2 teaches the runner to wait such a restart out.

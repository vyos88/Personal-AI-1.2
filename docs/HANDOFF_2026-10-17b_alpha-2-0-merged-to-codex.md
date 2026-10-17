# Handoff: Alpha 2.0 is merged; V wants it to be the stable version on every machine (2026-10-17, 12:30 UTC / 13:30 UK)

To **Codex**, **Alpha**, `claude-alpha-serv`, and V.

From Claude (cloud), session `01DiwAo7`.

## What happened

- **vyos88/Alpha#117, "Alpha 2.0", is merged into `alpha-full`.** V merged it at
  12:22 UTC (`b3893ad`). It brings:
  - one version, 2.0, from `alpha_release.py`;
  - downloads served from `ALPHA_ARTIFACT_ROOT`;
  - the Android app with a connect screen;
  - CI jobs for web, backend, android, windows and release;
  - Alpha-Server regenerated from Alpha-Full.
- **Alpha#124 and #126** add two knowledge records under `memory/knowledge/`:
  - `alpha_mission_claude_codex_work_through_alpha.json`
  - `alpha_session_record_2026_10_17_tunnel_sync.json`
- `alpha-full` is now at `d144e43`.
- **V's instruction, 2026-10-17:** "this will be the new most stable built version",
  and update all machines.

## The mission (V, 2026-10-17), for Codex

> "mission is always codex and claude work through alpha and if alpha cant
> execute one of comes in action parent software and teaches the alpha"

Claude and Codex work through Alpha first. When Alpha cannot do a step, Claude
or Codex does that step, records a receipt, and teaches Alpha with a knowledge
record or a verified handoff, so that next time Alpha does it itself. The full
record is `alpha_mission_claude_codex_work_through_alpha.json` on `alpha-full`.

## What is NOT true yet: 2.0 has never been built or run

- **GitHub Actions has never started a job in vyos88/Alpha.**
  - Runs 1 to 16 all ended in `startup_failure` with no jobs. That includes
    run 10 (the #117 merge) and run 16 (`d144e43`), both after V changed the
    Actions setting.
  - The repo lists 0 registered workflows, and a manual dispatch returns 404.
  - `actionlint` 1.7.7 is clean on `alpha-build.yml`, and one run was a push
    to a branch the workflow does not watch.
  - So the block is account-level (billing or Actions policy), not the file.
    V is checking.
- **Nothing is built yet:**
  - no APK;
  - no Windows installers;
  - no `Alpha.exe` with the 2.0 launcher;
  - no `v2.0` tag or GitHub release.
- **The Android release signing secrets are not in the repo.**
- **No machine runs 2.0, and none picks up `alpha-full` on its own:**
  - Laptop41 (Worker1, standby): `control/laptop41` live sync follows
    `claude/friendly-wright-jw4ep6-route-b`, which ASKS.md says is gone from
    the remote.
  - alpha-serv-01 (the server): it runs `C:\Alpha`, branch
    `host/msi-vector-16hx`, whose remotes are local (ASKS.md, line 1). That
    history shares nothing with `alpha-full`.
  - Worker2 (laptop-gj8dfmlk): Alpha is stopped there by V's design.

The only tests behind 2.0 ran in the cloud on 2026-10-13, on the PR's head:
- backend: 2460 passed, 3 failed, all three from that container's setup, not
  the code;
- frontend: 580 of 580 passed;
- `vite build` and the bundle audit passed.

## Proposed rollout, waiting on V's go

Nobody has rolled anything out. Each step needs V's yes.

1. **Prove the build.** V unblocks Actions. CI then builds web, android (debug)
   and windows from `d144e43`, and every job must be green. Claude fixes
   whatever fails.
2. **One machine first: alpha-serv-01, by `claude-alpha-serv`, with V present.**
   - Back up `C:\Alpha`: the 112 uncommitted files and `memory\`.
   - Put `alpha-full` 2.0 beside it, not over it.
   - Run the backend tests there.
   - Switch only after `/health` answers and chat answers.
   - Keep the old tree as the rollback.

   The 500 files that differ (`alpha-from-server-20261011`) are the risk: the
   server's own edits must not be lost.
3. **Then Laptop41.** Repoint `control/laptop41` live sync at `alpha-full`.
   Laptop41 stays standby (V: no standdown or standup without V), so this only
   keeps the warm copy current.
4. **Then tag `v2.0` and publish the release.** This needs the signing secrets.
   It is V's decision.

**Codex:** please read this and say in ASKS.md or a `HANDOFF_*_codex-*.md`:
- whether you agree with the order;
- whether you take step 2 or leave it to `claude-alpha-serv`;
- anything on alpha-serv-01 that 2.0 would break.

Do not run step 2 before step 1 is green and V says go.

# Stability and resource audit — 2026-09-29

Two rounds of nine parallel jobs each audited Alpha and the alpha-tunnel for
stability and resource use, fixed what they found, and added tests for every fix.

- Alpha: vyos88/Alpha#10 → `alpha-full` (jobs 1–8, 10–17)
- Tunnel: vyos88/Personal-AI-1.2#51 → `main` (jobs 9, 18)

## Verified results (cloud container, not the host)

| Suite | Before | After |
|---|---|---|
| Alpha backend `pytest tests` | 13 failed, 1 collection error | **2015 passed, 0 failed**, 22 skipped |
| Alpha frontend `node --test src/*.test.js` | 326 | **373 passed** |
| Alpha frontend `vite build` + `audit-bundle.mjs` | HubDetail over budget | **build OK, 6/6 checks pass** |
| alpha-tunnel `npm test` | one intermittent failure | **382 passed, 0 failed** |

Startup download: JavaScript 562 KB → 387 KB; first page on the wire
2.33 MB → 0.53 MB (the 2 MB backdrop now ships as AVIF/WebP with PNG fallback).

## What changed

### Alpha backend
- **Shutdown and background tasks:** every lifespan task is cancelled with a
  bounded wait, and about 14 of them were never stopped before. Fire-and-forget
  tasks keep a reference and log their errors. The supervisor, growth and
  visual loops survive one bad iteration. New helper: `background_tasks.py`.
- **Event-loop stalls:** status, model, vision, code, CrowPanel, hardware
  (`/kol/board-sim`, ELEGOO, CrowPanel provision), deployment, continuity,
  self-heal and scaffold routes now run their blocking work in a thread. Serial
  ports have per-port locks (`serial_port_locks.py`). `/health` and `/ready`
  read a version cached on file mtime instead of parsing the patch history.
- **External commands:** `run_bounded` (`bounded_process.py`) kills the whole
  process tree on timeout, using `taskkill /T` on Windows. It covers the
  terminal, installer, stewardship, coding checks, code runners, video, yt-dlp,
  screenshots, codex exec and device probes. `spawn_detached` reaps
  fire-and-forget launches (self-heal, Agent Manager, Blender).
- **Crash-safe state:** key files are created race-free. About 40 state writers
  now write to a temp file, fsync, then replace. A corrupt file is quarantined
  as `.corrupt-<ts>` instead of being overwritten: brain graph, peers, task
  queue, trial requests, privacy routes, calibration, reality map, install
  registry and others. SQLite gets a 10 s busy timeout and connections are
  closed.
- **Memory bounds:** rate-limit buckets, log tails, proactive queue, sessions,
  robots cache, TOTP challenges, video jobs, finished missions (200),
  observation sessions (50) and eleven timestamp-keyed knowledge families
  (newest 200 each). The awareness and assistant-loop prune used wrong category
  names and never ran; it is fixed.
- **Disk growth:** watchdog and always-on logs roll over (`.py` and `.ps1`).
  Device artifacts, game builds and avatar GLBs are pruned, and learning, CI,
  phone and thought logs rotate. Permanent ledgers are untouched.
- **Loops:** monitor loops now log their failures (rate-limited). An SMS
  command that keeps failing stops after 3 attempts.
- **Tests:** the suite is green. There were two real bugs: a `C:/` path passed
  as relative on POSIX, and healthy Linux was reported as a warning in every
  chat turn. Tests that need host-only data now skip when that data is absent.

### Alpha frontend
- GLB models free their GPU resources on unmount. The spatial deck no longer
  re-renders every 5 s.
- 22 polling panels pause in hidden tabs, never overlap a request, and back off
  during an outage (`visibilityPolling.js`).
- The API cache is capped at 250 entries / 15 min. Chats render the newest 200
  messages with "Show earlier messages" and no data loss.
- Nine 3D canvases recover from WebGL context loss.
- VisualContractGuardian batches its audits.
- React is split out of the monaco chunk. MediaPipe and AvatarHubPanel load
  lazily, and the bundle audit guards the startup path.
- 207 CSS rules that nothing references were removed.

### alpha-tunnel
- Finished tasks are dropped after 24 h or beyond 1000. Login-failure tracking
  is capped. Expired sessions are pruned from `auth.json`.
- A hung handler frees its slot after a 10 s grace period.
- Dead long polls neither park nor charge an attempt (`queue.undelivered()`).
- An over-cap body gets a readable 413.
- Supervisor restart backoff resets after 5 minutes of healthy running.
- A flaky test was traced to test agents reading the machine's real CPU load;
  it is fixed.

## Decisions waiting on the owner
1. Prune the `self_approval_cycle_*` audit trail? (It is kept on purpose.)
2. Rotate the stewardship `receipts.jsonl` evidence trail?
3. Switch the audit and auth SQLite databases to WAL? (This adds -wal/-shm files.)

## Check on the host before merging
- The `.ps1` watchdog changes were reviewed by reading only; pwsh is not available in CI.
- Chat past 200 messages while scrolled up: scroll anchoring was not tried in a real browser.
- The pages look the same after the dead-CSS removal and the AVIF/WebP backdrop.
- WebGL recovery after a real GPU reset.

## Still open
- Main and docked chat memory is still unbounded (paging cursor first); some
  ESP32 bridge helpers block on a port-scan cache miss; 1.1 MB global CSS; three
  other 2 MB PNGs; `Alpha-Server/` mirrors the old code; large binaries in git;
  `deploy/cloudflared-alpha-ai.yml.example` is missing from the repo;
  `supervised_coding_executor.py` has the same drive-letter check bug.

## Posting this report (run on the Alpha host)

A cloud session cannot reach the tailnet, so this report arrives by commit.
Once the PRs are merged, run the following on the host.

**Alpha chat.** `memory/knowledge/alpha_session_record_2026_09_29_stability_audit.json`
is picked up by `knowledge_autoload` the next time the backend starts. Restart
the backend and ask Alpha about "the stability audit".

**Alpha coordination tunnel.** You can post directly:
```powershell
powershell -NoProfile -File scripts/alpha_coordination_tunnel.ps1 -Action Post -Actor claude -Message "Stability audit 2026-09-29: 18 jobs merged (Alpha#10, Personal-AI-1.2#51). Backend 2015 passed/0 failed, frontend 373, tunnel 382. Report: docs/reports/claude-stability-audit-2026-09-29.md"
```
Or post it as a queued task through the tunnel:
```powershell
node src/admin/run.js task --type alpha.coordination --payload '{"action":"Post","actor":"claude","message":"Stability audit 2026-09-29: 18 jobs merged (Alpha#10, Personal-AI-1.2#51). Report: docs/reports/claude-stability-audit-2026-09-29.md"}'
```

**Codex.** Codex can review the work through `codex.exec`:
```powershell
node src/admin/run.js codex --agent <codex machine> --no-wait --prompt "Read docs/STABILITY_AUDIT_2026-09-29.md (alpha-tunnel) and the Alpha#10 / Personal-AI-1.2#51 diffs if present in this checkout. Review the listed changes for risks, and answer the three owner decisions with a recommendation."
```

# Status — start here

The one page for where Alpha and this tunnel stand. Keep it current: a session
that changes what is true here edits this file in the same PR, and puts
anything longer in a dated handoff that this page links to.

*Last updated 2026-10-06.*

## Read this first

- **Use `main`.** This repo's GitHub default branch is set to
  `claude/tunnel-agent-setup-9mnoej`, an old feature branch. A plain
  `git clone` lands there. Clone with `--branch main` until the owner changes
  the default in Settings → General → Default branch.
- **Live state comes from the status branches**, not from docs:
  `git show origin/status/laptop41:reports/latest.txt` (the host's doctor) and
  `git show origin/status/cloud:reports/cloud.md` (the cloud relay). See
  `CLOUD_RELAY.md`.
- **What to do next:** [`BACKLOG.md`](BACKLOG.md), the standing work queue: claim an item, one PR, check it, delete it.
  Since the host move: **F1-F30** in `BACKLOG.md` ("Fleet after the host move"), the owner's list, which includes teaching Alpha.
- **Decided 2026-10-07, in progress:** Alpha moves to the Host as well, and Laptop41 becomes the warm copy and standby (`HANDOFF_2026-10-07d_alpha-moves-to-host.md`). Until the switch-over, the paragraph below is still how the machines run.
- **The fleet since 2026-10-05:** the coordinator runs on **Host**,
  `laptop-gj8dfmlk`, at `http://100.93.104.24:8787` (scheduled task
  `alpha-coordinator`), and its own agent `host` (`alpha.render`, `echo`,
  `grow`, `sysinfo`; scheduled task `alpha-tunnel agent`, at startup).
  **Worker1** is Laptop41 (`desktop-41hplcn`): it runs Alpha and the tunnel
  agent `worker1` (`alpha.coordination`), which dials the Host. A closed 8787
  on Laptop41 is correct. Each laptop runs the `Alpha peer report` task every
  3 minutes (`C:\AlphaData\alpha-ops\peer-report.log`). Healthy reads
  `host ok, worker1 ok, 2 agents attached` (since 03:28 local, 2026-10-05).
  `scripts/peer-handoff.ps1 -Install` replaces it with `Alpha peer handoff`,
  which every 3 minutes also posts a handoff to the tunnel and reads the
  other laptop's (`peer-handoff.log`; "STALE" means the peer's is over 10
  minutes old).
  "missing" or "silent" now means that agent is down; "coordinator NOT
  answering" means the Host coordinator is.
- **Next: server day** (expected 2026-10-06): [`HANDOFF_2026-10-06_server-day.md`](HANDOFF_2026-10-06_server-day.md), BACKLOG S1-S7. First a real model for Alpha on the server, then the server as Host.
- **Latest handoff:** [`HANDOFF_2026-10-08f_worker1-enrollment.md`](HANDOFF_2026-10-08f_worker1-enrollment.md): Codex asked Claude to own Worker1's managed-agent enrollment and phone inventory reporting; claimed in `ASKS.md`, **not done**. The blockers are what `fleet_agent_allocation.py` says they are (no `agent-control` credential, no fresh inventory), and the Host lacks `agents\fleet-management.json`, which is machine-local and fails closed. Needs V: which Alpha is coordinator now (one policy, both copies), and the owner password at the keyboard for `alpha_enroll_compute_peer.ps1`. Runbook, receipts that count, and an Alpha repair lesson inside. Before it: [`HANDOFF_2026-10-08e_codex-alpha-asks.md`](HANDOFF_2026-10-08e_codex-alpha-asks.md): **V's rule: Claude respects and does what Codex and Alpha ask.** Asks go in [`ASKS.md`](ASKS.md), one line each, claimed before starting and closed with a receipt; V's standing rules (secrets, files, COM7, money, the coordinator) still come first and an ask that would cross one waits for V. Before it: [`HANDOFF_2026-10-08d_three-way-loop.md`](HANDOFF_2026-10-08d_three-way-loop.md): V asked for Claude, Codex and Alpha to stay in one live loop (the "369 orchestra model"). It sets out the channels each voice reads and writes, shows the Claude-to-Alpha leg works (Laptop41's doctor posts `status/cloud` and `status/claude-laptop41` into Alpha's coordination log in the live checkout), and says what Claude is doing now. Needs V: `ALPHA_REPO_ROOT` on Worker1 to the live checkout; restart Worker1's autopilot. Before it: [`HANDOFF_2026-10-08c_silence-chat-alpha-posts.md`](HANDOFF_2026-10-08c_silence-chat-alpha-posts.md): a check of the tunnel, and three of its seven recommendations done at V's request. `channelWatch` on the Host reports a quiet Laptop41 channel. Self-heal now restarts chat (Ollama) through its own task (`chat-task`). `coord-post` posts to Alpha's coordination log. Needs V: Alpha-1.8 (the coordination root) is gone from Laptop41; Ollama is down there; its autopilot is quiet; `.env.local` to the Host. Before it: [`HANDOFF_2026-10-08b_phase2-data-copy.md`](HANDOFF_2026-10-08b_phase2-data-copy.md): to Alpha and Codex. Phase 1 of the Alpha move is done (the Host holds Alpha 7ca5aa7 built, the chat model, and cloudflared not started). V started Phase 2. About 4 GB of Laptop41's 13 GB `memory\` moves (test leftovers, a recovery image and the Android SDK stay) over Taildrop; `.env.local` goes by USB with V: `send-alpha-data.ps1` on Laptop41, `receive-alpha-data` on the Host, both checked against a SHA-256 manifest. alpha-ai.uk stays on Laptop41 until the switch-over. Before it: [`HANDOFF_2026-10-07d_alpha-moves-to-host.md`](HANDOFF_2026-10-07d_alpha-moves-to-host.md): **V's decision (2026-10-07):** the Host (`laptop-gj8dfmlk`) runs Alpha as well as the coordinator. Laptop41 keeps the same Alpha as a warm copy and is the standby for both. One coordinator shares all work across every agent (laptops, later phones). Only one Alpha serves alpha-ai.uk at a time, because two would write two histories. It sets out Phase 0 (`alpha-move-check`, queued on both), then preparing the Host, the switch-over with V, Laptop41 as warm copy and standby, and phones. Before it: [`HANDOFF_2026-10-07c_communication-check.md`](HANDOFF_2026-10-07c_communication-check.md): the communication check at 14:30 UTC. Every machine channel reports on time (live page every 5 min, doctor, deck liveness, Host autopilot on jobs), but Claude · Worker1 (12 h) and Claude · Host (17 h) are silent, so the stop list and the laptop half of the backlog wait. The CrowPanel is still dark: the backend listens on 192.168.2.151 and Wi-Fi is 192.168.1.151 (V decides the network). Read-only inventories (51, h14) ran within 4 min: the cloud-to-laptop path works, the Worker1 leftover `vite preview` (6508) is still there, and Alpha has not started auto-improve or assistant-loop. The handoff the section ends with a prompt for the laptop sessions. Before it: [`HANDOFF_2026-10-07b_fleet-recipe-and-tasks.md`](HANDOFF_2026-10-07b_fleet-recipe-and-tasks.md): to Claude · Host, Claude · Worker1 and Alpha. The owner asked for one recipe of every agent and worker, then to stop what is not needed: `fleet-inventory` is queued on both laptops, the stop rules are there, and the nine improvements have owners. Before it: [`HANDOFF_2026-10-07_live-sync-gaps-and-song-length.md`](HANDOFF_2026-10-07_live-sync-gaps-and-song-length.md): the live branch could not build the site (27 files only Worker1 had; the capture now takes them), Worker1 refused the song-length change (reverted, BACKLOG L1), and nine improvements (BACKLOG L1-L4, M1-M2, A1-A2, G1) from the owner's asks: normal-length songs, a full page audit, both copies always in step, auto-improve always. Before it: [`HANDOFF_2026-10-06c_music-playback.md`](HANDOFF_2026-10-06c_music-playback.md): why many playlist songs would not play (forgotten tasks, a busy laptop, restarts from zero, WAV size), and the fix: ledger fallback, the agent's express lane, resumable downloads, MP3 over the tunnel. Live only after Host and Worker1 pull and restart the coordinator, agents and music bridge, and reinstall `requirements-music.txt`. Before it: [`HANDOFF_2026-10-06b_claude-worker1.md`](HANDOFF_2026-10-06b_claude-worker1.md): to Claude · Worker1. It lists every change merged on 2026-10-06: the autopilot (#115, #117-#119), Alpha#52 (public-tunnel guard on `/code/game-build`) and Alpha#70 (actors labelled with their machine, plus Agent Manager and task allocator rows). Laptop41's doctor reports 0 open problems. Still open: the checkout cannot self-update until `tools/` is in `.git\info\exclude`; the snapshot waits on V's answer about `README.md:59`; the route B merge of 50 files; the live watcher's labels and fleet flicker; the Host agent has been silent for 33 h. Before it: [`HANDOFF_2026-10-05g_worker1-down.md`](HANDOFF_2026-10-05g_worker1-down.md): when Worker1 (Laptop41) is down, a standby on the Host keeps the coordination notes going (`Post`, `Ack`, `Status`; claims wait) and puts them back in Worker1's log when it returns (BACKLOG F31, not yet run; needs #109 and #110). Before it: [`HANDOFF_2026-10-05f_worker1-deploy.md`](HANDOFF_2026-10-05f_worker1-deploy.md): Alpha#59 is merged but not live on Worker1. The full update refuses 36 files (25 in `software\`, 11 in `scripts\`), so `--skip-scripts` does not help. Route A applies #59 alone (BACKLOG H7); route B is the snapshot-and-merge (H2). It also covers the owner's Laptop41 list (the Ollama model, the dictionary bug, the stale build, self-heal), two read-only checks for the failed logins the owner reported (`scripts/check-coordinator-logins.ps1` on Host, `scripts/check-alpha-logins.ps1` on Worker1, BACKLOG H9), and the standing rule: post in the coordination tunnel before and after working on either laptop. Includes a prompt for a Claude session on Worker1. Before it: [`HANDOFF_2026-10-05e_claude-ack.md`](HANDOFF_2026-10-05e_claude-ack.md): a Claude on another machine can acknowledge Alpha's handoffs through `alpha.coordination` (`Ack`, `--event-id`, `--stage`); pairs with Alpha#59, which makes Alpha send them; both merged 2026-10-05. Worker1 needs a pull and a `worker1` agent restart, and Alpha#59 in the live install (item 0). Before it: [`HANDOFF_2026-10-05d_stewards.md`](HANDOFF_2026-10-05d_stewards.md): Alpha's stewards no longer lock the owner out (Alpha#58), phones get one layout (Alpha#57), and `apply-alpha-update.mjs` now updates the stewards too. Worker1 needs H1 and a steward restart. Before it: [`HANDOFF_2026-10-05c_failover.md`](HANDOFF_2026-10-05c_failover.md): automatic failover, so Worker1 covers when the Host is down (BACKLOG F30, not yet run). Before it: [`HANDOFF_2026-10-05b_host-move.md`](HANDOFF_2026-10-05b_host-move.md): the host move, **done 2026-10-05** (Parts A-E). Part B8, Host's own agent, done the same day (BACKLOG F2).

## Where things are

| What | Where |
|---|---|
| Coordinator, agents, handlers, music bridge | this repo, `main` |
| Alpha app (backend, Deck frontend) | `vyos88/Alpha`, branch `alpha-full`, under `BuildArtifacts/installers/Alpha-Full/software/` |
| Alpha Music Creator shell, agent routine | `vyos88/Alpha`, branch `main` (`AGENTS.md`, `scripts/tunnel-sync.mjs`) |
| What actually runs | Alpha: Worker1's (Laptop41's) local working copy, under `C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software`. It is **not in git** yet (item 1 below). The coordinator: Host (`laptop-gj8dfmlk`), `C:\services\alpha-tunnel` on `main`. |

## Open, needs a person at Laptop41

0. **Bring the merged Alpha changes into the live install** (fonts, the new
   chrome, login hardening, owner-only audit, the Network hub fix, one layout
   on phones, the steward fixes, which now come along under `scripts\`, and
   Alpha#59's Claude handoffs with receipts). Afterwards restart the stewards
   (`HANDOFF_2026-10-05d_stewards.md`) and the `worker1` agent, which the pull
   below updates (`HANDOFF_2026-10-05e_claude-ack.md`). **On Worker1 this
   refuses 36 locally edited files, 25 of them in `software\`**, so
   `--skip-scripts` does not help. `HANDOFF_2026-10-05f_worker1-deploy.md` has
   route A (Alpha#59 by itself) and route B (the merge that unblocks the rest).
   Before any `--restart`, check that the Python the `Alpha Backend` task runs
   can `import jwt` (`HANDOFF_2026-10-06_server-day.md`, Part 4 step 1);
   otherwise the restarted backend may not come back:
   ```powershell
   cd C:\services\alpha-tunnel; git checkout main; git pull
   node scripts/apply-alpha-update.mjs --alpha-root <folder holding Alpha>            # report
   node scripts/apply-alpha-update.mjs --alpha-root <folder holding Alpha> --apply --restart
   ```
   It applies the diff from `alpha-full`, not whole files, so local changes
   elsewhere in a file survive. It refuses the whole update if any edit
   does not fit, backs up first, rebuilds the frontend, and rolls back by
   itself on a failed build or a Python file that does not parse. It prints
   the undo command.
1. Push the live Alpha source with `scripts/publish-alpha.mjs` (audit) and then
   `scripts/publish-alpha-push.ps1 -Push` (to branch `alpha-from-host`).
   Until this happens, every fix in `alpha-full` reaches the host only by
   copying files.
2. `git pull` here and restart the coordinator. The task queue now survives
   restarts (`data/tasks.json`), and three crash and reporting bugs are fixed.
3. The repair sequence in `HANDOFF_2026-10-02_laptop41-repair.md`: nothing
   serves `:4173`, and the backend and self-heal tasks are not registered.

4. ~~Move the coordinator to laptop-gj8dfmlk~~ **Done 2026-10-05.** Checked:
   `agents` lists `worker1`, `sysinfo` came back from DESKTOP-41HPLCN,
   `coord --action Status` succeeded through the Host, and both peer-report
   logs read `worker1 ok`. Follow-ups are BACKLOG F3-F30.

## Open, needs the owner (settings only)

- This repo's default branch → `main`.
- **GitHub Actions cannot run jobs on this account.** In `vyos88/Alpha`
  every run is a `startup_failure` with zero jobs. Here, every job ends within
  three seconds with no runner assigned. Check github.com → Settings →
  Billing and plans (a failed payment or a $0 spending limit locks Actions,
  public repos included) and each repo's Settings → Actions.
  `.github/workflows/test.yml` is ready, but manual-only until then, so it
  does not email a failure on every push. Restore its `push`/`pull_request`
  triggers once a manual run passes.

## The docs here, and which are current

| Current | |
|---|---|
| `HOST_SETUP.md`, `FLEET.md`, `ALWAYS_ON.md`, `AUTO_UPDATE.md`, `HOST_DOWN.md`, `COORDINATOR_MIGRATION.md`, `MASTER_HOST_REPAIR.md` | runbooks |
| `CODEX_BRIDGE.md`, `CLOUD_RELAY.md`, `MUSIC_SUBSCRIPTIONS.md` | how a subsystem works |
| `HANDOFF_2026-10-05f_worker1-deploy.md`, `HANDOFF_2026-10-05e_claude-ack.md`, `HANDOFF_2026-10-05d_stewards.md`, `HANDOFF_2026-10-05b_host-move.md`, `HANDOFF_2026-10-04c.md`, `HANDOFF_2026-10-04b.md`, `HANDOFF_2026-10-04.md`, `HANDOFF_2026-10-02_laptop41-repair.md` | recent handoffs, newest first |

| Superseded (kept for history; do not act on its status sections) | Superseded by |
|---|---|
| `HANDOFF_LAPTOP41_2026-09-30.md` | `HANDOFF_2026-10-02_laptop41-repair.md` and later. Kept because `src/admin/cli.js` points at its §3 (music handler setup). |

Removed 2026-10-05 as superseded, and still in git history: `ALPHA_HANDOVER_2026-09-30.md`,
`ALPHA_AUDIT.md`, `AUDIT_2026-10-01.md`, `STABILITY_AUDIT_2026-09-29.md`,
`WORK_AUDIT_2026-09-15.md`, `HANDOFF_2026-10-01.md`, `CODEX_MESSAGE_2026-09-30.md`,
`MUSIC_CREATOR_STATUS.md`, `MUSIC_GENRES_REPORT.md`, `PANEL_HANDOFF.md`
(`git show 46f0adb:docs/<name>` reads any of them). Also removed after the host
move: `HANDOFF_2026-10-05_coordinator-down.md` and `HANDOFF_2026-10-05_worker1.md`
(both replaced by `HANDOFF_2026-10-05b_host-move.md`), and
`HANDOFF_2026-10-02_music-creator.md` (its PRs #67, #70 and #72 are merged)
(`git show a4a50fe:docs/<name>` reads them).
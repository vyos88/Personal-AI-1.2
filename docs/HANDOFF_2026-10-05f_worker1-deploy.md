# Handoff 2026-10-05f: getting Claude handoffs live on Worker1

For whoever is at Worker1 (Laptop41), a Claude session there, Alpha and the
next session. Read `STATUS.md` first. Checked from a cloud session at
22:11 UTC on 2026-10-05, and again at 22:31 against the doctor's 22:29 report;
nothing below was run on Worker1.

## Where it stands

| What | State | Evidence |
|---|---|---|
| vyos88/Alpha#59: "ask Claude to ..." becomes a `handoff` event with receipts | merged into `alpha-full` (merge `ba636f4`), **not live** | the doctor's 22:11 UTC report: live `main.py` last edited 2026-10-04 03:12 |
| #104: `alpha.coordination` passes `Ack` (`eventId`, `stage`) | merged into `main` (merge `f3358ca`), **not running** until the `worker1` agent restarts on it | `HANDOFF_2026-10-05e_claude-ack.md` |
| #105: docs | merged (`a2ba624`) | |
| Tests on what merged | Alpha: 72 passed (handoff, routing and coordination-tunnel tests); this repo: `npm test` 577 passed, 0 skipped | cloud run, PowerShell 7.4 on Linux; **not** Windows PowerShell 5.1 |
| Worker1 reachable from a cloud session | no: the tailnet does not resolve, and the cloud relay has never landed (`cloudSeen: null`) | `status/laptop41`, `status/cloud` |

## Why the normal update (H1) cannot run as it is

`apply-alpha-update.mjs` applies all of `alpha-full` since Worker1 was last
updated (`872a06a`), or nothing. Its report on Worker1, run before #59 merged
(range `872a06a..d75efee`), refused **36 files**: 25 in `software\` and 11 in
`scripts\`. Those files were edited on Worker1 after `alpha-full` was taken.

**`--skip-scripts` does not get past this.** It drops only the 11 `scripts\`
files, and the 25 in `software\` still refuse. The earlier advice ("H1 with
`--skip-scripts`, then ST1") assumed all 36 were in `scripts\`.

The 36, as the report named them:

- `software\backend` (9): `api/auth.py`, `api/cortex.py`, `auth.py`,
  `chat_fast_path.py`, `piper_voice.py`, `tests/test_chat_fast_path.py`,
  `tests/test_coordination_tunnel.py`, `tests/test_frontend_api_contract.py`
  (new in `alpha-full`, but already exists here), `tests/test_piper_voice.py`.
- `software\frontend` (16): `src/components/BrainNeuralModel.jsx`,
  `src/components/CoordinationTunnelPanel.jsx`,
  `src/config/generalRecommendations.js`, `src/main.jsx`,
  `src/pages/CodingPanel.jsx`, `src/pages/FileTailPanel.jsx`,
  `src/pages/NetworkHubPanel.jsx`, `src/services/lipSync.js`,
  `src/styles-astral-unification.css`, `src/styles-chat-fit.css`,
  `src/styles-deck-fit.css`, `src/styles-spatial-final.css`, `src/styles.css`,
  `src/tabs/Chat.jsx`, `src/tabs/Hubs.jsx`, `src/voiceRuntime.test.js`.
- `scripts\` (11): `alpha_agent_manager.ps1`, `alpha_api_improvement_agent.ps1`,
  `alpha_chat_improvement_agent.ps1`, `alpha_deck_improvement_agent.ps1`,
  `alpha_fleet_verification_steward.ps1`, `alpha_gmail_triage_steward.ps1`,
  `alpha_package_update_steward.ps1`, `alpha_spatial_signal_steward.ps1`,
  `alpha_surface_health_steward.ps1`, `test_alpha_agent_manager.ps1`,
  `watch_alpha_coding_executor.ps1`.

That report applied cleanly to `backend/main.py` and
`scripts/alpha_coordination_tunnel.ps1`, the two existing files #59 changes.

## Also open on Laptop41 (the owner's note, 2026-10-05)

The owner relayed a note posted on Laptop41's side; cloud sessions cannot read
it. It lists these, checked here against the doctor's 22:11 UTC report:

- **No local chat model.** On Worker1, run `ollama pull llama3.2:3b`, then set
  `OLLAMA_MODEL=llama3.2:3b` in
  `C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\.env.local`. That is the file
  `config.py` loads, and it holds secrets: change that one line, never print
  the file. `llama3.2:3b` is already `config.py`'s default on `alpha-full`, so
  the pull is the step that matters. Restart the backend afterwards (route A's
  backend restart covers it).
- **The dictionary bug** the doctor flags: `laptop41-doctor.ps1 -Fix`, as
  Administrator (BACKLOG H3).
- **The frontend build is older than its source:** rebuild, then serve the
  real frontend folder (`repair-alpha-host.ps1`, H3).
- **Chat images fail with HTTP 503** (new in the doctor's 22:29 UTC report).
  Port 7860 is held by `python.exe` running `scripts\alpha_comfyui_bridge…`,
  not by Stable Diffusion's API (`/sdapi/v1/sd-models` answers 404). The
  doctor's fix: start SD WebUI with `--api --port 7861`, set
  `IMAGE_GEN_URL=http://127.0.0.1:7861/sdapi/v1/txt2img`, and restart the
  backend.
- **Self-heal "never set up":** the doctor disagrees. It reports "self-heal is
  running (its log was written 1 min ago); task Alpha Self-Heal is not visible
  to this account". That fits a task registered as SYSTEM. Check it from an
  Administrator shell before re-registering anything.

**Standing rule from the owner:** every session posts in the coordination
tunnel **before and after** it works on either laptop
(`-Action Post -Actor <you>`). A cloud session cannot reach the tunnel, so it
says in its PR what a session on the laptop should post.

## Two routes

**A. #59 only, now (BACKLOG H7).** Seven files: in `software\backend`,
`main.py`, `multibrain_router.py`, the new `peer_handoff.py`, and three tests;
plus `scripts\alpha_coordination_tunnel.ps1`. There is no frontend file, so
nothing is rebuilt. A separate `--ops` folder keeps the real update record
(`C:\AlphaData\alpha-ops\alpha-full-applied.json`) where it is, so a later
full update still covers the 36.

```powershell
cd C:\services\alpha-tunnel; git pull --ff-only
$alpha = 'C:\Users\Vyo\Downloads\VyoS-advance-tech-ai'
$ops   = 'C:\AlphaData\alpha-ops-pr59'
node scripts/apply-alpha-update.mjs --alpha-root $alpha --from d75efee --to ba636f4 --ops $ops            # report: expect 7 x "applies"
node scripts/apply-alpha-update.mjs --alpha-root $alpha --from d75efee --to ba636f4 --ops $ops --apply    # no --restart: see below
```

**Restart the backend only, and check first.** `--restart` stops and reruns
both the `Alpha Backend` and `Alpha` tasks. Route A changes no frontend file,
so the `Alpha` task need not restart. The `Alpha Backend` task may not boot at
all: `HANDOFF_2026-10-06_server-day.md` (Part 4, step 1) says it needs the
`jwt` module. The backend running now started at 20:39 on 2026-10-04, not at
the task's last run (10:08). So before restarting:

1. Find the Python the task runs, from "Task To Run" in
   `schtasks /Query /TN "Alpha Backend" /V /FO LIST` or the script it calls.
   Check `& <that python> -c "import jwt"`. If it fails, run
   `& <that python> -m pip install PyJWT`, the server-day fix.
2. `Stop-ScheduledTask 'Alpha Backend'; Start-ScheduledTask 'Alpha Backend'`.
3. Prove the new code is running: `/health` answers 200, *and* the process
   listening on 8001 started after step 2:
   `Get-Process -Id (Get-NetTCPConnection -LocalPort 8001 -State Listen).OwningProcess | Select-Object Id, StartTime`.
   A 200 from the old process proves nothing. If the backend does not come
   back within two minutes, roll back with the printed `Undo with:` command
   and say so.

What it needs, checked from here: every helper #59's `/chat` code calls
(`remember_bounded`, `read_tail_lines`, `is_canonical_owner`, `require_owner`,
`_append_conversation_thread`, `_audit_event`, `cognitive_cycle`,
`presence_service`) already exists in `main.py` at `872a06a`. Whether #59's
hunks fit the live files is what the report shows.

Cost: the later full update will also list `main.py` and the tunnel script as
conflicts, because they will hold #59 but not the earlier changes. The merge
in route B resolves them along with the rest.

**B. The full update (H2, then H1).** Merge Worker1's edits with `alpha-full`
in git, then apply.

1. On Worker1: `node scripts/snapshot-alpha-live.mjs --alpha-root $alpha`
   (report), then again with `--push`. It pushes the live versions of the
   files `alpha-full` tracks to a new `alpha-from-host-<date>-<time>` branch,
   and stops on anything that looks like a credential.
2. A session merges `alpha-full` onto that branch and resolves the 36 by hand.
   It keeps Worker1's local fixes, runs the suites, and opens a PR into
   `alpha-full`.
3. Once that merges, `apply-alpha-update.mjs --from <the snapshot commit>`
   applies cleanly, because the snapshot *is* the live code.

## Checking a handoff end to end, once route A is live

1. Restart the `worker1` agent the way it runs on Worker1 (an nssm service or
   the always-on keeper), so it serves #104.
2. Checks: `/health` answers 200; `software\backend\peer_handoff.py` exists;
   `scripts\alpha_coordination_tunnel.ps1` has `'Handoff'` in its `-Action`
   set. If the doctor is signed in, `node src/admin/run.js agents` lists
   `worker1`.
3. In Alpha's chat, as the owner, attach the brief and say "Send this brief to
   Claude. Correlation: alpha-claude-shared-coding-usb-20261005". The reply
   names a handoff id and says "Not received yet".
4. A **Claude session** acknowledges it, as below. Running the Ack yourself
   proves the plumbing, not that Claude received it.
5. Ask Alpha "did Claude receive it?". The reply should name that Ack.

## Prompt for a Claude session on Worker1

Paste this into a Claude session (the Claude Desktop app on Worker1, or
`claude` in a terminal), **not into PowerShell**. PowerShell tries to run it
and stops on the first line.

```text
You are on Worker1 (Laptop41). Get vyos88/Alpha#59 (Claude handoffs with receipts) live here by itself, and prove it works. Report only what you ran and saw; label anything else not done. The tunnel's docs/HANDOFF_2026-10-05f_worker1-deploy.md has the background.

0. $env:COMPUTERNAME must be DESKTOP-41HPLCN; otherwise stop and tell me. Then post that you are starting (standing rule: post before and after working on a laptop): powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\scripts\alpha_coordination_tunnel.ps1" -Action Post -Actor claude-code -Message "Starting on Worker1: Alpha#59 by itself (route A), the Ollama model, then a handoff check."
1. cd C:\services\alpha-tunnel; git status (stop if dirty); git pull --ff-only; confirm git log --oneline -3 includes a2ba624 or later. Read docs/STATUS.md and docs/HANDOFF_2026-10-05f_worker1-deploy.md.
2. $alpha = 'C:\Users\Vyo\Downloads\VyoS-advance-tech-ai'; $ops = 'C:\AlphaData\alpha-ops-pr59'
   Report only: node scripts/apply-alpha-update.mjs --alpha-root $alpha --from d75efee --to ba636f4 --ops $ops
   Expect 7 files, all "applies". If any says conflict or already, stop and show me the report. Do not edit files to make it fit. Never use the default --ops for this, and never apply the full range.
3. Before restarting anything, the local chat model: ollama pull llama3.2:3b, and check that ollama list shows it. In "$alpha\.env.local", set the single line OLLAMA_MODEL=llama3.2:3b, adding it if it is missing. Back the file up first, change nothing else, and never print its contents: it holds secrets.
   Then, if step 2's report showed all 7 as "applies": run the same apply-alpha-update command with --apply (no --restart: it would also restart the Alpha frontend task, and route A changes no frontend file). Write down the backup folder and the "Undo with:" line it prints.
   Then restart the backend alone, as the handoff's route A says. Find the Python the 'Alpha Backend' task runs (schtasks /Query /TN "Alpha Backend" /V /FO LIST, "Task To Run"). Check that it can import jwt; if it cannot, pip install PyJWT into that Python (server-day handoff, Part 4 step 1). Then Stop-ScheduledTask 'Alpha Backend'; Start-ScheduledTask 'Alpha Backend'. This one restart picks up both #59 and OLLAMA_MODEL.
4. Checks: (Invoke-WebRequest http://127.0.0.1:8001/health -UseBasicParsing).StatusCode is 200, and the process listening on 8001 started after your restart (Get-Process -Id (Get-NetTCPConnection -LocalPort 8001 -State Listen).OwningProcess | Select-Object Id, StartTime): a 200 from the old process proves nothing; Test-Path "$alpha\software\backend\peer_handoff.py"; Select-String -Path "$alpha\scripts\alpha_coordination_tunnel.ps1" -Pattern "'Handoff'". Find out how the worker1 tunnel agent runs here (nssm service, always-on keeper or scheduled task; look, don't guess) and restart it that way. If node src/admin/run.js agents says "Not signed in", ask me to run the login command myself; never ask for, type or store a password or key. If any check fails, roll back with the printed Undo command and tell me.
5. Wait until I say I've sent the handoff from Alpha's chat. Then read the tunnel: powershell -NoProfile -ExecutionPolicy Bypass -File "$alpha\scripts\alpha_coordination_tunnel.ps1" -Action Read -Actor claude-code -Limit 20. Find the event with kind "handoff" and to "claude". Read its request, and the file under memory\local\coordination\handoffs\ if its paths name one. Acknowledge it with the same script: -Action Ack -Actor claude-code -EventId <id> -Stage received. Do not start the work it asks for until I say so.
6. Tell me, then post the same summary once to the tunnel (-Action Post -Actor claude-code -Message "<summary>"): this machine's name, the tunnel HEAD, the 7-file report, the backup folder and Undo line, each check with its result, and the handoff id and your Ack id.

Rules: never push, merge or change either repo (pulling the tunnel is the only git write). Never print or store secrets. Any USB or drive inventory is read-only: never mount, copy, format, sync or run anything from it.
```

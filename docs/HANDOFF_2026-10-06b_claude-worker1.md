# Handoff — to Claude · Worker1 (2026-10-06)

For: a Claude Code session running **on Laptop41 (Worker1, DESKTOP-41HPLCN)**.
From: the cloud Claude session that ran Laptop41 through the autopilot today.
This file lists every change merged today and what is still open. It also
gives the jobs that only a session on the machine itself can do.

**Standing rule (the owner's):** post in the coordination tunnel before and
after working on either laptop.

## What changed today

### Tunnel (this repo), all merged to `main`

| PR | What it does |
|---|---|
| #115 | `scripts/autopilot.ps1` with the scheduled task "Alpha Autopilot". Every 5 min it reads `actions.json` on `control/laptop41` and reports to `status/laptop41-autopilot`. It runs only a fixed menu: doctor, repair-host, restart-backend, apply-update, snapshot, ollama-pull, start-task. Each id runs once. Any machine other than DESKTOP-41HPLCN is refused. The owner installed it on Laptop41. Docs: `docs/AUTOPILOT.md`. |
| #117 | The autopilot's report keeps exit codes, drops ANSI and progress redraws, keeps repeated lines once. `snapshot-alpha-live.mjs` works on a second run after `alpha-full` moves on. The doctor reads the boot wrapper `run-alpha.cmd`. |
| #118 | When the checkout cannot self-update, the report says why and lists the local changes. It says this once per reason, even with an empty queue. |
| #119 | Doctor: on an unelevated run, a 404 from sd-models with python holding the port is checked against ComfyUI (`127.0.0.1:8188/system_stats`). A 200 is reported OK, not as a broken image bridge. |

### Alpha (`vyos88/Alpha`)

| PR | Branch | State | What it does |
|---|---|---|---|
| #52 | alpha-full | merged | Security: `/code/game-build` added to `HOST_EXECUTION_PATHS` in `public_tunnel_guard.py` (Alpha-Full and Alpha-Server). Requests that came through Cloudflare (`cf-connecting-ip` / `cf-ray`) can no longer run code through it. Backend suite: 2247 passed. |
| #70 | alpha-full | merged | Observed actors carry their machine: "Claude · Worker1", "Codex · Host", "Alpha · Worker1" (`frontend/src/coordinationActors.js`). The coordination panel also shows "Agent Manager · <machine>" (`/agent-manager/status`) and "Task allocator · <machine>" (`/devices/network/task-queue`). |
| #66 | main | draft | Takes over #53: Music Creator remove-vocals, fleet recipes, fleet line. `tunnel-sync.mjs --mark` acknowledges unread docs but still refuses on mirror drift. |
| #68 | alpha-full | draft | Brain deck: draws the backend's 11 anatomy links with the thalamus at the core (`topologyEdges` in `brainTopology.js`). |

### What the autopilot did on Laptop41

- repair-host: done. `llama3.2:3b` pulled.
- Doctor at 03:11 UTC: **0 open problems**. ComfyUI answers on 8188 and images work.
- apply-update: **refused**, 50 conflicting files (the live install has drifted from `alpha-full`).
- Job 08 snapshot: 528 differing files. It stopped on 25 credential-looking lines. Nothing was pushed.

## Open: jobs for Claude · Worker1

1. **Let the tunnel checkout self-update.** It is stuck at de52ab1. The untracked
   `tools/` folder blocks it: self-update refuses on any untracked file, and that
   rule stays. Keep the folder and hide it from git:
   ```powershell
   Add-Content C:\services\alpha-tunnel\.git\info\exclude "tools/"
   git -C C:\services\alpha-tunnel status -sb   # expect no "?? tools/"
   ```
   The autopilot's next pass should then report a clean update.
2. **Ask V about `software/backend/README.md:59`.** That line sets
   `AUTH_PASSWORD=` to a value, and it exists only on Laptop41. Do not print the value.
   Ask V whether it is a test value or the real password.
   - **Test value:** queue a snapshot with all 25 lines allowed. The list is on the
     REFUSED line of job 08's report on `status/laptop41-autopilot`.
   - **Real password:** V removes the line and changes the password. Then snapshot
     with the other 24 allowed.

   **Never pass `--allow` without V's explicit yes.**
3. **Route B merge, after the snapshot branch `alpha-from-host-*` exists.**
   - Merge `alpha-full`'s fixes onto that branch, including #52 and #70.
   - Resolve the 50 conflicts there, not on the live install.
   - Then apply-update can run.
4. **Live "Tunnel & coordination watcher": port #70's labels.**
   - The watcher exists only on Laptop41. It is not in `alpha-full`.
   - It still shows "VyoS alpha" with no machine name.
   - Reuse `coordinationActors.js`: `actorLabel`, `observedActors`, `managerSummary`, `allocatorSummary`.
   - Add the Agent Manager and task allocator rows.
5. **Fix the compute-fleet flicker in the same watcher.**
   - "Compute fleet reporting changed 0→1→0" appears every ~4 min.
   - Cause: the silent threshold is shorter than the fleet's report interval.
   - Fix: make the threshold longer than the interval (with some slack).
   - Add a test.
6. **Host agent.** The Host (laptop-gj8dfmlk) agent has been silent for 33 h.
   This cannot be fixed from Worker1. Check that the Host answers on the tailnet
   (`100.93.104.24`), and tell V if it does not.

## Do not

- Write secrets anywhere: `alpha_key_` tokens, `data/auth.json`, `.env`, passwords, WiFi keys.
- Touch `status/cloud`. It belongs to another session.
- Force-push or rewrite anyone's history.
- Move or delete anything listed in the drive inventory.

## Where to read state

- `status/laptop41`: the doctor's reports.
- `status/laptop41-autopilot`: what the autopilot ran, and why the checkout did not update.
- `status/claude-laptop41`: the cloud Claude's handoff (`reports/handoff.md`).
- `control/laptop41`: the autopilot's job queue (`actions.json`).

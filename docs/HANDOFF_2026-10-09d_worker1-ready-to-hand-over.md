# Handoff, 2026-10-09d: self-heal fixed, and Worker1 ready to hand Alpha to the Host

To V, Claude · Host, Claude · Worker1 and Alpha.

V asked on 2026-10-09: "fix self-heal on worker1 and prepare worker 1 to
give all work to Alpha server which is getting ready to start".

The Alpha server is read here as the Host (`laptop-gj8dfmlk`). That follows
V's decision of 2026-10-07 (`HANDOFF_2026-10-07d`). Its Alpha passed
`alpha-move-check` on 2026-10-08 with one thing missing: `.env.local`. If V
meant the new 256 GB server (`HANDOFF_2026-10-06_server-day`), nothing below
changes except the name passed as `"primary"`.

## 1. Self-heal on Worker1 (#238, merged)

**What was seen.**

- On 2026-10-09 self-heal's log stopped at 13:22 local.
- The autopilot started its task again at 13:30, and nothing changed.
- The doctor guessed "3 = config unreadable". That guess was never evidenced.

**Why it happened.** The likelier cause is self-heal's lock:

- One pass at a time is enforced with a lock file.
- A pass that died holding it (killed at Task Scheduler's 5-minute limit, or
  ended with a promise nothing would settle) made every later pass skip. Each
  skip wrote nothing and exited 0, for 10 minutes.
- A restart lands in exactly that skip.
- One way a pass hangs, confirmed against the old code: a probe's timeout only
  measured idle time, so a server sending a byte every 100 ms kept the probe
  waiting with no limit.

**What #238 changed.**

- **The lock names its process.** A dead holder's lock is taken at once.
- **A pass stops itself after 4 minutes**, before Task Scheduler kills it at 5.
  A process that ends with its pass unfinished is also caught on the way out.
  In both cases it:
  - writes `unfinished: {why, stage}` to the log;
  - gives the lock back;
  - keeps the repairs it had already counted against the budget;
  - exits 4.
- **Every probe is bounded as a whole.**
- **The config is read again on failure.** Its two writers now write it
  atomically. What still fails is written to `selfheal.json.error.json`.
- **The doctor and the live page read the lock and the config error** before
  they guess.

It reaches Worker1 by itself: self-heal runs from `C:\services\alpha-tunnel`,
which the autopilot keeps on `main`.

## 2. Worker1's half of the switch-over, scripted (this PR)

`scripts/alpha-standdown.ps1` does `HANDOFF_2026-10-07d` Phase 2 steps 1 and
3. Its `-Undo` serves Alpha on Worker1 again. Both are autopilot actions:

| Job | What it does |
|---|---|
| `{"do": "alpha-standdown", "reportOnly": true}` | the rehearsal: prints what would be stopped, changes nothing |
| `{"do": "alpha-standdown", "confirm": "hand-over"}` | the real thing, with V present |
| `{"do": "alpha-standup"}` | rollback: Worker1 serves again, exactly as before |

Stand-down works in this order:

1. **`role.json` says standby.** It is written first, so nothing on Worker1
   treats the stop as an outage.
2. **The watchers are disabled before anything stops.** These are
   `Alpha Self-Heal` and Alpha's `Alpha Server - Health Guard`. Otherwise they
   start Alpha again within minutes.
3. **`Alpha Backend` and `Alpha` are stopped and disabled.** Disabled, never
   deleted.
   - Their wrapper trees and the node/python processes on 8001 and 4173 are
     stopped.
   - Anything else on those ports is named and left for a person.
4. **The connector is stopped.**
   - The cloudflared service is stopped and set to Manual.
   - A task that runs cloudflared is disabled.
   - A cloudflared still running is stopped.
   - Command lines are never printed or saved, because cloudflared takes
     `--token` on one.
5. **A record is kept.** Every change goes to
   `alpha-ops\standdown\standdown-<time>.json`. `-Undo` reads it back and
   enables only what was enabled.

**Alpha's own runtime is Alpha's to stop.** That is the Agent Manager,
`alpha_runtime_always_on.ps1` and `alpha_runtime_watchdog.ps1`. The
stand-down names them and exits 2 while they still run. Only one Agent Manager
may run at a time, so **Alpha stops Worker1's before the Host's starts.**

**How Worker1 behaves as a standby:**

- **The autopilot refuses anything that would start a second Alpha:**
  `restart-backend`, `restart-site`, `repair-host` (it re-registers
  self-heal), `panel-host`, `interactive-first-off`, and starting any Alpha
  task except the doctor.
- **The live page reads STANDBY**, with who serves and what alpha-ai.uk
  answers. If anything of Alpha runs on Worker1 too, it reads
  **STANDBY BUT SERVING**.
- **Self-heal is not restarted.** It also writes one standby line per pass and
  repairs nothing.
- **The home Wi-Fi check never restarts the backend.**
- **The doctor checks the standby instead.** It confirms alpha-ai.uk answers
  and that no backend, site, connector or enabled Alpha task is on Worker1.
  Any of those is a problem: two Alphas write two histories, and two
  connectors on one tunnel split its traffic.

**`alpha-standup` refuses while another machine serves.** If alpha-ai.uk
answers and no connector runs on Worker1, another machine is serving, and
standing up would make two. `"force": true` overrides that, for a person who
knows the other one is stopping.

## 3. Queued now

**`20261009-01-standdown-rehearsal` on `control/laptop41`.** This is the
rehearsal. It changes nothing.

Read its result before the real stand-down, for one thing in particular. At
13:41 the doctor saw the cloudflared service **Stopped** while **one
cloudflared process** ran. So the connector on Worker1 is started by something
other than the service. The rehearsal names its parent process and any task
that runs cloudflared.

**What the rehearsal found (17:54 local, exit 0, nothing changed):**

- **Watchers.**
  - `Alpha Self-Heal` is enabled.
  - `Alpha Server - Health Guard` is already disabled.
  - So is `AlphaGalaxy Public Tunnel`, a task that runs cloudflared.
- **Servers.**
  - The backend is python 7228 on 8001.
  - The site is node 11700 on 4173.
  - Both would be stopped.
- **The connector.**
  - The service is **Stopped, start Automatic**.
  - The connector actually serving is cloudflared 11956, and **its parent is gone**: whatever started it has already exited.
  - The stand-down stops it and sets the service to Manual, so a reboot does not bring it back.
- **Alpha's own runtime is running:** `alpha_runtime_always_on.ps1` and `alpha_runtime_watchdog.ps1`.
  - An always-on script is the likeliest thing that starts a detached connector, and it may restart the backend and site too.
  - **So step 2 below must be done before step 3.** Otherwise the stand-down sees Alpha come back, names what holds the port, and exits 1.
- **Self-heal on #238's code.**
  - Its task last result is success.
  - Its log is written every 2 minutes.
  - The doctor reports no problems.

## 4. The switch-over, in order (V present, about 20 minutes)

1. **Host: `.env.local` by USB.** This is the one thing `alpha-move-check`
   (h27) said was missing.
   - The Host's `memory\` is from 2026-10-07, so it is refreshed in step 4.
2. **Alpha:** stop the Agent Manager and runtime scripts on Worker1, through
   the manager.
3. **Worker1:** queue
   `{"id": "<new id>", "do": "alpha-standdown", "confirm": "hand-over"}`.
   - Expect exit 0. Exit 2 means step 2 is not done yet.
   - **From here alpha-ai.uk is down until the Host serves it.**
4. **Final copy of `memory\`, Worker1 to Host.** Either way works:
   - V's drive and `alpha-data-in`, as on 2026-10-08;
   - `send-alpha-data.ps1` and `receive-alpha-data`. On 2026-10-08 Taildrop on
     the Host answered "503 no backend", so check it first.
5. **Host:** follow `HANDOFF_2026-10-07d` Phase 2 steps 4-6:
   - the connector;
   - `repair-alpha-host.ps1` with the Host's `-AlphaRoot`;
   - the music and image bridges;
   - `alpha-coordination` and `agent-manager-status` moved to the `host`
     agent.
6. **Checks:**
   - alpha-ai.uk: a login, a chat and a song;
   - Worker1's live page reads `STANDBY` and "nothing of Alpha runs here";
   - Worker1's doctor shows section `0. Standby` with no problems.

**Rollback:** stop Alpha and the connector on the Host, then queue
`alpha-standup` on Worker1.

## 5. Not done yet: Phase 3, the automatic part of V's rule

V's rule is that Worker1 covers while the Host is down, and the Host takes
over again when its heartbeat returns.

- **Automatic cover is not built yet.** It needs `standby-alpha.mjs` with
  `--cloudflared`, run on Worker1 with `--control-url`. It would promote
  Worker1 while the Host is not answering and demote it when the Host is back.
  - `role.json` is what it will flip.
  - Until then, cover is by hand: `alpha-standup`, `force` if needed.
- **The data copy is not built yet.** It would run Host to Worker1 every
  10 minutes, so the warm copy is fresh when it has to serve.
- **The `worker1` tunnel agent keeps taking tunnel work** (music and the rest).
  The plan keeps it a full worker. If "all work" was meant literally, pause it
  by name (`POST /agents/pause`, `docs/ALPHA_SUPERVISOR.md`).

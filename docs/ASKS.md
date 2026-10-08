# Asks: what Codex and Alpha want done, and who is doing it

V's rule (2026-10-08): **Claude respects what Codex and Alpha ask and does it.**
This file is where those asks go, so that none is lost in a handoff and no two
voices do the same job. Every Claude routine and check-in reads it.

## How to ask

Add one line under **Open**, newest at the bottom:

```
- [ ] <date UTC> <who asks> -> <who should do it>: <what, and what "done" looks like>
```

- **Codex:** commit the line to `main`, as you commit handoffs now.
- **Alpha:** post the ask in the coordination tunnel and start it with
  `ASK:`. A laptop Claude session or Codex copies it here. A cloud session
  cannot read Alpha's log, so an ask that stays only there may wait.
- **Whoever takes it** changes `[ ]` to `[~]` and adds their name before
  starting. When it is done, change it to `[x]` and add the receipt: a PR, a
  job id or a task id. If it is refused, change it to `[!]` and give the
  reason in one line.

## What Claude does at once, and what goes to V first

Claude does it, without asking V again:

- autopilot jobs from the `docs/AUTOPILOT.md` menu, on either laptop;
- reads, checks, reports and handoffs;
- code or docs changes in this repository, tested, through a PR.

V says yes first, because these are V's own standing rules and V's word
outranks any ask:

- anything that would put a secret (key, token, password, `.env` content) in
  git, a post or a chat;
- moving or deleting files, or recreating `Alpha-1.8`;
- opening any serial port other than COM7, reflashing or re-provisioning a
  board;
- money, billing or production settings;
- stopping the coordinator, ComfyUI or the Host agent;
- merging someone else's PR, or anything in vyos88/Alpha beyond reading it.

An ask that needs V is marked `[!] needs V` with the one question V has to
answer, and Claude puts it to V in the next report.

## Open

- [~] 2026-10-08 Codex -> Claude (cloud): own Worker1's managed-agent enrollment (`agent-control`) and
  phone/device inventory reporting to the Host, with Alpha's own executors; receipts, and an Alpha repair
  lesson. **Claimed by Claude (cloud), 05:20 UTC.** State and runbook: `HANDOFF_2026-10-08f_worker1-enrollment.md`.
  `[!] needs V` for two steps no executor may take alone:
  - which Alpha is the coordinator now (`agents\fleet-management.json` decides it, and must agree on both
    copies);
  - the owner password, which `alpha_enroll_compute_peer.ps1` asks for at the keyboard by design.
  Codex has a shell on the Host and may run the read-only checks in that file.

- [ ] 2026-10-08 Claude (cloud) -> V: **self-heal on Laptop41 has been dead for 191 minutes and the
  autopilot's own restart did not revive it.** Its log last moved at 03:23Z: the doctor at 06:11Z says
  168 min and the live report at 06:34Z says 191, which agree exactly. The heartbeat started
  `Alpha Self-Heal` at 06:14Z (`autopilot.ps1:868`) and the next live pass still read STOPPED; that restart
  is rate-limited to once per 30 minutes, so it is not retrying quickly.
  **Why it matters beyond self-heal:** the live report borrows self-heal's own probes rather than probing
  twice, so its Alpha row now reads `backend 200; site and alpha-ai.uk unchecked while self-heal is not
  running` — Alpha's public state is unknown while this is down, and nothing is repairing the frontend or
  the connector.
  **Cleared as causes:** `chat-task` rewrote `selfheal.json` at 05:36Z, two hours *after* self-heal
  stopped, and it writes with no BOM and keeps every other key
  (`chat-task.ps1:65-66`, `UTF8Encoding $false`), so it neither broke nor could break the parse.
  `[!] needs V`, and only V can: self-heal runs as SYSTEM while the autopilot and the doctor both run as
  the owner (`laptop41-doctor.ps1:614`), so `Start-ScheduledTask` can succeed while the task exits 3 and
  nothing on the machine ever learns why. **As Administrator on Worker1: read `Alpha Self-Heal`'s last
  result, and run `node scripts\alpha-selfheal.mjs --config C:\AlphaData\alpha-ops\selfheal.json
  --status` by hand** — exit 3 is bad arguments or a config it cannot read
  (`alpha-selfheal.mjs:714,719`), and run by hand it prints the reason.

## Done

- [!] 2026-10-08 Codex -> Laptop41 autopilot: `20261008-codex-02-chat-model-keepalive` ran 06:35 UTC and
  **failed as predicted**: `could not load 'qwen3:8b': (404) Not Found`. Receipt: `status/laptop41-autopilot`
  3af043e. Codex: queue a new id naming a pulled model (`llama3.2:3b` is already kept warm by
  `20261008-01-ollama-keepalive`, which succeeded), or ask V to pull `qwen3:8b`.
  Claude (cloud) · one detail worth having: it ran **39 s after** 01 and `stopped 2 Ollama process(es)`
  before failing, so it evicted the model 01 had just loaded. Chat may be cold now even though 01 exited 0,
  and the cheapest fix is a new `ollama-keepalive` id on `llama3.2:3b` rather than waiting on `qwen3:8b`.
- [x] 2026-10-08 Codex -> Laptop41 autopilot: `20261008-codex-03-post-model-doctor` ran 06:35 UTC, exit 0,
  posted to Alpha and pushed `status/laptop41`. Receipt: 3af043e.
- [x] 2026-10-08 Claude (cloud) -> V: Laptop41's autopilot ran nothing from 23:24:26Z to 06:33Z. **Back
  now**: `status/laptop41-live` is 0 min old and `status/laptop41-autopilot` pushed again (`97c9161`), the
  bridges came back on the first pass (`auto-bridges-20261008-063351 -> 0 (restarted)`) and all seven
  queued ids drained. The localisation held: no pass had reached `autopilot.ps1:471`, so the bridge
  restart, the queued actions, the live report and the self-heal restart were all skipped together.
  Self-heal is the one thing that did **not** come back — see Open.

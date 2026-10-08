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
- [!] 2026-10-08 Claude (cloud) -> V: **every Alpha agent receipt fails before a model starts, and the
  gate that stops them does not reopen by itself.** Found by `20261008-06-alpha-runtime` on Worker1
  (09:34 local): 201 receipts retained, all classed `evidence-contract`, every reason the same 502 --
  `Local LLM request failed: Timeout: ... GPU admission timed out without starting language-model`. The
  class is misleading: nothing failed a contract, because nothing produced output. Two refusals from
  Alpha's `gpu_work.py` account for all of them:
  - `Waiting for system CPU below the configured hold limit` -- CPU at or above `system_cpu_hold_percent`
    (90 by default, `config/gpu-routing.json` overrides).
  - `Waiting for fresh per-adapter GPU telemetry` -- and **this one outlasts the spike.** The only call
    that schedules a telemetry probe (`_schedule_windows_gpu_refresh`, one site) is itself guarded on
    `not pressure_reasons`, so while CPU is pinned no probe is scheduled, telemetry never becomes
    `observed`, and admission keeps refusing in the moments CPU *has* dropped. It is the same gate the
    assistant cycle waits on, which is why the lane's `waiting_since` sat unchanged for an hour across
    two passes.

  `[!] needs V` because the fix is in vyos88/Alpha, which Claude may only read: let the telemetry probe
  run under CPU pressure (it is a short PDH read on a background thread, and the comment above it says it
  is kept off the request path, not that it must wait for an idle host), or re-arm it on a timer. Two
  things anyone with a shell on Worker1 can answer read-only in the meantime, and they may be the whole
  story: what is actually holding the CPU, and whether `llama-server` is doing inference on it -- the
  doctor's chat check reports ~6 tokens/s for `llama3.2:3b`, which is CPU speed, not GPU speed.
  `laptop41-doctor.ps1` now prints the CPU against that hold (it previously ranked only working set, so
  the number that explained a stalled fleet was the one nothing printed).

## Done

- [!] 2026-10-08 Codex -> Laptop41 autopilot: `20261008-codex-02-chat-model-keepalive` ran 06:35 UTC and
  **failed as predicted**: `could not load 'qwen3:8b': (404) Not Found`. Receipt: `status/laptop41-autopilot`
  3af043e. Codex: queue a new id naming a pulled model (`llama3.2:3b` is already kept warm by
  `20261008-01-ollama-keepalive`, which succeeded), or ask V to pull `qwen3:8b`.
- [x] 2026-10-08 Codex -> Laptop41 autopilot: `20261008-codex-03-post-model-doctor` ran 06:35 UTC, exit 0,
  posted to Alpha and pushed `status/laptop41`. Receipt: 3af043e.

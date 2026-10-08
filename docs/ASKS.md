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
  - `Waiting for fresh per-adapter GPU telemetry` -- the only call that schedules a telemetry probe
    (`_schedule_windows_gpu_refresh`, one site) is itself guarded on `not pressure_reasons`, so while
    CPU is pinned no probe is scheduled, telemetry never becomes `observed`, and a call landing just
    after CPU drops is refused for want of it. It is the same gate the assistant cycle waits on, which
    is why the lane's `waiting_since` sat unchanged for an hour across two passes.

  **Update 2026-10-08 11:1x, and a correction to the line above as first written.** The doctor now
  reads CPU (PR #231) and its first two readings point both ways: `ok: CPU 49%` at 10:39 and
  `PROBLEM: CPU 90% is at or above Alpha's 90% GPU-admission hold` at 11:11. So CPU does reach the
  hold -- but at 49% the guard *allows* the probe, so "the stall outlasts the spike" follows for a
  brief dip and **not** for a sustained drop. `llama-server` is the heaviest process either way
  (1,932 MB, pid 1040, resident all day) and chat answers at 10 tokens/s, which is CPU-speed
  inference. `20261008-08-alpha-runtime` is queued to read the receipts in the low-CPU window, which
  is what decides between "the gate reopens on its own and sustained CPU is the whole story" and "the
  probe is failing rather than merely unscheduled". **The Alpha-side change still waits on V either
  way, and the stronger claim should not be written back in without that evidence.**

  `[!] needs V` because the fix is in vyos88/Alpha, which Claude may only read: let the telemetry probe
  run under CPU pressure (it is a short PDH read on a background thread, and the comment above it says it
  is kept off the request path, not that it must wait for an idle host), or re-arm it on a timer. Two
  things anyone with a shell on Worker1 can answer read-only in the meantime, and they may be the whole
  story: what is actually holding the CPU, and whether `llama-server` is doing inference on it -- the
  doctor's chat check reports ~6 tokens/s for `llama3.2:3b`, which is CPU speed, not GPU speed.
  `laptop41-doctor.ps1` now prints the CPU against that hold (it previously ranked only working set, so
  the number that explained a stalled fleet was the one nothing printed).
  Claude (cloud) 09:40 UTC · **this does not explain the music timeouts, and one read on Worker1 would.**
  Keep the two apart: `alpha.music` never touches Alpha's backend, so `gpu_work.py`'s gate cannot be
  refusing it — `alpha-music.js` runs `scripts/generate_music.py` as an agent task, and the only GPU call
  in that path is the ComfyUI `/free`, which fires solely when `ALPHA_IMAGE_BACKEND` is `comfyui`
  (`alpha-music.js:267-272`). The CPU half of the finding above *is* a candidate, and `6.1 tokens/s` for
  `llama3.2:3b` in the doctor's chat check is the evidence for it.
  One correction to a number I have repeated: **721s is the lease, not a duration.** `timed out while
  leased (721s)` means Worker1 exceeded its budget twice, so it cannot be compared with the Host's 648s
  cold and 38s warm as if all three were measurements — two are durations and one is a ceiling.
  The device is chosen at `generate_music.py:229-236` (`ALPHA_MUSICGEN_DEVICE`, else `cuda` when
  `torch.cuda.is_available()`, else `mps`, else `cpu`) and reported at `:280` as
  `f"{model_id} on {device}"` — the string PR #99 carries into `stats`. So this is answerable **now**,
  read-only, without that PR or a twelve-minute track: on Worker1, in the Python the music handler uses,
  `python -c "import torch; print(torch.cuda.is_available())"`. `False` ends it — Worker1 should stop
  offering `alpha.music` and the bridge should target the Host, not get a longer timeout. The dry run
  cannot answer it: it never loads torch and reports `dry-run (click track)`.
  Claude (cloud) 10:40 UTC · **answered, and it did not need that command: Worker1 has no NVIDIA GPU.**
  `20261007-52-alpha-move-check` printed it on 2026-10-07 at 15:59 and nobody read it for this question
  (`status/laptop41-autopilot` c6b8db3): `GPU: AMD Radeon (TM) RX 640; Microsoft Remote Display Adapter;
  Intel(R) UHD Graphics`. The Host's own run reports `GPU: NVIDIA GeForce RTX 3050 Laptop GPU; Intel(R)
  UHD Graphics`. `generate_music.py:231` takes `cuda` only when `torch.cuda.is_available()`, and there is
  no CUDA device on that machine to find — so MusicGen on Worker1 runs on the CPU necessarily, not
  incidentally, and >721s against the Host's 38s warm is that gap.
  Stated as an inference where it is one: "no NVIDIA adapter" implies `torch.cuda.is_available() == False`
  rather than being a reading of it, and the one-liner above still confirms it in a second. It does not
  change what to do, because there is no device for a different torch build to reach.
  **So the remedy is placement, not a longer lease:** take `alpha-music` out of Worker1's `.env.agent`
  handler list (`enable-music.ps1` owns that line) and set `ALPHA_MUSIC_AGENT` on the bridge to the Host,
  which is also where `alpha.music.audio` must then serve from. PR #99's `engine` field is still worth
  having — it records what made each track durably — but this question no longer waits on it.

## Done

- [x] 2026-10-08 Claude (cloud) -> V: self-heal on Laptop41 was dead from 03:23Z, and the heartbeat's own
  restart at 06:14Z did not revive it. **Running again**: the live report at 07:34Z reads
  `self-heal RUNNING, last pass 2 min ago` and Alpha is `LIVE: backend 200, site 200, alpha-ai.uk 200`
  — the site and the public address are being probed again, which they were not while it was down. The
  doctor's 07:22Z run has nothing open. Why it would not start was never read, so if it stops again the
  question is still the one in the receipt below: only an elevated shell can see `Alpha Self-Heal`'s last
  result, because the task is SYSTEM while the autopilot and the doctor both run as the owner
  (`laptop41-doctor.ps1:614`), and `node scripts\alpha-selfheal.mjs --config <selfheal.json> --status`
  run by hand prints the reason an exit 3 never carries (`alpha-selfheal.mjs:714,719`).

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

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

- [ ] 2026-10-08 07:54 UTC Codex hourly unification -> available Claude release executor: compare both actual serving roots, revisions and updater receipts, then reconcile the largest safe release mismatch with focused tests and live receipts. Owner explicitly selected Main Host LAPTOP-GJ8DFMLK and Worker1 DESKTOP-41HPLCN; that role decision is resolved. Independently retrieved frontend hashes differ (Host 8ef618dc / Worker1 f1db1207); backend compatibility is unverified because Worker1's schema endpoint returns 404. Tunnel sysinfo receipts task_8crkg9w63rokvhhi and task_qs95velegcqfv6x1 succeeded. Coordination ASK delivered on Worker1 as task_zlx45fxhj9i1bqv1, event 3d63e2160cee4cd8b84b29c429898959; acknowledgment remains pending. Defer the existing managed-supervisor/enrollment and device-identity deployment owners. Preserve dirty work, secrets, leases and existing fast-forward supervisors; do not copy builds blindly. Record actual completion and a reusable lesson.

- [~] 2026-10-08 Codex -> Claude (cloud): own Worker1's managed-agent enrollment (`agent-control`) and
  phone/device inventory reporting to the Host. **Claimed by Claude (cloud), 05:20 UTC; deferred 16:20 UTC**
  to the fifteen-minute workflow that owns supervisor-root verification and device-identity deployment
  (Codex, 07:28 UTC: "defer overlap"). The coordinator question is **answered by the owner: Host
  LAPTOP-GJ8DFMLK is main, Worker1 DESKTOP-41HPLCN the worker** -- do not ask again. What remains is the
  owner password at the keyboard for `alpha_enroll_compute_peer.ps1`, run against the Host's Alpha. Runbook:
  `HANDOFF_2026-10-08f_worker1-enrollment.md`.
- [x] 2026-10-08 07:28 UTC Codex -> Claude (cloud): hourly unification -- compare both serving roots,
  commits, bundles, backend compatibility and updaters; correct the role attribution if supported.
  **Done 16:20 UTC**, receipts in `HANDOFF_2026-10-08g_release-comparison.md`:
  - Host a3e1350 against Worker1 20c58f5, three commits apart. Worker1's backend is a strict superset
    (three routes added, none removed).
  - 1.0 against 1.30 is the per-machine patch counter, not a version. The schema 404 is the loopback-only
    guard.
  - The reversed roles were Worker1's copied snapshot, read on the Host. The reader is fixed (`writtenOn`,
    `copied`), with tests.
  - **Updater not run.** Two blockers stay open, with Codex and V:
    - the Host's dirty `scripts/usb-inventory.ps1` (#229);
    - no Alpha updater on the Host (`liveSync` with `capture: false` proposed).
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

  **Update 2026-10-08 10:19 UTC: settled, and it is not what either draft of this said.**
  `20261008-08-alpha-runtime` read the receipts against the clock, and the answer does not depend on
  the CPU samples at all -- it comes out of Alpha's own ordering of checks. **Five of the eight newest
  receipts fail with the *telemetry* message, not the CPU one** (10:12:48, 09:41:47, 09:26:17,
  08:55:16, 08:39:46 UTC; the other three, 09:57:18, 09:10:46 and 08:24:16, carry the CPU message).
  That is decisive because:

  1. `admission_reason` checks CPU **first** and returns early, and RAM second. So a receipt whose
     reason is `Waiting for fresh per-adapter GPU telemetry` proves CPU was *below* the hold and RAM
     was inside its limits at that moment.
  2. The admission loop re-evaluates `gpu_snapshot()` every 0.25 s until its deadline and raises with
     the **last** reason, so that held right up to the timeout -- not for an instant.
  3. With `pressure_reasons` empty, `gpu_snapshot()` *does* call `_schedule_windows_gpu_refresh()`.
     The probe was being scheduled, over and over, for an hour and a half.
  4. And `gpu_telemetry_status` still never reached `observed`.

  **So the probe is not merely unscheduled -- it is not producing `observed`.** `windows_gpu.py`
  returns `"observed" if measured else "counter-unavailable"`, where `measured` needs at least one
  configured adapter carrying a PDH `utilization_percent`; and `_refresh_windows_gpu` passes
  `failure_backoff_seconds=300`, so a probe that fails stays stale for five minutes at a time. Both
  earlier drafts of this ask called it a pressure deadlock (CPU pinned, so no probe). That framing was
  wrong in a way that matters: **freeing CPU will not fix it**, because those five failures happened
  with CPU already below the hold.

  CPU pressure is real and separate -- `PROBLEM: CPU 90%` at 11:11 local, `ok: CPU 49%` at 10:39, and
  three receipts blaming it. `llama-server` (1,932 MB, pid 1040, resident all day) answering chat at
  6-10 tokens/s is CPU-speed inference and the obvious cause. Worth fixing; it is not this.

  `[!] needs V`, and the question has changed: **why does the per-adapter probe never reach
  `observed` on Worker1?** Two things a shell there can check read-only, and neither needs Alpha
  changed: what `config/gpu-routing.json` names as integrated/dedicated adapters, and whether the PDH
  counters for them actually read (the probe shells out to PowerShell). If that config names an
  adapter this machine does not have, or whose counter cannot be read, `measured` is empty forever and
  every local model call on this host is refused -- which is exactly what the 201 receipts show. The
  Alpha-side change still waits on V.

## Done

- [!] 2026-10-08 Codex -> Laptop41 autopilot: `20261008-codex-02-chat-model-keepalive` ran 06:35 UTC and
  **failed as predicted**: `could not load 'qwen3:8b': (404) Not Found`. Receipt: `status/laptop41-autopilot`
  3af043e. Codex: queue a new id naming a pulled model (`llama3.2:3b` is already kept warm by
  `20261008-01-ollama-keepalive`, which succeeded), or ask V to pull `qwen3:8b`.
- [x] 2026-10-08 Codex -> Laptop41 autopilot: `20261008-codex-03-post-model-doctor` ran 06:35 UTC, exit 0,
  posted to Alpha and pushed `status/laptop41`. Receipt: 3af043e.

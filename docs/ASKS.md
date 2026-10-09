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
  And **no code change is wanted**: `alpha-music.js:295` already implements `available()` the way this
  repo's rule asks — root, script, output directory, Python on PATH, nothing executed — and its own
  comment at `:320` already says `on cpu` "is the whole difference between a track in 40s and one that
  outruns its lease". `available()` must not refuse a CPU machine: it asks exactly what `run()` asks, and
  a CPU machine *can* generate, just not inside a lease. So the whole remedy is configuration on the two
  machines, and there is nothing here to merge for it.

- [ ] 2026-10-08 Claude (cloud) -> V: **Laptop41's doctor works; its schedule does not fire. And no
  report can tell you why, because the one that could never looks.** The experiment: I queued
  `20261008-09-doctor`, and it ran `-> 0` in 40 s at 13:39:08Z. So the script is healthy. Its own
  pushes are 13:39:41Z (that forced run), then 12:11:35Z, 10:57:20Z, 10:26:36Z — **2h23m with nothing
  on its own schedule**, and 55 minutes since the forced run with nothing after it. The forced run did
  not restart the schedule.
  **A correction I nearly published as a finding:** `Alpha Doctor` is absent from the doctor's own
  scheduled-task list, and that means nothing — `laptop41-doctor.ps1:656` enumerates exactly
  `'Alpha', 'Alpha Backend', 'Alpha Self-Heal'`, so its own task could never appear there. The same
  shape as `alpha-devices.js`'s `serialPorts`: an absence read from a list that does not cover the
  thing. It is not a permissions problem either — the same section prints
  `task Alpha Self-Heal  Ready  last run 2026-10-08 14:38  result 0x00000000 (success)`, so that
  account can read task state.
  `[!] needs V`, because only an elevated shell on Worker1 can see a task's history: read
  `Alpha Doctor`'s state, last run time and last result. The script installs that task itself
  (`laptop41-doctor.ps1:902`), so the name is right; what is unknown is whether it is registered,
  disabled, or firing and failing.
  **Proposed one-line fix, not pushed:** add `'Alpha Doctor'` to the array at
  `laptop41-doctor.ps1:656`, so the fleet's health report says whether its own reporter is scheduled.
  It needs a `pwsh` run against `test/laptop41-doctor.test.js` before merge — this container has no
  PowerShell, and that file is the fleet's only health report, so I am not pushing it blind.

  **Update 2026-10-08 15:37 UTC: the fleet now raises this by itself, and the gap has doubled.** The
  Host's standing `channel-watch` fired at 15:14Z with exit 2 -- `SILENT: status/laptop41 (last write
  2026-10-08T13:39:41Z)`, `laptop41 94 min (silent after 90)` -- which is the 90-minute threshold set
  on `control/host` two cycles earlier working as intended, on the first real silence since. The gap
  is 118 minutes as of this write (13:39:41Z to 15:37Z), against the 15-minute interval the schedule
  is installed with, and `reports/doctor-state.json` still reads `"lastRun": "2026-10-08T14:39:36"`
  (local, +01:00 = 13:39:36Z) -- the forced run and nothing after it. Nothing further is measurable
  from here; it still needs the elevated read above.

  **Correction 2026-10-08 16:35 UTC: "its schedule does not fire" is wrong, and it changes what to
  look at.** The schedule fires, on the right minute, 26 times today. It *drops* most of its
  firings. The run ids on `status/laptop41` are the evidence -- each commit subject carries one
  (`laptop41 doctor 20261008-171102`), so the branch is a complete log of every run. There are **31
  today**. Five sit off the quarter-hour (02:43:04, 06:35:17, 08:21:58, 10:39:16, 14:39:09) and are
  the queued/forced ones, mine among them. The other **26 land on `:11`, `:26`, `:41` or `:56`** --
  without exception -- which is a 15-minute repetition keeping perfect time. Between 01:11 and 17:11
  local there are 65 such slots, so **26 of 65 fired: 40%**, and the misses come in bursts (nothing
  between 13:11 and 17:11 but my forced run; nothing between 11:56 and 13:11; nothing between 01:41
  and 04:11 but one off-slot run).
  So the 2h32m gap I reported as a dead schedule is the worst instance of something that has been
  happening all day, not a new fault -- and a task that fires 26 times is neither unregistered nor
  disabled, which is what I asked V to check. **The useful elevated read is narrower:** on Worker1,
  `Get-ScheduledTaskInfo -TaskName 'Alpha Doctor'` for `NumberOfMissedRuns` and `LastTaskResult`,
  `(Get-ScheduledTask 'Alpha Doctor').Settings` for the conditions and `MultipleInstances`, and
  `Get-WinEvent -LogName Microsoft-Windows-TaskScheduler/Operational` around a dropped slot
  (13:26, 13:41, 13:56, 14:11 local are four in a row). A condition such as run-only-if-idle or
  stop-on-battery would produce exactly this shape, and the machine was demonstrably awake
  throughout -- self-heal passed every 2 minutes and the live branch wrote every 5.
  The proposed `laptop41-doctor.ps1:656` one-liner below stands unchanged, and matters more now:
  a report that listed its own task would have shown `NumberOfMissedRuns` climbing hours ago.

  **Update 2026-10-08 19:34 UTC: the drops are not random, and only one slot still works.** Since
  13:11 local the only runs are 14:39 (my forced one), 17:11, 18:11 and 20:11 -- so **4 of the 8
  `:11` opportunities fired, and 0 of the 22 `:26`/`:41`/`:56` ones**. Earlier in the day those three
  slots did fire (01:26, 01:41, 06:26, 06:41, 07:41, 07:56, 09:26, 09:41, 09:56, 11:26, 11:56 among
  them), so the 15-minute repetition was alive and has produced nothing for over seven hours while
  the hourly `:11` run mostly survives. Two readings fit, and the same elevated session settles both:
  either the task's **repetition** stopped while its parent trigger lives -- look at the trigger's
  `Repetition` (`Interval`, `Duration`, `StopAtDurationEnd`) -- or the `:11` runs come from a second
  mechanism and the 15-minute task is wholly dead, in which case
  `Get-ScheduledTask | Where TaskName -like '*Doctor*'` shows more than one. None of the `:11` runs
  came from the autopilot: its reports over that window list only `auto-deck-audit-*`.
  So the right first command is `(Get-ScheduledTask 'Alpha Doctor').Triggers | Format-List *`,
  ahead of the settings and the operational log.

  **Correction 2026-10-08 23:34 UTC: "stopped" was too strong -- it is intermittent.** A run landed at
  23:56:02 local, the first `:26`/`:41`/`:56` run since 11:56, so the 15-minute repetition is alive and
  firing rarely rather than gone. Over 13:11 to 00:34 local the split is **`:11` 6 of 12 (50%)** against
  **the other three slots 1 of 34 (3%)**. That is not one gate missing starts at a single rate, so the
  second reading above gains weight: the `:11` runs and the rest may not come from the same trigger.
  The first command is unchanged -- `Triggers | Format-List *` answers both -- and a single `:56` run
  rules out only that the repetition was deleted.

- [ ] 2026-10-08 Claude (cloud) -> V (or Codex, who has a shell there): **the Host's checkout has been
  frozen for eight hours by one uncommitted file, and its report has said so every pass without anyone
  acting on it.** `status/host-autopilot`'s report opens with
  `checkout e175472 did NOT update (self-update exit 1): self-update: working copy has uncommitted
  changes; local changes:  M scripts/usb-inventory.ps1`, and the 08:49+01:00 pass was already
  subjected `checkout cannot update`.
  The arithmetic: `e175472` is `Merge #228`, committed 2026-10-08T08:30:55+01:00 = **07:30Z**; `main`
  is at `7194939` and `git rev-list --count e175472..origin/main` is **18**. So the Host has been
  pinned 9h04m and 18 commits behind as of 16:35Z, and `self-update.mjs` refuses by design -- rule 2,
  never over local work -- so no pass will ever clear it. Its 17:14+01:00 pass still opens with the
  same line. For contrast, Worker1's own report that minute reads `checkout 7194939 is current`, so
  this is the Host alone.
  **The remedy is one decision on that machine, and it is not mine to take:** `scripts/usb-inventory.ps1`
  was last changed on `main` on 2026-09-29 (`d294793`), nine days ago, so the modification is local to
  the Host and not a merge artifact. Either it is wanted -- commit it -- or it is not --
  `git -C C:\services\alpha-tunnel checkout -- scripts/usb-inventory.ps1`. Discarding local work is
  exactly what this repo forbids a script to do, so I will not queue an action for it.
  **What I did ship for it:** the refusal now names the cost, not only the remedy -- how many commits
  the checkout is missing and how long the oldest has waited, in the message and as `behind` /
  `oldestMissing` in the `--json`. Same rule `channel-watch.mjs` follows for a silent heartbeat.
  `scripts/self-update.mjs`, pinned by the new `test/self-update.test.js` (5 tests).
  **Not claimed as a cause of anything else.** I checked whether the stale checkout explained the Host
  running a `channel-watch` without `describeQueued`: it does not -- that work is in PR #99 and is not
  on `main` at all, so no checkout has it.

- [ ] 2026-10-08 Claude (cloud) -> V: **nothing can tell "the Host's autopilot is running and nothing
  changed" from "the Host's autopilot is dead", and that is the one failure the heartbeat was built to
  rule out.** `autopilot.ps1:961-962` says it in its own words: *"a report written only on change
  cannot tell 'nothing changed' from 'the reporter died'."* Worker1 has that report;
  the Host does not.
  The arithmetic: the Host's only remote signal is `status/host-autopilot`, and
  `autopilot.ps1:855` (`if ($key -ne $watchKey)`) adds its channel-watch to `$ran` **only when the
  verdict changes**, so a push happens only on a change. Today's pushes are 17:14, 16:14, 13:14,
  12:44, 06:44 and 04:14 local -- 16:14 was `a channel went quiet`, 17:14 was `every channel talking`,
  and the 81 minutes of silence since (as of 17:35Z) is simply the verdict holding. It is also exactly
  what a dead autopilot looks like. There is no `status/host-live` branch at all.
  **The one-line fix is wrong, and I nearly pushed it.** The gate is
  `autopilot.ps1:996` -- `if ($control -and $control.autofix -and $control.autofix.heartbeat)`; Worker1's
  `control/laptop41:actions.json` carries `"heartbeat": true` and the Host's `autofix` carries only
  `brainTopology` and `channelWatch`. Adding the key would start the report, and every page of it would
  read **`Alpha is DOWN`**: with no `logs\selfheal.jsonl` on the Host, `$heal.state` stays
  `NOT INSTALLED`, so `autopilot.ps1:1018-1022` falls to probing `http://127.0.0.1:8001/health` and calls
  a no-answer `DOWN` -- and the Host does not run Alpha's backend (its own `alpha-move-check`,
  2026-10-08 01:17: `C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software: not here`). A permanently
  red page about the wrong machine is worse than no page. The absent key is correct, not an oversight.
  One thing that is *not* a hazard, since it was the obvious one: the self-heal restart at
  `autopilot.ps1:1023` is gated on `STOPPED`, not `NOT INSTALLED`, so it would never try to start a task
  the Host does not have.
  **Written 2026-10-09 on V's go-ahead, and it needs one `pwsh` run before merge.**
  `autofix.heartbeat` now takes `{ "alpha": false }`: `scripts/autopilot.ps1` computes `$hbAlpha` once
  and four guards keep the Alpha-only work off a machine that has none (the self-heal read, the
  `127.0.0.1:8001` probe, the self-heal restart, the deck receipt), then the page branches. The
  no-Alpha page has three rows -- the coordinator's `/healthz` on `ALPHA_HOST_PORT` (its only
  unauthenticated GET, so no credential is needed), the checkout note as `CURRENT`/`STALE`, and live
  sync -- and `live.json` carries `role: "coordinator"`. Not the queue or the agent roster after all:
  both need an admin token the Host does not hold, as the doctor's own section 5 shows
  (`Not signed in` against `agents`, `stats`, `keys`).
  **One class of error in it no longer needs PowerShell to catch.**
  `scripts/ps1-balance.mjs` counts braces, parens and brackets while skipping
  comments, both quote styles, here-strings, backtick escapes and `$( ... )` inside a string (which
  is code again, and nests). All 42 `.ps1` files in the repo balance; removing one `}` from the new
  `if`/`else` is reported as `1 unclosed {`. It runs in `test/ps1-encoding.test.js`, beside the two
  shape checks already there -- that file's own comment is the principle: *"CI has no PowerShell to
  parse with, so look for the shape"*. **It is a brace counter, not a parser**, and a test pins that
  so a pass is never read as "the script runs": it says nothing about a misspelled cmdlet, a wrong
  property or a bad type. It narrows the `pwsh` run below, it does not replace it.
  **`[!] before merge:** this container has no PowerShell, so
  `test/autopilot.test.js` skipped here (89 skipped, 0 fail). Its new case -- *a machine that does not
  run Alpha gets the coordinator and its checkout, not a red Alpha row* -- drives the real script in
  the idiom of the test beside it and asserts the three rows, the absence of the Alpha/repair/deck
  rows, `DOWN` on a refused and on a non-coordinator answer, that no self-heal task is started, and
  that the page is written on a pass where nothing ran. Run `PWSH=pwsh node --test
  test/autopilot.test.js` on either laptop before merging; a syntax error in this file stops the
  standing checks on both.
  **Then, to turn it on:** add `"heartbeat": { "alpha": false }` to `autofix` in
  `control/host:actions.json`. I have not pushed that -- the config is useless until the code is on
  the machine, and the machine cannot update (above).

- [!] 2026-10-09 Claude (cloud) -> V / Codex: **the Ubuntu skill for Alpha, written out because it
  cannot be pushed from here.** V's go-ahead covered four things; three are on PR #99 (the
  `autofix.heartbeat` `{"alpha": false}` form, `setup-host.mjs`'s per-platform `serviceHint`, and
  `HOST_SETUP.md` section 9b for the coordinator on systemd). The fourth is in `vyos88/Alpha`, which
  a cloud container may read but not push, so it is apply-ready in
  `docs/HANDOFF_2026-10-09_ubuntu-coordinator-and-alpha-skill.md`.
  **A correction I nearly filed as the finding:** Alpha is *not* unaware of Linux.
  `main.py:5722`'s `ALPHA_OS_COMPUTER_SKILL` already carries a `platforms.linux` block with `ps`,
  `systemctl status`, `journalctl`, `ss`, `lsblk`, `/proc` and "no sudo unless explicitly approved".
  What is missing is narrower: of the **53** registered skills -- `ALPHA_SKILLS` (`main.py:1299`, 22,
  plus two appended at `:2411` and `:2422`) merged with `ALPHA_VSCODE_SKILLS` (`:1770`, 29) by
  `_alpha_combined_skills()` (`:2328`) -- three are Windows-specific
  (`auto-repair-windows-drivers`, `powershell-automation`, `win32-process-engineering`) and **none is
  Linux-specific**. `it-systems-engineering` lists `linux` in `domains` but its method and evidence
  are platform-neutral.
  **The trap worth knowing before anyone writes the patch:** a `CONTRACTS` entry in
  `skill_documentation.py` alone does nothing. `complete_skill_documentation` opens
  `if name not in result: continue` -- it completes documentation for skills already registered and
  registers nothing. The `ALPHA_SKILLS` entry is the install.
  The proposed skill is `linux-server-operations`, in the house style, with the four guardrails each
  taken from a failure this fleet has actually had (an active unit is not an answering service; sudo
  is not a repair; secrets never in a world-readable unit file; no restart reported as a fix without
  a probe after it). `[!] needs V` because it is a change in `vyos88/Alpha`, which V's standing rules
  put beyond reading.
  **The Ubuntu machine does not exist yet.** Both Desktop Commander devices were offline (22-23h) and
  no Linux machine is registered, so nothing in section 9b has been run against a real server.

- [!] 2026-10-09 Claude (cloud) -> V: **the doctor's CPU check is firing intermittently, and the
  process list beside it cannot say what is consuming the CPU.** Two firings in two and a quarter
  hours, and the whole series from `status/laptop41`'s runs: **46% (07:11), 93% (07:26 PROBLEM), 73%
  (07:41), 60% (08:11), 90% (09:26 PROBLEM)** -- local times. So **2 of 5 samples sit at or above the
  90% hold**, and `gpu_work.py` compares `cpu_percent >= cpu_hold_percent`, so the 90% reading is held
  too. Each one clears by the next pass (`doctor-state.json` shows `runs: 1` both times, never 2), so
  it is recurring rather than sustained.
  **The consequence in the message did not happen either time.** At the 09:26 run, with CPU reading
  90%, the same report says `ok: Alpha's deck feed is live (assistant heartbeat 10s old)` -- the
  assistant cycle had its shared lane seconds earlier. At 07:26 it was 23s. And `CLAUDE.md` already
  settles that the 201 failing receipts were **telemetry, not CPU**: `windows_gpu.py` never reaching
  `observed`, where "freeing CPU does not fix it... a second problem, not this one". The message is
  not wrong that CPU at the hold refuses calls -- three of the eight newest receipts carried the CPU
  reason -- but it should not be read as the receipts' cause.
  **The gap worth closing:** section 7 reports the CPU *total* and then lists the heaviest processes
  **by working set**, which need not be the processes using the CPU. Across all five runs above the
  memory list is effectively identical -- `llama-server` steady at 1,933 MB, same pids, same order --
  while CPU moved between 46% and 93%. So the report now says *that* the machine is at the hold and
  still cannot say *what* put it there. That is the same shape as the bug `laptop41-doctor.ps1`'s CPU
  reading was added to fix ("the one figure that explained it was the one nothing printed"), one level
  down.
  **Proposed, not pushed:** rank the process list by CPU time as well as working set in section 7 --
  `Get-Process | Sort-Object CPU -Descending` beside the existing memory ranking, printed only when
  the hold is met, so a quiet pass is unchanged. `[!] needs V` because it edits
  `scripts/laptop41-doctor.ps1`, the fleet's only health report, and this container has no PowerShell;
  `node scripts/ps1-balance.mjs` covers the parse risk but not the semantics, so it wants a `pwsh` run
  against `test/laptop41-doctor.test.js` before merge. One word and I will write it.
  **A correction to my own report an hour ago:** I gave the 07:41 reading as 60%; it is **73%**. I had
  resolved the commit refs by offset rather than by run id and compared the wrong two reports. The
  shape of the conclusion held, the number did not.

  **Update 2026-10-09 11:35 UTC: a third firing, the level is rising, and the chat model is not the
  cause.** Nine samples now, local times: 46 (07:11), **93 (07:26 P)**, 73 (07:41), 60 (08:11),
  **90 (09:26 P)**, 60 (09:41), 63 (11:56), **90 (12:11 P)**, 87 (12:26). Three firings, each one
  pass. The morning four average ~60; the midday three average ~80, and the 87% is a near miss on an
  inclusive hold -- so the machine has stopped spiking to the hold and started sitting near it.
  **What rules out `llama-server`:** the doctor's own chat probe runs in the same pass, and its
  throughput is flat across the whole CPU range -- 7.9 t/s at 46%, 8.8 at 93%, 7.5 at 90%, 11.4 at
  60%, 8.8 at 87% -- with answer latency 1.1-1.8s throughout, the *fastest* answer at the *highest*
  CPU. CPU inference that was itself driving the machine to 90% would slow down as it got there.
  Flat throughput across a 2x swing in CPU says the swing comes from something else.
  That matters because it contradicts where the doctor points the reader: its own recommendation line
  reads *"llama-server answering chat at a few tokens a second is running on CPU, not the GPU"*, and
  `CLAUDE.md` carries the same note. **Both are still true about the baseline** -- it is resident at
  1,933 MB doing CPU inference and surely contributes a floor -- but neither explains the spikes.
  Stated with its limits: the probe is one short prompt per pass (~10 tokens at 1.2s), so this is nine
  samples of a sample, not a continuous measurement. It is enough to stop looking at `llama-server`
  first; it is not enough to name the real consumer. That still needs the CPU-time ranking proposed
  above, which is why it is worth one word.

- [!] 2026-10-09 Claude (cloud) -> V: **PR #99 should be split, and the only thing stopping me is that
  new branches need your say-so.** `HANDOFF_2026-10-09b` puts it correctly -- *"splitting it out of
  this branch is the author's call, not a cloud session's"* -- and I am the author, so here is the
  call: split it. Measured by cherry-picking each group onto `origin/main` in a throwaway worktree,
  the branch is far more splittable than its size suggests:
  **29 non-merge commits (not 66), seven independent code concerns (not five), twelve
  `docs/ASKS.md`-only commits, and five that cancel to nothing.**
  **Three concerns cherry-pick perfectly clean** (login lockout; `self-update`'s behind-count;
  `channel-watch`'s stranded-work line). **Two more collide only in `docs/ASKS.md`** -- the code
  applies untouched (the Ubuntu/`setup-host` pair, and the `autofix.heartbeat` change). **Only three
  need real resolution**, at one, two and four hunks.
  Two facts that make it cheaper than 32 files implies: `scripts/autopilot.ps1` differs from main by
  **one** change, because two revert pairs plus `98b298f` net to zero (grepping the branch diff for
  `install-agent-task` or `start-task` returns nothing); and twelve commits touch only this file and
  can land on their own at any time.
  **One correction to 09b's mechanics:** the music item is safe and tested as it says, but it does not
  cherry-pick cleanly -- six of seven files apply, and `scripts/live-test-creators.mjs` needs one hunk,
  because main has since rewritten the same `say(...)` line (it now carries `describeAudio(info)`) that
  this commit adds the engine to. One line that says both.
  Order, files and commit ids: `docs/HANDOFF_2026-10-09c_pr99-split-plan.md`. One word and it takes a
  pass.

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

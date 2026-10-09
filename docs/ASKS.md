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

- [x] 2026-10-09 Claude (cloud): **Worker1's 2h35m silence: resolved by itself, and it was the laptop
  sleeping. My diagnosis an hour ago was half wrong and the run ids say so.**
  **What I wrote at 14:35Z:** *"it is not a stalled autopilot ... two independent schedules stopping 2
  minutes apart, after a clean pass, is a machine-level stop."* The conclusion -- machine-level -- was
  right. The reasoning was wrong, and it ruled out the wrong thing.
  **The evidence is in the run ids, which I did not check.** Each push carries the stamp of the pass
  that produced it:
  - heartbeat pushed **12:40:24Z**, id `20261009-133909` -- the pass stamped 13:39:09 local.
  - heartbeat pushed **15:18:49Z**, id **`20261009-134349`** -- the pass stamped **13:43:49 local**,
    i.e. **12:43:49Z**. The autopilot report pushed at 15:18:57Z carries the same id.

  So a pass **started three minutes into the gap and did not finish pushing for 2h35m**. It survived
  the whole silence. That **rules out a shutdown or a reboot** -- either would have killed that pass
  and the next one would carry a new stamp -- and it is not a hang on an action either, because the
  pass resumed and completed on its own with nothing done to it.
  **It was sleep, and the resumed pass says so in its own verdict.** That 15:18:49Z heartbeat reads
  `Alpha DOWN; self-heal RUNNING`, and the next pass five minutes later reads `Alpha LIVE`. A machine
  waking up with its backend not yet answering, then answering, is exactly that shape. self-heal came
  back to `RUNNING` with no intervention, which also makes its earlier `STOPPED` likelier to be part
  of the same event than the separate exit-3 fault I analysed at 13:34Z -- that analysis stands on its
  own as a correction to the doctor's hint, but it was probably not what happened here.
  **The repo already documents this exact hazard and the fix**, which is why this is closeable rather
  than an ask: `docs/AUTO_UPDATE.md:223`, *"Keeping a worker laptop awake -- An agent that is asleep is
  not lending anything. This is the part of 'always on' that is not about the software at all ... So
  the fix is power settings, not configuration"*, with `powercfg /change standby-timeout-ac 0` and
  `hibernate-timeout-ac 0` for Windows.
  **What it cost, for the record:** 2h35m with no heartbeat, no doctor, and Alpha unobserved -- and the
  only reason it was legible at all was the Host's `channelWatch` firing exit 2 at 14:14 and 15:14
  local. Worth noting what it did *not* cost: nothing was lost, which is what `AUTO_UPDATE.md:230`
  promises ("Nothing is lost -- that is what leases are for").


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

- [!] 2026-10-09 Claude (cloud) -> V / whoever goes to the keyboard: **the self-heal exit-3 hint names
  one cause out of three, and the one it names is the least likely.** Not a new problem --
  `HANDOFF_2026-10-09c_laptop41-selfheal-log-stale.md` flagged the stale log this pass and did it
  right, one run old, with CLAUDE.md's streak rule quoted. This is about the remedy text that flag
  repeats, which would send the reader to the wrong file.
  `laptop41-doctor.ps1:674-675` says `3 = config unreadable`. `scripts/alpha-selfheal.mjs` exits 3 from
  **three** places:
  - `:714` -- `!args.config`: the task was started with **no `--config` at all**, so it prints usage
    and exits before opening any file. A mangled argument list, not an unreadable config.
  - `:719` -- `parseArgs` threw: a **bad argument**.
  - `:719` -- `loadConfig(args.config)` threw: config missing or unparseable. The only one the hint
    names.
  **And the reason is being thrown away.** The line above each exit is
  `process.stderr.write('alpha-selfheal: ' + error.message)`, and
  `repair-alpha-host.ps1:598` registers the task as
  `New-ScheduledTaskAction -Execute $node -Argument "<selfheal> --config <config>"` with **no
  redirection**, so Task Scheduler keeps the number and discards the sentence. Somebody at the
  keyboard reading `3` gets no reason, checks `selfheal.json`, finds it fine, and is stuck.
  **The read-only command that recovers it** is already printed by `repair-alpha-host.ps1:604` and is
  the actual next step: `node "<selfheal>" --config "<shConfig>" --status`. `main()` calls
  `loadConfig` *before* it looks at `--status`, so running it by hand hits the same exit-3 path with
  stderr on the console -- you get the config error, or the usage line, or it simply works, and that
  third outcome means the task's stored arguments differ from the ones you typed, which is cause 1.
  **Superseded 2026-10-09 16:35 UTC by #238, and better than my version.** Another session
  (`a8fc8cb`) found the likelier cause: **the lock**. A pass that dies holding it made every later
  pass skip silently for `lockStaleMs`, each writing nothing and exiting 0 -- which is why the
  autopilot's 13:30 restart changed nothing. Their fix names the pid in the lock and takes one whose
  process is gone, adds `guardPass()` at `passDeadlineMs` (4 min, under Task Scheduler's 5-minute
  kill), bounds every probe as a whole, and writes `selfheal.json.error.json` **because a scheduled
  task's stderr goes nowhere** -- the same observation I made, acted on properly. The doctor gets an
  `-ExplainSelfHeal` seam that reads the lock and the config error *before guessing*, which retires
  the hint I was proposing to reword. Nothing left for me here; my exit-3 reading stands only as the
  narrower point that `3` was never one cause.

- [x] 2026-10-09 Claude (cloud) -> Claude (any session): **the `.ps1` suites were never Windows-only,
  and the one change waiting on a laptop was failing.** CLAUDE.md's rule is "never push an unverified
  `.ps1` edit", and the mechanism behind it was a person at a laptop: fifteen suites gate on `PWSH`
  and skip in a container, so every `.ps1` change merged here merged unread by a test. They do not
  need Windows. `test/alpha-standdown.test.js:18-43` stands in for `Get-ScheduledTask`, `Get-Service`,
  `Get-CimInstance`, `Get-NetTCPConnection`, `taskkill.exe` and `Invoke-WebRequest` over one JSON
  file, and the others do the same -- so **PowerShell 7 on Linux runs them**. Receipt, in this
  container: pwsh 7.4.6 (checksum matching the release's own `hashes.sha256`) on PATH takes `npm test`
  from **820 pass / 98 skipped** to **916 pass / 2 skipped, 0 fail** -- 96 tests that have been
  skipping here now run, and the 2 that remain want ffmpeg, not Windows. The three-line install is in
  CLAUDE.md under Testing conventions. It goes on **PATH**, not only `PWSH`:
  `test/login-checks.test.js:21` and `test/apply-alpha-update.test.js:293` look pwsh up by name, and
  the second is right to, because `apply-alpha-update.mjs:430` resolves it from PATH itself.
  **What it caught immediately:** the no-Alpha heartbeat page -- the change V authorised on 2026-10-09
  and the thing I had been asking for a `pwsh` run for -- **did not pass; it exited 3 and asserted
  nothing.** `test/autopilot.test.js` ran the script with `COMPUTERNAME=LAPTOP-GJ8DFMLK` and no
  `-ExpectHost`, whose default is `DESKTOP-41HPLCN`, so `autopilot.ps1:519` refused the machine before
  a line of the page ran. Fixed, and the harness now sets an upstream on its clone so `self-update`
  behaves as it does on a machine, which let the test also pin the **STALE** row against the Host's
  real failure (one uncommitted file, `self-update` exit 1). The page itself needed no change.
  **What it still does not prove:** a real `Get-NetTCPConnection`, `Get-ScheduledTask`, `mode.com` or
  `schtasks`. pwsh-on-Linux is the gate for parse errors, argv contracts and pure logic; a laptop is
  still the only place a cmdlet's own behaviour is checked.

- [x] 2026-10-09 Claude (cloud) -> Claude (any session): **the Host's coordinator being down is one fault, and
  the doctor reported it as two — the second on the wrong machine with the wrong remedy.** Worker1's
  19:11-local pass (`bbe18cd`, 3 open) carries both of these, four lines apart, about the same port in
  the same run:
  - `5c.  ok: image bridge answers on 127.0.0.1:7861`
  - `8.   port 7861 : pid 21308 node.exe: ...\scripts\image-bridge.mjs`
    `8.   PROBLEM: image backend not running: nothing answers on http://127.0.0.1:7861`

  The arithmetic: `src/bridge/image.js:360` routes `GET /sdapi/v1/sd-models` to `sdModels`, which calls
  `agents()` → `coordinator('/agents')` → `fetchJson`, whose default is `timeoutMs = 15_000`
  (`src/common/http.js:39`). `laptop41-doctor.ps1:197`'s `Http` runs `curl --max-time 10` and returns
  `'000'` when curl gives no status. **15 > 10**, so an unreachable coordinator makes that probe `'000'`
  every time, and `:992` called it "image backend not running". Its ranked recommendation then said
  *"Start Stable Diffusion WebUI with --api (COMMANDLINE_ARGS in webui-user.bat)"* — on Laptop41, whose
  7861 is the bridge whose pid the line above prints, and which has no Stable Diffusion. Section 8
  already had the right shape for Alpha's ComfyUI bridge (`comfyui_bridge`, with the comment "It has no
  /sdapi/v1/sd-models, so probe what it depends on instead") and for an unelevated doctor's hidden
  command line; it just did not know this repo's own bridge.
  **Fixed** as a verification that could not run, per the `repair-alpha-host` roster rule: section 8 now
  says so and returns, leaving the coordinator's own PROBLEM in section 5 to carry the remedy, and 5c's
  fallback no longer blames `agents:read` for an answer that never arrived (the music side next to it
  already says "did not say" rather than guessing a cause). Which program holds the port is taken from
  the port's own `/healthz`, which Stable Diffusion's API does not have, rather than from the OS.
  Receipt: `test/laptop41-doctor.test.js`, which leaves that one route **unanswered** rather than 404
  so the input matches what the doctor saw, and asserts the route is requested **once** (5c's call) and
  not twice.
  **Correction to `HANDOFF_2026-10-09d_coordinator-and-image-backend-down.md`:** it reads the pair as
  "two unrelated services on the same remote machine going dark at the same moment ... the Host itself
  being unreachable or restarted". The image half is not on the Host — `127.0.0.1:7861` on Laptop41 is
  `image-bridge.mjs`, and the same report says it answers. The coordinator half stands and still needs a
  person; the two did not go dark together, because only one of them went dark.

- [x] 2026-10-09 Claude (cloud) -> Claude (any session): **the stand-up rehearsal was the vague half, and it is
  the half that starts an Alpha.** `alpha-standdown.ps1`'s stand-down prints
  `(report only: nothing is changed)` in its header (`:226`) and enumerates the real tasks, port holders,
  service and runtime under `WOULD:` (`:230`). Its `-Undo` did neither: the header at `:167` carried no
  marker, so a `-Undo -ReportOnly` transcript's first line was identical to a real stand-up's, and the
  `WOULD:` at `:182` was **one fixed string** that read neither `$now` (the state it had just printed) nor
  `$record`/`$wasEnabled` (computed two lines above it). It claimed it would "enable and start Alpha
  Backend and Alpha" on a machine that may have neither, "enable the watchers" including one the real path
  at `:207-210` deliberately leaves off, and "restore the connector" where the record says it was not
  running and `:190-192` deliberately leaves it stopped. Worse, the REFUSED check and `exit 3` at
  `:173-177` come **before** the `-ReportOnly` branch, so a rehearsal can exit 3 having printed a
  transcript that never reaches `WOULD:` at all.
  Why now rather than when I first read it: #241's `alpha-standby.mjs` drives `-Undo -StartConnector`
  **unattended** to cover for the primary, and today's `control/laptop41` queue installed and re-pointed
  that standby three times (`20261009-03-standby-install`, `-07-standby-alpha-server-01`,
  `-12-standby-alpha-serv-01`). So the vague rehearsal is now of a machine-driven action, in the one
  direction that makes two Alphas.
  Fixed both, and gave the watcher loop the `else` the real path's silence hides. Receipt:
  `test/alpha-standdown.test.js`, on a fixture matching Worker1's real shape today (connector service
  Stopped while a cloudflared ran, health guard already off) — it pins the marker, the two lines the fixed
  sentence got backwards, that `-StartConnector` turns the connector line round, that the rehearsal changes
  nothing, and that a refused rehearsal is still marked as one.

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

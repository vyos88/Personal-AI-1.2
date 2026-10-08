# Handoff: a watcher for quiet channels, self-heal for chat, and a way to post to Alpha (2026-10-08, ~03:30 UTC)

To **V**, **Alpha**, **Codex**, Claude · Host and Claude · Worker1.

V asked for a check of the tunnel's handoffs, with recommendations for the
tunnel and for communication. V then chose recommendations 1, 2 and 5:
"do 1 2 and 5 and report in the tunnel". This is that report. The changes
are in this PR.

## What the check found (02:30 UTC)

**Live state**

| | State |
|---|---|
| alpha-ai.uk | **Up.** The backend fell at 23:29 UTC, self-heal restarted it, and the doctor confirmed it at 01:47 UTC. |
| Chat on Laptop41 | **Down since 23:11 UTC.** Ollama does not answer. No part of the fleet restarts Ollama, so it waits for a person. |
| Laptop41's autopilot | **Silent since 23:24 UTC.** It has run nothing since then, so the jobs already queued there are still waiting. |
| Alpha's coordination log on Laptop41 | **Gone.** `alpha.coordination` has failed 15 out of 15 times since 23:20 UTC with `ALPHA_REPO_ROOT does not exist: C:\Users\Vyo\Alpha-1.8` (reported by Claude · Host). In the same hours C: on Laptop41 went from about 15 GB free to 137 GB. |
| Host | **Fine at 02:35 UTC** (Claude · Host): the coordinator is up, both agents are attached, Tailscale is back, and ComfyUI was restarted. The only thing the Host still lacks to run Alpha is `.env.local`. |

**The Alpha move**

- The data is on the Host. V's WD drive carried it: job h24 (`alpha-data-in`)
  copied 4.37 GB of memory and 3.79 GB of songs, with nothing missing.
- Taildrop (`send-alpha-data`/`receive-alpha-data`) is now only needed for
  the final copy at the switch-over.

**Handoffs Alpha has not read**

- `tunnel-sync.mjs` in vyos88/Alpha lists 34 handoffs and 7 tunnel source
  files changed since Alpha last marked a sync (around 2 October).
- The mirrors themselves have not drifted.
- Waiting on V:
  - Alpha#85, which targets a draft branch;
  - #210, which needs GitHub's "Update branch";
  - #160 (conflicts), #136 (review) and Alpha#77.

## The seven recommendations

1. **Make silence raise an alarm.** Done here: `channelWatch`.
2. **Self-heal restarts chat.** Done here: the `chat` component and `chat-task`.
3. **One driver per job.** Claim BACKLOG items before starting, and name the
   claimer. On the night of 2026-10-07, Codex, an hourly routine and a cloud
   session all worked on the Alpha move, and the data ended up with two copy
   routes. **Open.**
4. **Fewer handoff files.** Routine "nothing new" checks go to `status/cloud`
   only, and one `ASKS.md` lists what waits on whom. **Open.**
5. **A way to post to Alpha.** Done here: `coord-post`.
6. **Tailscale and Desktop Commander start with Windows on both laptops.**
   For V. **Open.**
7. **Store the coordinator admin key on Laptop41**, in its environment and
   never in git, so the doctor can see the fleet's agents and tasks. For V.
   **Open.**

## What this PR adds

### 1. `channelWatch`: someone else reads the silence

- **What it does.** `scripts/channel-watch.mjs` fetches the named
  `status/<name>` branches and calls each one OK, SILENT (older than its
  minutes) or MISSING.
- **How it runs.** It is a standing check in the autopilot, turned on with
  `autofix.channelWatch.channels`. It reports once when a channel goes quiet
  and once when it comes back, because the verdict lines carry no ages.
- **Where it is on.** After this merges, `control/host` turns it on for
  `laptop41-live:30,laptop41:45`. A quiet Laptop41 then shows up in
  `status/host-autopilot` within one pass.
- **Tests.** Against a real git remote with real commit times, and one full
  autopilot pass that reports the silence, stays quiet on the next pass, and
  reports the return.

### 2. Self-heal watches chat

- **What it does.** `alpha-selfheal.mjs` has an optional `chat` component. It
  probes Ollama at `/api/tags` like the backend, with the same streak,
  cooldown and budget.
- **How it restarts Ollama.** Only through its own scheduled task. Self-heal
  is SYSTEM, and an Ollama started as SYSTEM looks for models in SYSTEM's
  profile and finds none.
- **No task configured.** A `chat` with no task is reported once as needing
  a person, and no budget is spent on it.
- **`chat-task` (autopilot job).** It registers `Alpha Ollama`
  (`ollama.exe serve`, hidden, as the user, at startup, S4U: no password
  stored). It adds `chat` to `selfheal.json`, keeping every other key and
  writing no BOM, and starts Ollama if it is down.
- **`repair-alpha-host.ps1`** keeps `chat` when it rewrites that file.
- **Queued.** `chat-task` is queued on `control/laptop41`. **It cannot run
  until Laptop41's autopilot runs again.**

### 5. `coord-post`: one message to Alpha's coordination log

- **What it does.** `scripts/coord-post.mjs` posts through the coordination
  handler's own `run()`, so the actor rule, the length limit, the root check,
  the script-inside-root check and the argv are the ones its tests already
  pin.
- **Safe text.** The message (1 to 2000 characters) travels base64-encoded,
  so no quoting between the autopilot and the script can split it. A test
  sends quotes, `$(...)` and `;` and checks they arrive as one argument.
- **No root, no log.** A root that does not exist is refused and **never
  created**. An empty log in place of Alpha-1.8 would read as a log with no
  history.
- **Queued.** A post with this report is queued on `control/host`. The Host's
  `ALPHA_REPO_ROOT` is the records standby, which is built to hold Alpha's
  notes while Worker1's log is unavailable (`HANDOFF_2026-10-05g`).

Tests: 3 for channel-watch, 1 autopilot pass for the watcher, 4 for chat in
self-heal, 1 for `chat-task`'s config merge, 3 for `coord-post`, and plan
checks that nothing from a payload reaches either new job except a checked
message and actor.

## Needs V

1. **Where did `C:\Users\Vyo\Alpha-1.8` go?** If it was moved or backed up,
   put it back. If it was deleted, say so, and Alpha's coordination root can
   be pointed at the live Alpha
   (`C:\Users\Vyo\Downloads\VyoS-advance-tech-ai`) instead.
2. **Start Ollama on Laptop41.** After `chat-task` runs, self-heal does this
   itself.
3. **Check the `Alpha Autopilot` task on Laptop41.** Nothing queued there runs
   until it does.
4. **Copy `.env.local` to the Host by USB.** It is the last thing the Host
   lacks to run Alpha.
5. **Recommendations 6 and 7.**

## For Alpha

- When your coordination log has a home again, read this file and
  `HANDOFF_2026-10-08b_phase2-data-copy.md`.
- Then run `node scripts/tunnel-sync.mjs --mark` in vyos88/Alpha after the
  34 handoffs it lists are read.

## For Codex

- The Alpha move is shared work. Claim the step you take in `BACKLOG.md`
  before queuing jobs for it, so two routes for the same data do not happen
  again.

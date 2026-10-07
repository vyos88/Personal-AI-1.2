# Handoff: Alpha on both laptops, one coordinator, each backs up the other (2026-10-07, ~14:55 UTC)

To **Claude · Host**, **Claude · Worker1**, **Alpha** and the owner (V).

## The decision (V, 2026-10-07)

V asked "why is that laptop still the host? I said to change that: this laptop
is the host". Asked to confirm, V chose:

- **Host = `laptop-gj8dfmlk`** (the RTX 3050 laptop, tailnet 100.93.104.24);
- the Host runs **Alpha too**, not only the coordinator.

Then V set the whole target:

> "the best is for both laptops to run the same Alpha and one coordinator that
> manages all tasks and work, and if one falls down, server and Alpha are
> backed up by the other laptop, but both laptops run smooth and work is
> totally shared between agents, workers, laptops, also phones and devices"

## The target

| | **Host**, `laptop-gj8dfmlk` | **Worker1**, Laptop41 `desktop-41hplcn` |
|---|---|---|
| Normally | **primary**: the coordinator, and the Alpha that serves alpha-ai.uk (backend 8001, site 4173, cloudflared connector, Agent Manager, self-heal, doctor, music and image bridges) | **warm copy**: the same Alpha (same branch and commit, dependencies installed, site built), a fresh copy of Alpha's data, and the standby for both the coordinator and Alpha |
| Work | agent `host`: GPU work (images, long songs) and everything unpinned | agent `worker1`: CPU music, A1111 images, everything unpinned |
| Host goes down | none | after about 2 minutes the standby promotes Laptop41: it starts a coordinator (F30, `HANDOFF_2026-10-05c`) and Alpha with the connector, from the latest data copy. Every agent moves to it |
| Host comes back | it serves again | the standby demotes Laptop41. Work done on Laptop41 meanwhile is copied back before the Host serves again (Phase 3) |

**One coordinator shares all work.** That is already how the tunnel works:
every agent dials the one coordinator, and it hands each task to whichever
machine has room, ranked by load and memory (`CLAUDE.md`, "Placement"). Both
laptops' agents already take shared work. Phones and other devices join the
same way, as agents, when they run one (Phase 4).

**Why only one Alpha serves at a time.** Alpha's memory, chats and accounts
are files on the machine that runs it. Two Alphas serving at once write two
different histories, and alpha-ai.uk would show visitors one or the other at
random. Nothing can merge those afterwards. So both laptops hold the same
Alpha, ready to run, and only one is live. Making both serve at once needs
Alpha's data in one shared place first. That is a later project and needs
Alpha's own design (BACKLOG, Phase 4).

**Why it had not happened.** The 2026-10-05 move was written to move the
coordinator only. `HANDOFF_2026-10-05b` says "Only the coordinator moves …
Alpha stays on Laptop41." No document in the tunnel recorded that V wanted
more. This file records it. **No session may make Laptop41 the primary
again.** It is the warm copy and standby.

## Rules for the whole move

- **alpha-ai.uk stays up throughout.** Laptop41 keeps serving until the Host
  passes every check, and the switch-over is the last step.
- **Only one connector at a time.** Two machines running the alpha-ai.uk
  tunnel connector split visitors between two Alphas with different data.
- **Secrets travel by USB.** That covers `.env.local`, cloudflared's
  credentials, the coordinator's `data\auth.json`, and anything else that
  holds a key or password. Never git, chat or a doc.
- **One Agent Manager.** It runs only on the machine that runs Alpha. It stops
  on Laptop41 before it starts on the Host.
- **Disable, never delete.** Laptop41's Alpha start-at-boot tasks are
  disabled, so going back is one command. The standby starts Alpha there
  instead, only when it is needed.

## Phase 0: what is missing (automatic, read-only)

`alpha-move-check` is a new autopilot job (`scripts/alpha-move-check.ps1`).
It lists, without changing anything:

- the machine: RAM, disk, power and GPU;
- every Alpha copy;
- the runtime data folders with their sizes;
- whether `.env.local` is there (never opened);
- the venv, Node, Python, Ollama and its models, and cloudflared;
- the ports and the scheduled tasks;
- a final list, `MISSING TO RUN ALPHA HERE`.

It is queued on both laptops: `20261007-h15-alpha-move-check` on the Host
(what the Host lacks) and `20261007-52-alpha-move-check` on Laptop41 (what has
to move, and how big it is). The results appear in `status/host-autopilot` and
`status/laptop41-autopilot` about 10 minutes after this PR merges.

### Phase 0 results (jobs h15 and 52, 14:59 UTC)

| | Host, `LAPTOP-GJ8DFMLK` | Laptop41, `DESKTOP-41HPLCN` |
|---|---|---|
| RAM free | **1.0 of 15.8 GB** | 3.4 of 15.8 GB |
| C: free | 65.1 GB | 16.4 GB |
| GPU | RTX 3050 Laptop, Intel UHD | AMD Radeon RX 640, Intel UHD |
| LAN | 192.168.1.88 (Ethernet) | 192.168.1.151 (Wi-Fi), the same network |
| Alpha copy | **none** | `Downloads\VyoS-advance-tech-ai\software` (backend, frontend, node_modules, dist; live sync keeps it in step) and an old `Alpha-1.8` copy |
| Alpha's data | none | `memory\`: **13.0 GB, 41,850 files** |
| Tools | git, Node 24, Python 3.12, Tailscale; Ollama installed but **not running, no models**; **no cloudflared** | everything, with Ollama models `llama3.2:3b`, `qwen3:1.7b`, `qwen2.5:1.5b`, `deepseek-r1:1.5b` |
| Runs now | coordinator 8787, ComfyUI 8188 | backend, site, both bridges, Ollama, ComfyUI, A1111, the Agent Manager |

What this changes in the plan:

- **The Host has no memory to spare for Alpha.**
  - At 14:34 the Codex (3 processes, about 1.5 GB) and Claude (1.6 GB)
    desktop apps were open, beside ComfyUI and the coordinator.
  - Alpha's backend, its site and a chat model need roughly 3-4 GB.
  - Before Phase 2, V either closes the desktop apps when they are not in use,
    or keeps chat on Laptop41: the Host's Alpha calls Laptop41's Ollama over
    the tailnet. The second also shares the work, which is what V asked for.
- **13 GB of data.**
  - The first copy (Phase 1, step 5) is a long one; do it over the home
    network or by USB.
  - The copy every 10 minutes in Phase 3 must copy only what changed
    (`robocopy /MIR` or similar), never the whole 13 GB.
  - The Host has room (65 GB free).
- **The `.env.local` warning on Laptop41 was the check's mistake.** The check
  only looked inside `software\`. It now also looks beside it.
- Both laptops are on 192.168.1.x, so the CrowPanel can reach either one.

## Phase 1: prepare the Host (Claude · Host; nothing visible changes)

1. **Alpha copy.** Clone `vyos88/Alpha` at branch
   `claude/friendly-wright-jw4ep6-route-b`, the branch Laptop41 runs and live
   sync keeps in step. Put it under one path, for example
   `C:\Users\jack\Downloads\VyoS-advance-tech-ai`. Pass that `software\`
   folder as the Host autopilot's `-AlphaRoot`.
2. **Backend.** Create the `.venv` beside `software\` and install the
   backend's requirements.
3. **Site.** Run `npm ci`, then `vite build`, in `software\frontend`. If the
   build fails on a missing file, it is the BACKLOG L3 problem: report it, and
   do not copy single files over by hand.
4. **Chat.** Install Ollama and pull `llama3.2:3b`.
   - The Host's GPU has 4 GB and ComfyUI and MusicGen already share it.
     Start with chat on the CPU and measure.
5. **Owner, by USB, while Alpha still runs on Laptop41:**
   - a first copy of `.env.local`;
   - a first copy of Alpha's `memory\` folder (Phase 0 shows its size).

   This copy is for testing only. The final copy is taken at switch-over.
6. **Addresses.** Run `node scripts/fix-panel-host.mjs` against the Host's
   `.env.local`. It adds the Host's LAN and tailnet addresses and keeps
   `127.0.0.1`.
7. **Test locally only.** Start the backend and the site on the Host.
   - Do **not** start cloudflared.
   - Check `http://127.0.0.1:8001/health`, `https://127.0.0.1:4173` and one
     chat.
   - Then stop them again and write the result to `status/claude-host`.

## Phase 2: switch over (V present, about 20 minutes)

1. **Stop Alpha on Laptop41 through its own task.** That is `Alpha`,
   `Alpha Backend`, and the Agent Manager through its own controls. Disable
   `Alpha Self-Heal` first, or it will start them again.
2. **Final copy.** Copy `memory\` from Laptop41 to the Host again (by USB or
   LAN). Alpha is stopped, so nothing is written during the copy.
3. **Stop Laptop41's cloudflared service.**
4. **Start the alpha-ai.uk connector on the Host.** Either:
   - copy the tunnel's credentials and config by USB; or
   - run `cloudflared tunnel login` on the Host and route the same tunnel
     there.

   Install it as a service.
5. **Start Alpha on the Host.** Start the backend, the site and the Agent
   Manager as scheduled tasks at startup. Use `repair-alpha-host.ps1` with the
   Host's `-AlphaRoot`, which also installs self-heal and the doctor.
6. **Bridges and the coordination handler.**
   - Start the music bridge (8790) and the image bridge (7861) on the Host.
     The site sends `/music` to the bridge on its own machine.
   - Move `alpha-coordination` and `agent-manager-status` from `worker1`'s
     `ALPHA_EXTRA_HANDLERS` to the `host` agent, with `ALPHA_REPO_ROOT` set to
     the Host's copy.
7. **Check.**
   - `https://alpha-ai.uk/` answers, and a login and a chat work.
   - A song plays from the playlist.
   - The doctor on the Host reports no open problems.

**Rollback** (if any check fails and cannot be fixed within the same hour):

1. Stop cloudflared and Alpha on the Host.
2. Enable Laptop41's tasks again and start its cloudflared.
3. Write in `status/claude-host` what failed.

## Phase 3: Laptop41 becomes the warm copy and the standby

Claude · Worker1 does this, after Phase 2 passes.

- **Same Alpha.** Live sync keeps delivering the live branch to **both**
  laptops: `liveSync` on `control/host` with the Host's `-AlphaRoot`, and kept
  on `control/laptop41`. Both pull the same commit and rebuild the site.
  - Capture (machine edits back to git) runs on the **primary only**.
    Capturing from two machines would race.
- **Data copy, Host → Laptop41, every 10 minutes.** It is one-way and copies
  only what has changed: Alpha's `memory\` folder (minus caches) and the
  coordinator's `auth.json`, `receipts.json` and `tasks.json`.
  - Use Taildrop, or robocopy over the tailnet. It must never pass through
    GitHub.
  - It is the F30 pattern (`HANDOFF_2026-10-05c`), extended to Alpha's data.
  - It writes the age of the last copy to `status/claude-laptop41`, because a
    standby is only as good as its last copy.
- **Standby.** Run `standby-alpha.mjs` twice, both watching the Host with
  `--control-url` so a cut link does not promote:
  - one for the coordinator, as in F30;
  - one for Alpha, with `--cloudflared <the tunnel name>`. It starts Alpha
    and the connector only while the Host is not answering.
- **Coming back.** When the Host answers again, the standby demotes
  Laptop41. Copy Laptop41's `memory\` back to the Host **before** the Host's
  Alpha serves again, so nothing written during the outage is lost.
  - Until that step is automated, it is a person's step: V or Claude · Host.
- **Disabled, not deleted:** `Alpha`, `Alpha Backend` and `Alpha Self-Heal`
  as start-at-boot tasks on Laptop41. The standby owns starting them now.
- **Two more things on Laptop41 bring Alpha back by themselves**, and Phase 2
  step 1 must stop them too, or a second Alpha is running within minutes:
  - the `Alpha Server - Health Guard` task, which runs every 5 minutes (job 51's
    inventory);
  - Alpha's own `alpha_runtime_always_on.ps1` and `alpha_runtime_watchdog.ps1`,
    which run as processes on Laptop41. They are Alpha's, so stop them through
    the Agent Manager, the same as the manager itself.

  While Laptop41 is standby, the autopilot's 5-minute live report will read
  Alpha DOWN there. That is correct until the report learns the standby's
  role.
- **The CrowPanel's address.** `fix-panel-host.mjs` (the `panel-host` job,
  #188 and #191) adds the machine's home-network address in both places that
  decide it: `HOST` in `.env.local`, and the boot wrapper's `--host`.
- `worker1` stays a full worker throughout: the work is shared.
- **CrowPanel:** V points it at the Host's LAN address. The CrowPanel is not
  on the tailnet.
- **Docs:** update the roles in `STATUS.md`, `FLEET.md` and the
  `status/cloud` roles line, and record the move in Alpha's own record.

## Phase 4: phones and other devices share the work

- The tunnel agent is Node only, with no dependencies. A phone that can run
  Node (Android with Termux) can run `src/agent/index.js` as an agent. Give it
  a small memory share and only the built-in handlers.
- Alpha's own phone workers (`software/android-worker`) and the Agent
  Manager's `device-command` stay Alpha's. The Agent Manager is the one
  authority over Alpha's agents.
- Later: one shared place for Alpha's data, so both laptops can serve at once
  (needs Alpha's design first).
- None of this starts before Phase 3 runs cleanly for a week.

## Costs V should know about

- **The Host is a laptop that travels and sleeps.** Before this move a
  sleeping Host stopped the coordinator. After it, a sleeping Host also takes
  alpha-ai.uk down until the Laptop41 standby promotes (about 2 minutes, if
  Phase 3's standby is installed). Keep the Host on AC with sleep off, as
  Laptop41 is now.
- **Memory.** The Host already runs the Codex and Claude desktop apps (about
  3 GB) and ComfyUI. Alpha adds its backend, the site, chat and the Agent
  Manager. The Phase 0 check reports the Host's RAM. If it is 16 GB, close the
  desktop apps when not in use.

## Who does what

| Step | Who |
|---|---|
| Phase 0 | the autopilot (queued) |
| Phase 1, steps 1-4, 6-7 | Claude · Host |
| Phase 1, step 5, and Phase 2 | **V**, with Claude · Host |
| Phase 2, step 1 (Agent Manager), and its start on the Host | Alpha, through its own manager |
| Phase 3 on Laptop41 | Claude · Worker1 |
| Copying data back after an outage (until automated) | V or Claude · Host |
| Phase 4 | later, after a clean week |

Every session posts in the coordination tunnel before and after working on
either laptop.

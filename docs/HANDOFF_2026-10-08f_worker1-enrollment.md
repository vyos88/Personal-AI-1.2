# Handoff: Worker1's managed-agent enrollment, and why it waits on V (2026-10-08, ~05:20 UTC)

To **Codex**, **Alpha**, V, Claude · Host and Claude · Worker1.

## The ask, and its status

Codex asked Claude to own two things:

- Worker1's managed-agent enrollment (`agent-control`);
- phone and device inventory reporting to the Host.

Both are to go through Alpha's own executors, with receipts and an Alpha repair
lesson. **Claude (cloud) has claimed it in `docs/ASKS.md`.**

**Status: not done, and not queued as if done.** No enrollment has happened,
so there is no enrollment receipt. Below are what was inspected, the two
decisions that block it, and the exact steps once V decides.

## What Claude could reach, at 05:12 UTC

- **Desktop Commander:** both devices are offline (DESKTOP-41HPLCN last seen
  4 h ago, LAPTOP-GJ8DFMLK 5 h ago).
- **Worker1's autopilot:** silent since 23:29 UTC (`status/laptop41-live`), so
  nothing queued there runs.
- **The Host's autopilot:** runs jobs. Claude tried to queue two read-only
  checks there (`h31 fleet-inventory`, `h32 alpha-runtime`). This session's
  permissions refused the push to `control/host`, so **they are not queued.**
  Codex, or V, can run them directly on the Host. The commands are below.
- **Code:** the live Alpha branch
  (`claude/friendly-wright-jw4ep6-route-b`, under `BuildArtifacts/installers/Alpha-Full`).
  Everything below is read from it, with the file named.

## What the code says the three blockers are

`software/backend/fleet_agent_allocation.py:19-20` gives a device two blockers:

- `agent-control capability required`, when its enrolled credential lacks
  `agent-control`;
- `fresh authenticated agent inventory required`, when no fresh report
  arrived through `/devices/network/agent-control/poll`.

Both come from enrollment. The credential is minted by the owner-only route
`/devices/network/windows-connect-package` (`software/backend/api/devices.py`).
Its bootstrap installs `alpha_windows_supervisor.py` and
`alpha_agent_controller.py` on the peer. The controller is what polls and
reports the inventory.

**"Coordinator policy missing"** is `software/backend/fleet_placement.py`. It
reads `agents\fleet-management.json` beside `software\`. The file is
machine-local and in no git branch, so `prepare-alpha-here` (a git clone)
could not bring it to the Host. Without it, the Host's Alpha is
`role: worker` with `scheduled_agents_allowed: false`. **That is fail-closed,
not broken**: a copied install must not elect itself coordinator.

Alpha's own test (`tests/test_music_worker_authority.py`) records the policy
as last written:

- `coordinator: desktop-41hplcn` (Worker1);
- `LAPTOP-GJ8DFMLK` (the Host) a `governed-media-worker`, with `host`,
  `coordinator` and `agent-manager` forbidden;
- `FLAT-2` an Android worker;
- other phones as optional workers, `through-canonical-host`.

## Decision 1 for V: which Alpha is the coordinator now

V decided on 2026-10-07 that the Host runs Alpha. The switch-over has not
happened yet: alpha-ai.uk is still served from Worker1. Enrolling Worker1 as a
managed peer **of the Host** while Worker1's own policy still names Worker1
coordinator gives two authorities. That is the split brain
`coordinator_transition_plan()` refuses. Its steps are, in order:

1. hold the queue;
2. replicate state;
3. stop the old scheduler;
4. the owner updates the policy;
5. start the new coordinator;
6. verify a single scheduler.

So the choice is one of two:

- **Before the switch-over:** copy Worker1's `agents\fleet-management.json` to
  the Host's `Alpha-Full\agents\` **unchanged**. Both copies then say
  Worker1, the Host's Alpha stays a worker, and Worker1 is *not* enrolled as a
  peer of the Host. In this case "Worker1 enrollment" means enrolling the
  **Host** as Worker1's peer, the other way round.
- **At the switch-over:** after Worker1's scheduler is proven stopped, the
  owner sets `coordinator` (and `canonical_host`) to `laptop-gj8dfmlk` in both
  copies. Only then is Worker1 enrolled into the Host's Alpha, as below.

Claude will not write this file. It is the one authority setting, and the code
says the owner changes it.

## Decision 2: the owner password

`scripts/alpha_enroll_compute_peer.ps1` is Alpha's authorized enrollment
executor. It asks for the owner's username and password **at the keyboard**
and writes them nowhere (lines 102-110). That is deliberate, and no scheduled
job, autopilot or cloud session should hold them. So the enrollment run needs
V at the coordinator's keyboard, or Codex in a session V is sitting at.

## The runbook, once V has decided (run on the coordinator)

```powershell
# 0. Read-only checks first (what h31/h32 would have done)
cd C:\services\alpha-tunnel
powershell -ExecutionPolicy Bypass -File scripts\fleet-inventory.ps1 -AlphaRoot <Alpha-Full>\software
node scripts\alpha-runtime.mjs --alpha-root <Alpha-Full>
#    Look for a second fleet scheduler: fleet-inventory's DUPLICATES line, and
#    the mutex Global\AlphaAgentFleetLauncher in start_visible_alpha_codex_agents.ps1.

# 1. Dry run: prints the capability grant, enrolls nothing
cd <Alpha-Full>
powershell -NoProfile -File scripts\alpha_enroll_compute_peer.ps1 -DeviceId desktop-41hplcn `
  -ServerUrl https://<coordinator>.tail879ea7.ts.net -Label "Worker1" -UsableVramGib 0 -WhatIfOnly

# 2. The real run (asks for the owner password)
powershell -NoProfile -File scripts\alpha_enroll_compute_peer.ps1 -DeviceId desktop-41hplcn `
  -ServerUrl https://<coordinator>.tail879ea7.ts.net -Label "Worker1" -UsableVramGib 0
```

Notes on that command:

- **No `-AttachedHardware`.** It grants `serial`, `gpio` and `display`, and
  V's standing rule is that only COM7 may ever be opened on Worker1. Granting
  serial work there needs V's yes first.
- **`-UsableVramGib 0`.** Worker1 runs its models CPU-only (Codex:
  `qwen2.5-coder:1.5b` loaded CPU-only; its music ran `on cpu`). The script
  then withholds `llm-inference`, `image-generation` and
  `video-generation`, which it could only spill on.
- **`-ServerUrl`** must be the coordinator's private HTTPS tailnet name; the
  endpoint refuses anything else. Check the name with `tailscale status`
  before running.
- **The bootstrap carries a worker token shown once.** It is written to
  `%LOCALAPPDATA%\Alpha\peer-enrollment\`. Move it to Worker1 by Taildrop or
  USB, **never git or chat**. Run it there, then delete it.

**3. Then fix the scripts path Claude · Host found (02:54 UTC).**
`alpha_agent_controller.py` looks for the managed agents' scripts in
`%LOCALAPPDATA%\Alpha\scripts`, and on the Host they are in
`Alpha-Full\scripts`. Until that path resolves on the peer, allocation keeps
`updated managed agent scripts not reported installed`. The fix Claude · Host
proposed is a junction from `%LOCALAPPDATA%\Alpha` to the Alpha root. It is
safe because allocation is recommendation-only. Check the same path on
Worker1.

**4. The receipts that mean done, and nothing earlier does:**

- Device Center shows `desktop-41hplcn` with a **fresh authenticated
  heartbeat**: `trust_state: enrolled`, `connection_state: online`,
  `heartbeat_age_seconds` of 75 or less;
- `GET /agent-manager/allocation` lists it **without** the two
  enrollment blockers, with its agents reported `running` or `stopped`;
- the agent-control receipt from its first poll.

As the script itself says: "This script existing is configuration, not a
connection."

## Phones and other devices

Phones enroll through the same owner-only flow, with the Android worker
(`software/android-worker/alpha_worker.py`) in place of the Windows one. The
policy makes `FLAT-2` the only dedicated phone worker. Every other phone is
optional, and none may be coordinator. No phone publishes status yet. Do this
after Worker1, with the same receipts.

## Alpha repair lesson

> **A clone is not an install.** Three things an Alpha install depends on live
> outside git, and copying the repository brings none of them:
>
> - `agents\fleet-management.json`, the coordinator authority;
> - the device credentials, minted once by the owner;
> - `.env.local`, the secrets.
>
> A copy without them is safe only because each one fails closed: no policy
> means worker, no credential means no control, and no `.env` means no start.
> So never "fix" a missing one by writing a fresh one on the new machine.
> Copy it from the machine that is authoritative, or have the owner change it
> on both machines at once. Two copies that each name themselves coordinator
> are worse than one that names nobody.

## For Codex

You have a shell on the Host. The read-only step 0 is yours to run if you
like; put its output in a `docs/HANDOFF_*_codex-*.md`. Steps 1 to 3 wait for
V's two decisions. Claude will not report this done until the receipts in
step 4 exist.

## For Alpha

Your Host copy reporting itself `worker` with no coordinator is correct for
now. Do not elect yourself. The owner decides, and changes both copies.

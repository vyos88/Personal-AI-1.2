# Handoff: receipts from Claude (cloud, `intelligent-darwin`), night of 2026-10-11

From a cloud session working with V, reaching the machines through Desktop
Commander (Alpha-serv-01, DESKTOP-41HPLCN and LAPTOP-GJ8DFMLK are all enrolled
there) and GitHub. Every item ends in something checkable. In the tunnel I post
as `claude-code`.

## Done

- **Alpha 1.9 package receipts** (sha256 `56cc6f3c...a796`, 985,789,703 bytes,
  which `claude-alpha-serv` said had no receipt):
  - desktop-41hplcn, envelope `c1c723a3`: moved from Downloads into
    `memory\local\fleet-transport\taildrop`, then
    `alpha_fleet_transport.py receive` exit 0, accepted and sha-verified,
    `staged-awaiting-owner-approval`, one `received-verified` receipt back to
    the Host (it arrived 03:33 local, per `claude-alpha-serv` `8ac785e7`).
    `automatic_execution_allowed=false`. Not installed.
  - laptop-gj8dfmlk, envelope `a3ab06b3`: no live Alpha checkout there to run
    `receive`, so checked by hand in `C:\Users\jack\Downloads` (Taildrop saves
    to Jack's account on that laptop): SHA-256 and size match, and the zip opens
    (7,327 entries). Not installed, not moved. Do not resend either.
- **vyos88/Alpha#87** merged to `alpha-full` (`34400d9`): the compute-worker
  installer keeps the worker and ComfyUI running.
- **alpha-serv-01 `C:\Alpha`**: that copy's own installer already did most of
  #87 and more (agent controller, heartbeat check, `.cmd`), so only the ComfyUI
  part was added there: the connect package enables and starts ComfyUI tasks,
  never disables, and `alpha_windows_supervisor.py` restarts ComfyUI's task when
  8188 stops answering (`ALPHA_COMFYUI_KEEPALIVE=0` turns it off). 54 related
  tests passed there; backend restarted 01:29 UTC with `start-local.ps1
  -AutomaticStart`; `/health` 200 in 31 s; alpha-ai.uk 200. Backup:
  `C:\AlphaData\deploy-backup\comfyui-keepalive-20261011-022147`.
- **The server copy on GitHub**: `alpha-from-server-20261011` (`ab7fda2`), made
  with `snapshot-alpha-live.mjs --include-new` from a separate clone of this
  repo's `main` (`C:\AlphaData\publish\tunnel-main`; the services' own
  `C:\services\alpha-tunnel` on that machine is not a git checkout and was not
  touched). 89 credential-looking lines were reviewed and allowed: all test
  fixtures, storage key names, a public OAuth URL or regexes.
- **The 3-6-9 rhythm, corrected by V**: see `ASKS.md` line 2 and vyos88/Alpha#89.
- **Teaching Alpha**: see `ASKS.md` line 6.

## In progress

- **Worker1's newer Alpha into the Host.** V: "this Alpha on this PC has updates
  the host doesn't have". Worker1's repo shares a root with the server's
  (`0c3d975`); the fork is `e202d1ff` (2026-09-21). Worker1 is 547 commits and
  31 uncommitted files ahead, plus **19 never-committed source files** (the
  Debts hub, the coding-context pack, deck audit and liveness, live
  coordination labels and their tests). That is 2.1 MB of git bundle and a 47 KB
  zip, both moved by Taildrop and hash-checked. Merged in a separate worktree,
  `C:\AlphaData\publish\merge-wt`: 475 files came across clean, 60 merged by
  themselves, and 37 conflicted (108 hunks), each resolved with a recorded
  decision (`C:\AlphaData\publish\resolution-log.json`). The coordinator stays
  `alpha-serv-01`, tier names stay `admin`, Worker1's singing cluster is taken
  whole (it is a superset), and the Debts/coding-context routes come in with
  their files. The backend suite is running on the merge and on a baseline
  worktree for comparison. **`C:\Alpha` is unchanged and nothing goes live
  without V's OK.**

## Needs V

- **ComfyUI on Worker1.** V asked for ComfyUI to stay on. The `ComfyUI` task
  registered on desktop-41hplcn at 01:32 UTC (CPU, `C:\Users\Vyo\ComfyUI`) was
  then Stopped and Disabled (`0x41306`) along with every other Alpha task
  there, matching the owner pause and Codex's laptop light mode. It stays off
  until V says which wins. Worker2's ComfyUI (RTX 3050) is running.
- **Queued autopilot jobs that will not run**: `control/laptop41`
  `20261011-c1-enable-image` and `control/host` `20261011-h32-enable-image`.
  Both machines' `Alpha Autopilot` tasks are Disabled.
- **Worker1's fleet config still names itself coordinator**
  (`config/fleet-file-sync.json`, `fleet-release-delivery.json`,
  `agents/fleet-management.json` say `desktop-41hplcn`). The Host's say
  `alpha-serv-01`. Alpha's own worker-to-host channel (`alpha_fleet_transport.py`
  `sync_cycle` -> authenticated `worker-contribution` -> `staged-review-required`
  on the Host) is the lasting way for the two copies to exchange updates, and it
  needs Worker1 pointed at `alpha-serv-01` first.

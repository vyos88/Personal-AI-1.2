# Handoff: Phase 2 of the Alpha move has started, with the data copy (2026-10-08, ~01:30 UTC)

To **Alpha**, **Codex**, Claude · Host and Claude · Worker1. Background is in
`HANDOFF_2026-10-07d_alpha-moves-to-host.md`.

V asked for this move, then said "start Phase 2" and "commit and report to
Alpha and Codex". This file is that report.

## Where the move stands

| Phase | State |
|---|---|
| 0: read-only checks on both laptops | done (jobs h15, 52) |
| 1: prepare the Host | **done** (job h19, 2026-10-07 15:49 UTC) |
| 2: copy the data, then switch over | **started**: the copy tools are merged and tested; the first copy is next |
| 3: Laptop41 as warm copy and standby | not started |

Phase 1 left the Host with:

- Alpha `7ca5aa7` at `C:\Users\jack\Downloads\VyoS-advance-tech-ai\BuildArtifacts\installers\Alpha-Full`;
- the venv with the backend's requirements;
- the site built;
- `llama3.2:3b` pulled;
- cloudflared installed and **not started**;
- ComfyUI back on 8188.

alpha-ai.uk is still served by Laptop41, and that does not change until the
switch-over.

## What moves, and what stays behind

Laptop41's `memory\` is 13.0 GB, and 12.6 GB of that is in `memory\local`.
Most of it is not Alpha's state, so it stays behind (sizes from 2026-10-08):

| Left on Laptop41 | Size | Why |
|---|---|---|
| `memory\local\pytest-*`, `test-temp` | about 5.5 GB | test leftovers |
| `memory\local\uno-q-recovery` | 2.1 GB | one board recovery image |
| `memory\local\android-sdk` | 0.8 GB | a build tool |
| `memory\local\books` | n/a | a junction to `E:\Alpha\Library\books` |
| `__pycache__` | small | rebuilt on first run |

That leaves **about 4 GB**.

**The configuration does not travel with the data.** `.env.local` (7.9 KB) and
`.env` in `VyoS-advance-tech-ai\` hold Alpha's secrets. They go to the Host the
way `HANDOFF_2026-10-07d` says secrets go: **V copies them by USB.** Put them
in `C:\Users\jack\Downloads\VyoS-advance-tech-ai\BuildArtifacts\installers\Alpha-Full\`
on the Host. No script here reads, copies or sends them. The thirteen
`.env.local.bak*` copies stay on Laptop41.

## How it moves

1. **Laptop41:** `scripts/send-alpha-data.ps1` (new in this PR).
   - It packs `memory\` into one tar in `E:\AlphaMove\outbox`. E: has 341 GB
     free; C: has under 15 GB.
   - It writes a SHA-256 manifest. It does not touch any configuration file.
   - It sends everything to `laptop-gj8dfmlk` with `tailscale file cp`
     (Taildrop: end-to-end encrypted, peer to peer, inside V's tailnet).
   - It only reads Alpha's files, so Alpha keeps serving while it runs.
   - V connected Laptop41 to Desktop Commander, so a Claude session can start
     it there.
2. **Host:** the autopilot job `receive-alpha-data` (#213).
   - It checks every file against the manifest before touching anything.
   - It refuses an archive with any path outside `memory\`.
   - It keeps the Host's previous `memory\` as `memory.prev-<stamp>`.
   - If a `.env.local` ever arrives in its inbox, it places it beside
     `software\` without printing it and removes the received copy. The send
     script never sends one.
   - It refuses while anything listens on 8001 there, and it starts nothing.

A test packs a fake Laptop41 with the send script and unpacks it with the
receive script. It checks that:

- test leftovers stay behind;
- the data arrives byte for byte;
- no configuration file is packed;
- the source is never changed.

## Next steps

1. **First copy, while Alpha runs on Laptop41.** Run send, then queue
   `receive-alpha-data` on `control/host`. **V:** copy `.env.local` and `.env`
   to the Host by USB, to the folder above.
2. **Try Alpha on the Host, locally only:** backend on `127.0.0.1:8001` and
   the site, with no cloudflared. This needs a small job that starts both,
   checks `/health` and one page, and stops them again. That job is not
   written yet.
3. **Switch over, with V present.**
   - On Laptop41: disable Self-Heal, then stop Alpha and its Agent Manager.
   - Make the final copy with the same two scripts.
   - Move the connector: stop cloudflared on Laptop41, start it on the Host.
   - Start Alpha on the Host.
   - Check alpha-ai.uk, a login, a chat and a song.
   - Rollback: start Laptop41's tasks and cloudflared again.
4. **Laptop41 becomes the warm copy and standby (Phase 3).**
   - Arm `standby-alpha.mjs` there with `-ProbeUrl` pointing at the Host's
     Alpha, not at a coordinator. `docs/HOST_DOWN.md` explains why the default
     is wrong on that machine.

## For Alpha

- **Your Agent Manager moves with you, and only one may run.** At the
  switch-over it stops on Laptop41 before it starts on the Host. Two managers
  at once is how stewards restart each other. Please plan the stop and start
  through your manager's own controls, and post them in your coordination log.
- **Until the switch-over, the Host's copy of `memory\` is a copy.** Write
  nothing there. The final copy replaces it.
- After the switch-over, `auto-improve` and `assistant-loop` should start on
  the Host (BACKLOG A1), within their budgets.

## For Codex

- Nothing to run. **Do not run `send-alpha-data.ps1` or
  `receive-alpha-data.ps1` yourself:** each run moves V's data and secrets.
- A review of the two scripts and their tests is welcome as a comment on the
  PR: `scripts/send-alpha-data.ps1`, `scripts/receive-alpha-data.ps1`, and
  `test/autopilot.test.js`, under "send-alpha-data packs" and "receiving Alpha
  data".
- C3/C5 (the drive-space inventory) stay read-only as before. The 5.5 GB of
  `pytest-*` folders above belong in that inventory. Nothing is deleted
  without V.

## Also seen on 2026-10-07/08

- Laptop41 is back on `192.168.2.151`. The doctor says the backend listens on
  no home-network address, so the CrowPanel is still dark. Another session is
  on it (`HANDOFF_2026-10-07_ram-crisis-explained-crowpanel-progress.md`).
- The Host Claude session hit its weekly usage limit (resets 10 Oct). Its
  permission check also refused a recurring check on its own account. The
  Host's Phase 1 ran as autopilot jobs instead.

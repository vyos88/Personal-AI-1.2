# Handoff: Alpha#125 is merged, Alpha#136 holds the follow-ups (2026-10-17, 20:25 UTC / 21:25 UK)

To **Codex**, **Claude** (every session), **Alpha**, and V.

From Claude (cloud), session `01UNpnSb`.

## What changed

**vyos88/Alpha#125 is merged into `alpha-full`** (`e0f1de0`). It brings:

- A4 done: owner checks go through `require_owner`.
  - `/auth/users` was open to any signed-in account before.
- A2 for 8 modules (missions, auth, devices, chat, health, advanced_assistant,
  arduino_control, code). Several dead copies hid real bugs, now fixed:
  - the mission timeline;
  - the worker heartbeat hash;
  - artifact retention;
  - the coding to-dos list that vanished while empty.
- The Windows worker reports the real GPU on AMD laptops.
  - Laptop41's Radeon RX 640 was missed before.
  - The Network hub shows "free of total VRAM" and how busy the GPU is.
- The Brain deck's new Neurons, Pathways and Memory views.

**vyos88/Alpha#136 (draft, CI running) holds the follow-ups.** Each is tested;
the backend suite passes (2504) and the frontend suite passes apart from three
tests that need `node_modules`.

- **A2 is finished.**
  - The last 122 dead route copies are gone.
  - `tests/route_shadow_baseline.json` is empty, so any new dead copy fails CI.
  - Two fixes that lived only in dead copies are ported:
    - `/autonomy/status` now says `degraded` when the autoprogress loop is
      alive but has stopped beating;
    - `/assistant/books-ingest-by-domain-run-now` caps its inputs.
- **ST3 is done.**
  - The stewards' Python token call gives up after 20 s and kills a hung
    Python.
  - It lives in one shared file, `alpha_steward_python_token.ps1`.
- **ST5 is done.**
  - `workers.json` records each worker's process start time.
  - A PowerShell that inherits a dead worker's PID is reported as
    `wrong-process`.
  - `-ForceNew` stops the old fleet first.
- **CI now runs the steward PowerShell tests** under `pwsh`.
- **Repair reports reach Alpha's memory.**
  - `/system/repair-notify` answered 401 to the local repair scripts, so no
    repair lesson was ever saved.
  - Calls from the machine itself now pass; tunnel or proxy calls still need
    the owner.
- **Blocking and honesty fixes:**
  - `/code/capability-check` no longer blocks the event loop.
  - The code/Codex upgrade skills stop logging "verified" upgrades they never
    ran.
- **The Network hub shows each machine's worker script version.**
  - It compares the version with the server's and names the machines that need
    the connector rerun.
- **Brain deck:**
  - Pathways show how long each was active.
  - A "what changed" strip.
  - Firing history survives a reload for 30 minutes.
  - The sensory cortex and cerebellum fire on real signals, served by the new
    `/neurobrain/sensorimotor`:
    - the sensory cortex fires on a world-model ingest;
    - the cerebellum fires on a car motion command.
- **A test fails if a FastAPI upgrade hides the api/ routers again**, as 0.143
  did (440 routes missing).

`BACKLOG.md` in this PR:

- deletes A1 (already done: `/recommendations/debug` has a route) and A4;
- marks A2, ST3 and ST5 "in review: Alpha#136";
- narrows V5 to the 3D view;
- adds A5 to A7 for what was found and not done.

## What needs a person

1. **V: merge Alpha#136** once CI is green.
2. **H1 on the live host**, after the merge: `node scripts/apply-alpha-update.mjs
   --alpha-root <Alpha> --apply --restart`, then restart the stewards
   (`HANDOFF_2026-10-05d_stewards.md`).
   - The new steward files (`alpha_steward_python_token.ps1`) come with
     `scripts\`.
   - Workers started before the update have no start time in `workers.json`,
     so they fall back to the name check until the next restart.
3. **Rerun the Windows connector on each laptop** so its worker reports its
   script version. Until then the Network hub lists it as needing the update,
   which is true.
4. **On Laptop41:** check the Network hub shows the AMD Radeon RX 640 with about
   4 GB of VRAM.
5. **After deploying:** run `frontend/scripts/visual-audit.mjs` on the host on
   the Brain and Network routes. The cloud session cannot reach alpha-ai.uk.
6. Still open from earlier recommendations:
   - rotate the panel and agent keys the old coordinator issued;
   - find where the alpha-ai.uk 502/404 blips come from (compare alpha-serv-01's
     local health with the public endpoint at the next blip);
   - set cloudflared to start on boot;
   - settle Laptop41's role (it still runs a backend);
   - unstick its self-update (stuck on `c1aa435` by untracked song-cover files);
   - give alpha-serv-01 its own worker so it appears in the Network hub;
   - send long songs to the RTX 3050 laptop first (G1).

## What is next in code

- **A3**: split `main.py` one hub at a time. It is safe now that no route is
  shadowed.
- **A5**: needs V's call on what the Brain deck's 3D view should draw.
- **A6 and A7** (new), and **ST4** (DPAPI fallback for the package and voice
  stewards).

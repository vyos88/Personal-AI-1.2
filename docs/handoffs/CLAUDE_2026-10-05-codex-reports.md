# Codex reports C1 and C2, answered — 2026-10-05

For Codex, Alpha and V. Written by a cloud Claude session that picked up the
Codex handoff (`docs/handoffs/CODEX_2026-10-04-laptop41.txt` on
`claude/wizardly-brown-o23nhl`) and the read-only reports in
[`BACKLOG.md`](../BACKLOG.md). Checked against `vyos88/Alpha` `alpha-full`
at `099c410` (after #45).

## C1 — the two frontend calls with no route (for A1)

**`GET /recommendations/debug?hub_id=`** (Hubs.jsx, HubDetail.jsx
"Why these recommendations?", RecommendationAuditPanel). No route and no
function produced a signal trace. But everything the panel shows already
exists in the hub autonomy cycle (`_run_hub_autonomy_update_cycle_sync`):
per-hub health from `_hub_health_status`, the list from
`_build_hub_recommendations`, and the context values both read. Alpha's own
chat guidance (`response_intelligence_engine.py` lines ~1102-1130) tells it to
use this endpoint.
**Done, not yet pushed:** a read-only route over the stored cycle, commit
`14d7571` (merged with `alpha-full` as `e8a9d60`). Each recommendation is
labelled `signal` (with the signal named), `assistant-loop`, or `standing`
(written into the builder, so no invented driver). Five new tests; backend
suite 2109 passed, 22 skipped. It is waiting on a branch to push to (see
"Blocked" below).

**`POST /arduino/elegoo/install-alpha-firmware`** (Devices.jsx, six buttons:
compile/upload for `uno_car`, `esp32_bridge`, `crowpanel_camera_viewer`).
No backend function maps those targets to a sketch and a board. The parts
exist: `/arduino/compile` and `/arduino/flash` (`api/arduino.py`, via
`compile_sketch`/`flash_sketch`), the sketches under `hardware/examples/`
(`elegoo_v4_serial_car_firmware/`, `crowpanel_elegoo_cam_viewer/`, several
`esp32_*_bridge/`), and `arduino_tools._write_default_sketches`, which writes
an `alpha_esp32_elegoo_bridge` sketch. The FQBN for the two ESP32 targets is
recorded nowhere. `docs/elegoo_uno_v4_curriculum.md` documents the endpoint as
if it existed.
**Answer:** the route would be new code that flashes hardware, with board
choices nobody has written down. Either V names the sketch and FQBN for each
target (then it is a thin route over `flash_sketch`), or the six buttons go
and the curriculum points at the Arduino workspace's flash. Left in
`KNOWN_MISSING` until V picks.

## C2 — `api.missions` shadowed handlers (for A2)

All 13 shadowed handlers in `api/missions.py` differ from the `main.py` copy
that serves. Most differences are the module's style (state through
`_get_state`, a 503 when state is missing), not behaviour. The ones that
matter:

| Handler | Difference |
|---|---|
| `DELETE /missions/{id}`, `POST /devices/host-control`, `POST /missions/{id}/run` | **Auth.** Live copy: `require_owner`. Dead copy: any signed-in user. |
| `GET /alpha/iq` | Different scoring: live uses `project_category_counts` and benchmark/learning bonuses with tiers up to "Frontier"; dead counts all projects and uses old tiers ("Theorist", "Genius"). |
| `GET /alpha/thoughts/log` | Live reads the log off the event loop (`asyncio.to_thread`); dead reads it inline and blocks. |
| `POST /assistant/autonomous-thoughts/run-now` | Same: live runs the cycle in a thread, dead blocks the loop. |
| `GET /devices/host-knowledge` | Live adds `linux_awareness`; dead does not. |
| `GET /assistant/autonomous-thoughts/status` | Live adds priority counts over recent thoughts. |

In every case the live copy is the newer, safer one. None of the dead copies
has something the live one lacks that a user would miss.
**Answer:** delete `api/missions.py`'s 13 shadowed handlers (and their 13
baseline lines). Do not "reconcile" towards the dead copies: three of them
would drop the owner check.

## Blocked: where the Alpha change goes

The session's assigned branch in `vyos88/Alpha`,
`claude/beautiful-gauss-vmx4d6`, was already merged (Alpha #4) and holds
unrelated Music Creator history from `main`. Putting the A1 commit there needs
the branch replaced, which needs V's go-ahead; the alternative is a new branch
name. Until V picks, the commit is only in that session's checkout.

## Still open from the Codex handoff (unchanged, need V at Laptop41)

From `status/laptop41` (doctor 2026-10-05 00:26 local, checkout `6b3e990`,
i.e. PR #66 is already pulled there):
1. Alpha Self-Heal: still not completing (repair-alpha-host.ps1 as Administrator).
2. Live `main.py` dictionary bug: doctor `-Fix` as Administrator.
3. The `Alpha` task points at `C:\ProgramData\AlphaBoot\run-alpha.cmd`, not the frontend folder.
4. `dist` older than source since 2026-10-04 21:05: rebuild.
Plus, from the handoff: `Alpha Backend` boot task fails on a missing `jwt`
module (backend won't survive a reboot); an unknown cloudflared process carries
the public site while the service is Stopped; no Ollama, so chat has no model;
C: had 6.7 GB free.

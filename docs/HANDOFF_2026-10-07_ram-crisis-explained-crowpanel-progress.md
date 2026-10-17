# Handoff: RAM crunch explained, CrowPanel backend reachable again (2026-10-07, ~17:30 UTC)

## The RAM crisis flagged last check has a known cause — and a fix

> **Correction (17:45 UTC, after jobs 58 and 59 ran on Worker1):** the stray
> tree is not what ate the RAM, and it is not a preview server.
> `stop-stray-site` (job 58) found one preview tree, the live one on 4173,
> and left pid 6508 alone because its command does not say `preview` (31 MB).
> `fleet-inventory` (job 59) puts the RAM in **ComfyUI on Worker1**
> (`C:\Users\Vyo\ComfyUI`, port 8188): **3,473 MB**, on a laptop with no
> NVIDIA GPU that also runs the A1111 generator on 7860. Whether Worker1
> should run either is the owner's call (`HANDOFF_2026-10-07b`: the Host's
> RTX 3050 does images). What 6508 actually runs is the next
> `stop-stray-site` report: it now prints the end of each command line, its
> start time and its ports. The text below is kept as written.

PR #198's description explains it directly: since 02:54 UTC, a **leftover
`vite preview` process tree** (left running from before the "Alpha" task
last restarted at 02:31) has been running alongside the real site, and
`fleet-inventory` has been reporting `DUPLICATES: Alpha site x2` for over
12 hours with nobody at the laptop to clear it. That's what was eating the
RAM I flagged (down to 0.9-2.6 GB free this session).

Merged **#198**, "autopilot stop-stray-site": a new autopilot action that
finds and kills only the stray preview tree, by a narrow rule — whatever
process is actually listening on port 4173 (the live site) is never
touched; it stops only *other* vite trees whose command says `preview`,
together with their `npm run preview` wrapper; it does nothing if no vite
listener is found; and it verifies the real site still answers on 4173
afterward (exits 1 if not). Verified: clean merge, full suite **731
passed, 0 failed, 55 skipped**.

**Not yet executed** — merging adds the capability to the repo; someone
still needs to queue `{"do":"stop-stray-site"}` on Worker1's autopilot (per
the PR, job 56 followed by a `fleet-inventory` check at job 57) for it to
actually free the RAM.

## CrowPanel: the backend is reachable again

The backend now listens on `192.168.1.151` (the address that moved earlier
today) and `http://192.168.1.151:8001/health` answers 200 — that half of
the long-running issue is fixed. The remaining piece: no device on the
home network has called the backend yet, so the panel itself still needs
re-provisioning over USB serial (recommendation #1, unchanged).

Merged **#196**, "fix-panel-host: find the settings file, and read it the
way the backend does" — two real bugs a hand-run on Worker1 found: the
script guessed a wrong hardcoded path (`...\app\.env.local`, which doesn't
exist on Worker1's actual layout) and, when a file had two `HOST` lines,
read the *last* one (dotenv's rule) instead of the *first* (the rule
`run_server.py` itself actually uses) — meaning it could report and "fix"
a line the backend was never reading. Verified: clean merge, full suite
**732 passed, 0 failed, 54 skipped**.

## Not reviewed this pass (flagged for later / the owner)

- **Alpha PR #84** — "Music Creator: follow tunnel #159 playback" — new,
  draft, picks up the music-playback fixes merged in tunnel #159. Not
  independently verified in this pass.
- #136, #153, #80, #76, #74, #99 — unchanged, still open.

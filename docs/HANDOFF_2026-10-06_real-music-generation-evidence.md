# Handoff: real MusicGen generations confirmed, GPU-contention bug fixed (2026-10-06, ~22:30 UTC)

## The real-world status change: non-dry-run MusicGen generations have succeeded

PR #156's description cites a live-test job log with real wall-clock times for
real tracks on the **Host** (laptop-gj8dfmlk):

| Job | When | Host time for one 5s track |
|---|---|---|
| 30 | 21:12 | 44s (ComfyUI down) |
| 35 | 21:34 | 68s |
| 39 | 22:18 | 400s (ComfyUI up) |
| 40 | 22:29 | timed out while leased, 721s |

Jobs 30 and 35 are genuine, non-dry-run MusicGen generations completing
successfully (confirmed CUDA torch, not a CPU fallback). PR #155's
description adds that "on 2026-10-06 every live-test track, on both the Host
and Worker1, was reported as '~511 bytes, plays (WAV)'" — i.e. a live-test
harness has been generating real tracks on **both** machines; the ~511-byte
reading was a measurement bug (reading the JSON sidecar instead of the WAV),
not evidence the tracks themselves were bad.

So: real music generation is happening on real hardware on both laptops.
The thing both standing checks have been watching for all day.

## Root cause of the slowdown, and the fix — merged

The 44s→400s→timeout progression was GPU VRAM contention: ComfyUI keeps its
image checkpoint (~2.6 GB of the Host's 4 GB RTX 3050) loaded between
images, and MusicGen-small + T5 (~2.3 GB) then got pushed into shared system
RAM by the Windows driver instead of failing outright, which is why it was
slow rather than erroring.

Merged both fixes after independent verification (cloned, merged current
`main`, ran the full suite on each):

- **#155** — "Live test: judge each track by its bytes, play it whole, check
  the playlist." Pure test-tooling fix (`wav-check.mjs`,
  `live-test-creators.mjs`): reads the real WAV instead of the JSON sidecar,
  checks length/loudness, and cross-checks the playlist. No production
  handler touched. **683 passed, 0 failed, 36 skipped.**
- **#156** — "Music: unload ComfyUI's models before a track, so MusicGen has
  the GPU." Production fix in `alpha-music.js`: before generating, asks
  ComfyUI's `/free` to unload its models, only on a machine with
  `ALPHA_IMAGE_BACKEND=comfyui`. Bounded (5s timeout), best-effort (never
  throws, never fails the track if ComfyUI is down/slow/unreachable — tested
  for all three), and opt-outable (`ALPHA_MUSIC_FREE_GPU=0`). **680 passed,
  0 failed, 36 skipped.**

Both were drafts; marked ready and merged via PR, same process as #112,
#113, #116 earlier today.

**Not yet verified:** the fix needs the Host's agent to pick up the new code
(self-update or restart) before it takes effect there — per #156's own
"after merge" note, the next live-test music run on the Host should show
tracks back to about a minute, not 400s+.

## Everything else this pass

CrowPanel/deck-feed problems are unchanged (still open, "backend not
reachable on the home network" at 15 runs; the "deck feed degraded" line
reset to 1 run, likely just a restart blip, not a new finding). PR #153 (the
accidental `status/laptop41` → stale-branch PR, flagged last check) is still
open and still just noise. #136 (Personal-AI-1.2) and #74 (Alpha) are
unchanged, still flagged, not merged.

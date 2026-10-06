# Handoff: the chat image-generation 502/503s — root cause refined, two competing fixes drafted

**Written by:** automated hourly handoff check, last updated 2026-10-06 00:27 UTC
**Status:** real root cause now confirmed by a code fix (not just this
doc's earlier guess); two Alpha PRs independently fix it and need the
owner to pick one and close the other.

## Corrected root cause

My first version of this doc guessed the port conflict was a *different
program* (ACE-Step's Gradio app) squatting on port 7860. That guess was
wrong in the specifics. The real mechanism, confirmed by
[vyos88/Alpha#63](https://github.com/vyos88/Alpha/pull/63) and
[#64](https://github.com/vyos88/Alpha/pull/64) (both draft, both read this
doc and independently diagnosed the live bug):

**Alpha's own ComfyUI bridge** (`scripts\alpha_comfyui_bridge*.py`, only on
Laptop41/Worker1, not in any branch of this repo) correctly listens on
port 7860 — nothing else is squatting on it. But the bridge forwards every
render to **ComfyUI itself on port 8188, which was not running**. Alpha's
readiness probe treated *any* HTTP answer on 7860 as "backend ready," so it
queued the render, the bridge returned 503 because ComfyUI wasn't there to
do the work, and chat reported "Image generation failed: 502: image
backend failed: HTTP 503" — a true failure, but a misleading message, with
no indication that starting ComfyUI would fix it.

## Two independent fixes exist — the owner needs to pick one

Two different Claude sessions drafted essentially the same fix, minutes
apart, same base commit, same single file (`software/backend/main.py`):

- **[Alpha#63](https://github.com/vyos88/Alpha/pull/63)** — "Image chat:
  don't promise a render the ComfyUI bridge cannot make." Probe checks
  ComfyUI's `/system_stats`; adds an `unavailable_because` field; 11 new
  tests (all fail on base); full suite 2221/22/2 (2 pre-existing failures
  unrelated to this, missing speech-recognition tools); manually run in a
  real app instance against stand-ins on 7860/8188.
- **[Alpha#64](https://github.com/vyos88/Alpha/pull/64)** — "Stop
  promising chat images the ComfyUI bridge cannot render." Same idea, also
  adds a fallback to the next ready backend (then OpenAI if allowed) when
  one fails; 16 new tests; full suite 2230/20, clean `ruff`.

Both are real, well-tested fixes for the same bug, on the same base, in
the same file — merging both would conflict. **Neither has been tested
against the real bridge or a real ComfyUI** (both PRs say so themselves);
the probe logic is inferred from the doctor's reports of what the bridge
answers, not from a live run against it. This is a judgment call for a
person, not something to merge unattended: pick one (#64 has the added
fallback-to-other-backend behavior #63 doesn't), close the other, and
still start ComfyUI on Laptop41 (`run_cpu.bat`/`run_nvidia_gpu.bat`, or
`python main.py --listen 127.0.0.1 --port 8188`) — the code fix only makes
the error message honest, it doesn't make ComfyUI run.

## Still true from the original version of this doc

- The "dictionary bug" item resolved itself (confirmed in an earlier pass).
- The image-port problem itself is still open on Laptop41's live telemetry
  (9 runs as of this update) — nothing changes there until ComfyUI is
  actually started.

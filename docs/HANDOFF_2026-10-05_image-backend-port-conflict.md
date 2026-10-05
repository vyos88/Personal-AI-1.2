# Handoff: root cause found for the chat image-generation 502/503s

**Written by:** automated hourly handoff check, 2026-10-05 23:27 UTC
**Status:** live, current, needs a person on Laptop41 — this is the answer
to the "Image generation failed: 502: image backend failed: HTTP 503"
error reported earlier in this session, which this session could not
diagnose at the time for lack of a visible backend file.

## What the doctor found, new this pass

```
=== 8. Image generation ===
  IMAGE_GEN_URL = http://127.0.0.1:7860/sdapi/v1/txt2img  (from .env.local)
  port 7860 : pid 13900 python.exe
  PROBLEM: image port 7860 is held by python.exe, not Stable Diffusion's
  API (/sdapi/v1/sd-models answers 404): chat images fail with HTTP 503
```

Alpha's backend is configured to call Stable Diffusion WebUI's API on port
7860, but whatever is actually listening there right now (`pid 13900
python.exe`) isn't it — it answers 404 to `/sdapi/v1/sd-models`, which is
how the doctor tells the real API apart from something else merely holding
the port. That something else is likely ACE-Step's Gradio app, which also
defaults to port 7860 — the doctor's own recommendation names that as the
probable conflict.

**This is exactly the bug from earlier today's chat transcript**
("Image generation failed: 502: image backend failed: HTTP 503") — not a
code bug in Alpha's image-generation path, but two local programs fighting
over one port.

## The fix (from the doctor's own ranked recommendations)

> Start Stable Diffusion WebUI with `--api --port 7861` and set
> `IMAGE_GEN_URL=http://127.0.0.1:7861/sdapi/v1/txt2img` where the backend
> reads it, then restart the backend.

This needs a person at Laptop41 — nothing here can restart a process on
that machine.

## Also resolved since the last pass (no action needed)

The "live main.py still has the dictionary bug" item is gone from the
summary; the report now shows `ok: chat fix (dictionary 500) is in the
live main.py`. One fewer standing problem.

## Other new activity this pass (drafts, not yet actionable)

Five new draft PRs on `Personal-AI-1.2`, all part of the same Worker1
failover effort as `Alpha#60` (already flagged in
`HANDOFF_2026-10-05_monetization-prs.md`): **#109** (let a coordination
agent take only some actions), **#110** (merge a standby's coordination
log back into Worker1's), **#111** (the matching handoff doc, F31),
**#112** (remove superseded handoff docs), **#113** (fix the device
inventory script path on Windows). All draft; nothing to merge yet.

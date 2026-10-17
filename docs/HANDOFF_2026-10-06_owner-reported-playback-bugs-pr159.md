# Handoff: the owner hit real playback bugs on the live site (2026-10-06, ~23:30 UTC)

## This is the owner using the real product, not a test

PR #159's description opens: "The owner reported that many songs in the
**alpha-ai.uk** playlist won't play," naming a specific track ("În vale la
grădină") and the exact error text shown
(`Audio download timed out. Try again; large WAV files can take longer to
load`), plus asking why a 40-second track is so large. That's a live bug
report from actual use of the deployed site, not a draft or a test harness —
the strongest kind of real-world signal either standing check watches for.

## Four real causes, each found and fixed

| Cause | Fix |
|---|---|
| The playlist reads the receipt ledger, but Play looked the task up in the in-memory queue, which forgets a task after 24h or 1,000 newer tasks — reached in about half a day at current fleet traffic | Read a forgotten task back from its receipt |
| A busy laptop making a song (400-720s observed on the Host) starved audio-slice requests, which gave up after 60s | A new "express lane": an agent with full task slots still takes `alpha.music.audio` one at a time |
| A retry re-downloaded from byte 0 | Resumable downloads via a `.part` file |
| WAV crosses the tunnel at ~10x the needed size | The bridge now asks for MP3 (ffmpeg/LAME), falling back to WAV for older agents or a failed encode |

## Why I'm flagging this rather than merging it

PR #159 (Personal-AI-1.2) is large (1009 additions, 11 files) and, unlike
the smaller fixes merged earlier today, it changes the **core
agent-coordinator polling protocol**: a new `features: ['poll-types']` flag
at registration and `types=` narrowing on `GET /agent/:id/tasks/next`. That
path is shared by every task type, not just music — a mistake there has
fleet-wide blast radius, not just a music-bridge one. It's also explicit
that nothing takes effect until someone **restarts the coordinator, both
agents, and the music bridge, and reinstalls `requirements-music.txt`** on
the real machines — a coordinated live-host rollout, not a passive merge.
Test results are strong (734 tests, 698 passed, 0 failed, 36 skipped) but
that's exactly the kind of change this check's own rules say to flag rather
than wave through.

**Alpha PR #76** (frontend: `TrackPlayer` retry/progress UI, download-name
fix, up-to-5-minute tracks) explicitly says "merge after #159" — it depends
on #159 landing and the bridge restarting, so it's not actionable on its
own either. Only checked with a strict TypeScript pass here, not a real
browser against a live bridge.

Both are drafts, both unmerged. This needs the owner's own call, given the
protocol surface and the multi-machine restart it requires.

## Telemetry this pass

A brief RAM crisis flagged and already resolved: "fixed since last run:
only 0.4 of 15.8 GB RAM free" — a transient spike, back to 3.7GB free now,
nothing further to do. CrowPanel/deck-feed problems are unchanged (now 20
runs on the two main ones). PR #153 (the accidental status-branch PR) is
still open, still noise. #136 (Personal-AI-1.2) is unchanged, still
flagged.

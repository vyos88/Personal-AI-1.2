# Handoff: CrowPanel fully resolved; PR #210 needs an "Update branch" first (2026-10-07, ~22:30 UTC)

## The CrowPanel saga from today is over

After roughly 17 hours open, the doctor's pass now reports:

> `ok: no problems found`
> `+ fixed since last run: the backend listens on no home-network address...`
> `+ fixed since last run: no device on the home network has called the backend...`
> `ok: home-network devices that called the backend in the last couple of
> minutes: 192.168.2.97 (38 connections)`

The address flipped back to `192.168.2.151` (matching what the backend
listens on), and the physical panel has actually called in 38 times. No
action needed — just closing the loop on everything flagged earlier today
(HOST mismatch, panel not reaching the backend, heartbeat staleness).

## Merged by the owner: Alpha #76

The music-playback frontend follow-up (`TrackPlayer` retry/progress UI for
`503 still_fetching`, non-`.wav` download naming, up to 5-minute tracks) —
merged directly by the owner. No action needed from here.

## Flagged, not merged: PR #210

"panel: open the port as a device at every COM number, configure it by
name" — a real, well-tested fix (two genuine bugs found by the first live
`panel-identify` sweep on Worker1: `fs.open` needs `\\.\COMn` at every
port number, not just COM10+, while `mode.com` needs the *plain* name).
44 tests, 0 failures.

**Why I'm not touching this one:** the PR's own description flags a branch-
history complication — its branch predates another session's squash-merged
PR #208, so merging it as-is could show #208's work as reverted. The author
already tried to realign it and was blocked by a safety classifier on the
force-push, and explicitly asks for GitHub's own "Update branch" action
instead. That's exactly the kind of git-state surgery I shouldn't attempt
blind from here — it needs the owner (or the author, with the right access)
to click "Update branch" or do the equivalent merge themselves.

## Everything else this pass

No other new PRs. #136, #153, #160, #99, #80, #74, #73, #69, #68, #66, #53,
#34, #22, #2 unchanged.

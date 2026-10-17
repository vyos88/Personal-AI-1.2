# Handoff: CrowPanel reachable again, plus three new PRs (2026-10-07, ~00:30 UTC)

## Good news: the CrowPanel/deck-feed problem from most of today is resolved

Someone did the live-host fix (edit `.env.local`'s `HOST`, restart the
backend, re-provision the panel) between checks. The doctor now reports:

> `backend listens on: ::1, 100.69.243.25, 127.0.0.1, 192.168.2.151`
> `ok: the panel's way in answers: http://192.168.2.151:8001/health 200 (Wi-Fi)`
> `ok: home-network devices that called the backend in the last couple of
> minutes: 192.168.2.97 (37 connections)`

The two `NEEDS A PERSON` lines that had been open 20 runs are gone. Only one
line remains, and it's new (2 runs): the deck feed is still reported
degraded because this backend predates Alpha#26's heartbeat fix — a
separate, smaller issue from the reachability problem that's now fixed.

Music, image, and brain-topology checks are all still green.

## Merged: PR #161 (read-only, low risk)

"doctor: list every board and home-network device by address" — adds COM
port/VID:PID/instance id for USB boards, and IP/MAC for this machine and its
home-network neighbors, all read from Windows' own tables. Nothing probed
or sent. Verified: clean merge with `main`, full suite **700 passed, 0
failed, 38 skipped**. Merged.

## Flagged, not merged: PR #160 (merge conflict) and Alpha #77

**PR #160** ("Autopilot: repair doubled line ends in Alpha by itself") —
the owner explicitly asked for this (CR CR LF line-ending corruption to be
fixed without anyone running commands), and the implementation is
careful (byte-level validation, backups under `<ops>\backups\`, change
detection to avoid repeat noise, 5 new tests). But merging current `main`
into it **conflicts in `scripts/autopilot.ps1`** — something else (likely
#136's fleet-status.json work) touched the same script since this PR's
base. A conflict in a script that runs unattended on live machines needs
someone who can see both intents to resolve it correctly, not a
cloud-session guess. Flagging rather than resolving blind.

**Alpha PR #77** ("Topology: name the CrowPanel, match devices by MAC in
any spelling") — small, cosmetic (display names in the tunnel/Network hub),
but depends on PR #161 (just merged) to get real MAC data, and this repo's
structure (multiple parallel builds — Alpha-Full, Alpha-Server,
BuildArtifacts installers) means I haven't independently verified which
copy of `fleetNames.js` it's actually editing in this session. Flagging for
a closer look rather than merging on an unfamiliar branch layout.

## Unchanged from the last two checks

PR #159 (Personal-AI-1.2) and Alpha #76 are still open, still flagged
(core polling-protocol change + multi-machine restart requirement). #136 is
still open, still flagged (merge conflict is actually touching the same
file this PR also wants — worth noting if whoever resolves #160 also looks
at #136). PR #153 (the accidental status-branch PR) is still open, still
noise.

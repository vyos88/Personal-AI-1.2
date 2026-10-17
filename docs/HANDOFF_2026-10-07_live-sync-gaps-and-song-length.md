# Handoff: live-sync gaps, the refused song-length change, and 9 improvements (2026-10-07, ~02:00 UTC)

To every session, Codex and Alpha. The owner asked for these, then went to bed:

- normal-length songs (2:30-3:30);
- a full audit of every page;
- "both versions always auto-update all decks and hubs, and auto-improve always".

Below is what was done, what is not done yet, and the next nine items. The
items are also in `BACKLOG.md` as L1-L4, M1-M2, A1-A2 and G1.

## Done tonight (merged and live)

- **#159** (music playback): forgotten tracks play from the ledger, the express
  lane, resumable downloads, MP3 over the tunnel. It is live on both laptops.
  Host jobs h09/h10 and Worker1 jobs 47/48 all exited 0. The music check made a
  5 s track on the Host in 59 s, played it as MP3 (57 KB) and found it in the
  playlist.
- **#167**: the autopilot job `restart-coordinator`, and the live test now
  reads MP3.
- **This PR**: the live sync now captures what the site needs to build. It
  takes the frontend's data JSON (`software/frontend/src`, `software/frontend/public`;
  never backend JSON, which is runtime state) up to 2 MB each. It takes
  `software/frontend/scripts`. It no longer treats "tokens"
  (`styles-tile-tokens.css`) as a credential; `token`, `secret`, `password` and
  the rest still exclude a file. The credential scan still reads every line.

## Found: git cannot build the live site

The live branch `claude/friendly-wright-jw4ep6-route-b` is missing 27 files that
Worker1's frontend imports. `vite build` on the branch fails at the first one,
`src/styles-tile-tokens.css`. They are in no branch at all:

- `src/styles-tile-tokens.css`. Skipped as "named like a secret".
- 24 data files, which were never captured because `.json` was not taken:
  - `src/encyclopedia.json`, `src/animalModels.json`, `src/animalGroups.json`;
  - `src/educationalAssignments.json`, `src/educationalCollectionAssignments.json`, `src/anatomyPlacementReview.json`;
  - every `src/*Prototype.json`: owl, clownfish, frog, honeybee, octopus, crab, hammerhead, moonJelly, turtle, butterfly, ladybird, fern, cactus, broadleaf, conifer, grass, sunflower;
  - `public/assets/anatomy/skeleton-anatomical/manifest.json`.
- `scripts/css-rules.mjs` and `scripts/css-source-metrics.mjs` (frontend tests import them).

If Worker1's disk died, these would be lost. The first in-sync pass after this
PR reaches Worker1 should capture them. Check: the capture line in
`status/laptop41-autopilot` names about 27 new files. After that, `vite build`
on the branch succeeds.

## Not done: songs of normal length (reverted, needs L1)

Alpha Mate songs are capped in two places on the live branch:

- `software/backend/chat_music_generation.py` `validate_brief`: `duration_sec`
  defaults to 60 s and refuses anything over 120 s.
- `scripts/alpha_public_song_worker.py` `_strict_audio_check`: the decode stops
  at 127 s and fails any song that reaches it.

The singing panel (`MusicSingingPanel.jsx`) offers 15, 30 or 60 s. Quick start
already defaults to 180 s.

Commits 2242b98 and 48bdf61 raised these to 3:00 by default, up to 4:00, with a
260 s decode cap and 2:30/3:00/3:30 in the panel. Two new pytest cases passed;
`test_post_launch_instrumentation_failure_preserves_successful_pid` fails on
Linux with and without the change.

Worker1's live sync **refused** them: "a file here differs where the change was
made". While it was off the tip, nothing was captured either, so f219f4b
reverts both. The branch is again exactly what Worker1 runs (7e76aeb), and
delivery and capture resume.

The likely culprit is `scripts/alpha_public_song_worker.py`: `scripts\` is
captured against its own record, so Worker1's copy may not be the branch's.
Redo the change once Worker1's real copy is in git (L1).

## Not done: a full audit of every page (A2)

This cloud session cannot reach alpha-ai.uk: the environment's network policy
denies the host. Alpha's own `software/frontend/scripts/visual-audit.mjs`
covers every deck, hub and subtab at 1440x900 and 412x915. It reports:

- slivers;
- sideways scroll;
- route-not-found;
- failed requests;
- broken images;
- console errors.

It needs an account that can open every hub. It could not run on a local
build either, because the branch does not build (above).

## The nine improvements

| ID | What | Why | Done when |
|---|---|---|---|
| L1 | Redo the song-length change (above) on top of Worker1's real `alpha_public_song_worker.py`, `chat_music_generation.py` and `MusicSingingPanel.jsx` | the owner asked for 2:30-3:30 songs; every chat song is under 2:00 | live sync reports IN SYNC on the commit, and a chat song of 3:00 lands in the playlist |
| L2 | `live-sync` / `apply-alpha-update.mjs`: on REFUSED, name the file and the first hunk that did not fit in the report | "a file here differs where the change was made" told no one which file, so the fix needed a person | a refusal in `status/laptop41-autopilot` names the file and line |
| L3 | A standing check that the live branch builds from git: after each capture, scan the frontend for imports of files git lacks (or run `npm ci && vite build` in a scratch clone) and report `PROBLEM` in the autopilot report | 27 missing files went unnoticed until a session tried to build | the check is in the autopilot's standing checks and reports 0 missing |
| L4 | Capture source files the name rule drops: `test_owner_password_persistence.py`, `alpha_secret_scan.py`, `enter-owner-password-private.ps1` and 6 more are code, not secrets. Decide whether code (by extension) skips the name rule, since the line scan reads every line anyway | they exist only on Worker1 | they are in git, or a decision is written in `LIVE_SYNC.md` |
| M1 | Live playlist (`MusicPlaylist.jsx`): treat `503 still_fetching` from `/music/tasks/:id/audio` as "try again in 5 s", as Alpha#76 does for the panel. Merge Alpha#76 itself (it waits on the owner) | since #159 the bridge answers 503 while a long track comes across; the live page shows "Audio download timed out" instead of waiting | a long track plays on the first press, after a progress message |
| M2 | Live playlist: play a song's MP3 (`mp3_url`), not its WAV master | the owner's error read "large WAV files can take longer to load"; the MP3 is about a tenth of the size | the player's request is for `.mp3` when one exists |
| A1 | "Auto-improve always" (owner, 2026-10-07): find what turns Alpha's auto-improve on (`AutoImprovePanel.jsx` and its backend) and make it on by default after a restart, inside its existing budgets and guards | the owner asked for it to run always | after a backend restart, the auto-improve status shows enabled with cycles recorded |
| A2 | Run the full page audit somewhere that can see the site: a new autopilot job `visual-audit` on Worker1 against `https://127.0.0.1:4173`, with an audit login stored on that machine (user environment, never in git); or the owner allows alpha-ai.uk in the cloud environment's network settings | the owner asked for every page to be audited | `visual-audit/summary.txt` is in the autopilot report, its problems are BACKLOG items |
| G1 | Long songs on the GPU: Worker1's music torch is CPU-only (`2.14.1+cpu`), the Host's is CUDA (RTX 3050). Route songs over 60 s to the Host first, for MusicGen (bridge order is already `host,worker1`) and for Alpha Mate's native singer | a 3-minute song on CPU takes many times longer | a 3:00 song is made on the Host |

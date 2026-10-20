# 2026-10-20: Music Creator styles, live song progress, and three songs (to the Host)

From a cloud Claude session working for V, through Desktop Commander on
**alpha-serv-01** (Alpha) and **laptop-gj8dfmlk** (the Host, which runs the
singing GPU). V asked for everything done today to be reported to the Host,
and for a report back. The ask is in [`ASKS.md`](ASKS.md).

## What changed on alpha-serv-01 (live, not committed)

Every change below is in the working tree of `C:\Alpha` (branch
`host/msi-vector-16hx`). None of it is committed yet. Each original file is
backed up under `C:\Alpha\tmp\*.before-*`.

| File | Change |
|---|---|
| `software/backend/creative_production_knowledge.py` | New style **`dark blues rock`** (Madrugada: 62-100 BPM, starts at 81 in E minor; clean offset guitar with spring reverb and delay, slide and lap steel, organ swells, brushes and floor-tom rolls, a deep baritone). Aliases `madrugada`, `dark rock`, `blues rock`. New style **`detroit techno`** (Jeff Mills: 132-142 BPM, starts at 137, the tempo of *The Bells*; distorted 909 kick, rolling offbeat hats, delayed claps, a looping bell sequence, drums-only 16-bar intro and outro for DJs). Aliases `jeff mills`, `detroit`. Render specs and `GENRE_ROOT` for both. |
| `software/backend/music_genre_identity.py` | Groove identities for both styles, so their rhythm, bass, transitions and delivery reach the Singing caption. |
| `software/backend/music_singing.py` | (1) `get_job` keeps the engine's own `progress` (0-100) and `stage` on a generating job. They were being dropped, so the progress ring never had a number. (2) Lyrics that are only `[Instrumental]` now produce an instrumental caption. Before, every brief told the engine to sing, including instrumentals. |
| `software/frontend/src/components/MusicQuickStart.jsx` | `Dark blues rock` and `Detroit techno` added to `MORE_STYLES`. |
| `software/frontend/src/components/SongGenerationProgress.jsx` | Null fields in the live GPU-console snapshot no longer erase the job's own progress. Once a high number has not moved for 20 s, the ring shows a labelled elapsed-time estimate ("Decoding the audio (estimated from elapsed time)") that slows toward 98% and never shows 100%. ACE-Step stops counting near 79% while it decodes the audio, and the ring then looked hung. |

Tests run on alpha-serv-01: backend genre, production and singing suites all
pass (243, then 111 after the last singing change). Frontend `musicSimpleMode`
and `songGenerationProgress` pass (21).

**Backend restarts.** `run_server.py` on 8001 was restarted three times
(about 04:18, 04:24 and 04:42 local). The second restart left the backend down
for about 40 s, because the stop command matched its own shell. V has said the
backend must stay up: put the next change in the frontend where that can be
done, and restart only when a change needs it. The backend running now has
everything above except the frontend estimate, which needs no restart.

**Frontend build.** A production build into `dist` was attempted. Folder
renames were refused by a lock, so `dist` was copied from the new build. The
old build is kept as `dist.before-madrugada-20261020-041649`. `vite preview` on
4173 dropped connections before and after this. Its builds also contain no
Music Studio, so it does not look like the page V uses. The dev server on 5173
serves the source live.

## Songs made (owner VyoS, in the saved songs)

| Title | Style | Length | Result |
|---|---|---|---|
| Madrugada | dark blues rock, E minor, 72 BPM | 3:00 | completed 04:24, checks passed |
| Sofia Transmission | detroit techno, A minor, 137 BPM, instrumental | 5:00 | completed about 04:56, checks passed |
| Destiny Madrugada (3 min take) | dark blues rock, G minor, 70 BPM | 3:00 | was rendering at 75% when this was written |
| Destiny Madrugada (4 min take) | same | 4:00 | **failed**: the engine died while decoding the audio |

## What the Host should know

- **The singing engine died while decoding a 4-minute song.** At the time,
  the Host had about 1.3 GB of physical RAM free and the engine held about
  6 GB of working set and about 22 GB of commit. The demand runner restarted
  it. 3- and 5-minute renders finished once more RAM was free.
- **The memory admission in `run-singing-demand.py` refused jobs (503)**
  whenever free RAM fell below 2 GB. To get the songs through, Copilot
  (8 processes) and Edge (7) were closed on the Host, at V's request.
- `C:\Users\jack\Music\play-when-ready.ps1` was added to the Host. It plays the
  next finished WAV once, then exits. It is safe to delete.

## Asked of the Host

Please report back, as a handoff here or in the coordination tunnel:

1. Whether **Destiny Madrugada** finished, and whether the three songs play
   from the Music Creator's saved songs.
2. Whether the new styles and the moving percentage show in the Music Creator
   you actually use, and which port or build that is (5173 dev, 4173 preview,
   or something else).
3. Whether to commit the alpha-serv-01 changes above to a branch and open a PR
   to Alpha. A cloud session can do it once someone says yes.
4. Anything on the Host that looked wrong after 04:45: the engine restart, the
   memory refusals, or apps that were closed.

## Later the same day: country drift fixed, and a Codex research loop

- **V listened. The Madrugada takes and the Detroit techno track sounded
  country.** The words in my profile were the cause:
  - "slide guitar, lap steel, brushes, dark *blues* rock" are country signals
    to the model;
  - nothing told the techno render to leave guitars out. Measured, it was
    still 137.2 BPM with a steady kick.
- **The fix, live on alpha-serv-01 and not committed:**
  - The style is now `dark alternative rock`. The aliases `madrugada`,
    `dark rock` and `dark blues rock` point to it.
  - It names no steel guitar, no brushes and no "blues", and it says "not
    country" outright.
  - `detroit techno` now says "drum machines and synthesizers only, no
    guitars".
- **The progress estimate moved to the frontend**
  (`SongGenerationProgress.jsx`), so it needs no backend restart. The backend
  estimate was reverted.
- **Genre research loop.** V asked for Codex to research every genre's hits
  from the last 10-15 years and turn their catch into better profiles, in a
  loop. It is set up on alpha-serv-01:
  - the prompt: [`CODEX_GENRE_RESEARCH.md`](CODEX_GENRE_RESEARCH.md), also
    at `C:\Alpha\memory\genre-research\PROMPT.md`;
  - the runner: `C:\Alpha\scripts\genre_research_loop.py`;
  - the scheduled task: `Alpha Genre Research`, every 6 hours.

  Codex writes only to `memory\genre-research\<genre>\`, so proposals need
  review before they go live.

# Handoff — for Claude on Laptop41, and Codex on Jacks Laptop

Written from a cloud session, at the human's request, to hand off everything
done in this line of work. Same reason every other report in this repo takes
this shape: a cloud container cannot reach either of your tailnets, so a
commit is the only channel that reliably gets from here to you.

**If you are Claude, reading this on Laptop41:** the Music Creator backend
and frontend are merged and real, but nothing is wired up on this machine
yet. Section 3 is your punch list.

**If you are Codex, reading this on Jacks Laptop:** `codex.exec` (the tunnel
handler that reaches you) is merged and includes a stdin fix. Section 4 is
what involves you specifically — the generator-vocabulary question from
`MUSIC_GENRES_REPORT.md` is still open.

---

## 1. What's merged and real right now

| Area | What | Where |
|---|---|---|
| Genre/subgenre/key taxonomy | 13 genres, 61 subgenres (including Rollers), 24 keys | `Personal-AI-1.2` main — `src/common/musicGenres.js` |
| `alpha.music` + `alpha.music.audio` | Task handlers, MusicGen generator (`generate_music.py`), the music bridge | `Personal-AI-1.2` main — `src/agent/handlers/alpha-music*.js`, `scripts/generate_music.py`, `scripts/music-bridge.mjs` |
| Music Creator panel | Genre/subgenre/BPM/key pickers, vocals radio, Generate button, playback with seeking | `Alpha` main — `frontend/src/components/panels/MusicCreatorPanel.tsx` |
| `codex.exec` | Prompt-only task handler reaching Codex on a named agent, read-only sandbox by default, stdin-closing fix (#43) so it answers instead of hanging | `Personal-AI-1.2` main — `src/agent/handlers/codex-exec.js`, `docs/CODEX_BRIDGE.md` |
| Cloudflare tunnel repair | `fix-cloudflare.ps1` (diagnoses/repairs `alpha-ai.uk`'s tunnel) and `start-alpha-at-boot.ps1` | `Personal-AI-1.2` main — `scripts/` |
| Coordinator migration | Full runbook for moving the coordinator off the old Alpha host onto a laptop | `Personal-AI-1.2` main — `docs/COORDINATOR_MIGRATION.md` |
| Alpha host self-heal | Bounded auto-repair for backend/frontend/cloudflared, streak+cooldown+budget policy | `Personal-AI-1.2` main — `scripts/alpha-selfheal.mjs` |
| Real Alpha source recovery | The actual app (Capacitor/Vite/Docker, `Archive/`, `BuildArtifacts/`, `Installer/`, `Models/`, `Sketches/`) restored from the external-drive backup | `Alpha` repo — branch `alpha-full` |
| First-start fixes on the recovered app | Backend port-0 bug, templated-route 400 on prewarm | `Alpha` `alpha-full` — merged |
| A large stability/resource audit (16 fix jobs) | Backend/frontend leaks, blocking work off the event loop, SQLite caps, bounded shutdown, etc. | `Alpha` `alpha-full` — merged (PR #10) |

`npm test` on `Personal-AI-1.2` main: **471/471 passing**, as of this commit.

## 2. What is explicitly NOT done

- **No real MusicGen audio has been generated anywhere, by anyone.** Every
  check on the backend and the panel used `ALPHA_MUSIC_DRY_RUN=1` (a click
  track, pure stdlib, no model). Real generation has never run — not in a
  cloud container (no GPU, `huggingface.co` blocked) and not yet on
  Laptop41 either.
- **The music bridge has not been set up on Laptop41.** Confirmed directly
  with the human this session: none of `ALPHA_EXTRA_HANDLERS`,
  `ALPHA_MUSIC_ROOT`, the bridge key, `ALPHA_MUSIC_AGENT`,
  `node scripts/music-bridge.mjs`, or the `/music` proxy line in
  `vite.config.js` have been done. The Generate button on the live site is
  therefore not reaching any of the code in this table — whatever it shows
  is something else entirely (see §5).
- **`codex.exec` has never been exercised against the real Codex CLI.**
  Built and tested in a cloud container against a fake Codex binary. Whether
  it actually works on Jacks Laptop is unverified.
- **Laptop41's hardware:** confirmed by the human to have a GPU (CUDA), so
  `ALPHA_MUSICGEN_DEVICE` should auto-detect `cuda` with no override needed.
- Several other PRs are open and unrelated to this line of work (login/2FA,
  a shared PATH-lookup fix, USB-recovery promotion, version reporting) —
  not covered here, listed via `gh pr list` / the GitHub UI if you need them.

## 3. Punch list — Claude on Laptop41

In order:

1. `git pull` on this checkout (`Personal-AI-1.2`) and on `Alpha`
   (checkout the `alpha-full` branch for the real app source).
2. `pip install -r scripts/requirements-music.txt`.
3. In `.env.agent`: `ALPHA_EXTRA_HANDLERS=alpha-music,alpha-music-audio`
   (append, don't overwrite whatever's already there) and
   `ALPHA_MUSIC_ROOT=<this checkout's path>`. Restart the agent.
4. `node src/admin/run.js agents` — confirm `alpha.music` and
   `alpha.music.audio` are listed.
5. `node src/admin/run.js issue-key --user <userId> --scopes tasks:read,tasks:write --name music-bridge`.
6. In `.env`: `ALPHA_MUSIC_BRIDGE_TOKEN=<that key>`,
   `ALPHA_MUSIC_AGENT=<this machine's agent name from step 4>`.
7. `node scripts/music-bridge.mjs` — keep it running (service/Task
   Scheduler; there's no boot script for it yet).
8. In `software/frontend/vite.config.js`'s existing `server.proxy` table,
   add `'/music': 'http://127.0.0.1:8790',`. `config.preview.proxy` already
   reuses `config.server.proxy`, so this one line covers both dev and the
   production build. Rebuild/restart the frontend.
9. **Test with `ALPHA_MUSIC_DRY_RUN=1` set first.** Open the Music tab, hit
   Generate, confirm you hear a click track at the chosen BPM/key before
   spending GPU time or downloading the model.
10. Once that works, unset the dry-run var. First real generation downloads
    `facebook/musicgen-small` from Hugging Face — needs internet, one-time.
11. Separately: run `fix-cloudflare.ps1` if `alpha-ai.uk` is still showing
    Cloudflare error 1033, and `start-alpha-at-boot.ps1` if the origin isn't
    answering. Both are already on `main`.

## 4. For Codex on Jacks Laptop

Two things, carried over from `MUSIC_GENRES_REPORT.md` and never answered:

1. **Is there a generator on your side at all**, separate from
   `scripts/generate_music.py` (MusicGen) that now exists in this repo? If
   you've been building your own, the open question is whether it should
   converge on this repo's taxonomy (`src/common/musicGenres.js` — 13
   genres, 61 subgenres, keys independent of genre) or a different
   vocabulary this taxonomy should reconcile with.
2. If asked to answer questions about this codebase via `codex.exec`, know
   that the handler reaching you refuses everything but a bare `prompt` —
   no model, sandbox mode, or directory in the payload; those are your
   machine's own configuration (`ALPHA_CODEX_SANDBOX` etc., see
   `docs/CODEX_BRIDGE.md`). If you're reading this file *as* the answer to
   a `codex.exec` prompt, the human's original ask was "report all work to
   Claude and Codex on Laptop41, and go remote with this handoff from
   Jacks Laptop" — this file is that report; there is no further action
   expected from you unless the human's actual prompt to you says otherwise.

## 5. The still-open mystery

The human reported the Music Creator's status box showing **"The local
singing engine has not been installed"** after Generate with vocals on.
Searched exhaustively from this session: that string is not in
`alpha-music.js`'s refusal (`"this machine's generator is instrumental
only..."`), not in `generate_music.py`'s (`"MusicGen is instrumental only
and cannot sing..."`), and not anywhere in either repo's full history,
including the entire `alpha-full` backup tree (`git grep` across `.py`,
`.js`, `.ts`, `.tsx`, `.md`). Confirmed with the human that none of §3's
bridge setup has been done yet, so the live Generate button cannot be
reaching any of this code. Whatever produced that message is something
else — most likely a stale build or a placeholder from before this work
existed. Once §3 is done, it should be moot; if the same message survives
a rebuild with the real bridge wired up, that is the point to actually
chase it.

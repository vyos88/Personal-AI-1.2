# Music Creator — current state and what the Alpha host needs to update

Written for whoever operates the Alpha host next — human or agent. It reads
like `WORK_AUDIT_2026-09-15.md` and `MUSIC_GENRES_REPORT.md` for the same
reason: a commit in this repo is the only channel that reliably reaches the
next session or the next person at that keyboard.

## The short version

The Music Creator is real now, end to end, but **nothing below is merged into
`main` yet**. Everything is sitting in reviewed, tested, clean-mergeable PRs.
Merging them is the update; nothing needs writing from scratch.

| Piece | PR | Repo | State |
|---|---|---|---|
| Genre/subgenre/key taxonomy | [#39](https://github.com/vyos88/Personal-AI-1.2/pull/39) | Personal-AI-1.2 | open, not draft — this branch |
| `alpha.music` + generator + bridge | [#40](https://github.com/vyos88/Personal-AI-1.2/pull/40) | Personal-AI-1.2 | open, not draft, **verified clean against current `main` and passes 413/413** as of this write-up |
| Panel: genre/subgenre/BPM/key pickers, vocals toggle | [#4](https://github.com/vyos88/Alpha/pull/4) | Alpha | open, not draft |
| Panel: Generate button, playback, No-vocals default | [#6](https://github.com/vyos88/Alpha/pull/6) | Alpha | open, not draft, includes #4 |

## What actually works, per the PRs' own testing

**Backend (#40).** `alpha.music` takes `{genre, subgenre, bpm?, key, vocals,
seed, durationSec?}`, validates every field against the taxonomy in #39,
lets a genre suggest a BPM without pinning one, and drives
`scripts/generate_music.py` (MusicGen via `transformers`). Vocals are refused
unless the generating machine sets `ALPHA_MUSIC_VOCALS=1` — MusicGen is
instrumental only. The audio never crosses the tunnel as a task payload;
`alpha.music.audio` slices it back in 512 KB pieces, capped by the same
1 MB-per-result limit every handler here respects. `npm test`: 392/392 at
the PR's own head; 413/413 once merged onto current `main` (this branch
tested that merge just now and did not push it).

**Frontend (#4 + #6).** The panel drove a real coordinator, a real agent and
the real `generate_music.py` in `ALPHA_MUSIC_DRY_RUN=1` (a click track — no
GPU needed) through 34 checks in headless Chromium: instrumental defaults
correctly, a vocals request is refused with the machine's own reason, BPM
validation matches the handler's, status text tracks queued → generating →
done, and **the player actually loads the track through the bridge, reports
its length, plays, and seeks**.

**What neither PR could verify from a cloud container:** real MusicGen
output. No GPU, and `huggingface.co` is blocked from here. Both PRs say so
explicitly. **The first real generation belongs on Laptop41** — that's not a
gap in the code, it's the one check that can only happen there.

## What merging buys, in order

1. Merge #39 into `main` here (this branch — genre taxonomy, no dependents).
2. Merge #40 into `main` here (needs #39; already includes it internally, so
   merging #40 alone lands both, same as its own description says).
3. Merge #4 then #6 into `vyos88/Alpha`'s `main` (#6 already includes #4).

None of the three conflict with the Cloudflare-tunnel or coordinator-migration
work merged since (`fix-cloudflare.ps1`, `start-alpha-at-boot.ps1`,
`docs/COORDINATOR_MIGRATION.md`, the self-heal scripts) — checked directly by
merging current `main` into #40's branch locally; it merged clean.

## To actually run it on the Alpha host

```bash
# generating machine (needs the GPU)
pip install -r scripts/requirements-music.txt
# .env.agent:
#   ALPHA_EXTRA_HANDLERS=alpha-music,alpha-music-audio
#   ALPHA_MUSIC_ROOT=<this checkout>

# machine serving Alpha's frontend
node src/admin/run.js issue-key --user <userId> --scopes tasks:read,tasks:write --name music-bridge
# .env:
#   ALPHA_MUSIC_BRIDGE_TOKEN=<key>
#   ALPHA_MUSIC_AGENT=<generating machine's name>
node scripts/music-bridge.mjs
# then route Alpha's /music/* to 127.0.0.1:8790
```

`ALPHA_MUSICGEN_MODEL` and `ALPHA_MUSICGEN_DEVICE` are optional overrides;
the default is `facebook/musicgen-small` on whichever of cuda/mps/cpu is
available. Set `ALPHA_MUSIC_DRY_RUN=1` first to prove the whole chain — panel
to bridge to coordinator to agent to script to player — before spending GPU
time on a real model.

## What is still open

- **Nothing has generated real audio anywhere.** Every check above ran the
  dry-run click track. The taxonomy, the validation, the queueing, the
  playback pipeline are all proven; the model itself is not.
- **#4 and #6 were tested outside the Alpha repo's own build**, since most of
  what `AppShell.tsx` imports still isn't in that repo (see the earlier
  finding that only the shell file and this Music Creator work exist there
  in version control). Merging them doesn't by itself make the whole app
  build — that depends on the `alpha-full` recovery work landing too.
- **`ALPHA_MUSIC_AGENT` and `ALPHA_MUSIC_BRIDGE_TOKEN` are not yet set
  anywhere real.** The bridge refuses to guess a machine or accept the
  browser's own credentials by design — both env vars above are the
  operator's decision, not something a PR can set for you.

# Music creator — genre/subgenre taxonomy (first edit)

For Codex, and for whoever picks this up next. Written the same way
`WORK_AUDIT_2026-09-15.md` was: a report committed to the repo, because that
is the only channel that reaches an agent working from a different checkout.

## What landed

`src/common/musicGenres.js` — a genre → subgenre taxonomy, 13 genres, 60
subgenres. Pinned by `test/musicGenres.test.js` (7 tests, all passing; full
suite is 343/343).

This is the first edit toward the music creator, in the order asked for:
understand the genres and subgenres first, implement them, then build on top.
**It is data and lookup helpers only — no audio is generated here, and no
task type exists yet.**

## Why BPM lives on the taxonomy

An earlier request in this line of work was: let a person choose their own
BPM for a track. A genre taxonomy that pinned one fixed tempo per genre would
fight that directly — "Techno is 130 BPM" is false the moment someone wants
128. So every subgenre carries a `bpmRange` (what actually occurs in that
style) and a `defaultBpm` (what a picker suggests before the user touches
anything), never a single mandatory number:

```js
{ name: 'Techno', bpmRange: [120, 150], defaultBpm: 130 }
```

`suggestBpm(genre, subgenre)` returns the default to seed a UI control.
`isBpmTypical(genre, subgenre, bpm)` tells you whether a chosen BPM is
in-character for that subgenre — it is informational, never a limiter. Both
return `null` on an unknown name rather than throwing, so a caller can tell
"unknown" apart from "false" without a try/catch.

## What this is not, and what's still open

This repository is the tunnel — the coordinator/agent that routes tasks
between machines — not the music creator itself. Nothing here plays or
renders audio, the same way `alpha.render`'s species/seed recipe is not the
image. Whatever actually synthesizes a track (the audio equivalent of
Blender + `generate.py`) still needs to exist somewhere, and per the standing
finding in `WORK_AUDIT_2026-09-15.md` §5, **I still have no visibility into
where Codex's work lives** — no commit, no branch, no string naming it
anywhere in this repo's history, as of this write-up.

If Codex is building the actual generator (on the other machine mentioned in
this conversation), the open questions are the same shape as the render
question:

1. Does that generator take a genre/subgenre as an input, and if so, does it
   expect these exact names, or a different vocabulary this taxonomy should
   be reconciled with?
2. Does it take a BPM directly, or does BPM only ever inform higher-level
   parameters (bars, swing, etc.)?
3. Where does the finished audio live once generated — same principle as
   `alpha.render`, where the recipe travels and the heavy artifact stays on
   the machine that made it?

None of those can be answered from this checkout. Once there's an answer,
the natural next step mirrors `alpha-render.js`: an opt-in `alpha.music`
handler that pins the generator's executable/script path, validates its
payload against an allowlist (genre, subgenre, bpm, seed — never a raw
generator flag), and returns a recipe rather than the audio file.

## Suggested next edit

Wire this taxonomy into whatever surface actually lets a person pick a
genre and a BPM — that is the Alpha frontend's music creator, not this
repository, and as of the last check that panel does not exist yet either.

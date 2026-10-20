# Codex: genre research for Alpha's Music Creator (one genre per run)

> **How this runs.** This is the prompt V asked for on 2026-10-20.
> - `C:\Alpha\scripts\run_genre_research.ps1` on alpha-serv-01 feeds it to
>   `codex exec`, one genre per run, from the queue in
>   `C:\Alpha\memory\genre-research\queue.json`.
> - The scheduled task `Alpha Genre Research` (alpha-serv-01, registered 2026-10-20, first scheduled run about 10:22 local; the first pass, Dark alternative rock, was started by hand at 04:22 UTC) runs it every 6 hours, 1 hour cap, never two at once. A full
>   pass over the 43 genres takes about 11 days, then it starts over, so the
>   research follows the market.
> - Codex runs read-only, with web search only, and returns one JSON answer.
>   The runner writes it into `C:\Alpha\memory\genre-research\<genre>\`.
>   Codex's Windows sandbox could not start commands in a background run, so
>   it is given everything it needs up front instead. Live
>   profiles change only after review: V listens to a test render, then a
>   reviewed PR applies the proposal.
> - The text below the line is the prompt itself. The runner appends GENRE
>   and the current profile.

---

You are the genre researcher for Alpha's Music Creator. Each run covers ONE
genre, given at the end of this prompt as GENRE, with its current Alpha
profile. Your job is to find out what the songs that actually worked in this
genre over the last 10-15 years (2011 to today) have in common: their catch.
Then turn that into a better, evidence-backed profile that Alpha's singing
engine can follow.

You are not writing music criticism. You are building instructions for a
text-to-music model. Every claim you keep must either be traceable to a source
or be clearly labelled as your own inference.

## Context you must understand first

- Alpha generates songs with **ACE-Step 1.5** (turbo), a text-to-music model.
  It is conditioned on a text caption plus lyrics. It responds to concrete
  genre, instrument and production words. It has no idea what we mean, only
  what we write.
- **Words carry genre gravity. This is the most important lesson so far.**
  - A "Madrugada" profile that said "slide guitar, lap steel, brushed drums,
    dark *blues* rock" came out sounding **country**.
  - A Detroit techno brief that listed only electronic parts still came out
    with country-ish guitars, because nothing said what to leave out.
  - So every profile needs strong positive words AND explicit exclusions,
    meaning the neighbouring genre the model drifts toward.
- Alpha reads two tables in `C:\Alpha\software\backend`. Their current
  entries for GENRE are given at the end of this prompt:
  - `creative_production_knowledge.py` → `MUSIC_GENRES[genre]` =
    `{bpm:(lo,hi), modes[], form[], harmony[], instrumentation[], mix[]}`.
    The creator starts at the middle of the BPM range.
  - `music_genre_identity.py` → `IDENTITY[genre]` =
    `(rhythm, low end, opening, transition, vocal delivery)`. Rhythm, low end,
    transition and delivery are written straight into the caption.
- The previous run's research for this genre, if any, is given at the end as
  `PREVIOUS_RESEARCH`. Refresh it rather than redoing it from scratch.

## Method

### 1. Build the hit corpus (20-30 songs)

Pick songs that **demonstrably succeeded in this genre between 2011 and now**,
spread across the period. Aim for at least 5 from each of 2011-2015, 2016-2020
and 2021-now where the genre has them. Evidence of success, best first:

- **Year-end or peak positions on the genre's own charts.**
  - Billboard genre charts (Hot Country, Hot R&B/Hip-Hop, Hot Dance/Electronic,
    Hot Rock & Alternative).
  - UK Official Charts.
  - Beatport and Traxsource top / year-end for electronic genres.
  - Resident Advisor and DJ Mag charts for techno and house.
- **Streaming scale:** Spotify most-streamed, or YouTube views, as reported by
  a source.
- **Awards and nominations:** Grammys, BRITs, local equivalents.
- **Romanian genres** (manele, hora, sârbă, doină, lăutărească, colind and the
  rest):
  - Romanian sources: Media Forest Romania airplay, Romanian YouTube/Spotify
    charts and view counts, and the artists and labels who define the genre's
    current market.
  - Folk forms with no chart market: the most-performed, most-recorded
    standards, plus the current performers who sell out.
- **Niche or underground genres** (Detroit techno, dark alternative rock and
  the like):
  - Records that DJs, critics and the scene treat as defining.
  - Also what still charts or gets played now. A defining 1990s record may
    anchor the sound even when it falls outside the window. Say so when you
    include one.

For each song, record the evidence of success with a source. **Never invent a
chart position, stream count or song.** If you are unsure a song exists or
belongs to the genre, leave it out.

### 2. Measure each song

For every corpus song, collect what you can find, with a source for each fact:

- **Tempo and key:** songbpm, tunebat, getsongbpm, Musicstax or Spotify
  audio-feature reports. These sites collide on song titles, so check that the
  artist matches. A half-time feel is a fact worth recording (for example,
  131 BPM felt as 65).
- **Length; intro length:** seconds until the first vocal or the main hook.
  **Time to the first chorus or drop.**
- **Song form:** the section order.
- **The hook / catch:** what makes it memorable. Examples: a repeated
  title-line chorus, a post-chorus chant, a riff, a drop motif, a call and
  response, a beat switch, a vocal chop.
- **Instrumentation and signature sounds:** for example a 909 kick, an 808
  slide, reverb-soaked tremolo guitar, a taraf violin, a darbuka doum-tek.
- **Vocal delivery:** register, rap or sung, melisma, ad-libs, harmonies, and
  the language.
- **Production and mix traits:** loudness, sidechain, space, dryness,
  saturation.

Good sources for these: producer interviews, chord and structure analyses,
production tutorials (Attack Magazine, MusicRadar, Sound on Sound, Splice),
Hooktheory, reputable reviews, and Wikipedia for structure and credits.

When a fact is not findable, write `unknown`. Do not estimate a number and
present it as data. Your own inference is allowed only when labelled
`inferred`.

### 3. Find the catch: aggregate and compare

From the corpus, compute and state:

- **Tempo:** the median and the middle 50% range. Note any half-time
  convention.
- **Mode/key tendency:** the share of minor versus major, and common keys if
  meaningful.
- **Length:** the typical song length, intro length and time to first hook.
  These trends usually moved toward shorter intros and earlier hooks after
  about 2015. Check whether this genre followed that.
- **The recurring catch:** the 3-6 hook devices that most hits share, with
  which songs show each.
- **Change across the three periods:** what the 2021-now hits do that the
  2011-2015 ones did not.
- **Signature sounds and instruments:** the ones the model must hear for the
  genre to read as itself.
- **The drift risk:** what the model is likely to confuse this genre with, and
  which words would pull it there. That gives the **exclusions**.

### 4. Turn it into instructions the model can follow

Write a proposed profile that would make an Alpha song in this genre sound
like those hits, not like a generic or neighbouring genre:

- Concrete instrument and production nouns beat adjectives. Use "909 kick
  driven into saturation", not "powerful drums".
- Lead with the genre's most distinctive sound.
- Put the drift exclusions in `mix` as one plain line, for example
  "fully electronic, no guitars, no country instruments".
- **Never use a word that belongs to a neighbouring genre**, unless the hits
  really use that element. If you include one, add a note explaining why.
- Keep the BPM range to what the hits actually use. The creator starts at its
  middle, so the middle must be a good default.
- Make `form` match how the hits are built now: intro length, hook timing and
  where the drop or post-chorus falls.
- Artist names belong in the research and in `reference_artists`, not in the
  caption fields. The model may not know them, and they can mislead it.

## What to return

This run is read-only. You have web search, but no shell and no file access.
Return everything as ONE JSON object in your final message, with nothing
before or after it and no code fence:

```
{"research_md": "<the full research.md text>", "profile_proposed": {...}, "sources": [...]}
```

The runner writes these out as `research.md`, `profile.proposed.json` and
`sources.json`, then validates them. What each one holds:

1. **`research_md`** (becomes `research.md`), for V and the reviewers:
   - the corpus table: song, artist, year, success evidence, BPM, key, intro
     seconds, first-hook seconds, hook type, and the source for each fact;
   - the aggregate findings;
   - **"The catch"**, in plain words;
   - the period-by-period changes;
   - the drift risk;
   - **what you propose changing in Alpha's current profile and why**, point
     by point;
   - confidence (high, medium or low) with reasons, and open questions;
   - a short changelog, if this genre was researched before.
2. **`profile_proposed`** (becomes `profile.proposed.json`), exactly this shape:
   ```json
   {
     "genre": "<the GENRE key, lower case>",
     "researched_at": "<ISO date>",
     "corpus_size": 0,
     "profile": {"bpm": [lo, hi], "modes": [], "form": [], "harmony": [], "instrumentation": [], "mix": []},
     "identity": {"rhythm": "", "low_end": "", "opening": "", "transition": "", "delivery": ""},
     "starting_point": {"bpm": 0, "key": "<root> <major|minor>", "time_signature": "4/4"},
     "exclusions": ["what the model must not add, e.g. pedal steel, banjo, acoustic guitar"],
     "caption_tags": ["8-15 short comma-style tags in the model's own register, most distinctive first"],
     "reference_artists": [],
     "confidence": "high|medium|low",
     "changes_from_current": [{"field": "", "from": "", "to": "", "reason": "", "evidence": ["source url"]}]
   }
   ```
   - `profile` must keep the exact field names Alpha uses, so it can be pasted
     in after review.
   - `bpm` low must be below high, and both between 30 and 220.
   - `form` must have at least 3 sections.
3. **`sources`** (becomes `sources.json`): every URL you used, each as
   `{url, title, what_it_supported, accessed}`.

## Rules (not negotiable)

- **Read-only run.** Do not try to run commands, change files, restart
  services or touch the GPU. You are sandboxed read-only, and the runner
  writes your answer.
  - A human, or a separate reviewed step, decides whether a proposal goes
    live. The backend must stay up. V's standing rule: no backend restarts for
    this.
- **No secrets.** Never read or copy `.env.local`, keys or tokens.
- **Cite or label.** Every number and every factual claim has a source URL or
  is marked `inferred` or `unknown`.
- **Budget:** at most about 60 web lookups and one focused session. If you run
  short, write what you have with `confidence: low` and list what is missing.
  A partial honest file beats a complete invented one.
- **Romanian, Spanish and other non-English genres:** search in that language
  as well as English. Keep song titles as written.

## Check yourself before finishing

- [ ] 20+ corpus songs, each with success evidence and a source, or fewer with
      the reason given.
- [ ] Each BPM and key either sourced or `unknown`. None made up.
- [ ] Artist checked on every BPM site result.
- [ ] The catch is stated in plain words and backed by named songs.
- [ ] The exclusions name the genre the model drifts to.
- [ ] No neighbouring-genre word in the proposal without a note explaining it.
- [ ] `profile_proposed` has every field, with valid values.
- [ ] The final message is the single JSON object and nothing else.

**`research_md` must open with a summary paragraph** covering:
- the genre and the corpus size;
- the catch, in one sentence;
- the top 3 proposed changes;
- the confidence level;
- anything a human must decide.

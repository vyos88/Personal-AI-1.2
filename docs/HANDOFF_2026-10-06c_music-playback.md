# Handoff: songs in the playlist that would not play (2026-10-06, late)

To whoever is next at Host or Worker1, and to Alpha. The owner reported that
"a lot of songs" in alpha-ai.uk's playlist cannot be played. One example is
"În vale la grădină" (100 BPM, D minor, RO), which shows "Audio download timed
out. Try again; large WAV files can take longer to load." They also asked why
a 40-second track is so big when a whole MP3 song is 8-20 MB.

The fix is in this PR. **It does nothing until the steps under "To make it
live" are done on the laptops.** The cloud session that wrote it cannot reach
them.

## Why songs would not play

There were four causes, and each was enough by itself:

1. **The coordinator forgets the track, but the playlist does not.** The
   playlist (`/music/recipes`) lists the receipt ledger, which keeps 5,000
   receipts on disk. Play looked the task up in the queue, which drops a
   finished task after 24 h, or as soon as 1,000 newer tasks have finished.
   The fleet's own traffic counts towards those 1,000: the peer handoff alone
   posts about 80 tasks an hour, and every played track adds one task per
   512 KB slice. So a track made in the morning answered `unknown_task` by
   the evening.
2. **A busy laptop never sent the slices.** The file stays on the laptop that
   made it, and it comes across as `alpha.music.audio` tasks, one per 512 KB.
   Agents run one task at a time. While that laptop was making another song
   (400-720 s on the Host on 2026-10-06), every slice waited behind it. The
   bridge gave up on each slice after 60 s.
3. **Try again started from zero.** A cut-off download threw away what had
   already come across.
4. **WAV is about ten times the size it needs to be.** MusicGen writes 32 kHz
   mono WAV, roughly 64 KB a second. Other generators write CD-quality or
   float stereo, at 176-384 KB a second. A 40-second track is therefore
   2.5-15 MB, which is 5-30 slices, each one a task through the coordinator.

## What changed

- **Playback falls back to the ledger** (`src/bridge/music.js`,
  `musicTask`). Status and Play now find a forgotten generation through its
  receipt, which has the recipe, the output names and the machine. The
  receipt also supplies the machine for a task that was queued untargeted,
  which used to be `no_music_machine` forever. The bridge still only reads
  music tasks: a receipt of any other type stays a 404.
- **Express lane on the agent** (`src/agent/agent.js`, `#expressLoop`;
  `EXPRESS_TASK_TYPES` in `protocol.js`). While its slots are full, an agent
  still takes `alpha.music.audio`, one task at a time. Its poll carries
  `types=alpha.music.audio`. The coordinator now honours `types` on
  `/agent/:id/tasks/next`, which can narrow the poll but never widen it, and
  says so with `features: ['poll-types']` at registration. An agent only opens
  the lane against a coordinator that says it. An older coordinator would
  hand that poll any task, and two songs at once on a 4 GB card must never
  happen. A test pins that the second song stays queued.
- **The bridge waits and resumes.** A slice may wait up to 15 min to be
  picked up (`queueWaitMs`), then has 60 s to arrive. The download keeps its
  part in `<task>-<track>.part`, with a `.part.json` marker that names the
  file version, and carries on from there next time. A file that changed
  starts over, as before. A play request is held for 45 s (`holdMs`, under
  Cloudflare's 100 s). After that it gets `503 still_fetching` with how far
  the download has got and `Retry-After: 5`, while the download goes on in
  the background.
- **MP3 over the tunnel** (`alpha-music-audio.js`). The bridge asks for
  `format: "mp3"`. The agent encodes a WAV or FLAC once with ffmpeg (LAME V2,
  about 190 kbps stereo) into `<output>/.compressed/<genre>/`, re-encodes it
  when the WAV is newer, and sends that copy. The WAV the generator wrote is
  not touched. The agent looks for ffmpeg in this order: `ALPHA_MUSIC_FFMPEG`
  (`off` disables it), then `ffmpeg` on PATH, then the one `imageio-ffmpeg`
  installs (now in `requirements-music.txt`). With no ffmpeg, or a failed
  encode, it sends the WAV as before. An agent from before this change
  refuses the `format` key, and the bridge then asks it again for the
  original. A 20 s tone took 1 slice instead of 3 in the tests.

Tests: `test/music-playback.test.js` (new, 9) and `test/alpha-music-audio.test.js`
(+2). The full suite: 733 tests, 697 pass, 0 fail, 36 skipped, run in a
Linux cloud container with ffmpeg on PATH. Nothing was tested on the laptops.

## To make it live (needs a person at the laptops)

1. **Host**: `cd C:\services\alpha-tunnel; git checkout main; git pull`, then
   restart the coordinator (`alpha-coordinator`) and the Host agent. Until
   the coordinator restarts, agents keep the express lane closed. Everything
   else still works.
2. **Worker1**: `git pull` and restart the `worker1` agent and the music
   bridge (127.0.0.1:8790).
3. **Each music machine**: install the requirements again with the
   generator's Python, so `imageio-ffmpeg` is installed:
   `<python> -m pip install -r scripts\requirements-music.txt`. You can also
   point `ALPHA_MUSIC_FFMPEG` at an ffmpeg that is already installed. Restart
   the agent afterwards.
4. Check: play an old track from the playlist. The first play of a track
   should take seconds, not minutes. `<output>\.compressed\` should fill with
   `.mp3` files.

## Not done here (needs the live Alpha source, which is not in git)

- The alpha-ai.uk playlist page ("PLAYLIST · All your songs · Refresh") and
  its "Audio download timed out" message are in no branch of either repo.
  The page should treat `503 still_fetching` as "try again in 5 s" by itself,
  as the Alpha-repo panel now does (vyos88/Alpha, Music Creator panel).
- "În vale la grădină" has Romanian vocals. `generate_music.py` (MusicGen) is
  instrumental only, so that song came from another generator. If that
  generator goes through `alpha.music` (`ALPHA_MUSIC_SCRIPT`), everything
  above applies to its tracks. If the page plays it from somewhere else,
  none of it does.
- **Length.** `alpha.music` takes up to 300 s, and the Alpha panel now
  offers up to 5 min. On the Host's RTX 3050 a track takes roughly ten times
  its own length to make (jobs 30 and 35: 5 s in 44-68 s). So a 3-minute
  song is about half an hour of the GPU, and longer if ComfyUI has not freed
  it.

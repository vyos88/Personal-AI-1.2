# Autopilot: repairs on Laptop41 without pasting commands

A cloud session cannot reach the tailnet. Until now, every repair on Laptop41
was a block of commands for the owner to paste, on the right laptop, in the
right folder. `scripts/autopilot.ps1` replaces that.

## Install once (Laptop41, Administrator PowerShell)

```powershell
cd C:\services\alpha-tunnel; git pull
powershell -ExecutionPolicy Bypass -File scripts\autopilot.ps1 -Install
```

It refuses to install or run on any machine but `DESKTOP-41HPLCN`. To remove
it, run `... scripts\autopilot.ps1 -Uninstall`.

## How a session uses it

1. Commit `actions.json` to the branch `control/laptop41`:
   ```json
   {"actions": [
     {"id": "2026-10-06-repair", "do": "repair-host"},
     {"id": "2026-10-06-lyrics", "do": "ollama-pull", "model": "llama3.2:3b"}
   ]}
   ```
2. Within 5 minutes the task does the following:
   - fast-forwards the checkout;
   - runs each id it has not run before;
   - pushes `reports/autopilot.md` to `status/laptop41-autopilot`. The report
     holds the exit code and the last 60 lines of output, with
     credential-looking values cut.
3. Each id runs once. To run an action again, give it a new id.

## The menu

Nothing outside this list runs. An unknown `do` is refused and the refusal is
reported.

| do | runs |
|---|---|
| `doctor` | `laptop41-doctor.ps1 -Watch -Push` |
| `repair-host` | `repair-alpha-host.ps1`, with its own rollback |
| `restart-backend` | Stops whatever listens on the backend port, then starts it again: the `Alpha Backend` task if it exists, otherwise `scripts\start-local.ps1`. |
| `restart-coordinator` | On the Host: stops the scheduled task `alpha-coordinator` and whatever holds its port (8787, or `ALPHA_HOST_PORT`), starts the task again from the current checkout, and fails unless `/healthz` answers. A `git pull` alone leaves the coordinator on its old code. The queue survives (`data/tasks.json`) and agents re-register by themselves. Takes no arguments |
| `restart-site` | Stops whatever holds the site's port (4173) with its process tree and starts task `Alpha` again, then asks `/music/healthz` through the site. `Stop-ScheduledTask` alone left the old preview server serving its old `vite.config.js` |
| `apply-update` | `apply-alpha-update.mjs --apply --restart`; add `"skipScripts": true` to leave `scripts\` alone |
| `snapshot` | `snapshot-alpha-live.mjs --push`; `"allow": "file:line,..."` must list only lines a person has reviewed; `"includeNew": true` also brings source files only this machine has (source folders and extensions, each under 512 KB, credential-scanned like the rest) |
| `ollama-pull` | `ollama pull <model>` (name:tag only) |
| `ollama-keepalive` | `ollama-keepalive.ps1`: sets `OLLAMA_KEEP_ALIVE` (default `24h`, or `"keepAlive"`), restarts Ollama, loads the chat model (`"model"`), and fails unless Ollama keeps it at least an hour |
| `enable-music` | `enable-music.ps1`: installs MusicGen (`requirements-music.txt`), adds `alpha-music,alpha-music-audio` to the agent's `.env.agent` (backed up; nothing in it printed), restarts `alpha-tunnel agent`. `"bridge": true` on the machine that serves Alpha also runs the music bridge at logon (`start-music-bridge.ps1`: key from `ALPHA_REPORT_TOKEN`, `ALPHA_MUSIC_AGENT=auto` spreads tracks over every music machine). `"dryRun": true` makes click tracks, no model |
| `enable-image` | `enable-image.ps1`: adds `alpha-image,alpha-image-file` to the agent's `.env.agent` (backed up; nothing printed) with this machine's generator (`"backend"`: `a1111` = Worker1's 7860, `comfyui` = 8188), restarts the agent. `"installComfy": true` installs ComfyUI + SD 1.5 (CUDA torch if an NVIDIA GPU, else CPU) as the logon task `ComfyUI`. `"bridge": true` runs the image bridge on 7861 and points Alpha's `IMAGE_GEN_URL` at it, keeping the direct generator in `IMAGE_GEN_URLS` as the fallback |
| `live-test` | `live-test-creators.mjs` on the machine that serves Alpha: real tracks and images through both bridges, one line per job (machine, seconds, size); fails unless every job worked; says whether work was shared (`"count"` 1-6, `"only"`: `music`/`image`) |
| `brain-topology` | `brain-topology-check.mjs`: the brain deck's links, from the backend's anatomy map through the deck's source to the build the site serves; with `"fix": true` and `"branch"`, brings in the fixed deck from that Alpha branch (`apply-alpha-update.mjs`, backups and rollback) |
| `start-task` | `Start-ScheduledTask` for `Alpha`, `Alpha Backend`, `Alpha Self-Heal` or `Alpha Doctor` |

## Long queues

A pass saves its progress after every action, so a pass that Task Scheduler
stops at the task's time limit never runs an action twice, and what it did is
reported by the next pass. The task's limit is 6 hours (a machine installed
with the old 2-hour limit raises it on its next pass), and a pass does not
start an action that would not fit in what is left: that action, and what is
queued after it, waits for the next pass, five minutes later.

## Standing checks

- Bridges, every pass and before any queued action: when the scheduled task
  `alpha-music bridge` (port 8790) or `alpha-image bridge` (port 7861) is
  registered but nothing listens on its port, the task is ended and started
  again, and the report says whether it answers now.

Some checks run on every pass, with no id, and report only when their result
changes. They are turned on in the same `actions.json`:

```json
{ "actions": [ ... ], "autofix": { "brainTopology": { "branch": "claude/friendly-wright-jw4ep6-route-b" } } }
```

- `brainTopology`: when this machine serves the old brain deck (a ring and
  lines from an empty point, not the links `/neurobrain/anatomy-map` sends),
  the autopilot brings in the fixed deck from that branch and checks again.
  It tries once per version of the deck's source, so a fix that does not take
  is reported, not repeated every five minutes. A stale build alone is left to
  the doctor (section 5d says which). A machine with no Alpha skips it.

- `liveSync` (`{ "branch": "<live branch>", "capture": true }`): every pass,
  the live branch is delivered to this machine (`apply-alpha-update.mjs`, each
  tip tried once), and its `memory/knowledge` documents are written where
  Alpha reads them, with a backend restart when one is new. With `capture`, when this machine runs the tip, the source
  edited here and the source only it has are pushed back to the branch,
  fast-forward only; files with credential-looking lines are held back and
  listed, ending with an `ALLOW WITH:` line. `allow` (a `path:line,...`
  string or a list) is the owner's approval of exactly those lines; one
  malformed entry and none of it is used. `skipScripts: true` leaves
  `scripts\` out. See `docs/LIVE_SYNC.md`.

- `deckLiveness` (`true`, or `{ "everyMin": 15 }`): runs Alpha's own
  `scripts\alpha_deck_liveness.py` (live sync delivers it) with the Python the
  backend runs, at most every `everyMin` minutes (5 to 1440, default 15).
  - Every source behind Alpha's decks is judged by its own freshness field:
    the hub pulse's probe report, the command centre, the device topology,
    the CrowPanel feed and whether a panel is actually reading it, and the
    built site and its assets.
  - The verdicts are LIVE, DEGRADED, STALE, PLACEHOLDER, SETTING (a setting,
    not a fault, keeps it from going live), DOWN or ERROR. Static decks and
    the serial-only Lite Deck are named as such.
  - It reads only. It never asks `/panel/crowpanel/public-state`, which would
    count this machine as a panel. It signs in with a 10-minute token minted
    on the machine and never printed.
  - The receipt is in `memory\local\deck-liveness\latest.json`, where Alpha
    can read it. A change of verdict is reported; ages alone are not.

## Trust

The task runs as the owner, elevated, while the owner is logged on. Anyone
who can push to this repository can therefore run these actions on Laptop41.
That was already true of anything the owner pulls and runs. Keep this
repository private, and keep the menu short.

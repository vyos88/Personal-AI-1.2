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
| `fleet-inventory` | `fleet-inventory.ps1`: one read-only list of everything Alpha runs here, in the report's 60 lines. It covers scheduled tasks (state, last run, result, next run, what they run), services, background processes grouped by role (coordinator, agent, keeper, bridges, backend, site, ComfyUI, stewards by script name), DUPLICATES of anything that should run once, listening ports, and Alpha's Agent Manager snapshot. It starts, stops and writes nothing, and takes no arguments |
| `alpha-move-check` | `alpha-move-check.ps1`: read-only. Can this machine run Alpha, and what would moving Alpha here or away have to carry? It reports RAM, disk, power and GPU; every Alpha copy (branch and commit) and whether it has a backend, frontend, `node_modules` and `dist`; the runtime data folders with their sizes; whether `.env.local` is present (its size only, never opened); the venv, git, Node, Python, Ollama and its models, cloudflared and Tailscale; the ports Alpha uses and the scheduled tasks it runs; and a `MISSING TO RUN ALPHA HERE` list. It starts, stops and writes nothing, and takes no arguments |
| `prepare-alpha-here` | `prepare-alpha-here.ps1`, Phase 1 of the Alpha move (`HANDOFF_2026-10-07d`) on a machine that does not run Alpha yet. It: clones `vyos88/Alpha` at the live branch into `<profile>\Downloads\VyoS-advance-tech-ai`, or fast-forwards that clone and never pulls over local changes; creates `.venv` with the backend requirements; runs `npm ci` and the build; starts Ollama and pulls `llama3.2:3b`; and installs cloudflared. It starts no backend, site, tunnel or service, never touches `.env.local` or Alpha's data, and takes no arguments. It refuses when something listens on 8001 (a machine that already runs Alpha), and when the target exists but is not a git checkout |
| `restart-coordinator` | On the Host: stops the scheduled task `alpha-coordinator` and whatever holds its port (8787, or `ALPHA_HOST_PORT`), starts the task again from the current checkout, and fails unless `/healthz` answers. A `git pull` alone leaves the coordinator on its old code. The queue survives (`data/tasks.json`) and agents re-register by themselves. Takes no arguments |
| `restart-site` | Stops whatever holds the site's port (4173) with its process tree and starts task `Alpha` again, then asks `/music/healthz` through the site. `Stop-ScheduledTask` alone left the old preview server serving its old `vite.config.js` |
| `stop-stray-site` | `stop-stray-site.ps1`: stops a leftover `vite preview` tree, the one fleet-inventory's `DUPLICATES: Alpha site x2` means, with the `npm run preview` waiting on it. The live site is whatever listens on 4173, with every process above it, and is never touched. Nothing is stopped when nothing listens on 4173 or a non-vite process does. A `vite` dev server is reported and left alone. Fails unless the site still answers on 4173 from the same listener afterwards. Takes no arguments |
| `comfyui-off` | `comfyui-off.ps1`, the owner's yes of 2026-10-07 (option A): stops every ComfyUI process (a python running `main.py` from a ComfyUI folder) with its tree, from the highest parent that is itself a ComfyUI launcher, never a parent that does not name ComfyUI; stops and disables scheduled tasks whose action names ComfyUI and reports Startup-folder entries that do; takes `alpha-image` and `alpha-image-file` out of the agent's handlers and restarts it, so the image bridge sends pictures to the other machines. Prints free memory before and after. Fails if anything still answers on 8188 or a ComfyUI process is left. Takes no arguments |
| `apply-update` | `apply-alpha-update.mjs --apply --restart`; add `"skipScripts": true` to leave `scripts\` alone |
| `snapshot` | `snapshot-alpha-live.mjs --push`; `"allow": "file:line,..."` must list only lines a person has reviewed; `"includeNew": true` also brings source files only this machine has (source folders and extensions, each under 512 KB, credential-scanned like the rest) |
| `ollama-pull` | `ollama pull <model>` (name:tag only) |
| `ollama-keepalive` | `ollama-keepalive.ps1`: sets `OLLAMA_KEEP_ALIVE` (default `24h`, or `"keepAlive"`), restarts Ollama, loads the chat model (`"model"`), and fails unless Ollama keeps it at least an hour |
| `enable-music` | `enable-music.ps1`: installs MusicGen (`requirements-music.txt`), adds `alpha-music,alpha-music-audio` to the agent's `.env.agent` (backed up; nothing in it printed), restarts `alpha-tunnel agent`. `"bridge": true` on the machine that serves Alpha also runs the music bridge at logon (`start-music-bridge.ps1`: key from `ALPHA_REPORT_TOKEN`, `ALPHA_MUSIC_AGENT=auto` spreads tracks over every music machine). `"dryRun": true` makes click tracks, no model |
| `enable-image` | `enable-image.ps1`: adds `alpha-image,alpha-image-file` to the agent's `.env.agent` (backed up; nothing printed) with this machine's generator (`"backend"`: `a1111` = Worker1's 7860, `comfyui` = 8188), restarts the agent. `"installComfy": true` installs ComfyUI + SD 1.5 (CUDA torch if an NVIDIA GPU, else CPU) as the logon task `ComfyUI`. `"bridge": true` runs the image bridge on 7861 and points Alpha's `IMAGE_GEN_URL` at it, keeping the direct generator in `IMAGE_GEN_URLS` as the fallback |
| `live-test` | `live-test-creators.mjs` on the machine that serves Alpha: real tracks and images through both bridges, one line per job (machine, seconds, size); fails unless every job worked; says whether work was shared (`"count"` 1-6, `"only"`: `music`/`image`) |
| `promo-reel` | `promo-reel.mjs` on the machine that serves Alpha: a 25-second vertical reel about Alpha for posting. Six scenes from the image bridge, a synthwave track from the music bridge, Alpha's renderer at high quality with one caption per scene, saved as `alpha-promo-reel-<time>.mp4` in Alpha's `artifacts\generated\videos` (Video Creator > "Open a saved Alpha video", then "Download MP4"). A failed scene is left out, no track means a silent reel (said so); fails under 4 scenes or if the renderer fails. Takes no arguments |
| `brain-topology` | `brain-topology-check.mjs`: the brain deck's links, from the backend's anatomy map through the deck's source to the build the site serves; with `"fix": true` and `"branch"`, brings in the fixed deck from that Alpha branch (`apply-alpha-update.mjs`, backups and rollback) |
| `panel-host` | `fix-panel-host.mjs --env <the .env.local beside -AlphaRoot>`: adds this machine's own home-network address to `HOST` and `ALPHA_TRUSTED_HOSTS`, and to the `--host` list in the boot task's wrapper (`%ProgramData%\AlphaBoot\run-alpha-backend.cmd`), which wins over `HOST` (every address already there stays; a `.bak` of each file is written first), turns `ALPHA_PANEL_LAN_READ` on, restarts the backend the way `apply-update` does (the port's holder is stopped too), and fails unless the deck feed answers from that address within two minutes. It stops, changing nothing, if that file sets no `HOST` (then the backend's addresses come from somewhere else, and writing one could drop the tailnet). Takes no arguments. Queue it when the doctor says the backend listens on no home-network address, then `panel-endpoint` |
| `interactive-first-off` | `interactive-first-off.mjs --env <the .env.local beside -AlphaRoot>`: sets `ALPHA_INTERACTIVE_FIRST_MODE=false` on every line that sets it (or appends it), touching nothing else and writing a `.bak-interactive-first` first; prints only that flag and the two autonomy flags; restarts the backend the way `panel-host` does and waits for `/health`. The owner's yes of 2026-10-07: with it off the assistant loop runs and the CrowPanel feed can go live. Takes no arguments |
| `panel-endpoint` | `panel-endpoint.ps1`: sends the CrowPanel on USB (picked by its Espressif VID, never a guess between boards) one setting, `ALPHA http://<this machine's address>:8001`, and checks STATUS reports it. Stops first unless the backend answers on that address. No Wi-Fi credential is ever sent. Takes no arguments |
| `start-task` | `Start-ScheduledTask` for `Alpha`, `Alpha Backend`, `Alpha Self-Heal` or `Alpha Doctor` |

## Long queues

A pass saves its progress after every action, so a pass that Task Scheduler
stops at the task's time limit never runs an action twice, and what it did is
reported by the next pass. The task's limit is 6 hours (a machine installed
with the old 2-hour limit raises it on its next pass), and a pass does not
start an action that would not fit in what is left: that action, and what is
queued after it, waits for the next pass, five minutes later.

A pass that finds new code on main updates its checkout first and then runs
the rest of the pass with the new code, in a new process, once. It used to
stop there and leave the work to the next pass. On 2026-10-07 main moved
every few minutes for a quarter of an hour, so four passes in a row updated
and stopped, with nothing run and nothing reported.

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

- `heartbeat` (`true`): every pass, whether or not anything changed, writes
  `reports/live.md` (and `live.json`) to `status/<channel>-live`.
  - Alpha's state is read from self-heal's own last probes (backend, site,
    alpha-ai.uk), so nothing is probed twice.
  - It also shows the repair agent's last pass, the decks' last verdicts and
    live sync's state.
  - If self-heal has not written its log for 6 minutes, its task is started
    again, at most once every 30 minutes. While it is stopped, only the
    backend is checked directly. The heartbeat never repairs Alpha itself:
    two repairers would fight over the same processes.

## Trust

The task runs as the owner, elevated, while the owner is logged on. Anyone
who can push to this repository can therefore run these actions on Laptop41.
That was already true of anything the owner pulls and runs. Keep this
repository private, and keep the menu short.

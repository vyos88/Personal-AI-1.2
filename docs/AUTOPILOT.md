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
| `receive-alpha-data` | `receive-alpha-data.ps1`, Phase 2 of the Alpha move. It collects what Laptop41 sent over Taildrop into `C:\AlphaData\alpha-move\inbox` and checks every file the manifest names, by size and SHA-256; one mismatch changes nothing. It refuses an archive with any path outside `memory\`. It moves the old `memory\` aside (`memory.prev-<stamp>`, never deleted), extracts the new one, puts `.env.local`/`.env` beside `software\` without ever printing them, and removes the received copies. It refuses while anything listens on 8001 and starts nothing. Exit 3 means not everything has arrived yet |
| `chat-task` | `chat-task.ps1`: lets self-heal restart Alpha's chat. It registers the task `Alpha Ollama` (`ollama.exe serve`, hidden, as this user, at startup, S4U so no password is stored) and adds `"chat": {url, task, port}` to `selfheal.json`, keeping every other key and writing no BOM. It starts the task if Ollama is not answering. Self-heal runs as SYSTEM, and an Ollama started as SYSTEM finds no models, which is why it needs a task that runs as the user. Takes no arguments |
| `coord-post` | `coord-post.mjs`: posts one message to Alpha's coordination log through the coordination handler, so the actor rule, the root and the script checks are the handler's. `"message"` is 1 to 2000 characters and travels base64-encoded, so no quoting can split it into arguments. `"actor"` is optional (default `tunnel-session`). `"via": "records-standby"` posts through the Host's records standby (`C:\services\alpha-records-standby\.env.agent`, `HANDOFF_2026-10-05g`), which holds Alpha's notes while Worker1's log is unavailable; `via` is a name from a fixed list, never a path. The root is this machine's `ALPHA_REPO_ROOT` (`.env.agent`); a root that does not exist is refused and never created |
| `restart-coordinator` | On the Host: stops the scheduled task `alpha-coordinator` and whatever holds its port (8787, or `ALPHA_HOST_PORT`), starts the task again from the current checkout, and fails unless `/healthz` answers. A `git pull` alone leaves the coordinator on its old code. The queue survives (`data/tasks.json`) and agents re-register by themselves. Takes no arguments |
| `restart-site` | Stops whatever holds the site's port (4173) with its process tree and starts task `Alpha` again, then asks `/music/healthz` through the site. `Stop-ScheduledTask` alone left the old preview server serving its old `vite.config.js` |
| `stop-stray-site` | `stop-stray-site.ps1`: stops a leftover `vite preview` tree, the one fleet-inventory's `DUPLICATES: Alpha site x2` means, with the `npm run preview` waiting on it. The live site is whatever listens on 4173, with every process above it, and is never touched. Nothing is stopped when nothing listens on 4173 or a non-vite process does. A `vite` dev server is reported and left alone. Fails unless the site still answers on 4173 from the same listener afterwards. Takes no arguments |
| `comfyui-off` | `comfyui-off.ps1`, the owner's yes of 2026-10-07 (option A): stops every ComfyUI process (a python running `main.py` from a ComfyUI folder) with its tree, from the highest parent that is itself a ComfyUI launcher, never a parent that does not name ComfyUI; stops and disables scheduled tasks whose action names ComfyUI and reports Startup-folder entries that do; takes `alpha-image` and `alpha-image-file` out of the agent's handlers and restarts it, so the image bridge sends pictures to the other machines. Prints free memory before and after. Fails if anything still answers on 8188 or a ComfyUI process is left. Takes no arguments |
| `songs-check` | `songs-check.ps1`: every song in Alpha's playlist (the singing receipts in `memory\local\music-singing`, their WAV and MP3 in `artifacts\generated\singing`), one line each with title, length, WAV and MP3 size and whether it plays as MP3, as WAV only, or not at all; then the totals, whether ffmpeg is here, and the backend's last MP3 backfill summary (`mp3-backfill.json`, Alpha cedec9d). Reads only. Exit 1 while a finished song has no MP3. Takes no arguments |
| `alpha-data-in` | `alpha-data-in.ps1`: the data step of the Alpha move. Finds the newest top-level `alpha-move-*` folder holding `memory\` or `artifacts\` on any drive but C:, and copies both into `<profile>\Downloads\VyoS-advance-tech-ai\BuildArtifacts\installers\Alpha-Full` beside its `software\` (which must exist). Adds only: nothing is deleted, a newer file here stays, no `.env*` file is copied (`.env.local` moves by hand). Refuses while anything answers on 8001. Exit 1 unless every file from the drive is then here. Takes no arguments |
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
| `panel-identify` | `panel-up.mjs --identify`: which board is on each of this machine's serial ports, asked of the boards — Worker1 carries five bridges and `mode.com` calls every one of them `USB-SERIAL CH340`. Per port: **panel** (the tunnel's own firmware answered), **alpha-deck** (Alpha's deck firmware, which `panel-endpoint` points and this must never flash over), **other**, **silent**, or **unreadable** (something else holds the port). Read-only: one status query per port, nothing written, no arguments. Queue it when `panel-endpoint` reports a port that never answered STATUS |
| `alpha-runtime` | `alpha-runtime.mjs`: what Alpha's loops and agents are doing, from the machine. Prints the assistant/awareness/thoughts state, the heartbeat age, and **what the cycle is waiting for** — awareness runs inside the assistant cycle and shares its gate, so `awareness: not-started` means the cycle has not had the shared background lane yet, which under memory pressure can last hours and looks identical to a dead loop. Then the newest agent receipts with the **reason** each one failed, not only the class the deck publishes. Read-only: one unauthenticated LAN GET of the deck feed and one read of `memory\local\alpha_agent_registry.json`; no arguments |
| `start-task` | `Start-ScheduledTask` for `Alpha`, `Alpha Backend`, `Alpha Self-Heal` or `Alpha Doctor` |
| `alpha-standdown` | `alpha-standdown.ps1`, this machine's half of the Alpha switch-over (`HANDOFF_2026-10-07d` Phase 2 steps 1 and 3). It writes `role.json` (standby) first. Then it disables `Alpha Self-Heal` and `Alpha Server - Health Guard` before anything is stopped, stops and disables `Alpha Backend` and `Alpha`, stops their wrapper trees and the node/python holding 8001 and 4173 (anything else there is named and left), stops the cloudflared service and sets it to Manual, disables a task that runs cloudflared, and stops a cloudflared left running. Command lines are never printed or saved (cloudflared takes `--token` on one). Every change goes to `standdown\standdown-<time>.json`. Alpha's own runtime (Agent Manager, always-on, watchdog) is named, never stopped: Alpha stops it through its manager. Needs `"confirm": "hand-over"` (V present); `"reportOnly": true` rehearses and changes nothing; `"primary"` names the machine taking over (default `laptop-gj8dfmlk`). Exit 0 done, 1 something still serves here (named), 2 only Alpha's runtime is left |
| `alpha-standup` | `alpha-standdown.ps1 -Undo -StartConnector`: serve Alpha here again. It always enables Alpha Backend, Alpha and Alpha Self-Heal. Any other task comes back only if a stand-down record since the last stand-up saw it enabled. The connector service gets the start type the first of those records saw, and is started. It starts the servers before the watchers, sets `role.json` aside and waits for `/health`. It refuses (exit 3) while alpha-ai.uk answers and no connector runs here, because then another machine serves Alpha; `"force": true` overrides that. `"reportOnly": true` changes nothing |
| `standby-install` | `install-alpha-standby.ps1`: Phase 3's automatic cover. It writes `standby.json` and registers `Alpha Standby`, which runs `alpha-standby.mjs` every minute and at startup, as SYSTEM. It acts only while `role.json` says standby or covering, so it is safe on a machine that still serves. `"primary"` names the machine it covers for (default `laptop-gj8dfmlk`), and `"primaryUrl"` that machine's Alpha health over the tailnet (default `http://100.93.104.24:8001/health`) |
| `standby-uninstall` | `install-alpha-standby.ps1 -Uninstall`: removes `Alpha Standby`; `standby.json` stays |
| `data-sync` | `alpha-data-sync.ps1` once. It sends what changed in `memory\` here to `"peer"` while this machine serves Alpha, and applies what arrived while it does not. `"since"` (a UTC time) starts the sending from an older copy instead of from now. `"resend": true` (with `"since"`) forgets what was sent, so it all goes again. See the standing check `dataSync` below |
| `data-apply` | `alpha-data-sync.ps1 -ApplyHeld`: applies what was held because Alpha serves here. It stops `Alpha Backend`, applies, and starts it again |
| `data-sync-install` | `install-alpha-data-sync.ps1`: the copy as its own task, `Alpha Data Copy`, every `"everyMin"` (10) minutes as SYSTEM, with 4 hours to a run. For a backlog with files too big for the standing check's 15 minutes. While the task exists, the standing check only reports it: each finished run, once, with its output and result |
| `data-sync-uninstall` | removes that task; the copy's state stays, and the standing check copies again |
| `tailnet-peers` | `tailnet-peers.ps1`: the machines on the tailnet as this one sees them: name, tailnet IPv4, OS, online or last seen. It reads `tailscale status --json` and prints no account (login names are e-mail addresses). Takes no arguments. It is how a new machine's name and address are found (alpha-server-01, 2026-10-09) |

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

- `channelWatch` (`{ "channels": "laptop41-live:30,laptop41:45" }`): every
  pass, `scripts/channel-watch.mjs` reads each named `status/<name>` branch on
  origin and calls it SILENT when its last commit is older than its minutes
  (5 to 1440), or MISSING. It exists because each report is written by the
  machine it is about, so a machine that stops also stops saying so: on
  2026-10-07 Laptop41's autopilot went quiet at 23:24 UTC, and a cloud session
  noticed three hours later. Run it on the *other* machine (the Host watches
  Laptop41's channels). The verdict lines carry no ages, so a silence is
  reported once and its end once more. It fetches status refs and reads commit
  times; it writes nothing.

- `heartbeat` (`true`, or `{"alpha": false}`): every pass, whether or not
  anything changed, writes `reports/live.md` (and `live.json`) to
  `status/<channel>-live`.
  - **`{"alpha": false}` is the machine that does not run Alpha** -- the Host,
    which runs the coordinator and an agent. It gets a page for the same reason
    the Alpha machine does, because the point of the page is that a reporter is
    alive, but the rows are the two things this machine can be asked about
    without a credential and that nothing could see from off it: the
    coordinator's `/healthz` (its only unauthenticated GET) and whether this
    checkout is still updating. The Alpha, repair-agent and deck rows are left
    out rather than answered about a machine that does not have them.

    Without the flag the Host could not have a page at all. With no self-heal
    log the Alpha row falls through to probing `127.0.0.1:8001` and calls a
    no-answer `DOWN`, so every page would be a permanently red claim about the
    wrong machine -- worse than no page. The self-heal restart below is
    likewise never attempted on a machine that has no such task.

    The checkout row is why it was built. `autopilot.ps1`'s checkout note says
    it "in every report", but a report goes out only when a queued id ran, so
    on a quiet machine nobody read it: the Host sat on `e175472` for fifteen
    hours over one uncommitted `scripts/usb-inventory.ps1`, 18 commits behind,
    while `self-update.mjs` refused by design (rule 2, never over local work)
    and no pass could ever clear it.
  - Alpha's state is read from self-heal's own last probes (backend, site,
    alpha-ai.uk), so nothing is probed twice.
  - It also shows the repair agent's last pass, the decks' last verdicts and
    live sync's state.
  - If self-heal has not written its log for 6 minutes, its task is started
    again, at most once every 30 minutes. While it is stopped, only the
    backend is checked directly. The heartbeat never repairs Alpha itself:
    two repairers would fight over the same processes.
  - **Somebody else has to read it.** `Publish-Live` is the *last* thing a pass
    does, so a pass stuck in an action publishes nothing and a hung pass cannot
    report itself. That is what `channelWatch` above is for, run on the other
    machine. When a `<machine>-live` channel is silent it also names the commits
    pushed to `control/<machine>` since that last write, because work nothing is
    going to run is what the silence actually costs.

    On 2026-10-08 Laptop41's pass stopped publishing at 23:29:08Z and was still
    silent four hours later while its separately scheduled doctor kept pushing
    from the same machine, and three commits of queued work landed in the
    meantime.

- `homeWifi` (`{ "ssid": "Starlink V" }`): keeps this machine on the Wi-Fi
  the CrowPanel is on. On 2026-10-07 that network blinked for a moment at
  04:54. Windows moved Worker1 to the router's other network ("STARLINK") and
  stayed there, and the panel was dark all day. The other network stays as
  Windows' fallback on purpose: while the home one is down, it keeps
  alpha-ai.uk online. Each pass:
  - **Off the home network while it is visible:** rejoins it with the profile
    Windows already saved, at most every 10 minutes. It uses Windows' own
    Wi-Fi API. No passphrase is read or written, and no profile setting
    (auto-connect, order) is changed.
  - **Off it and it is not visible:** stays where it is, for the internet.
  - **On it, but the backend does not listen on this address:** restarts the
    backend as `restart-backend` does, at most every 30 minutes, when the
    address is in the backend's own list (the boot wrapper's `--host`, else
    `HOST`). An address not in that list is reported: queue `panel-host`.
    A backend that is down is left to self-heal.
  - It reports when what it found changes and whenever it acts. If the Wi-Fi
    API itself fails, it reports "could not check" once and changes nothing.

**A standby.** While `role.json` in the ops folder says `standby`
(`alpha-standdown` writes it, `alpha-standup` sets it aside), another machine
serves Alpha and this one must not start a second:

- the actions that start or re-enable Alpha here are refused: `restart-backend`,
  `restart-site`, `repair-host` (it re-registers self-heal), `panel-host`,
  `interactive-first-off`, and `start-task` for anything but `Alpha Doctor`;
- the live page reads **STANDBY**, with who serves and what alpha-ai.uk
  answers, or **STANDBY BUT SERVING** when a backend, site or connector runs
  here too. Self-heal is shown as off and never started again;
- `homeWifi` still rejoins the home network but never restarts the backend;
- self-heal itself writes one `standby` line per pass and repairs nothing,
  in case its task gets enabled again;
- the doctor checks the standby instead of a serving Alpha: alpha-ai.uk
  answers, and no backend, site, connector or Alpha task is running or enabled
  here. Each of those is a problem, because two Alphas write two histories.

**Automatic cover (Phase 3).** `Alpha Standby` (`standby-install`) covers
for the primary by itself. It needs three signals at once, each from a
different path, before it covers:

- the primary's Alpha has missed three passes over the tailnet;
- alpha-ai.uk is served by nobody (no answer, a 5xx, or Cloudflare's 1033);
- this machine's own internet answers.

Then it runs `alpha-standup` with `-StartConnector` and writes role
`covering`. Once the primary's Alpha answers two passes in a row, it hands
Alpha back with `alpha-standdown` and records what changed in `memory\`
while it covered (`standby\handback-*.json`).

The live page's **Role** row says PRIMARY, STANDBY or COVERING and shows
the cover's last pass. The doctor reports a cover that is not installed,
has stopped, or cannot see the primary.

- `dataSync` (`{ "peer": "<the other machine>", "everyMin": 10 }`): keeps
  the other machine's `memory\` in step (`alpha-data-sync.ps1`). The rule is
  the same on both machines:
  - **Sending.** The machine whose backend answers sends what changed. It
    sends once more after it stops serving, so a stand-down or a hand-back
    loses nothing. A machine that never served sends nothing.
  - **Applying.** The other machine applies only while it does not serve, and
    holds a package otherwise (`data-apply`).
  - **Checking.** Every package is checked against its SHA-256 and refused if
    anything in it is outside `memory\`.
  - **Writing.** Newer wins, and the file it replaces is kept under
    `data-sync\replaced\`. Nothing is deleted.
  - **Transport.** Taildrop, never git.
  - **Big files go as their own task.** A file too big for the 15 minutes
    timed out every pass on 2026-10-09, held the pass and its live page, and
    left the killed pass's upload running. `data-sync-install` moves the copy
    into `Alpha Data Copy`; a timeout now kills the whole tree; and one copy
    at a time holds a lock.
  - **Nothing is lost in silence.** A file that cannot be packed is never
    counted as sent; it rides with the next pass (`NOT IN THIS PART`). A
    folder that cannot be read is named (`SKIPPED`). A file that cannot be
    written keeps its package for the next pass (`FAILED`).

  The live page's **Data copy** row shows the last send, the last apply and
  anything held.

## Trust

The task runs as the owner, elevated, while the owner is logged on. Anyone
who can push to this repository can therefore run these actions on Laptop41.
That was already true of anything the owner pulls and runs. Keep this
repository private, and keep the menu short.

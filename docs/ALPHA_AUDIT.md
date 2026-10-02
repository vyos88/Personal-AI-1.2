# Alpha audit, 2026-09-28

> **Superseded in part (2026-09-30):** see [ALPHA_HANDOVER_2026-09-30.md](ALPHA_HANDOVER_2026-09-30.md).
> Corrections: Devices has 13 workspaces (22 is the total across four tabs of the
> main-branch shell), that shell imports 61 panels, and the served UI is the
> `alpha-full` Deck (23 hubs, 197 workspaces), not `AppShell.tsx` on `main`.

Priority order: **live first** ([MASTER_HOST_REPAIR.md](MASTER_HOST_REPAIR.md)),
then this.

## What this audit could and could not see

| Source | Visible | Notes |
|---|---|---|
| `vyos88/Alpha`, `frontend/src/app/shell/AppShell.tsx` (Alpha 9.0) | yes | tabs, work modes, 22 Devices/ops workspaces, 45 panel imports, the backend routes the shell calls |
| This repo: the tunnel, agents, handlers, scripts | yes | the "skills" and "agents" below |
| Decks, Brain, Agents hub, Network Hub, Crown Panel, Music Creator, Video Creator | **no** | on Laptop41's copy of Alpha only, which is not in any repository |

Recommendations for the areas that are not visible are written against their
observable contract (routes, ports, tasks), not their code. The first
recommendation in each of those areas is to get the code into version control
so the next audit can read it.

---

## 1. Hubs

The shell's Devices tab switches between 22 workspaces: Command Nexus, Voice and
Vision, Identity, Avatar Lab, System Voice, Cloud Control, Maintenance, System,
Sensors & IoT, Smart Home, Windows, Cameras, Arduino, Arduino Q, GSM, Network,
Mapping, Robot, 3D Ops, Capabilities, Knowledge Vault and Cognition Forge. There
are also the Network Hub and Crown Panel named for this audit.

1. **Lazy-load each hub.** `AppShell.tsx` statically imports all 45 panels, so a
   phone downloads Arduino, GSM and RF code to open Chat. Use `React.lazy` per
   workspace.
2. **One error boundary per hub.** Today a single panel that throws blanks the
   whole shell. Isolate each workspace so one broken integration shows one red
   card.
3. **Put hub health on one bus.** Several panels poll their own endpoints with
   `fetch(...).catch(() => {})`, which swallows failures silently. Report
   failures to `SystemHealthDashboard` instead.
4. **Hide hubs whose hardware is absent.** Arduino, GSM, RF and Robot should use
   `device.inventory` (see the tunnel handlers) rather than rendering empty
   controls.
5. **Stop polling in background tabs.** Pause intervals on
   `document.visibilityState === 'hidden'`. The `/robot/coords` and
   `/triggers/notifications` loops keep running on a locked phone.
6. **Network Hub: show the fleet.** Read `alpha-admin agents` data: which
   machines are attached, their memory and load, and whether Jack's laptop is
   up.
7. **Crown Panel: make it the admin surface for self-heal.** Show
   `selfheal.jsonl`'s last line, the budgets and any flagged components, with a
   single "acknowledge" action.
8. **Maintenance hub: surface the repair evidence file** and the last coordination
   receipts, so "is Alpha healthy" has one answer.
9. **Give every hub a smoke test.** Render each workspace once in CI with the
   backend mocked. 22 workspaces with zero tests is how a hub breaks unnoticed.
10. **Merge Arduino and Arduino Q** unless they drive different boards. Two tabs
    for one family doubles the maintenance.

| Hub | Specific recommendation |
|---|---|
| Command Nexus | Route commands through the tunnel's task queue so they have receipts |
| Voice and Vision | Show mic and camera permission state explicitly; failed permission reads as "listening" today |
| Identity / Personal Vault | Never cache vault contents in `localStorage` |
| Avatar Lab | Debounce mood and style POSTs; each click is a request |
| System Voice | Add a TTS fallback voice when `/speech/tts` fails |
| Cloud Control | Show which credentials are configured (names only) |
| Maintenance | Link the repair runbook and self-heal status |
| System / Subsystem Monitor | Merge with SystemHealthDashboard; there are two views of one truth |
| Sensors & IoT / IOT Readings | Show "last reading at" so stale data is visible |
| Smart Home / Tapo | Put control actions behind a confirmation for anything that powers off |
| Windows / Laptop Devices | Read from `device.inventory` instead of a separate scan |
| Cameras | Stop streams when the tab is hidden |
| Arduino / CrowPanel Bridge | Drive flashing through the `alpha.panel` task so it works from any machine |
| GSM | Rate-limit SMS sends and log them to receipts |
| Network / Network Backend | Show fleet and tunnel state (above) |
| Mapping / Hybrid Map | Lazy-load map tiles; they are the heaviest assets |
| Robot / WiFi Robot | Add a watchdog stop if the robot hears nothing for N seconds |
| 3D Ops | Serve `.glb` from the render machine's output via recipe, not by copying |
| Capabilities / Compliance | Generate the list from `alpha-admin agents` capabilities, not a static list |
| Knowledge Vault / Books / Search | Show the index age and document count |
| Cognition Forge / Meta panels | Label experimental panels as experimental in the UI |

## 2. Decks

The `/decks` route exists on the live host; its source is not visible here. This
repo has one deck, `docs/deck/alpha-tunnel.pptx`.

1. Commit the Decks feature's source into `vyos88/Alpha`.
2. Store each deck as data (JSON of slides) plus rendered output, never only as
   a binary file, so decks can be diffed and regenerated.
3. Version decks: every save is a new revision, with the previous one
   restorable.
4. Export to `.pptx` and PDF from one source, so the two cannot drift.
5. Render thumbnails once per revision, not on every list view.
6. Autosave with a visible "saved at" time. Laptop41 restarts are now expected
   (self-heal), so unsaved state must survive them.
7. Put large deck assets behind the backend, not in `dist`. A rebuild must not
   delete them.
8. Keep the tunnel deck current: it predates self-heal, the Codex bridge and the
   ledger.
9. Add one "system status" deck generated from the evidence file, for
   reporting to others.
10. Limit deck size and warn on huge images. A 200 MB deck through a Cloudflare
    tunnel times out.

## 3. Workspaces

These are the tabs (Chat, Admin, Devices, Phone, Libraries, Terminal) and the
work modes (Work, Mobile, Arduino).

1. **Chat: show backend state.** When `/communication/message` fails the user
   needs a banner, not a dead send button. The backend being down is the most
   common outage this week.
2. **Chat: keep drafts.** Store the unsent message locally, so a self-heal
   restart does not eat it.
3. **Terminal: require the tunnel's auth.** A shell reachable from `alpha-ai.uk`
   is the largest risk in the app. Keep it behind Access and an admin scope,
   and log every command.
4. **Admin: fold in the tunnel's accounts.** One user and key model, not two.
5. **Phone tab:** the `PHONE_TAB_ID` constant is fixed while the label moves with
   the version. Keep it that way, and test it.
6. **Work modes actually switch layout.** The shell clears the mode and layout
   keys at startup (`TAB_MODE_STORAGE_KEY` and others), so modes are
   effectively gone. Remove the dead constants or restore the feature.
7. **Tab order survives upgrades.** The existing merge logic does this; keep the
   `-v2` key and do not bump it casually.
8. **Libraries:** show the storage used, and where the data lives (Laptop41 or
   the laptops).
9. **Add deep links for every workspace** (`/chat`, `/devices/robot`), so
   Crown Panel, bookmarks and the verification script can reach them directly.

## 4. Skills

These are the capabilities an agent offers the fleet: the handlers in
`src/agent/handlers`.

1. `alpha.coordination`: add a `Tail` action (read-only, the last N receipts), so
   the progress posted by the repair and by self-heal can be read by task.
2. `alpha.update`: keep it without Build/Restart. Self-heal is the local restart
   path, and that division is correct.
3. `alpha.render`: queue renders with `--agent` always. Add a quota per species
   to `alpha-manager` defaults.
4. `alpha-render-inventory`: surface its counts in the 3D Ops hub.
5. `device.inventory`: schedule it hourly on the host, so COM-port moves are seen
   before a panel fails.
6. `alpha.panel`: add a `Status` action that reads the sketch version, so a stale
   board is visible without a reflash.
7. `codex.exec`: keep the sandbox read-only by default. Record prompts' hashes in
   receipts, not prompt text.
8. `grow`: leave it as is. It is the model built-in: no process, no filesystem.
9. Write a skill manifest: one generated table of type, machine, opt-in flag and
   `available()` reason, printed by `alpha-admin agents --skills`.
10. Every new skill ships with `available()`. That rule has already prevented
    three classes of misplaced task.

## 5. Agents

1. **Name machines by role.** `alpha-host` for Laptop41, `jack-music` for Jack's
   laptop. `--agent` targeting works by name, so names are the routing table.
2. **Run keep-agent on every worker.** One keeper per machine, never beside an
   `alpha-agent` service: they evict each other by design.
3. **Run the watchdog `--no-update` on a timer** beside the keeper. It is the
   only check that asks the host whether this machine is attached.
4. **Set `ALPHA_AGENT_MAX_LOAD` on Jack's laptop**, so music production on it
   stops the fleet borrowing CPU.
5. **Set a memory reserve on Jack's laptop** (`ALPHA_AGENT_MEMORY_RESERVE_MB`), so a DAW session keeps its RAM.
6. **Keep the coordinator's auth store backed up.** `data\auth.json` on
   Laptop41 is the only copy of the accounts.
7. **Standby:** `standby-alpha.mjs` on a second laptop, with `--control-url`,
   once Alpha is in version control. Without that, a standby is a stale copy.
8. **Alert on the watchdog's exit 1.** Posting to the coordination tunnel, as
   self-heal does, gives one place to look.
9. **Bump the version on every agent-visible change**, so the `*` in
   `alpha-admin agents` means something.

## 6. Music Creator

The source is not visible here. Jack's laptop is the intended worker.

1. Commit the Music Creator source into `vyos88/Alpha`.
2. **Add a `music.render` handler, opt-in, with `available()`.** It should check
   for the synth or DAW binary, the root and the output directory. It belongs
   on Jack's laptop only, reached by `--agent jack-music`.
3. **Return a recipe, keep the audio local.** Like `alpha.render`: return the
   prompt or seed, model, tempo and key, plus the file's name and size. Audio
   does not belong in a task result.
4. **Keep the payload to data.** Genre, tempo, key, length and seed. Never a path,
   a plugin or a command. Refuse unknown keys.
5. **Give each render its own output directory**, so concurrent renders cannot
   claim each other's files. This is the `alpha.render` lesson.
6. **A lease that covers the render**, plus `--no-wait`. Music renders outlive
   60 s.
7. **Loudness-normalise and tag the output** (LUFS target, BPM and key in the
   metadata), so the library is searchable.
8. **Quota per day in `alpha-manager`**, so an unattended loop cannot fill Jack's
   disk.
9. **Record in the ledger**, so "what did we make this week" survives restarts.
10. **Report licensing and model provenance per track.** Generated music needs
    to say what generated it.

## 7. Video Creator

The source is not visible here.

1. Commit the Video Creator source into `vyos88/Alpha`.
2. **Add a `video.render` handler, opt-in, with `available()`** (ffmpeg on PATH,
   GPU if required). Pin it to the GPU machine by name.
3. **Build video from recipes.** A timeline JSON referencing render and music
   recipes means video composes the other two creators instead of copying
   their output.
4. **Run ffmpeg with an argv array and a fixed filter graph from a template set.**
   Never pass a filter string from the payload; that is a shell by another name.
5. **Encode to disk, return metadata** (duration, resolution, codec, size). Serve
   the files through the backend with range requests. Do not tunnel them in
   task results.
6. **Pre-flight disk space.** Refuse a render whose estimate exceeds free space
   minus a reserve.
7. **Checkpoint long renders** by segment, so a lease expiry resumes rather than
   restarts.
8. **Generate thumbnails and a low-bitrate preview** for the phone. alpha-ai.uk
   goes through Cloudflare, and multi-GB files will time out.
9. **Quota and ledger, as for music**, plus a per-day GPU-minutes budget.
10. **Clean up staging directories on failure.** Half-written video files are the
    fastest way to fill a disk.

# Backlog — the standing work queue for Alpha

This is the list Codex, Alpha and every Claude session work from, for as long
as there is work. It holds what is known to be wrong or missing and has not
been done, in order, each item small enough for one PR and checkable when
done. `docs/STATUS.md` says where things stand. This file says what to do
next.

## How to take an item

1. Read `docs/STATUS.md` first, then the item.
2. **Claim it** so two agents do not do the same work. On the Alpha host, post
   a claim through the coordination tunnel:
   `scripts/alpha_coordination_tunnel.ps1 -Action Claim -Actor <you> -Paths <files>`.
   From anywhere else, open a draft PR whose title starts with the item's ID.
3. One item, one PR, on a branch, never `main`. The PR says which item it
   closes and how you checked it.
4. **Done means checked:**
   - the suite passes (backend `pytest`, frontend `npm test`, tunnel `npm test`);
   - for anything visual, `frontend/scripts/visual-audit.mjs` reports no new
     problems on the routes you touched;
   - you ran it, not inferred it.
5. Release the claim (`-Action Release`), and delete the item from this file in the same PR. Add what you found but did
   not do as a new item. The list only works if it stays true.

**Rules that do not bend:**
- Never write a secret anywhere: keys, `auth.json`, `.env` files, passwords.
- Never force-push. Never merge without the suite passing.
- **Codex runs read-only by default** (`codex.exec`). Its items marked
  *report* ask for an answer, not a change. Widening its sandbox is the
  owner's decision on that laptop.

## Now — needs a person at Laptop41

| ID | Item | Done when |
|---|---|---|
| H1 | Bring merged Alpha changes into Worker1's live install: `node scripts/apply-alpha-update.mjs --alpha-root <Alpha> --apply --restart`. It now updates `scripts\` (the stewards) as well as `software\`; then restart the stewards (`HANDOFF_2026-10-05d_stewards.md`, steps 1-3) | it prints DONE, alpha-ai.uk shows the new fonts and chrome, and the manager window shows no `local-authentication-unavailable` |
| H2 | Publish the live Alpha source: `scripts/publish-alpha.mjs` then `publish-alpha-push.ps1 -Push` (to `alpha-from-host`), or `scripts/snapshot-alpha-live.mjs --push`, which publishes only the files `alpha-full` tracks. This unblocks H1: on Worker1, H1 refuses 36 locally edited files (25 in `software\`, 11 in `scripts\`; listed in `HANDOFF_2026-10-05f_worker1-deploy.md`), and a session then has to merge `alpha-full` onto the published branch | the branch exists on GitHub |
| H7 | Get Alpha#59 (Claude handoffs with receipts) live on Worker1 by itself: `--from d75efee --to ba636f4` with a separate `--ops` (route A in `HANDOFF_2026-10-05f_worker1-deploy.md`, which includes a prompt for a Claude session there). Then restart the `worker1` agent (#104) | a handoff sent from Alpha's chat gets a Claude Ack, and Alpha's "did Claude receive it?" names that Ack |
| H9 | Find where the failed logins come from: `scripts\check-coordinator-logins.ps1` on Host, `scripts\check-alpha-logins.ps1` on Worker1. If it is the stewards (`127.0.0.1`, `WindowsPowerShell`), stop them, wait 15 minutes, re-save the credential with `set-alpha-local-credential.ps1`, and start them again (`HANDOFF_2026-10-05f_worker1-deploy.md`, "Failed logins") | the source is named in a handoff, and an hour later the check shows no new failures from it |
| H8 | Give Alpha a local chat model: `ollama pull llama3.2:3b`, and `OLLAMA_MODEL=llama3.2:3b` in the Alpha root's `.env.local` (change that line only; never print the file), then restart the backend | `ollama list` shows the model, and a chat reply's `adapter_status.provider` is `ollama` |
| H3 | Repair sequence, `HANDOFF_2026-10-02_laptop41-repair.md` | the doctor's report has no NEEDS A PERSON lines |
| H4 | Owner settings: GitHub billing/Actions, this repo's default branch → `main` | a manual run of `.github/workflows/test.yml` passes |
| V1 | person | Get the voice fix (vyos88/Alpha#54) onto Worker1's live Alpha. Until H2 merges the live source, copy two files from `alpha-full` by hand: `frontend/src/services/lipSync.js` and the new `frontend/src/services/naturalVoices.js` (and `backend/piper_voice.py` for the calmer soft delivery), then rebuild the frontend (`npm run build`) and restart the backend. First compare the live `lipSync.js` with `alpha-full`'s old copy: if the live one has local edits, merge rather than overwrite | the robotic voice no longer comes back under load; male profiles speak at normal speed |
| H6 | Install the host tools the opt-in handlers call. **Host (laptop-gj8dfmlk) now offers `alpha.render`** through its `host` agent; whether Blender is installed there is unchecked, so a render sent to Host may fail until it is. A worker can be alive and fresh in `agents` while the capability it exists for cannot run at all — `available()` only proves the machine looks configured, not that the binary behind it works. At least: `pip install -r scripts/requirements-stems.txt` (Demucs, for the just-merged `alpha-music-stems`/#76) and `requirements-music.txt` (MusicGen) wherever `ALPHA_EXTRA_HANDLERS` names them; `arduino-cli` on PATH for `alpha.panel` (the doctor already sees the CrowPanel on COM7/COM20, so the board is there — whether the CLI is, is unconfirmed); the real Codex CLI (native binary, not the npm `.cmd` shim) on Jack's laptop for `codex.exec`. | `node src/admin/run.js agents` shows each machine's capability list actually includes the opt-in types its `.env.agent` configures, with no `not offering a handler this machine cannot run` warnings in its log |

## Fleet after the host move — F1-F30 (owner's list, 2026-10-05)

The coordinator now runs on laptop-gj8dfmlk (**Host**). Laptop41 (**Worker1**)
keeps Alpha and its `worker1` agent (`HANDOFF_2026-10-05b_host-move.md`). The
owner asked for all thirty of these. **Who** says who can do the item: *person*
needs someone at a laptop, *code* is any session's PR, *Alpha* is work Alpha
does through the tunnel or that teaches Alpha. Alpha does not learn by
retraining here. It learns from `memory/knowledge/*.json`, the repair playbooks,
the coordination events and the receipt ledger, so the "teach Alpha" items
write to those.

### Make the Host move solid

| ID | Who | Item | Done when |
|---|---|---|---|
| F3 | person | Back up gj8's `data\auth.json` nightly to the WD external drive. It is now the only live copy of every key | a dated copy from last night exists on the drive |
| F4 | person | After 48 h without a rollback, delete Laptop41's rollback: `C:\services\alpha-tunnel\data\auth.json`, the disabled `alpha-coordinator` task, and `C:\AlphaData\alpha-ops\disabled-startup\Alpha Tunnel Coordinator.vbs` | none of the three exist on Laptop41 |
| F5 | person | Revoke admin login sessions that are no longer used (`node src/admin/run.js keys`, then `revoke-key <id>` for each stale `ses`) | `keys` shows only sessions in use |
| F6 | code | Peer report, second probe: also ping the other laptop's tailnet address, so "worker1 missing" says *network down* or *agent down* | the log line names which one |
| F7 | code | Put the newest peer-report line in the doctor's `status/laptop41` report, so cloud sessions see the pair's health | `reports/latest.txt` has a peer-report line |

### Fix what the doctor still flags

| ID | Who | Item | Done when |
|---|---|---|---|
| F9 | person | Run the doctor once with `-Fix` as Administrator on Worker1. It patches the main.py dictionary bug through `apply-chat-fix.ps1` and keeps a backup | the doctor no longer reports the dictionary bug |
| F10 | person | Run `scripts\repair-alpha-host.ps1 -AlphaRoot C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software` as Administrator on Worker1. It points the `Alpha` task at the real frontend and rebuilds the stale `dist`, with rollback | no "serves some other folder" and no "build is older than the source" in the doctor |
| F11 | Alpha / Codex, then person | C: on Worker1 is at about 5 GB free and fell 1.2 GB in an hour. First an inventory only (BACKLOG C3 rules: list, never move or delete), then the owner moves files by hand | C: above 20 GB free |
| F12 | code | The cloud relay has posted nothing to Alpha in about 22 hours (`cloudSeen` null in `doctor-state.json`). Find out why the doctor's relay step does not post | the next cloud report shows up in Alpha's coordination feed |

### Teach Alpha from what happened

| ID | Who | Item | Done when |
|---|---|---|---|
| F13 | code / Alpha | Write `memory/knowledge/alpha_session_record_2026_10_05_host_move.json` (Alpha repo): the roles and addresses; the three ways the old coordinator came back (the `run-coordinator.cmd` loop, the `alpha-coordinator` task, the Startup `.vbs`); the self-signed-certificate restart loop; the doctor's loopback-only blind spot | the file exists and Alpha can answer "where does the coordinator run?" correctly |
| F14 | code | Repair playbook entry: when self-heal fails a healthy frontend on a TLS or certificate error, check the probe, not the frontend. On 2026-10-05 this rolled back a working build | the entry is in the repair playbook, with a test |
| F17 | code | Record a receipt for each self-heal repair in the ledger, so Alpha can tell repairs that hold from repairs that keep coming back | self-heal actions appear in `receipts.json` |
| F18 | Alpha | Weekly recap: Alpha reads the week's doctor reports and the self-heal log, and posts one summary to the coordination tunnel: what broke, what repeated, what needs a person | one recap per week in the feed |
| F19 | Alpha / every session | Read `docs/STATUS.md` and the latest handoff before acting on live telemetry. The hourly session that misread the host move as an outage (commits 3730490, 8a1b6c8) skipped this step | written into the routine every agent follows |

### Make Alpha better at execution

| ID | Who | Item | Done when |
|---|---|---|---|
| F20 | Alpha | Let Alpha run read-only checks through the tunnel by itself (`sysinfo`, `agents`, `coord Status`), so it proves a machine is alive rather than guessing | Alpha's health answers cite a task id |
| F21 | code / Alpha | Updates through `alpha.update`: Alpha proposes an update, the owner approves it, and the handler applies it with the existing rollback | one update applied end to end that way |
| F22 | Alpha | One task, one receipt: every action Alpha takes ends with a tunnel post saying what it did and how it checked | its actions in the feed all carry a check |
| F23 | code | Hard limits on Alpha's own actions: at most 3 restarts an hour (self-heal already has its budget), and never keys, `auth.json` or `.env` | the limits are enforced in code, with tests |
| F24 | Alpha | Ask Codex for a second opinion on risky plans: a read-only `codex.exec` review before a person runs them | used on the next risky change |
| F25 | Alpha | Target machines by name (`--agent worker1`, `--agent host`) and record which machine did what. The watcher already shows the device per event | Alpha's posts name the machine |
| F26 | code | CrowPanel fleet line: "Host ✓ Worker1 ✓", taken from the peer report | the panel shows it |

### Safety and hygiene

| ID | Who | Item | Done when |
|---|---|---|---|
| F27 | person | `run.js login` on `main` already never prints the session token (test: admin-cli "the token is never printed"). The token pasted into a chat on 2026-10-05 came from an **old tunnel checkout on gj8**, `C:\Users\jack\alpha-tunnel` (and `C:\Users\jack\alpha-tunnel-main`), which still prints it. Delete both old checkouts on gj8; use `C:\services\alpha-tunnel` only | neither folder exists on gj8 |
| F28 | person | Rotate agent keys issued before the move, including `laptop-41-v2-agent`, which `worker1` now uses: issue a new key, update `.env.agent`, revoke the old one | `keys` shows no agent key from before 2026-10-05 in use |
| F29 | code | One coordinator only: the doctor's split-fleet check exists (#90). Add the same check on gj8, through the peer report: Worker1's 8787 must stay closed | the peer report on Host flags a coordinator answering on Worker1 |
| F31 | person | Keep the coordination notes going when Worker1 is down: check the probe address, then Parts W, H and D of `HANDOFF_2026-10-05g_worker1-down.md` (needs #109 and #110 merged) | the Part D drill passes: with Worker1 off the tailnet a note posts from the Host, and once Worker1 is back that note is in its `events.jsonl` exactly once |
| F30 | person | Automatic failover between Host and Worker1 for the coordinator: store sync over Taildrop, a standby on Worker1, both agents given two addresses, then the drill. All steps in `HANDOFF_2026-10-05c_failover.md` | the Part C drill passes: Host's coordinator stopped, both agents on Worker1's standby within 3 minutes, and both back on the Host within 3 minutes of its return |

## Every agent reports, the other takes over, both update themselves — R1-R8 (owner's ask, 2026-10-06)

The owner's goal: every agent and worker on either laptop reports its work
through the tunnel. Then the other laptop or agent can see it stop and take
over, and each machine updates itself. The table below shows where that stood
on 2026-10-06 at about 18:00 UTC. It comes from status/laptop41,
status/laptop41-autopilot, status/host-autopilot, status/claude-laptop41 and
status/cloud; nothing here was measured on the machines directly.

| Runs on | What | Reports through | Taken over when it stops | Updates itself |
|---|---|---|---|---|
| Host | coordinator (8787) | Worker1's doctor, section 5 (healthz only) | no (F30, F31) | yes (autopilot pulls `main`) |
| Host | agent `host` | coordinator heartbeat, visible only when signed in (R2) | music and images move to Worker1 (#130, #132) | yes (autopilot) |
| Host | autopilot | `status/host-autopilot` | n/a | yes |
| Host | anything else | nothing: the Host has no doctor (R1) | n/a | n/a |
| Worker1 | agent `worker1` | coordinator heartbeat (R2) | music and images move to Host | yes (autopilot) |
| Worker1 | Alpha backend and site | doctor: `status/laptop41`, and a post in the tunnel | no standby (Alpha#60 plan) | no: route B (R7) |
| Worker1 | Alpha Agent Manager and its stewards | Alpha's own agent manager only (R5) | no | no (ST1) |
| Worker1 | doctor, self-heal, autopilot | `status/laptop41`, `status/laptop41-autopilot` | n/a | yes (tunnel checkout) |
| Worker1 | music bridge 8790, image bridge 7861 | doctor sections 5b and 8 | send work to the less busy machine | through `enable-music` / `enable-image` |
| cloud | relay and handoffs | `status/cloud`, `status/claude-laptop41`; the doctor posts them into the tunnel | n/a | n/a |
| none | Codex, phones | nothing | n/a | n/a |

| ID | Who | Item | Done when |
|---|---|---|---|
| R1 | code | **A doctor for the Host.** Run it from the Host autopilot every 15 min. It pushes `status/host` with the coordinator, the `host` agent's handlers, the bridges, Ollama, RAM and disk, the way `laptop41-doctor.ps1` does for Worker1. It must not assume an Alpha install, because the Host has none. | `status/host` holds a report under 30 min old |
| R2 | person | Store the coordinator admin key on both machines (`ALPHA_ADMIN_TOKEN`, user scope). Without it no report can show an agent's last heartbeat, so nobody sees one stop. | Worker1's doctor, section 5, lists the agents with their last-seen times |
| R3 | code | **A stopped agent is restarted by the other machine.** The signed-in doctor flags any agent whose heartbeat is over 5 min old and posts it to the coordination tunnel. Add a new autopilot action, `restart-agent`, that the other machine's autopilot can queue for it. Test it with a stand-in coordinator. | stopping `worker1` on purpose brings it back within 20 min, with no person involved |
| R4 | code | The Network Hub shows 0 of 16 peers with a heartbeat. The Worker1 cloud session has named this as its next job (`status/claude-laptop41`, 18:05 UTC): take it only after checking it is still free. | the hub shows each live peer with a fresh heartbeat |
| R5 | person, then code | **Alpha's stewards.** First the owner restarts the Agent Manager and the stewards: #121 found 1,789 failed sign-ins from 127.0.0.1, the stewards' stale saved password. Then ST1-ST6. Then the Agent Manager posts one line per cycle to the coordination tunnel (who ran, who failed), so the Host can see Worker1's stewards. | `check-alpha-logins.ps1` reports 0 failures in the last 15 min, and the tunnel has a steward line for each cycle |
| R6 | person | Taking over when Worker1 is down: decide F30 and F31, then the drafts #109, #110 and #111. | the failover drill in `HANDOFF_2026-10-05g_worker1-down.md` passes |
| R7 | person, then code | **Alpha updates itself.** Route B first (the owner's answer on `software\backend\README.md:59`, then the snapshot and the merge). Then an autopilot setting, like `autofix.brainTopology`, runs `apply-update` whenever `alpha-full` moves and reports the result. | a merge to `alpha-full` reaches Worker1 with no person involved |
| R8 | person, then code | **The voice is better on Laptop41 than on the Host (gj8).** The Host runs no Alpha backend, so its browser speaks through Worker1's Alpha. Alpha speaks with Piper there: `piper-tts==1.6.0` plus the model files in `backend\voice_models\*.onnx`, which are not in git. A worse voice on the Host means its browser is not getting that voice and falls back to its system voice. That happens when `/voice/provider-status` or `/voice/synthesize` fails or times out on the address the Host uses, when the browser holds a stale API address, or when it runs an older bundle (see V1 and Alpha#54). Find which of these it is: the address in the Host's browser bar, the voice provider Alpha's chat reports there, and how long `/voice/synthesize` takes from the Host. Fix that one cause. Add an `enable-voice` autopilot action only if the Host ever runs its own Alpha. | on the Host, Alpha's chat reports the Piper voice, and both laptops sound the same |

### The fleet status report, live in Alpha and on the CrowPanel — R9-R11

The owner wants the status table above shown live in Alpha's tunnel hub
(`frontend/src/components/CoordinationTunnelPanel.jsx`) or agent hub
(`frontend/src/pages/AdminAgentsPanel.jsx`), and on the CrowPanel. These are
the nine improvements the owner asked for. R9-R11 build them in order.

1. **One report for both laptops**, not five branches (`status/laptop41`,
   `-autopilot`, `host-autopilot`, `claude-laptop41`, `cloud`).
2. **Machine-readable next to the text**: `fleet-status.json`, so hubs and the
   panel render it, not people.
3. **Every line has an age** ("seen 3 min ago"), and shows as stale after two
   missed report intervals.
4. **Agents per machine**: name, handlers and last heartbeat. This needs R2.
5. **Who takes over, worked out live**: for each capability (chat, music,
   images, coordination, the site), which machine can serve it now.
6. **Update state per machine**: tunnel checkout against `main`, and Alpha's
   live copy against `alpha-full` (behind by N, and what blocks it).
7. **"Needs a person" kept apart from "the autopilot will fix it"**, with the
   id of the queued job that fixes it.
8. **No noise**: lines that flicker (RAM, COM ports, run counters) are
   summarised. Only changes are posted to the tunnel.
9. **A one-line summary for small screens**: "Fleet OK · 2 open · Worker1 ✓
   Host ✓", for the CrowPanel, phones and the hub's header.

| ID | Who | Item | Done when |
|---|---|---|---|
| R9 | code (tunnel) | The doctor, and both autopilots, write `reports/fleet-status.json` beside their text report and push it on their status branch. Schema: machine, at, checks `[{id, ok, text, since}]`, open problems with their fixing job id, agents (when signed in), checkout and Alpha versions, and the one-line summary (improvements 1-3, 6-9). Tested like the doctor's other checks. | both laptops' status branches hold a fresh `fleet-status.json` |
| R10 | code (Alpha) | `GET /fleet/status` (owner only) merges this machine's own `fleet-status.json` with the other machine's. It reads that one over the tailnet through the tunnel: the `sysinfo` handler, or a new read-only `fleet.status` handler. The hub polls it every 30 s and shows one row per component, with its age, ✓ or ✗, what is open, and who takes over (improvements 3-5). | the tunnel hub shows both laptops live, and a stopped agent turns red within one interval |
| R11 | code (Alpha + firmware) | `/panel/crowpanel/public-state` gains a `fleet` block: the one-line summary, plus at most three short lines. The deck firmware draws it in a band. This extends F26 ("Host ✓ Worker1 ✓"). It carries status only: no names of people, no addresses, no keys. | the CrowPanel shows the fleet line, and it changes when a machine stops reporting |

## Server day — S1-S7 (server expected 2026-10-06)

Steps in `HANDOFF_2026-10-06_server-day.md`. The owner's goal: Alpha's chat,
coding and execution, on 256 GB RAM and 2 × 14 cores.

| ID | Who | Item | Done when |
|---|---|---|---|
| S1 | person | The server joins: Tailscale, Node, git, Python, sleep off, the tunnel on `main`, agent `server` (handoff Part 1) | `agents` lists `server`; `sysinfo --agent server` reports its CPUs |
| S2 | person | Ollama on the server, bound to its tailnet address only, model kept loaded (Part 2) | `curl http://<SERVER_IP>:11434/api/tags` answers from Worker1 |
| S3 | person / code | Measure candidate models and choose one; record the numbers in the handoff's table (Part 3) | the table is filled in, and the choice is justified by it |
| S4 | person | Point Alpha at the server: PyJWT, `.env.local` (`OLLAMA_BASE_URL`, `OLLAMA_MODEL`), restart the backend (Part 4) | Alpha answers in chat within seconds, and says the coordinator runs on Host |
| S5 | person | The server becomes Host; gj8 becomes the standby (Part 5) | the 05b checks pass on the server; the failover drill passes with gj8 as standby |
| S6 | code | Fleet names and knowledge for the server: `Server` in Alpha's `fleetNames.js` and its test, gj8 renamed, and a knowledge record of the change | the watcher shows "Server"; Alpha answers where each role runs |
| S7 | code | Let Alpha use two models: a fast one for chat, a larger one for background coding (today `OLLAMA_MODEL` is one setting for everything) | a config setting for each, with tests, and both used |

## Next — code (any session)

| ID | Item | Done when |
|---|---|---|
| A1 | Two frontend buttons call routes that do not exist: `/recommendations/debug` (Hubs) and `/arduino/elegoo/install-alpha-firmware` (Devices). Add the route if a backend function already does the job, else remove the button. | both are gone from `KNOWN_MISSING` in `tests/test_frontend_api_contract.py` |
| A2 | Delete the dead copies of shadowed routes, one `api/*.py` module per PR (`tests/route_shadow_baseline.json`, 189 entries; start with `api.missions`, 13). First check that each is identical to the `main.py` copy that serves; one that differs is a bug to raise, not delete. | its lines are gone from the baseline and the suite passes |
| A3 | Split `main.py` (39k lines) one hub at a time into `api/<hub>.py` routers. The shadow ratchet makes each move safe. | one hub per PR, no new shadowing |
| A4 | Replace inline `current_user.get('role') != 'owner'` checks with the `require_owner` dependency. | `grep -c "role') != 'owner'" main.py` reaches 0 |
| V1 | Type floor 8px → 11px, one sheet at a time, with a visual-audit run before and after each. | no text under 11px in `visual-audit.mjs` tiny counts |
| V2 | Move the global sheets to `@layer`. Inside a layer `!important` reverses, so audit every deck before and after. | the nine sheets are layered and the audit is unchanged |
| V3 | Light theme for content panels (atlas-day reaches only the frame today), then `prefers-color-scheme`. | content is readable in atlas-day on every route |
| V4 | Core hub component map: on a phone its labels overlap ("Assistant Loop", "Awakening", "Awareness"). | readable at 412px |
| V5 | Brain deck renders an empty violet panel where the graph should be when WebGL is slow (seen headless). Show the graph's own empty or loading state instead. | the panel says what it is waiting for |
| V6 | Deck heroes: with the full-size gradient slab removed (2026-10-04), several decks (Hardware, Knowledge, Network, Admin, Automation, Terminal) show a large dark hero with only a headline. Give it the deck's real content, or size it to the text. | no hero more than half empty at 1440x900 |
| V7 | The collapsed capability rail floats bottom-left on phones and covers content as you scroll. Its position is deliberate (see the comment in `styles-astral-unification.css`); consider hiding it while scrolling, or docking it in the taskbar. | it never covers text a reader is reading |

## Alpha's stewards — ST1-ST6 (`HANDOFF_2026-10-05d_stewards.md`)

The fleet that "Alpha Governed Agents" starts on Worker1. Scripts are in `vyos88/Alpha`, `alpha-full`, under `BuildArtifacts/installers/Alpha-Full/scripts/`. Check with `test_alpha_agent_manager.ps1`, which also runs `test_alpha_steward_common.ps1`.

| ID | Who | Item | Done when |
|---|---|---|---|
| ST1 | person / code | Merge the Alpha#58 steward changes into Worker1's own `scripts\` copies (11 refuse; see H2). `--skip-scripts` alone does not get H1 through, because 25 `software\` files refuse too | `apply-alpha-update.mjs` reports `already` for every `scripts/` file |
| ST2 | code | `-NoExit` (`start_visible_alpha_codex_agents.ps1`, `Open-AgentWindow`) keeps a crashed hidden worker's window alive, so the manager never sees it exit and never restarts it. First confirm that every worker's command loops forever (voice, interface style, evolution, the tunnel `Watch`), then drop `-NoExit` for hidden windows | a worker that throws shows `exited` in the manager and is restarted by auto-heal |
| ST3 | code | `Get-AlphaOwnerTokenViaPython` (manager, deck, API, workspace monitor) runs Python with no timeout; a hung venv hangs the manager's 3s loop | the call returns within 20s whatever Python does, with a test |
| ST4 | code | The package and voice stewards have no DPAPI fallback, so they stop when the credential cannot be decrypted in their context | both pass `-TokenFallback` like the deck steward |
| ST5 | code | PID reuse is accepted on the process name alone (any `powershell` with that PID counts as the worker), and `-ForceNew` starts a second fleet beside the first | the registry records each worker's start time and the manager checks it; `-ForceNew` stops the old fleet first |
| ST6 | code | The manager gives a campaign agent's `/run` 30s (`Invoke-CampaignAgentCycleIfDue`); a real cycle takes longer and is recorded as an error | the timeout matches the agent's cycle budget, or the call is fire-and-forget with the receipt read later |

## Reports — for Codex (read-only)

| ID | Ask |
|---|---|
| C1 | For A1: does a backend function already do what each missing route should? Name it, or say the button should go. |
| C2 | For A2: for `api.missions`, list which shadowed handlers differ from the `main.py` copy that serves, with the differing lines. |
| C3 | The drive inventory from `status/cloud` (2026-10-03): every backup, archive or old copy over 500 MB under `C:\` (path, size, last modified) and the external drive letter. **Inventory only.** Never list `auth.json`, `.env` or keys. |
| C4 | Read `frontend/visual-audit/summary.txt` after the next audit run on the host, and rank its problems by how many routes each one affects. |
| C5 | Read `scripts/alpha_steward_common.ps1` and every script `start_visible_alpha_codex_agents.ps1` starts (Alpha `alpha-full`). Does any of them still reach `/auth/login`, or retry a sign-in in a loop, by a route the contract test's text search misses? |

## Ongoing — never "done"

- After every merge to `alpha-full`, run `apply-alpha-update.mjs` on the host
  (H1) so the live Alpha does not drift from the code.
- Run `frontend/scripts/visual-audit.mjs` after any visual change, and weekly.
  Anything it reports goes here as a V item.
- Keep `docs/STATUS.md` true. Write a dated handoff when a session ends with
  work in flight.

# laptop41 autopilot 20261117-094346

Host: DESKTOP-41HPLCN   Alpha: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software

checkout c1aa4356 did NOT update (self-update exit 1): node.exe : self-update: working copy has uncommitted changes /     + FullyQualifiedErrorId : NativeCommandError; local changes:  M scripts/laptop41-doctor.ps1,  M test/laptop41-doctor.test.js, ?? scripts/alpha_song_cover_file.mjs, ?? scripts/alpha_song_cover_jobs.py, ?? scripts/alpha_song_cover_preview.mjs, ?? scripts/alpha_song_cover_preview.py, ?? scripts/alpha_song_cover_render.py, ?? scripts/run-worker1-gpu.ps1, ?? scripts/song-cover-preview-input.png, ?? scripts/song-cover-preview-output/, ?? scripts/worker1-gpu-demand.mjs, ?? scripts/worker1-gpu-demand.mjs.before-cover-preview, ?? scripts/worker1-gpu-demand.mjs.before-song-cover-colours, ?? scripts/worker1-small-output/, ?? scripts/worker1-small-render.py
queue: 110 action(s) on control/laptop41, all of them already run

## auto-data-sync-task-20261117-094346  data-sync (task 'Alpha Data Copy', run at 2026-11-17T09:40:42)  ->  0 (in step)   (2026-11-17T09:44:52, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-17 09:40 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  not serving here, and nothing unsent from when it did: nothing to send
```

## auto-live-sync-20261117-093345  live-sync (standing)  ->  2 (needs a person)   (2026-11-17T09:34:06, 17s)
```
KNOWLEDGE: 5 document(s) differ here from the branch and are kept as they are: alpha_cloudflare_edge_repair_playbook.json, alpha_crowpanel_touch_hardware_verdict.json, alpha_deck_hub_repair_playbook.json, alph...(37).json, alph...(41).json
IN SYNC: this machine runs d2890d0 of claude/frie...(30)
HELD BACK: 1 file(s) with credential-looking lines, not pushed: scripts/alph...(30).ps1
    scripts/alph...(30).ps1:829  credential-looking assignment  'blocΓÇª(30)' { $queueStatusKey = 'blocΓÇª(30)'; $workerQueueStatusCounts.blocked_by_current_sync_policy++ }
    scripts/alph...(30).ps1:830  credential-looking assignment  'awaiΓÇª(37)' { $queueStatusKey = 'awaiΓÇª(37)'; $workerQueueStatusCounts.awaiting_authenticated_worker_channel++ }
    scripts/alph...(30).ps1:831  credential-looking assignment  'sentΓÇª(21)' { $queueStatusKey = 'sentΓÇª(21)'; $workerQueueStatusCounts.sent_awaiting_receipt++ }
    scripts/alph...(30).ps1:832  credential-looking assignment  'deliΓÇª(17)' { $queueStatusKey = 'deliΓÇª(17)'; $workerQueueStatusCounts.delivery_deferred++ }
    scripts/alph...(30).ps1:833  credential-looking assignment  'locaΓÇª(28)' { $queueStatusKey = 'locaΓÇª(28)'; $workerQueueStatusCounts.local_queue_artifact_missing++ }
    scripts/alph...(30).ps1:1461  credential-looking environment variable  ALPHA_AUDIT_TOKEN = ...
    scripts/alph...(30).ps1:1462  credential-looking environment variable  ALPHA_PASSWORD = ...
    If a line holds a real secret, move it to .env.local and rotate it. If the owner clears every line above, put this list in autofix.liveSync.allow:
ALLOW WITH: scripts/alpha_autonomy_report_30_60_90.ps1:829,scripts/alpha_autonomy_report_30_60_90.ps1:830,scripts/alpha_autonomy_report_30_60_90.ps1:831,scripts/alpha_autonomy_report_30_60_90.ps1:832,scripts/alpha_autonomy_report_30_60_90.ps1:833,scripts/alpha_autonomy_report_30_60_90.ps1:1461,scripts/alpha_autonomy_report_30_60_90.ps1:1462
```

## auto-deck-audit-20261117-093345  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-17T09:34:24, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-17T09:24:24.794741+00:00: 20 working, 1 empty, 0 broken
WORKING avatar: answers with data (animation_contract.animations 0, animation_contract.missing_actions 4, presence.available_channels 2, profile.visual_contract.palette 4)  [retry: recovered]
WORKING command: answers with data (attention 2)
WORKING control-center: answers with data (11 field(s))
WORKING devices: answers with data (boards 9)
WORKING operations: answers with data (events 20)
WORKING memory: answers with data (gaps 2, sources 7)
WORKING core: answers with data (blockers 1, metacognition.gaps 4)
WORKING beta-assistant: answers with data (allowed_tasks 5, detected_ports 0, restricted_tasks 5)
WORKING coding: answers with data (idea_method 8, languages.embedded 3, languages.javascript 5, languages.powershell 3)
WORKING extensions: answers with data (safeguards 5, skills.sources 5)
WORKING virtual-reality: answers with data (projection.axes 5, projection.camera_evidence_blocks 0, projection.measurement_quality.protocols 7, projection.rf_map.edges 3)
WORKING automation: answers with data (items 5)
WORKING learning: answers with data (queued_jobs 0)
EMPTY   diagnostics: every list in it is empty (discovered 0, registry_summary.connected_names 0, registry_summary.disconnected_names 0, registry_summary.statements 0)
WORKING kol-kos: answers with data (system.boolean_algebra.operators 7, system.opcodes 23, system.routing_tiers 4, ternary_model.states 3)
WORKING phone: answers with data (7 field(s))
WORKING network: answers with data (links 39, nodes 39, resources.awaiting_first_heartbeat 29, resources.capability_set 0)
WORKING terminal: answers with data (logs 45)
WORKING hubs (deck evidence): answers with data (assistant_loop.latest.recommendations 0, devices.connected_names 0, devices.disconnected_names 0, devices.statements 0)
WORKING music playlist: answers with data (songs 96)  [songs-mp3: 87 of 87 songs have their MP3; made 0 now, 0 failed, 0 waiting]
WORKING crowpanel: answers with data (touch.bus.addresses 2, touch.firmware_diagnostics 4)
```

## auto-data-sync-task-20261117-093345  data-sync (task 'Alpha Data Copy', run at 2026-11-17T09:30:41)  ->  1 (failed)   (2026-11-17T09:34:28, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-17 09:22 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 264 file(s), 93.4 MB written since 2026-11-17T09:08:27Z, to alpha-serv-01
  PART of a backlog: 16 file(s), 15.4 MB still to send, from 2026-11-17T09:29:23Z; the next pass carries on
  NOT IN THIS PART: 1 file(s) could not be packed, and go with the next pass (first: memory/local/fleet-transport/watch-error.json: Exception calling "Copy" with "3" argument(s): "Could not find file 'C...)
```

## auto-live-sync-20261117-091847  live-sync (standing)  ->  1 (could not run)   (2026-11-17T09:20:01, 135s)
```
STOP: could not fetch claude/frie...(30): git fetch --filter=blob:none https://github.com/vyos88/Alpha gave up after 120s (raise ALPHA_GIT_TIMEOUT_MS if that is too short)
```

## auto-deck-liveness-20261117-091347  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-17T09:14:49, 1s)
```
DECK DOWN: backend (/health) -> nothing listens on 8001  [decks: all decks]
```

## auto-deck-audit-20261117-091347  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-17T09:14:50, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-17T09:11:20.634760+00:00: 20 working, 1 empty, 0 broken
WORKING avatar: answers with data (animation_contract.animations 0, animation_contract.missing_actions 4, presence.available_channels 2, profile.visual_contract.palette 4)
WORKING command: answers with data (attention 6)
WORKING control-center: answers with data (11 field(s))
WORKING devices: answers with data (boards 9)
WORKING operations: answers with data (events 20)
WORKING memory: answers with data (gaps 2, sources 7)
WORKING core: answers with data (blockers 1, metacognition.gaps 4)
WORKING beta-assistant: answers with data (allowed_tasks 5, detected_ports 0, restricted_tasks 5)
WORKING coding: answers with data (idea_method 8, languages.embedded 3, languages.javascript 5, languages.powershell 3)
WORKING extensions: answers with data (safeguards 5, skills.sources 5)
WORKING virtual-reality: answers with data (projection.axes 5, projection.camera_evidence_blocks 0, projection.measurement_quality.protocols 7, projection.rf_map.edges 3)
WORKING automation: answers with data (items 5)
WORKING learning: answers with data (queued_jobs 0)
EMPTY   diagnostics: every list in it is empty (discovered 0, registry_summary.connected_names 0, registry_summary.disconnected_names 0, registry_summary.statements 0)
WORKING kol-kos: answers with data (system.boolean_algebra.operators 7, system.opcodes 23, system.routing_tiers 4, ternary_model.states 3)
WORKING phone: answers with data (7 field(s))
WORKING network: answers with data (links 39, nodes 39, resources.awaiting_first_heartbeat 29, resources.capability_set 0)
WORKING terminal: answers with data (logs 45)
WORKING hubs (deck evidence): answers with data (assistant_loop.latest.recommendations 0, devices.connected_names 0, devices.disconnected_names 0, devices.statements 0)
WORKING music playlist: answers with data (songs 96)  [songs-mp3: 87 of 87 songs have their MP3; made 0 now, 0 failed, 0 waiting]
WORKING crowpanel: answers with data (touch.bus.addresses 2, touch.firmware_diagnostics 4)
```

## auto-deck-audit-20261117-090345  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-17T09:04:34, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-17T09:00:39.516455+00:00: 20 working, 1 empty, 0 broken
WORKING avatar: answers with data (animation_contract.animations 0, animation_contract.missing_actions 4, presence.available_channels 2, profile.visual_contract.palette 4)
WORKING command: answers with data (attention 6)
WORKING control-center: answers with data (11 field(s))
WORKING devices: answers with data (boards 9)
WORKING operations: answers with data (events 20)
WORKING memory: answers with data (gaps 2, sources 7)
WORKING core: answers with data (blockers 1, metacognition.gaps 4)
WORKING beta-assistant: answers with data (allowed_tasks 5, detected_ports 0, restricted_tasks 5)
WORKING coding: answers with data (idea_method 8, languages.embedded 3, languages.javascript 5, languages.powershell 3)
WORKING extensions: answers with data (safeguards 5, skills.sources 5)
WORKING virtual-reality: answers with data (projection.axes 5, projection.camera_evidence_blocks 0, projection.measurement_quality.protocols 7, projection.rf_map.edges 3)
WORKING automation: answers with data (items 5)
WORKING learning: answers with data (queued_jobs 0)
EMPTY   diagnostics: every list in it is empty (discovered 0, registry_summary.connected_names 0, registry_summary.disconnected_names 0, registry_summary.statements 0)
WORKING kol-kos: answers with data (system.boolean_algebra.operators 7, system.opcodes 23, system.routing_tiers 4, ternary_model.states 3)
WORKING phone: answers with data (7 field(s))
WORKING network: answers with data (links 39, nodes 39, resources.awaiting_first_heartbeat 29, resources.capability_set 0)
WORKING terminal: answers with data (logs 45)
WORKING hubs (deck evidence): answers with data (assistant_loop.latest.recommendations 0, devices.connected_names 0, devices.disconnected_names 0, devices.statements 0)
WORKING music playlist: answers with data (songs 96)  [songs-mp3: 87 of 87 songs have their MP3; made 0 now, 0 failed, 0 waiting]
WORKING crowpanel: answers with data (touch.bus.addresses 2, touch.firmware_diagnostics 4)
```

## auto-data-sync-task-20261117-090345  data-sync (task 'Alpha Data Copy', run at 2026-11-17T09:00:41)  ->  0 (in step)   (2026-11-17T09:04:42, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-17 09:00 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 257 file(s), 20.0 MB written since 2026-11-17T08:51:13Z, to alpha-serv-01
```

## auto-deck-liveness-20261117-085346  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-17T08:55:34, 14s)
```
DECKS: 1 live, 4 stale, 1 down, 1 static, 1 no feed
DECK STALE: deck evidence (/hubs/pulse) -> the probe loop is not running (no cadence published)  [decks: alpha, terminal, spatial, embodiment, knowledge, core, reality, automation, apps, android, admin, atlas]
    22/22 hub checks ok, report 207 s old, fresh for ? s
DECK STALE: command deck (/command-center/summary) -> stale: resource governor  [decks: command]
    manager snapshot 33 s old
DECK STALE: devices (/devices/network/topology) -> no device has reported within its window (status waiting-for-heartbeat)  [decks: network, hardware, atlas]
    39 device(s), newest heartbeat 3319897 s old, fresh for 90 s
DECK LIVE: CrowPanel feed (/panel/crowpanel/state) -> feed live  [decks: CrowPanel]
    assistant heartbeat 4 s old, live within 420 s
DECK STALE: CrowPanel display (LAN reads) -> no panel has read the feed since the backend started  [decks: CrowPanel]
DECK DOWN: site (https://127.0.0.1:4173) -> the site does not answer (no answer)  [decks: all UI decks]
DECK STATIC: static decks -> no live data by design  [decks: educational, image-creator, video-creator]
DECK NO FEED: Alpha Lite Deck (COM6) -> USB serial only, no network feed; never opened by this check  [decks: Alpha Lite Deck]
receipt: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory\local\deck-liveness\latest.json
```

## auto-deck-audit-20261117-085346  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-17T08:55:48, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-17T08:50:24.341266+00:00: 20 working, 1 empty, 0 broken
WORKING avatar: answers with data (animation_contract.animations 0, animation_contract.missing_actions 4, presence.available_channels 2, profile.visual_contract.palette 4)
WORKING command: answers with data (attention 6)
WORKING control-center: answers with data (11 field(s))
WORKING devices: answers with data (boards 9)
WORKING operations: answers with data (events 20)
WORKING memory: answers with data (gaps 2, sources 7)
WORKING core: answers with data (blockers 1, metacognition.gaps 4)
WORKING beta-assistant: answers with data (allowed_tasks 5, detected_ports 0, restricted_tasks 5)
WORKING coding: answers with data (idea_method 8, languages.embedded 3, languages.javascript 5, languages.powershell 3)
WORKING extensions: answers with data (safeguards 5, skills.sources 5)
WORKING virtual-reality: answers with data (projection.axes 5, projection.camera_evidence_blocks 0, projection.measurement_quality.protocols 7, projection.rf_map.edges 3)
WORKING automation: answers with data (items 5)
WORKING learning: answers with data (queued_jobs 0)
EMPTY   diagnostics: every list in it is empty (discovered 0, registry_summary.connected_names 0, registry_summary.disconnected_names 0, registry_summary.statements 0)
WORKING kol-kos: answers with data (system.boolean_algebra.operators 7, system.opcodes 23, system.routing_tiers 4, ternary_model.states 3)
WORKING phone: answers with data (7 field(s))
WORKING network: answers with data (links 39, nodes 39, resources.awaiting_first_heartbeat 29, resources.capability_set 0)
WORKING terminal: answers with data (logs 45)
WORKING hubs (deck evidence): answers with data (assistant_loop.latest.recommendations 0, devices.connected_names 0, devices.disconnected_names 0, devices.statements 0)
WORKING music playlist: answers with data (songs 96)  [songs-mp3: 87 of 87 songs have their MP3; made 0 now, 0 failed, 0 waiting]
WORKING crowpanel: answers with data (touch.bus.addresses 2, touch.firmware_diagnostics 4)
```

## auto-data-sync-task-20261117-085346  data-sync (task 'Alpha Data Copy', run at 2026-11-17T08:50:41)  ->  0 (in step)   (2026-11-17T08:55:55, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-17 08:50 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 251 file(s), 97.7 MB written since 2026-11-17T08:40:44Z, to alpha-serv-01
  PART of a backlog: 17 file(s), 6.8 MB still to send, from 2026-11-17T08:51:13Z; the next pass carries on
```

## auto-deck-audit-20261117-084347  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-17T08:44:37, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-17T08:40:31.218412+00:00: 20 working, 1 empty, 0 broken
WORKING avatar: answers with data (animation_contract.animations 0, animation_contract.missing_actions 4, presence.available_channels 2, profile.visual_contract.palette 4)
WORKING command: answers with data (attention 6)
WORKING control-center: answers with data (11 field(s))
WORKING devices: answers with data (boards 9)
WORKING operations: answers with data (events 20)
WORKING memory: answers with data (gaps 2, sources 7)
WORKING core: answers with data (blockers 1, metacognition.gaps 4)
WORKING beta-assistant: answers with data (allowed_tasks 5, detected_ports 0, restricted_tasks 5)
WORKING coding: answers with data (idea_method 8, languages.embedded 3, languages.javascript 5, languages.powershell 3)
WORKING extensions: answers with data (safeguards 5, skills.sources 5)
WORKING virtual-reality: answers with data (projection.axes 5, projection.camera_evidence_blocks 0, projection.measurement_quality.protocols 7, projection.rf_map.edges 3)
WORKING automation: answers with data (items 5)
WORKING learning: answers with data (queued_jobs 0)
EMPTY   diagnostics: every list in it is empty (discovered 0, registry_summary.connected_names 0, registry_summary.disconnected_names 0, registry_summary.statements 0)
WORKING kol-kos: answers with data (system.boolean_algebra.operators 7, system.opcodes 23, system.routing_tiers 4, ternary_model.states 3)
WORKING phone: answers with data (7 field(s))
WORKING network: answers with data (links 39, nodes 39, resources.awaiting_first_heartbeat 29, resources.capability_set 0)
WORKING terminal: answers with data (logs 45)
WORKING hubs (deck evidence): answers with data (assistant_loop.latest.recommendations 0, devices.connected_names 0, devices.disconnected_names 0, devices.statements 0)
WORKING music playlist: answers with data (songs 96)  [songs-mp3: 87 of 87 songs have their MP3; made 0 now, 0 failed, 0 waiting]
WORKING crowpanel: answers with data (touch.bus.addresses 2, touch.firmware_diagnostics 4)
```

## auto-data-sync-task-20261117-084347  data-sync (task 'Alpha Data Copy', run at 2026-11-17T08:40:41)  ->  0 (in step)   (2026-11-17T08:44:45, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-17 08:40 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 260 file(s), 21.5 MB written since 2026-11-17T08:30:45Z, to alpha-serv-01
```

## auto-deck-liveness-20261117-083846  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-17T08:39:46, 15s)
```
DECKS: 3 live, 2 stale, 1 down, 1 static, 1 no feed
DECK LIVE: deck evidence (/hubs/pulse) -> every hub check passed  [decks: alpha, terminal, spatial, embodiment, knowledge, core, reality, automation, apps, android, admin, atlas]
    22/22 hub checks ok, report 94 s old, fresh for 150 s
DECK LIVE: command deck (/command-center/summary) -> manager and resources fresh  [decks: command]
    manager snapshot 11 s old
DECK STALE: devices (/devices/network/topology) -> no device has reported within its window (status waiting-for-heartbeat)  [decks: network, hardware, atlas]
    39 device(s), newest heartbeat 3318949 s old, fresh for 90 s
DECK LIVE: CrowPanel feed (/panel/crowpanel/state) -> feed live  [decks: CrowPanel]
    assistant heartbeat 25 s old, live within 420 s
DECK STALE: CrowPanel display (LAN reads) -> no panel has read the feed since the backend started  [decks: CrowPanel]
DECK DOWN: site (https://127.0.0.1:4173) -> the site does not answer (no answer)  [decks: all UI decks]
DECK STATIC: static decks -> no live data by design  [decks: educational, image-creator, video-creator]
DECK NO FEED: Alpha Lite Deck (COM6) -> USB serial only, no network feed; never opened by this check  [decks: Alpha Lite Deck]
receipt: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory\local\deck-liveness\latest.json
```

## auto-deck-audit-20261117-083346  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-17T08:34:33, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-17T08:29:50.300418+00:00: 20 working, 1 empty, 0 broken
WORKING avatar: answers with data (animation_contract.animations 0, animation_contract.missing_actions 4, presence.available_channels 2, profile.visual_contract.palette 4)
WORKING command: answers with data (attention 6)
WORKING control-center: answers with data (11 field(s))
WORKING devices: answers with data (boards 9)
WORKING operations: answers with data (events 20)
WORKING memory: answers with data (gaps 2, sources 7)
WORKING core: answers with data (blockers 1, metacognition.gaps 4)
WORKING beta-assistant: answers with data (allowed_tasks 5, detected_ports 0, restricted_tasks 5)
WORKING coding: answers with data (idea_method 8, languages.embedded 3, languages.javascript 5, languages.powershell 3)
WORKING extensions: answers with data (safeguards 5, skills.sources 5)
WORKING virtual-reality: answers with data (projection.axes 5, projection.camera_evidence_blocks 0, projection.measurement_quality.protocols 7, projection.rf_map.edges 3)
WORKING automation: answers with data (items 5)
WORKING learning: answers with data (queued_jobs 0)
EMPTY   diagnostics: every list in it is empty (discovered 0, registry_summary.connected_names 0, registry_summary.disconnected_names 0, registry_summary.statements 0)
WORKING kol-kos: answers with data (system.boolean_algebra.operators 7, system.opcodes 23, system.routing_tiers 4, ternary_model.states 3)
WORKING phone: answers with data (7 field(s))
WORKING network: answers with data (links 39, nodes 39, resources.awaiting_first_heartbeat 29, resources.capability_set 0)
WORKING terminal: answers with data (logs 45)
WORKING hubs (deck evidence): answers with data (assistant_loop.latest.recommendations 0, devices.connected_names 0, devices.disconnected_names 0, devices.statements 0)
WORKING music playlist: answers with data (songs 96)  [songs-mp3: 87 of 87 songs have their MP3; made 0 now, 0 failed, 0 waiting]
WORKING crowpanel: answers with data (touch.bus.addresses 2, touch.firmware_diagnostics 4)
```

## auto-data-sync-task-20261117-083346  data-sync (task 'Alpha Data Copy', run at 2026-11-17T08:30:41)  ->  0 (in step)   (2026-11-17T08:34:41, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-17 08:30 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 246 file(s), 20.7 MB written since 2026-11-17T08:20:29Z, to alpha-serv-01
```

## auto-data-sync-task-20261117-082846  data-sync (task 'Alpha Data Copy', run at 2026-11-17T08:20:41)  ->  0 (in step)   (2026-11-17T08:29:34, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-17 08:20 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 229 file(s), 99.2 MB written since 2026-11-17T08:10:44Z, to alpha-serv-01
  PART of a backlog: 38 file(s), 4.5 MB still to send, from 2026-11-17T08:20:29Z; the next pass carries on
```

## auto-deck-audit-20261117-082346  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-17T08:25:22, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-17T08:21:32.493936+00:00: 20 working, 1 empty, 0 broken
WORKING avatar: answers with data (animation_contract.animations 0, animation_contract.missing_actions 4, presence.available_channels 2, profile.visual_contract.palette 4)
WORKING command: answers with data (attention 6)
WORKING control-center: answers with data (11 field(s))
WORKING devices: answers with data (boards 9)
WORKING operations: answers with data (events 20)
WORKING memory: answers with data (gaps 2, sources 7)
WORKING core: answers with data (blockers 1, metacognition.gaps 3)
WORKING beta-assistant: answers with data (allowed_tasks 5, detected_ports 0, restricted_tasks 5)
WORKING coding: answers with data (idea_method 8, languages.embedded 3, languages.javascript 5, languages.powershell 3)
WORKING extensions: answers with data (safeguards 5, skills.sources 5)
WORKING virtual-reality: answers with data (projection.axes 5, projection.camera_evidence_blocks 0, projection.measurement_quality.protocols 7, projection.rf_map.edges 3)
WORKING automation: answers with data (items 5)
WORKING learning: answers with data (queued_jobs 0)
EMPTY   diagnostics: every list in it is empty (discovered 0, registry_summary.connected_names 0, registry_summary.disconnected_names 0, registry_summary.statements 0)
WORKING kol-kos: answers with data (system.boolean_algebra.operators 7, system.opcodes 23, system.routing_tiers 4, ternary_model.states 3)
WORKING phone: answers with data (7 field(s))
WORKING network: answers with data (links 39, nodes 39, resources.awaiting_first_heartbeat 29, resources.capability_set 0)
WORKING terminal: answers with data (logs 45)
WORKING hubs (deck evidence): answers with data (assistant_loop.latest.recommendations 4, devices.connected_names 0, devices.disconnected_names 0, devices.statements 0)
WORKING music playlist: answers with data (songs 96)  [songs-mp3: 87 of 87 songs have their MP3; made 0 now, 0 failed, 0 waiting]
WORKING crowpanel: answers with data (touch.bus.addresses 2, touch.firmware_diagnostics 4)
```

## auto-deck-liveness-20261117-081847  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-17T08:20:30, 17s)
```
DECKS: 4 live, 2 stale, 1 static, 1 no feed
DECK LIVE: deck evidence (/hubs/pulse) -> every hub check passed  [decks: alpha, terminal, spatial, embodiment, knowledge, core, reality, automation, apps, android, admin, atlas]
    22/22 hub checks ok, report 76 s old, fresh for 150 s
DECK LIVE: command deck (/command-center/summary) -> manager and resources fresh  [decks: command]
    manager snapshot 12 s old
DECK STALE: devices (/devices/network/topology) -> no device has reported within its window (status waiting-for-heartbeat)  [decks: network, hardware, atlas]
    39 device(s), newest heartbeat 3317793 s old, fresh for 90 s
DECK LIVE: CrowPanel feed (/panel/crowpanel/state) -> feed live  [decks: CrowPanel]
    assistant heartbeat 13 s old, live within 420 s
DECK STALE: CrowPanel display (LAN reads) -> no panel has read the feed since the backend started  [decks: CrowPanel]
DECK LIVE: site (https://127.0.0.1:4173) -> the page and every asset it names load  [decks: all UI decks]
    7 asset(s) checked
DECK STATIC: static decks -> no live data by design  [decks: educational, image-creator, video-creator]
DECK NO FEED: Alpha Lite Deck (COM6) -> USB serial only, no network feed; never opened by this check  [decks: Alpha Lite Deck]
receipt: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory\local\deck-liveness\latest.json
```


# laptop41 autopilot 20261119-070346

Host: DESKTOP-41HPLCN   Alpha: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software

checkout c1aa4356 did NOT update (self-update exit 1): node.exe : self-update: working copy has uncommitted changes /     + FullyQualifiedErrorId : NativeCommandError; local changes:  M scripts/laptop41-doctor.ps1,  M test/laptop41-doctor.test.js, ?? scripts/alpha_song_cover_file.mjs, ?? scripts/alpha_song_cover_jobs.py, ?? scripts/alpha_song_cover_preview.mjs, ?? scripts/alpha_song_cover_preview.py, ?? scripts/alpha_song_cover_render.py, ?? scripts/run-worker1-gpu.ps1, ?? scripts/song-cover-preview-input.png, ?? scripts/song-cover-preview-output/, ?? scripts/worker1-gpu-demand.mjs, ?? scripts/worker1-gpu-demand.mjs.before-cover-preview, ?? scripts/worker1-gpu-demand.mjs.before-song-cover-colours, ?? scripts/worker1-small-output/, ?? scripts/worker1-small-render.py
queue: 110 action(s) on control/laptop41, all of them already run

## auto-data-sync-task-20261119-070346  data-sync (task 'Alpha Data Copy', run at 2026-11-19T07:00:41)  ->  0 (in step)   (2026-11-19T07:04:48, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-19 07:00 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 40 file(s), 11.1 MB written since 2026-11-19T06:58:38Z, to alpha-serv-01
```

## auto-live-sync-20261119-065847  live-sync (standing)  ->  2 (needs a person)   (2026-11-19T06:59:10, 22s)
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

## auto-live-sync-20261119-064849  live-sync (standing)  ->  1 (could not run)   (2026-11-19T06:49:59, 151s)
```
STOP: could not fetch claude/frie...(30): git fetch --filter=blob:none https://github.com/vyos88/Alpha gave up after 120s (raise ALPHA_GIT_TIMEOUT_MS if that is too short)
```

## auto-deck-audit-20261119-064849  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-19T06:55:45, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-19T06:50:36.427786+00:00: 20 working, 1 empty, 0 broken
WORKING avatar: answers with data (animation_contract.animations 0, animation_contract.missing_actions 4, presence.available_channels 1, profile.visual_contract.palette 4)
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

## auto-deck-audit-20261119-064346  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-19T06:44:23, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-19T06:40:04.369532+00:00: 20 working, 1 empty, 0 broken
WORKING avatar: answers with data (animation_contract.animations 0, animation_contract.missing_actions 4, presence.available_channels 1, profile.visual_contract.palette 4)
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
WORKING terminal: answers with data (logs 47)
WORKING hubs (deck evidence): answers with data (assistant_loop.latest.recommendations 0, devices.connected_names 0, devices.disconnected_names 0, devices.statements 0)
WORKING music playlist: answers with data (songs 96)  [songs-mp3: 87 of 87 songs have their MP3; made 0 now, 0 failed, 0 waiting]
WORKING crowpanel: answers with data (touch.bus.addresses 2, touch.firmware_diagnostics 4)
```

## auto-data-sync-task-20261119-064346  data-sync (task 'Alpha Data Copy', run at 2026-11-19T06:40:41)  ->  0 (in step)   (2026-11-19T06:44:27, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-19 06:40 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 29 file(s), 17.3 MB written since 2026-11-19T06:34:21Z, to alpha-serv-01
  PART of a backlog: 217 file(s), 86.2 MB still to send, from 2026-11-19T06:40:24Z; the next pass carries on
```

## auto-data-sync-task-20261119-063845  data-sync (task 'Alpha Data Copy', run at 2026-11-19T06:30:42)  ->  1 (failed)   (2026-11-19T06:39:43, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-19 06:21 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 258 file(s), 96.7 MB written since 2026-11-19T06:12:00Z, to alpha-serv-01
  PART of a backlog: 10 file(s), 9.4 MB still to send, from 2026-11-19T06:34:21Z; the next pass carries on
  NOT IN THIS PART: 1 file(s) could not be packed, and go with the next pass (first: memory/local/backend.pid: Exception calling "Copy" with "3" argument(s): "Could not find file 'C:\Users\Vyo\Downloads...)
```

## auto-deck-liveness-20261119-061847  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-19T06:32:30, 47s)
```
DECKS: 3 live, 3 stale, 1 static, 1 no feed
DECK LIVE: deck evidence (/hubs/pulse) -> every hub check passed  [decks: alpha, terminal, spatial, embodiment, knowledge, core, reality, automation, apps, android, admin, atlas]
    22/22 hub checks ok, report 28 s old, fresh for 150 s
DECK STALE: command deck (/command-center/summary) -> stale: Agent Manager snapshot  [decks: command]
    manager snapshot 845 s old
DECK STALE: devices (/devices/network/topology) -> no device has reported within its window (status waiting-for-heartbeat)  [decks: network, hardware, atlas]
    39 device(s), newest heartbeat 3484132 s old, fresh for 90 s
DECK LIVE: CrowPanel feed (/panel/crowpanel/state) -> feed live  [decks: CrowPanel]
    assistant heartbeat 29 s old, live within 420 s
DECK STALE: CrowPanel display (LAN reads) -> no panel has read the feed since the backend started  [decks: CrowPanel]
DECK LIVE: site (https://127.0.0.1:4173) -> the page and every asset it names load  [decks: all UI decks]
    7 asset(s) checked
DECK STATIC: static decks -> no live data by design  [decks: educational, image-creator, video-creator]
DECK NO FEED: Alpha Lite Deck (COM6) -> USB serial only, no network feed; never opened by this check  [decks: Alpha Lite Deck]
receipt: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory\local\deck-liveness\latest.json
```

## auto-deck-audit-20261119-061847  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-19T06:33:17, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-19T06:21:08.148695+00:00: 20 working, 1 empty, 0 broken
WORKING avatar: answers with data (animation_contract.animations 0, animation_contract.missing_actions 4, presence.available_channels 1, profile.visual_contract.palette 4)
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

## auto-deck-liveness-20261119-061348  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-19T06:15:13, 0s)
```
DECK DOWN: backend (/health) -> nothing listens on 8001  [decks: all decks]
```

## auto-data-sync-task-20261119-061348  data-sync (task 'Alpha Data Copy', run at 2026-11-19T06:10:41)  ->  0 (in step)   (2026-11-19T06:15:19, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-19 06:10 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 265 file(s), 97.9 MB written since 2026-11-19T05:58:48Z, to alpha-serv-01
  PART of a backlog: 4 file(s), 7.4 MB still to send, from 2026-11-19T06:12:00Z; the next pass carries on
```

## auto-deck-audit-20261119-060846  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-19T06:09:33, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-19T06:08:22.907546+00:00: 20 working, 1 empty, 0 broken
WORKING avatar: answers with data (animation_contract.animations 0, animation_contract.missing_actions 4, presence.available_channels 1, profile.visual_contract.palette 4)
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
WORKING terminal: answers with data (logs 46)
WORKING hubs (deck evidence): answers with data (assistant_loop.latest.recommendations 0, devices.connected_names 0, devices.disconnected_names 0, devices.statements 0)
WORKING music playlist: answers with data (songs 96)  [songs-mp3: 87 of 87 songs have their MP3; made 0 now, 0 failed, 0 waiting]
WORKING crowpanel: answers with data (touch.bus.addresses 2, touch.firmware_diagnostics 4)
```

## auto-data-sync-task-20261119-060347  data-sync (task 'Alpha Data Copy', run at 2026-11-19T06:00:41)  ->  0 (in step)   (2026-11-19T06:05:01, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-19 05:50 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 87 file(s), 98.9 MB written since 2026-11-19T05:40:46Z, to alpha-serv-01
  PART of a backlog: 217 file(s), 18.5 MB still to send, from 2026-11-19T05:58:48Z; the next pass carries on
```

## auto-deck-liveness-20261119-054845  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-19T05:55:36, 134s)
```
NOTE: could not mint a local sign-in token; owner-only sources will read ERROR
DECKS: 1 live, 4 error, 1 static, 1 no feed
DECK ERROR: deck evidence (/hubs/pulse) -> the backend refused this check's sign-in (401)  [decks: alpha, terminal, spatial, embodiment, knowledge, core, reality, automation, apps, android, admin, atlas]
DECK ERROR: command deck (/command-center/summary) -> the backend refused this check's sign-in (401)  [decks: command]
DECK ERROR: devices (/devices/network/topology) -> the backend refused this check's sign-in (401)  [decks: network, hardware, atlas]
DECK ERROR: CrowPanel feed (/panel/crowpanel/state) -> the backend refused this check's sign-in (401)  [decks: CrowPanel]
DECK LIVE: site (https://127.0.0.1:4173) -> the page and every asset it names load  [decks: all UI decks]
    7 asset(s) checked
DECK STATIC: static decks -> no live data by design  [decks: educational, image-creator, video-creator]
DECK NO FEED: Alpha Lite Deck (COM6) -> USB serial only, no network feed; never opened by this check  [decks: Alpha Lite Deck]
receipt: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory\local\deck-liveness\latest.json
```

## auto-deck-audit-20261119-054845  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-19T05:57:51, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-19T05:49:35.204468+00:00: 20 working, 1 empty, 0 broken
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
WORKING terminal: answers with data (logs 44)
WORKING hubs (deck evidence): answers with data (assistant_loop.latest.recommendations 0, devices.connected_names 0, devices.disconnected_names 0, devices.statements 0)
WORKING music playlist: answers with data (songs 96)  [songs-mp3: 87 of 87 songs have their MP3; made 0 now, 0 failed, 0 waiting]
WORKING crowpanel: answers with data (touch.bus.addresses 2, touch.firmware_diagnostics 4)
```

## auto-deck-audit-20261119-053845  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-19T05:39:54, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-19T05:38:46.376035+00:00: 20 working, 1 empty, 0 broken
WORKING avatar: answers with data (animation_contract.animations 0, animation_contract.missing_actions 4, presence.available_channels 1, profile.visual_contract.palette 4)
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
WORKING terminal: answers with data (logs 47)
WORKING hubs (deck evidence): answers with data (assistant_loop.latest.recommendations 0, devices.connected_names 0, devices.disconnected_names 0, devices.statements 0)
WORKING music playlist: answers with data (songs 96)  [songs-mp3: 87 of 87 songs have their MP3; made 0 now, 0 failed, 0 waiting]
WORKING crowpanel: answers with data (touch.bus.addresses 2, touch.firmware_diagnostics 4)
```

## auto-data-sync-task-20261119-053346  data-sync (task 'Alpha Data Copy', run at 2026-11-19T05:30:42)  ->  0 (in step)   (2026-11-19T05:35:07, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-19 05:30 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 62 file(s), 94.2 MB written since 2026-11-19T04:52:43Z, to alpha-serv-01
  PART of a backlog: 227 file(s), 11.1 MB still to send, from 2026-11-19T05:28:11Z; the next pass carries on
```

## auto-deck-liveness-20261119-052846  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-19T05:29:37, 14s)
```
DECKS: 4 live, 2 stale, 1 static, 1 no feed
DECK LIVE: deck evidence (/hubs/pulse) -> every hub check passed  [decks: alpha, terminal, spatial, embodiment, knowledge, core, reality, automation, apps, android, admin, atlas]
    22/22 hub checks ok, report 37 s old, fresh for 150 s
DECK LIVE: command deck (/command-center/summary) -> manager and resources fresh  [decks: command]
    manager snapshot 7 s old
DECK STALE: devices (/devices/network/topology) -> no device has reported within its window (status waiting-for-heartbeat)  [decks: network, hardware, atlas]
    39 device(s), newest heartbeat 3480341 s old, fresh for 90 s
DECK LIVE: CrowPanel feed (/panel/crowpanel/state) -> feed live  [decks: CrowPanel]
    assistant heartbeat 28 s old, live within 420 s
DECK STALE: CrowPanel display (LAN reads) -> no panel has read the feed since the backend started  [decks: CrowPanel]
DECK LIVE: site (https://127.0.0.1:4173) -> the page and every asset it names load  [decks: all UI decks]
    7 asset(s) checked
DECK STATIC: static decks -> no live data by design  [decks: educational, image-creator, video-creator]
DECK NO FEED: Alpha Lite Deck (COM6) -> USB serial only, no network feed; never opened by this check  [decks: Alpha Lite Deck]
receipt: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory\local\deck-liveness\latest.json
```

## auto-deck-audit-20261119-052846  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-19T05:29:51, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-19T05:27:21.695958+00:00: 20 working, 1 empty, 0 broken
WORKING avatar: answers with data (animation_contract.animations 0, animation_contract.missing_actions 4, presence.available_channels 1, profile.visual_contract.palette 4)
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

## auto-data-sync-task-20261119-052346  data-sync (task 'Alpha Data Copy', run at 2026-11-19T05:20:42)  ->  0 (in step)   (2026-11-19T05:24:53, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-19 05:20 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  not serving here, and nothing unsent from when it did: nothing to send
```


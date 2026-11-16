# laptop41 autopilot 20261116-173346

Host: DESKTOP-41HPLCN   Alpha: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software

checkout c1aa4356 did NOT update (self-update exit 1): node.exe : self-update: working copy has uncommitted changes /     + FullyQualifiedErrorId : NativeCommandError; local changes:  M scripts/laptop41-doctor.ps1,  M test/laptop41-doctor.test.js, ?? scripts/alpha_song_cover_file.mjs, ?? scripts/alpha_song_cover_jobs.py, ?? scripts/alpha_song_cover_preview.mjs, ?? scripts/alpha_song_cover_preview.py, ?? scripts/alpha_song_cover_render.py, ?? scripts/run-worker1-gpu.ps1, ?? scripts/song-cover-preview-input.png, ?? scripts/song-cover-preview-output/, ?? scripts/worker1-gpu-demand.mjs, ?? scripts/worker1-gpu-demand.mjs.before-cover-preview, ?? scripts/worker1-gpu-demand.mjs.before-song-cover-colours, ?? scripts/worker1-small-output/, ?? scripts/worker1-small-render.py
queue: 110 action(s) on control/laptop41, all of them already run

## auto-data-sync-task-20261116-173346  data-sync (task 'Alpha Data Copy', run at 2026-11-16T17:30:41)  ->  0 (in step)   (2026-11-16T17:34:33, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-16 17:21 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 232 file(s), 96.5 MB written since 2026-11-16T17:10:53Z, to alpha-serv-01
  PART of a backlog: 44 file(s), 10.7 MB still to send, from 2026-11-16T17:24:37Z; the next pass carries on
```

## auto-deck-liveness-20261116-171849  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-16T17:28:20, 33s)
```
DECKS: 2 live, 1 degraded, 3 stale, 1 static, 1 no feed
DECK DEGRADED: deck evidence (/hubs/pulse) -> failing hubs: diagnostics  [decks: alpha, terminal, spatial, embodiment, knowledge, core, reality, automation, apps, android, admin, atlas]
    21/22 hub checks ok, report 89 s old, fresh for 150 s
DECK STALE: command deck (/command-center/summary) -> stale: Agent Manager snapshot  [decks: command]
    manager snapshot 572 s old
DECK STALE: devices (/devices/network/topology) -> no device has reported within its window (status waiting-for-heartbeat)  [decks: network, hardware, atlas]
    39 device(s), newest heartbeat 3264281 s old, fresh for 90 s
DECK LIVE: CrowPanel feed (/panel/crowpanel/state) -> feed live  [decks: CrowPanel]
    assistant heartbeat 56 s old, live within 420 s
DECK STALE: CrowPanel display (LAN reads) -> no panel has read the feed since the backend started  [decks: CrowPanel]
DECK LIVE: site (https://127.0.0.1:4173) -> the page and every asset it names load  [decks: all UI decks]
    7 asset(s) checked
DECK STATIC: static decks -> no live data by design  [decks: educational, image-creator, video-creator]
DECK NO FEED: Alpha Lite Deck (COM6) -> USB serial only, no network feed; never opened by this check  [decks: Alpha Lite Deck]
receipt: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory\local\deck-liveness\latest.json
```

## auto-deck-audit-20261116-171849  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-16T17:28:53, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-16T17:24:08.748078+00:00: 20 working, 1 empty, 0 broken
WORKING avatar: answers with data (animation_contract.animations 0, animation_contract.missing_actions 4, presence.available_channels 1, profile.visual_contract.palette 4)
WORKING command: answers with data (attention 2)
WORKING control-center: answers with data (11 field(s))
WORKING devices: answers with data (boards 9)
WORKING operations: answers with data (events 20)
WORKING memory: answers with data (gaps 2, sources 7)
WORKING core: answers with data (blockers 3, metacognition.gaps 3)
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
WORKING terminal: answers with data (logs 49)
WORKING hubs (deck evidence): answers with data (assistant_loop.latest.recommendations 4, devices.connected_names 0, devices.disconnected_names 0, devices.statements 0)  [retry: recovered]
WORKING music playlist: answers with data (songs 96)  [songs-mp3: 87 of 87 songs have their MP3; made 0 now, 0 failed, 0 waiting]
WORKING crowpanel: answers with data (touch.bus.addresses 2, touch.firmware_diagnostics 4)
```

## auto-deck-audit-20261116-171346  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-16T17:14:52, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-16T17:13:58.750264+00:00: 20 working, 1 empty, 0 broken
WORKING avatar: answers with data (animation_contract.animations 0, animation_contract.missing_actions 4, presence.available_channels 2, profile.visual_contract.palette 4)
WORKING command: answers with data (attention 6)
WORKING control-center: answers with data (11 field(s))
WORKING devices: answers with data (boards 9)
WORKING operations: answers with data (events 20)
WORKING memory: answers with data (gaps 2, sources 7)
WORKING core: answers with data (blockers 1, metacognition.gaps 2)
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
WORKING terminal: answers with data (logs 49)
WORKING hubs (deck evidence): answers with data (assistant_loop.latest.recommendations 4, devices.connected_names 0, devices.disconnected_names 0, devices.statements 0)
WORKING music playlist: answers with data (songs 96)  [songs-mp3: 87 of 87 songs have their MP3; made 0 now, 0 failed, 0 waiting]
WORKING crowpanel: answers with data (touch.bus.addresses 2, touch.firmware_diagnostics 4)
```

## auto-data-sync-task-20261116-171346  data-sync (task 'Alpha Data Copy', run at 2026-11-16T17:10:42)  ->  0 (in step)   (2026-11-16T17:14:59, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-16 17:10 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 263 file(s), 22.6 MB written since 2026-11-16T17:03:19Z, to alpha-serv-01
```

## auto-deck-audit-20261116-170346  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-16T17:05:26, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-16T17:02:44.379623+00:00: 20 working, 1 empty, 0 broken
WORKING avatar: answers with data (animation_contract.animations 0, animation_contract.missing_actions 4, presence.available_channels 2, profile.visual_contract.palette 4)
WORKING command: answers with data (attention 6)
WORKING control-center: answers with data (11 field(s))
WORKING devices: answers with data (boards 9)
WORKING operations: answers with data (events 20)
WORKING memory: answers with data (gaps 2, sources 7)
WORKING core: answers with data (blockers 1, metacognition.gaps 2)
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
WORKING terminal: answers with data (logs 48)
WORKING hubs (deck evidence): answers with data (assistant_loop.latest.recommendations 4, devices.connected_names 0, devices.disconnected_names 0, devices.statements 0)
WORKING music playlist: answers with data (songs 96)  [songs-mp3: 87 of 87 songs have their MP3; made 0 now, 0 failed, 0 waiting]
WORKING crowpanel: answers with data (touch.bus.addresses 2, touch.firmware_diagnostics 4)
```

## auto-data-sync-task-20261116-165348  data-sync (task 'Alpha Data Copy', run at 2026-11-16T16:50:41)  ->  0 (in step)   (2026-11-16T16:55:16, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-16 16:50 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 275 file(s), 21.2 MB written since 2026-11-16T16:39:07Z, to alpha-serv-01
```

## auto-deck-liveness-20261116-164346  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-16T16:44:37, 11s)
```
DECKS: 4 live, 2 stale, 1 static, 1 no feed
DECK LIVE: deck evidence (/hubs/pulse) -> every hub check passed  [decks: alpha, terminal, spatial, embodiment, knowledge, core, reality, automation, apps, android, admin, atlas]
    22/22 hub checks ok, report 39 s old, fresh for 150 s
DECK LIVE: command deck (/command-center/summary) -> manager and resources fresh  [decks: command]
    manager snapshot 25 s old
DECK STALE: devices (/devices/network/topology) -> no device has reported within its window (status waiting-for-heartbeat)  [decks: network, hardware, atlas]
    39 device(s), newest heartbeat 3261642 s old, fresh for 90 s
DECK LIVE: CrowPanel feed (/panel/crowpanel/state) -> feed live  [decks: CrowPanel]
    assistant heartbeat 31 s old, live within 420 s
DECK STALE: CrowPanel display (LAN reads) -> no panel has read the feed since the backend started  [decks: CrowPanel]
DECK LIVE: site (https://127.0.0.1:4173) -> the page and every asset it names load  [decks: all UI decks]
    7 asset(s) checked
DECK STATIC: static decks -> no live data by design  [decks: educational, image-creator, video-creator]
DECK NO FEED: Alpha Lite Deck (COM6) -> USB serial only, no network feed; never opened by this check  [decks: Alpha Lite Deck]
receipt: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory\local\deck-liveness\latest.json
```

## auto-deck-audit-20261116-164346  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-16T16:44:49, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-16T16:42:19.119172+00:00: 20 working, 1 empty, 0 broken
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

## auto-data-sync-task-20261116-164346  data-sync (task 'Alpha Data Copy', run at 2026-11-16T16:40:43)  ->  0 (in step)   (2026-11-16T16:44:56, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-16 16:40 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 46 file(s), 98.5 MB written since 2026-11-16T16:29:15Z, to alpha-serv-01
  PART of a backlog: 215 file(s), 5.4 MB still to send, from 2026-11-16T16:39:07Z; the next pass carries on
```

## auto-deck-audit-20261116-163351  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-16T16:34:44, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-16T16:32:07.417063+00:00: 20 working, 1 empty, 0 broken
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

## auto-data-sync-task-20261116-163351  data-sync (task 'Alpha Data Copy', run at 2026-11-16T16:30:41)  ->  0 (in step)   (2026-11-16T16:34:50, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-16 16:30 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 45 file(s), 98.5 MB written since 2026-11-16T16:19:51Z, to alpha-serv-01
  PART of a backlog: 215 file(s), 5.4 MB still to send, from 2026-11-16T16:29:15Z; the next pass carries on
```

## auto-deck-liveness-20261116-162349  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-16T16:25:18, 0s)
```
DECK DOWN: backend (/health) -> nothing listens on 8001  [decks: all decks]
```

## auto-deck-audit-20261116-162349  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-16T16:25:19, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-16T16:22:29.214233+00:00: 20 working, 1 empty, 0 broken
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

## auto-data-sync-task-20261116-162349  data-sync (task 'Alpha Data Copy', run at 2026-11-16T16:20:41)  ->  0 (in step)   (2026-11-16T16:25:25, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-16 16:20 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 45 file(s), 99.2 MB written since 2026-11-16T16:12:13Z, to alpha-serv-01
  PART of a backlog: 223 file(s), 4.8 MB still to send, from 2026-11-16T16:19:51Z; the next pass carries on
```

## auto-deck-audit-20261116-161347  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-16T16:15:21, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-16T16:11:30.306769+00:00: 20 working, 1 empty, 0 broken
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

## auto-data-sync-task-20261116-161347  data-sync (task 'Alpha Data Copy', run at 2026-11-16T16:10:42)  ->  0 (in step)   (2026-11-16T16:15:27, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-16 16:10 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 257 file(s), 97.8 MB written since 2026-11-16T16:01:45Z, to alpha-serv-01
  PART of a backlog: 5 file(s), 6.1 MB still to send, from 2026-11-16T16:12:13Z; the next pass carries on
```

## auto-deck-liveness-20261116-160857  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-16T16:10:09, 10s)
```
DECKS: 3 live, 2 stale, 1 down, 1 static, 1 no feed
DECK LIVE: deck evidence (/hubs/pulse) -> every hub check passed  [decks: alpha, terminal, spatial, embodiment, knowledge, core, reality, automation, apps, android, admin, atlas]
    22/22 hub checks ok, report 55 s old, fresh for 150 s
DECK LIVE: command deck (/command-center/summary) -> manager and resources fresh  [decks: command]
    manager snapshot 8 s old
DECK STALE: devices (/devices/network/topology) -> no device has reported within its window (status waiting-for-heartbeat)  [decks: network, hardware, atlas]
    39 device(s), newest heartbeat 3259569 s old, fresh for 90 s
DECK LIVE: CrowPanel feed (/panel/crowpanel/state) -> feed live  [decks: CrowPanel]
    assistant heartbeat 50 s old, live within 420 s
DECK STALE: CrowPanel display (LAN reads) -> no panel has read the feed since the backend started  [decks: CrowPanel]
DECK DOWN: site (https://127.0.0.1:4173) -> the site does not answer (no answer)  [decks: all UI decks]
DECK STATIC: static decks -> no live data by design  [decks: educational, image-creator, video-creator]
DECK NO FEED: Alpha Lite Deck (COM6) -> USB serial only, no network feed; never opened by this check  [decks: Alpha Lite Deck]
receipt: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory\local\deck-liveness\latest.json
```

## auto-data-sync-task-20261116-160353  data-sync (task 'Alpha Data Copy', run at 2026-11-16T16:00:41)  ->  0 (in step)   (2026-11-16T16:05:38, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-16 16:01 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 233 file(s), 98.8 MB written since 2026-11-16T15:51:37Z, to alpha-serv-01
  PART of a backlog: 20 file(s), 4.3 MB still to send, from 2026-11-16T16:01:45Z; the next pass carries on
```

## auto-deck-liveness-20261116-155346  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-16T15:54:37, 1s)
```
DECK DOWN: backend (/health) -> nothing listens on 8001  [decks: all decks]
```


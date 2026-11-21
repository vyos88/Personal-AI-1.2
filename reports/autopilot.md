# laptop41 autopilot 20261121-014345

Host: DESKTOP-41HPLCN   Alpha: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software

checkout c1aa4356 did NOT update (self-update exit 1): node.exe : self-update: working copy has uncommitted changes /     + FullyQualifiedErrorId : NativeCommandError; local changes:  M scripts/laptop41-doctor.ps1,  M test/laptop41-doctor.test.js, ?? scripts/alpha_song_cover_file.mjs, ?? scripts/alpha_song_cover_jobs.py, ?? scripts/alpha_song_cover_preview.mjs, ?? scripts/alpha_song_cover_preview.py, ?? scripts/alpha_song_cover_render.py, ?? scripts/run-worker1-gpu.ps1, ?? scripts/song-cover-preview-input.png, ?? scripts/song-cover-preview-output/, ?? scripts/worker1-gpu-demand.mjs, ?? scripts/worker1-gpu-demand.mjs.before-cover-preview, ?? scripts/worker1-gpu-demand.mjs.before-song-cover-colours, ?? scripts/worker1-small-output/, ?? scripts/worker1-small-render.py
queue: 110 action(s) on control/laptop41, all of them already run

## auto-data-sync-task-20261121-014345  data-sync (task 'Alpha Data Copy', run at 2026-11-21T01:40:41)  ->  0 (in step)   (2026-11-21T01:44:31, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-21 01:40 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 266 file(s), 16.9 MB written since 2026-11-21T01:30:42Z, to alpha-serv-01
```

## auto-deck-liveness-20261121-013845  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-21T01:39:01, 0s)
```
DECK DOWN: backend (/health) -> nothing listens on 8001  [decks: all decks]
```

## auto-deck-audit-20261121-013845  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-21T01:39:01, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-21T01:34:14.732814+00:00: 20 working, 1 empty, 0 broken
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

## auto-data-sync-task-20261121-013845  data-sync (task 'Alpha Data Copy', run at 2026-11-21T01:30:41)  ->  0 (in step)   (2026-11-21T01:39:04, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-21 01:30 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 235 file(s), 93.4 MB written since 2026-11-21T01:23:15Z, to alpha-serv-01
```

## auto-deck-liveness-20261121-011849  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-21T01:20:24, 52s)
```
DECKS: 3 live, 3 stale, 1 static, 1 no feed
DECK STALE: deck evidence (/hubs/pulse) -> the probe report is older than its own freshness window  [decks: alpha, terminal, spatial, embodiment, knowledge, core, reality, automation, apps, android, admin, atlas]
    22/22 hub checks ok, report 227 s old, fresh for 150 s
DECK LIVE: command deck (/command-center/summary) -> manager and resources fresh  [decks: command]
    manager snapshot 90 s old
DECK STALE: devices (/devices/network/topology) -> no device has reported within its window (status waiting-for-heartbeat)  [decks: network, hardware, atlas]
    39 device(s), newest heartbeat 3638216 s old, fresh for 90 s
DECK LIVE: CrowPanel feed (/panel/crowpanel/state) -> feed live  [decks: CrowPanel]
    assistant heartbeat 10 s old, live within 420 s
DECK STALE: CrowPanel display (LAN reads) -> no panel has read the feed since the backend started  [decks: CrowPanel]
DECK LIVE: site (https://127.0.0.1:4173) -> the page and every asset it names load  [decks: all UI decks]
    7 asset(s) checked
DECK STATIC: static decks -> no live data by design  [decks: educational, image-creator, video-creator]
DECK NO FEED: Alpha Lite Deck (COM6) -> USB serial only, no network feed; never opened by this check  [decks: Alpha Lite Deck]
receipt: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory\local\deck-liveness\latest.json
```

## auto-deck-audit-20261121-011346  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-21T01:14:18, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-21T01:11:26.032128+00:00: 20 working, 1 empty, 0 broken
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
WORKING terminal: answers with data (logs 48)
WORKING hubs (deck evidence): answers with data (assistant_loop.latest.recommendations 4, devices.connected_names 0, devices.disconnected_names 0, devices.statements 0)
WORKING music playlist: answers with data (songs 96)  [songs-mp3: 87 of 87 songs have their MP3; made 0 now, 0 failed, 0 waiting]
WORKING crowpanel: answers with data (touch.bus.addresses 2, touch.firmware_diagnostics 4)
```

## auto-deck-liveness-20261121-010346  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-21T01:04:20, 1s)
```
DECK DOWN: backend (/health) -> nothing listens on 8001  [decks: all decks]
```

## auto-data-sync-task-20261121-010346  data-sync (task 'Alpha Data Copy', run at 2026-11-21T01:00:41)  ->  0 (in step)   (2026-11-21T01:04:26, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-21 00:51 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 97 file(s), 21.5 MB written since 2026-11-20T23:40:47Z, to alpha-serv-01
  PART of a backlog: 263 file(s), 100.1 MB still to send, from 2026-11-21T00:49:21Z; the next pass carries on
```

## auto-deck-audit-20261121-004847  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-21T00:52:09, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-21T00:47:48.381857+00:00: 20 working, 1 empty, 0 broken
WORKING avatar: answers with data (animation_contract.animations 0, animation_contract.missing_actions 4, presence.available_channels 1, profile.visual_contract.palette 4)
WORKING command: answers with data (attention 5)
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
WORKING terminal: answers with data (logs 47)
WORKING hubs (deck evidence): answers with data (assistant_loop.latest.recommendations 4, devices.connected_names 0, devices.disconnected_names 0, devices.statements 0)
WORKING music playlist: answers with data (songs 96)  [songs-mp3: 87 of 87 songs have their MP3; made 0 now, 0 failed, 0 waiting]
WORKING crowpanel: answers with data (touch.bus.addresses 2, touch.firmware_diagnostics 4)
```

## auto-deck-liveness-20261121-004345  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-21T00:44:41, 11s)
```
DECKS: 4 live, 2 stale, 1 static, 1 no feed
DECK LIVE: deck evidence (/hubs/pulse) -> every hub check passed  [decks: alpha, terminal, spatial, embodiment, knowledge, core, reality, automation, apps, android, admin, atlas]
    22/22 hub checks ok, report 73 s old, fresh for 150 s
DECK LIVE: command deck (/command-center/summary) -> manager and resources fresh  [decks: command]
    manager snapshot 6 s old
DECK STALE: devices (/devices/network/topology) -> no device has reported within its window (status waiting-for-heartbeat)  [decks: network, hardware, atlas]
    39 device(s), newest heartbeat 3636043 s old, fresh for 90 s
DECK LIVE: CrowPanel feed (/panel/crowpanel/state) -> feed live  [decks: CrowPanel]
    assistant heartbeat 1 s old, live within 420 s
DECK STALE: CrowPanel display (LAN reads) -> no panel has read the feed since the backend started  [decks: CrowPanel]
DECK LIVE: site (https://127.0.0.1:4173) -> the page and every asset it names load  [decks: all UI decks]
    7 asset(s) checked
DECK STATIC: static decks -> no live data by design  [decks: educational, image-creator, video-creator]
DECK NO FEED: Alpha Lite Deck (COM6) -> USB serial only, no network feed; never opened by this check  [decks: Alpha Lite Deck]
receipt: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory\local\deck-liveness\latest.json
```

## auto-data-sync-task-20261121-004345  data-sync (task 'Alpha Data Copy', run at 2026-11-21T00:40:41)  ->  0 (in step)   (2026-11-21T00:44:57, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-21 00:40 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  not serving here, and nothing unsent from when it did: nothing to send
```

## auto-data-sync-task-20261121-003345  data-sync (task 'Alpha Data Copy', run at 2026-11-21T00:30:41)  ->  0 (in step)   (2026-11-21T00:34:11, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-21 00:30 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  not serving here, and nothing unsent from when it did: nothing to send
```

## auto-deck-audit-20261121-001846  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-21T00:20:15, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-21T00:16:30.063845+00:00: 20 working, 1 empty, 0 broken
WORKING avatar: answers with data (animation_contract.animations 0, animation_contract.missing_actions 4, presence.available_channels 1, profile.visual_contract.palette 4)
WORKING command: answers with data (attention 5)
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
WORKING terminal: answers with data (logs 47)
WORKING hubs (deck evidence): answers with data (assistant_loop.latest.recommendations 4, devices.connected_names 0, devices.disconnected_names 0, devices.statements 0)
WORKING music playlist: answers with data (songs 96)  [songs-mp3: 87 of 87 songs have their MP3; made 0 now, 0 failed, 0 waiting]
WORKING crowpanel: answers with data (touch.bus.addresses 2, touch.firmware_diagnostics 4)
```

## auto-data-sync-task-20261121-001846  data-sync (task 'Alpha Data Copy', run at 2026-11-21T00:20:41)  ->  267009 (failed)   (2026-11-21T00:20:52, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-21 00:10 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  not serving here, and nothing unsent from when it did: nothing to send
```

## auto-data-sync-task-20261121-001346  data-sync (task 'Alpha Data Copy', run at 2026-11-21T00:10:41)  ->  0 (in step)   (2026-11-21T00:14:22, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-21 00:10 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  not serving here, and nothing unsent from when it did: nothing to send
```

## auto-deck-liveness-20261121-000902  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-21T00:10:18, 1s)
```
DECK DOWN: backend (/health) -> nothing listens on 8001  [decks: all decks]
```

## auto-data-sync-task-20261121-000346  data-sync (task 'Alpha Data Copy', run at 2026-11-21T00:00:41)  ->  0 (in step)   (2026-11-21T00:04:21, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-21 00:00 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  not serving here, and nothing unsent from when it did: nothing to send
```

## auto-deck-audit-20261120-235846  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-20T23:59:14, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-20T23:57:17.259219+00:00: 20 working, 1 empty, 0 broken
WORKING avatar: answers with data (animation_contract.animations 0, animation_contract.missing_actions 4, presence.available_channels 1, profile.visual_contract.palette 4)
WORKING command: answers with data (attention 5)
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
WORKING terminal: answers with data (logs 52)
WORKING hubs (deck evidence): answers with data (assistant_loop.latest.recommendations 4, devices.connected_names 0, devices.disconnected_names 0, devices.statements 0)
WORKING music playlist: answers with data (songs 96)  [songs-mp3: 87 of 87 songs have their MP3; made 0 now, 0 failed, 0 waiting]
WORKING crowpanel: answers with data (touch.bus.addresses 2, touch.firmware_diagnostics 4)
```

## auto-data-sync-task-20261120-235346  data-sync (task 'Alpha Data Copy', run at 2026-11-20T23:50:41)  ->  0 (in step)   (2026-11-20T23:54:47, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-20 23:50 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  not serving here, and nothing unsent from when it did: nothing to send
```

## auto-deck-audit-20261120-234846  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-20T23:49:15, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-20T23:45:57.164199+00:00: 20 working, 1 empty, 0 broken
WORKING avatar: answers with data (animation_contract.animations 0, animation_contract.missing_actions 4, presence.available_channels 1, profile.visual_contract.palette 4)
WORKING command: answers with data (attention 5)
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


# laptop41 autopilot 20261117-031347

Host: DESKTOP-41HPLCN   Alpha: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software

checkout c1aa4356 did NOT update (self-update exit 1): node.exe : self-update: working copy has uncommitted changes /     + FullyQualifiedErrorId : NativeCommandError; local changes:  M scripts/laptop41-doctor.ps1,  M test/laptop41-doctor.test.js, ?? scripts/alpha_song_cover_file.mjs, ?? scripts/alpha_song_cover_jobs.py, ?? scripts/alpha_song_cover_preview.mjs, ?? scripts/alpha_song_cover_preview.py, ?? scripts/alpha_song_cover_render.py, ?? scripts/run-worker1-gpu.ps1, ?? scripts/song-cover-preview-input.png, ?? scripts/song-cover-preview-output/, ?? scripts/worker1-gpu-demand.mjs, ?? scripts/worker1-gpu-demand.mjs.before-cover-preview, ?? scripts/worker1-gpu-demand.mjs.before-song-cover-colours, ?? scripts/worker1-small-output/, ?? scripts/worker1-small-render.py
queue: 110 action(s) on control/laptop41, all of them already run

## auto-deck-liveness-20261117-031347  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-17T03:15:19, 16s)
```
DECKS: 3 live, 2 stale, 1 down, 1 static, 1 no feed
DECK LIVE: deck evidence (/hubs/pulse) -> every hub check passed  [decks: alpha, terminal, spatial, embodiment, knowledge, core, reality, automation, apps, android, admin, atlas]
    22/22 hub checks ok, report 83 s old, fresh for 150 s
DECK LIVE: command deck (/command-center/summary) -> manager and resources fresh  [decks: command]
    manager snapshot 21 s old
DECK STALE: devices (/devices/network/topology) -> no device has reported within its window (status waiting-for-heartbeat)  [decks: network, hardware, atlas]
    39 device(s), newest heartbeat 3299483 s old, fresh for 90 s
DECK LIVE: CrowPanel feed (/panel/crowpanel/state) -> feed live  [decks: CrowPanel]
    assistant heartbeat 16 s old, live within 420 s
DECK STALE: CrowPanel display (LAN reads) -> no panel has read the feed since the backend started  [decks: CrowPanel]
DECK DOWN: site (https://127.0.0.1:4173) -> the site does not answer (no answer)  [decks: all UI decks]
DECK STATIC: static decks -> no live data by design  [decks: educational, image-creator, video-creator]
DECK NO FEED: Alpha Lite Deck (COM6) -> USB serial only, no network feed; never opened by this check  [decks: Alpha Lite Deck]
receipt: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory\local\deck-liveness\latest.json
```

## auto-deck-audit-20261117-030849  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-17T03:10:36, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-17T03:10:09.634820+00:00: 20 working, 1 empty, 0 broken
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

## auto-data-sync-task-20261117-030346  data-sync (task 'Alpha Data Copy', run at 2026-11-17T03:00:42)  ->  0 (in step)   (2026-11-17T03:05:23, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-17 03:00 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  not serving here, and nothing unsent from when it did: nothing to send
```

## auto-deck-liveness-20261117-025850  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-17T03:00:05, 14s)
```
DECKS: 4 live, 2 stale, 1 static, 1 no feed
DECK LIVE: deck evidence (/hubs/pulse) -> every hub check passed  [decks: alpha, terminal, spatial, embodiment, knowledge, core, reality, automation, apps, android, admin, atlas]
    22/22 hub checks ok, report 58 s old, fresh for 150 s
DECK LIVE: command deck (/command-center/summary) -> manager and resources fresh  [decks: command]
    manager snapshot 12 s old
DECK STALE: devices (/devices/network/topology) -> no device has reported within its window (status waiting-for-heartbeat)  [decks: network, hardware, atlas]
    39 device(s), newest heartbeat 3298569 s old, fresh for 90 s
DECK LIVE: CrowPanel feed (/panel/crowpanel/state) -> feed live  [decks: CrowPanel]
    assistant heartbeat 50 s old, live within 420 s
DECK STALE: CrowPanel display (LAN reads) -> no panel has read the feed since the backend started  [decks: CrowPanel]
DECK LIVE: site (https://127.0.0.1:4173) -> the page and every asset it names load  [decks: all UI decks]
    7 asset(s) checked
DECK STATIC: static decks -> no live data by design  [decks: educational, image-creator, video-creator]
DECK NO FEED: Alpha Lite Deck (COM6) -> USB serial only, no network feed; never opened by this check  [decks: Alpha Lite Deck]
receipt: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory\local\deck-liveness\latest.json
```

## auto-deck-audit-20261117-025850  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-17T03:00:19, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-17T02:57:27.399597+00:00: 20 working, 1 empty, 0 broken
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

## auto-data-sync-task-20261117-025351  data-sync (task 'Alpha Data Copy', run at 2026-11-17T02:50:41)  ->  0 (in step)   (2026-11-17T02:55:33, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-17 02:50 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  not serving here, and nothing unsent from when it did: nothing to send
```

## auto-deck-liveness-20261117-024346  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-17T02:44:58, 16s)
```
DECKS: 3 live, 2 stale, 1 down, 1 static, 1 no feed
DECK LIVE: deck evidence (/hubs/pulse) -> every hub check passed  [decks: alpha, terminal, spatial, embodiment, knowledge, core, reality, automation, apps, android, admin, atlas]
    22/22 hub checks ok, report 94 s old, fresh for 150 s
DECK LIVE: command deck (/command-center/summary) -> manager and resources fresh  [decks: command]
    manager snapshot 31 s old
DECK STALE: devices (/devices/network/topology) -> no device has reported within its window (status waiting-for-heartbeat)  [decks: network, hardware, atlas]
    39 device(s), newest heartbeat 3297667 s old, fresh for 90 s
DECK LIVE: CrowPanel feed (/panel/crowpanel/state) -> feed live  [decks: CrowPanel]
    assistant heartbeat 33 s old, live within 420 s
DECK STALE: CrowPanel display (LAN reads) -> no panel has read the feed since the backend started  [decks: CrowPanel]
DECK DOWN: site (https://127.0.0.1:4173) -> the site does not answer (no answer)  [decks: all UI decks]
DECK STATIC: static decks -> no live data by design  [decks: educational, image-creator, video-creator]
DECK NO FEED: Alpha Lite Deck (COM6) -> USB serial only, no network feed; never opened by this check  [decks: Alpha Lite Deck]
receipt: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory\local\deck-liveness\latest.json
```

## auto-deck-audit-20261117-024346  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-17T02:45:15, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-17T02:43:48.237567+00:00: 20 working, 1 empty, 0 broken
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

## auto-data-sync-task-20261117-024346  data-sync (task 'Alpha Data Copy', run at 2026-11-17T02:40:41)  ->  0 (in step)   (2026-11-17T02:45:24, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-17 02:40 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 232 file(s), 97.4 MB written since 2026-11-17T02:30:51Z, to alpha-serv-01
  PART of a backlog: 26 file(s), 6.8 MB still to send, from 2026-11-17T02:41:36Z; the next pass carries on
```

## auto-deck-audit-20261117-023351  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-17T02:35:26, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-17T02:34:38.743205+00:00: 20 working, 1 empty, 0 broken
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

## auto-data-sync-task-20261117-023351  data-sync (task 'Alpha Data Copy', run at 2026-11-17T02:30:42)  ->  0 (in step)   (2026-11-17T02:35:33, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-17 02:30 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 253 file(s), 21.2 MB written since 2026-11-17T02:23:54Z, to alpha-serv-01
```

## auto-deck-liveness-20261117-022349  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-17T02:27:16, 23s)
```
DECKS: 1 down, 1 static, 1 no feed
DECK DOWN: backend (/health) -> the backend does not answer (no answer)  [decks: all decks]
DECK STATIC: static decks -> no live data by design  [decks: educational, image-creator, video-creator]
DECK NO FEED: Alpha Lite Deck (COM6) -> USB serial only, no network feed; never opened by this check  [decks: Alpha Lite Deck]
receipt: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory\local\deck-liveness\latest.json
```

## auto-deck-audit-20261117-022349  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-17T02:27:39, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-17T02:26:58.269546+00:00: 20 working, 1 empty, 0 broken
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

## auto-data-sync-task-20261117-022349  data-sync (task 'Alpha Data Copy', run at 2026-11-17T02:20:41)  ->  0 (in step)   (2026-11-17T02:27:51, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-17 02:20 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 254 file(s), 99.7 MB written since 2026-11-17T02:10:48Z, to alpha-serv-01
  PART of a backlog: 8 file(s), 1.5 MB still to send, from 2026-11-17T02:23:54Z; the next pass carries on
```

## auto-deck-audit-20261117-021347  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-17T02:14:31, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-17T02:12:16.035825+00:00: 20 working, 1 empty, 0 broken
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

## auto-data-sync-task-20261117-021347  data-sync (task 'Alpha Data Copy', run at 2026-11-17T02:10:41)  ->  0 (in step)   (2026-11-17T02:14:37, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-17 02:10 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 266 file(s), 21.3 MB written since 2026-11-17T02:00:44Z, to alpha-serv-01
```

## auto-deck-liveness-20261117-020849  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-17T02:09:39, 7s)
```
DECKS: 4 live, 2 stale, 1 static, 1 no feed
DECK LIVE: deck evidence (/hubs/pulse) -> every hub check passed  [decks: alpha, terminal, spatial, embodiment, knowledge, core, reality, automation, apps, android, admin, atlas]
    22/22 hub checks ok, report 99 s old, fresh for 150 s
DECK LIVE: command deck (/command-center/summary) -> manager and resources fresh  [decks: command]
    manager snapshot 17 s old
DECK STALE: devices (/devices/network/topology) -> no device has reported within its window (status waiting-for-heartbeat)  [decks: network, hardware, atlas]
    39 device(s), newest heartbeat 3295539 s old, fresh for 90 s
DECK LIVE: CrowPanel feed (/panel/crowpanel/state) -> feed live  [decks: CrowPanel]
    assistant heartbeat 29 s old, live within 420 s
DECK STALE: CrowPanel display (LAN reads) -> no panel has read the feed since the backend started  [decks: CrowPanel]
DECK LIVE: site (https://127.0.0.1:4173) -> the page and every asset it names load  [decks: all UI decks]
    7 asset(s) checked
DECK STATIC: static decks -> no live data by design  [decks: educational, image-creator, video-creator]
DECK NO FEED: Alpha Lite Deck (COM6) -> USB serial only, no network feed; never opened by this check  [decks: Alpha Lite Deck]
receipt: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory\local\deck-liveness\latest.json
```

## auto-deck-audit-20261117-020345  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-17T02:04:44, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-17T02:04:20.038201+00:00: 20 working, 1 empty, 0 broken
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

## auto-data-sync-task-20261117-020345  data-sync (task 'Alpha Data Copy', run at 2026-11-17T02:00:41)  ->  0 (in step)   (2026-11-17T02:04:51, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-17 02:00 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 250 file(s), 18.2 MB written since 2026-11-17T01:52:00Z, to alpha-serv-01
```

## auto-deck-audit-20261117-015353  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-17T01:54:55, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-17T01:50:36.589835+00:00: 20 working, 1 empty, 0 broken
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


# laptop41 autopilot 20261128-002349

Host: DESKTOP-41HPLCN   Alpha: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software

checkout c1aa4356 did NOT update (self-update exit 1): node.exe : self-update: working copy has uncommitted changes /     + FullyQualifiedErrorId : NativeCommandError; local changes:  M scripts/laptop41-doctor.ps1,  M test/laptop41-doctor.test.js, ?? scripts/alpha_song_cover_file.mjs, ?? scripts/alpha_song_cover_jobs.py, ?? scripts/alpha_song_cover_preview.mjs, ?? scripts/alpha_song_cover_preview.py, ?? scripts/alpha_song_cover_render.py, ?? scripts/run-worker1-gpu.ps1, ?? scripts/song-cover-preview-input.png, ?? scripts/song-cover-preview-output/, ?? scripts/worker1-gpu-demand.mjs, ?? scripts/worker1-gpu-demand.mjs.before-cover-preview, ?? scripts/worker1-gpu-demand.mjs.before-song-cover-colours, ?? scripts/worker1-small-output/, ?? scripts/worker1-small-render.py
queue: 110 action(s) on control/laptop41, all of them already run

## auto-deck-liveness-20261128-002349  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-28T00:24:27, 17s)
```
DECKS: 2 live, 3 stale, 1 down, 1 static, 1 no feed
DECK STALE: deck evidence (/hubs/pulse) -> the probe loop is not running (no cadence published)  [decks: alpha, terminal, spatial, embodiment, knowledge, core, reality, automation, apps, android, admin, atlas]
    22/22 hub checks ok, report 220 s old, fresh for ? s
DECK LIVE: command deck (/command-center/summary) -> manager and resources fresh  [decks: command]
    manager snapshot 26 s old
DECK STALE: devices (/devices/network/topology) -> no device has reported within its window (status waiting-for-heartbeat)  [decks: network, hardware, atlas]
    39 device(s), newest heartbeat 4239636 s old, fresh for 90 s
DECK LIVE: CrowPanel feed (/panel/crowpanel/state) -> feed live  [decks: CrowPanel]
    assistant heartbeat 22 s old, live within 420 s
DECK STALE: CrowPanel display (LAN reads) -> no panel has read the feed since the backend started  [decks: CrowPanel]
DECK DOWN: site (https://127.0.0.1:4173) -> the site does not answer (no answer)  [decks: all UI decks]
DECK STATIC: static decks -> no live data by design  [decks: educational, image-creator, video-creator]
DECK NO FEED: Alpha Lite Deck (COM6) -> USB serial only, no network feed; never opened by this check  [decks: Alpha Lite Deck]
receipt: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory\local\deck-liveness\latest.json
```

## auto-data-sync-task-20261128-002349  data-sync (task 'Alpha Data Copy', run at 2026-11-28T00:20:41)  ->  0 (in step)   (2026-11-28T00:24:51, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-28 00:20 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 290 file(s), 95.3 MB written since 2026-11-28T00:10:48Z, to alpha-serv-01
  PART of a backlog: 76 file(s), 10.0 MB still to send, from 2026-11-28T00:19:27Z; the next pass carries on
```

## auto-deck-audit-20261128-001848  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-28T00:19:19, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-28T00:19:08.915788+00:00: 20 working, 1 empty, 0 broken
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

## auto-data-sync-task-20261128-001349  data-sync (task 'Alpha Data Copy', run at 2026-11-28T00:10:41)  ->  0 (in step)   (2026-11-28T00:14:42, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-28 00:10 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 371 file(s), 21.5 MB written since 2026-11-27T23:57:03Z, to alpha-serv-01
```

## auto-deck-liveness-20261128-000349  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-28T00:04:22, 1s)
```
DECK DOWN: backend (/health) -> nothing listens on 8001  [decks: all decks]
```

## auto-data-sync-task-20261128-000349  data-sync (task 'Alpha Data Copy', run at 2026-11-28T00:00:41)  ->  0 (in step)   (2026-11-28T00:04:31, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-28 00:00 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 36 file(s), 95.4 MB written since 2026-11-27T23:50:47Z, to alpha-serv-01
  PART of a backlog: 335 file(s), 10.4 MB still to send, from 2026-11-27T23:57:03Z; the next pass carries on
```

## auto-deck-audit-20261127-235849  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-27T23:59:18, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-27T23:58:25.731212+00:00: 20 working, 1 empty, 0 broken
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

## auto-deck-audit-20261127-235349  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-27T23:54:24, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-27T23:50:47.391162+00:00: 20 working, 1 empty, 0 broken
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

## auto-data-sync-task-20261127-235349  data-sync (task 'Alpha Data Copy', run at 2026-11-27T23:50:41)  ->  0 (in step)   (2026-11-27T23:54:31, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-27 23:50 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 361 file(s), 20.9 MB written since 2026-11-27T23:40:47Z, to alpha-serv-01
```

## auto-data-sync-task-20261127-234349  data-sync (task 'Alpha Data Copy', run at 2026-11-27T23:40:41)  ->  0 (in step)   (2026-11-27T23:44:27, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-27 23:40 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 368 file(s), 14.7 MB written since 2026-11-27T23:29:36Z, to alpha-serv-01
```

## auto-deck-audit-20261127-233850  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-27T23:39:19, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-27T23:38:07.072821+00:00: 20 working, 1 empty, 0 broken
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

## auto-data-sync-task-20261127-233349  data-sync (task 'Alpha Data Copy', run at 2026-11-27T23:30:41)  ->  0 (in step)   (2026-11-27T23:34:36, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-27 23:30 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 31 file(s), 94.8 MB written since 2026-11-27T23:20:47Z, to alpha-serv-01
  PART of a backlog: 333 file(s), 11.0 MB still to send, from 2026-11-27T23:29:36Z; the next pass carries on
```

## auto-deck-audit-20261127-232849  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-27T23:29:13, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-27T23:28:03.102812+00:00: 20 working, 1 empty, 0 broken
WORKING avatar: answers with data (animation_contract.animations 0, animation_contract.missing_actions 4, presence.available_channels 1, profile.visual_contract.palette 4)
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

## auto-data-sync-task-20261127-232353  data-sync (task 'Alpha Data Copy', run at 2026-11-27T23:20:41)  ->  0 (in step)   (2026-11-27T23:24:56, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-27 23:20 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 353 file(s), 14.7 MB written since 2026-11-27T23:08:09Z, to alpha-serv-01
```

## auto-deck-audit-20261127-231848  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-27T23:19:14, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-27T23:18:18.151779+00:00: 20 working, 1 empty, 0 broken
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

## auto-data-sync-task-20261127-231349  data-sync (task 'Alpha Data Copy', run at 2026-11-27T23:10:41)  ->  0 (in step)   (2026-11-27T23:14:40, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-27 23:10 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 29 file(s), 93.8 MB written since 2026-11-27T23:00:46Z, to alpha-serv-01
  PART of a backlog: 334 file(s), 11.0 MB still to send, from 2026-11-27T23:08:09Z; the next pass carries on
```

## auto-deck-audit-20261127-230850  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-27T23:09:27, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-27T23:07:56.402134+00:00: 20 working, 1 empty, 0 broken
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

## auto-data-sync-task-20261127-230349  data-sync (task 'Alpha Data Copy', run at 2026-11-27T23:00:41)  ->  0 (in step)   (2026-11-27T23:04:27, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-27 23:00 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 353 file(s), 14.6 MB written since 2026-11-27T22:50:46Z, to alpha-serv-01
```

## auto-deck-liveness-20261127-225849  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-27T22:59:17, 6s)
```
DECKS: 4 live, 2 stale, 1 static, 1 no feed
DECK LIVE: deck evidence (/hubs/pulse) -> every hub check passed  [decks: alpha, terminal, spatial, embodiment, knowledge, core, reality, automation, apps, android, admin, atlas]
    22/22 hub checks ok, report 80 s old, fresh for 150 s
DECK LIVE: command deck (/command-center/summary) -> manager and resources fresh  [decks: command]
    manager snapshot 17 s old
DECK STALE: devices (/devices/network/topology) -> no device has reported within its window (status waiting-for-heartbeat)  [decks: network, hardware, atlas]
    39 device(s), newest heartbeat 4234517 s old, fresh for 90 s
DECK LIVE: CrowPanel feed (/panel/crowpanel/state) -> feed live  [decks: CrowPanel]
    assistant heartbeat 29 s old, live within 420 s
DECK STALE: CrowPanel display (LAN reads) -> no panel has read the feed since the backend started  [decks: CrowPanel]
DECK LIVE: site (https://127.0.0.1:4173) -> the page and every asset it names load  [decks: all UI decks]
    7 asset(s) checked
DECK STATIC: static decks -> no live data by design  [decks: educational, image-creator, video-creator]
DECK NO FEED: Alpha Lite Deck (COM6) -> USB serial only, no network feed; never opened by this check  [decks: Alpha Lite Deck]
receipt: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory\local\deck-liveness\latest.json
```

## auto-deck-audit-20261127-225849  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-27T22:59:23, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-27T22:58:15.586070+00:00: 20 working, 1 empty, 0 broken
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


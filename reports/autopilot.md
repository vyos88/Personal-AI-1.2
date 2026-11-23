# laptop41 autopilot 20261123-072345

Host: DESKTOP-41HPLCN   Alpha: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software

checkout c1aa4356 did NOT update (self-update exit 1): node.exe : self-update: working copy has uncommitted changes /     + FullyQualifiedErrorId : NativeCommandError; local changes:  M scripts/laptop41-doctor.ps1,  M test/laptop41-doctor.test.js, ?? scripts/alpha_song_cover_file.mjs, ?? scripts/alpha_song_cover_jobs.py, ?? scripts/alpha_song_cover_preview.mjs, ?? scripts/alpha_song_cover_preview.py, ?? scripts/alpha_song_cover_render.py, ?? scripts/run-worker1-gpu.ps1, ?? scripts/song-cover-preview-input.png, ?? scripts/song-cover-preview-output/, ?? scripts/worker1-gpu-demand.mjs, ?? scripts/worker1-gpu-demand.mjs.before-cover-preview, ?? scripts/worker1-gpu-demand.mjs.before-song-cover-colours, ?? scripts/worker1-small-output/, ?? scripts/worker1-small-render.py
queue: 110 action(s) on control/laptop41, all of them already run

## auto-data-sync-task-20261123-072345  data-sync (task 'Alpha Data Copy', run at 2026-11-23T07:20:41)  ->  0 (in step)   (2026-11-23T07:24:42, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-23 07:20 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 297 file(s), 6.5 MB written since 2026-11-23T07:09:32Z, to alpha-serv-01
```

## auto-data-sync-task-20261123-071345  data-sync (task 'Alpha Data Copy', run at 2026-11-23T07:10:41)  ->  0 (in step)   (2026-11-23T07:14:55, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-23 07:10 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 270 file(s), 103.1 MB written since 2026-11-23T07:00:45Z, to alpha-serv-01
  PART of a backlog: 47 file(s), 1.9 MB still to send, from 2026-11-23T07:09:32Z; the next pass carries on
```

## auto-deck-liveness-20261123-070846  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-23T07:09:13, 0s)
```
DECK DOWN: backend (/health) -> nothing listens on 8001  [decks: all decks]
```

## auto-deck-audit-20261123-070846  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-23T07:09:14, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-23T07:04:21.531332+00:00: 20 working, 1 empty, 0 broken
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
WORKING terminal: answers with data (logs 51)
WORKING hubs (deck evidence): answers with data (assistant_loop.latest.recommendations 4, devices.connected_names 0, devices.disconnected_names 0, devices.statements 0)
WORKING music playlist: answers with data (songs 96)  [songs-mp3: 87 of 87 songs have their MP3; made 0 now, 0 failed, 0 waiting]
WORKING crowpanel: answers with data (touch.bus.addresses 2, touch.firmware_diagnostics 4)
```

## auto-data-sync-task-20261123-070344  data-sync (task 'Alpha Data Copy', run at 2026-11-23T07:00:41)  ->  0 (in step)   (2026-11-23T07:04:30, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-23 07:00 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 267 file(s), 21.7 MB written since 2026-11-23T06:58:00Z, to alpha-serv-01
```

## auto-deck-liveness-20261123-064847  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-23T06:53:10, 253s)
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

## auto-deck-audit-20261123-064847  deck-audit (Alpha)  ->  2 (19 working, 1 empty, 1 broken)   (2026-11-23T06:57:26, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-23T06:53:30.653353+00:00: 19 working, 1 empty, 1 broken
WORKING avatar: answers with data (animation_contract.animations 0, animation_contract.missing_actions 4, presence.available_channels 2, profile.visual_contract.palette 4)  [retry: recovered]
BROKEN  command: no answer (nothing read)  [retry: still broken]
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
WORKING terminal: answers with data (logs 48)
WORKING hubs (deck evidence): answers with data (assistant_loop.latest.recommendations 4, devices.connected_names 0, devices.disconnected_names 0, devices.statements 0)
WORKING music playlist: answers with data (songs 96)  [songs-mp3: 87 of 87 songs have their MP3; made 0 now, 0 failed, 0 waiting]
WORKING crowpanel: answers with data (touch.bus.addresses 2, touch.firmware_diagnostics 4)
```

## auto-deck-audit-20261123-064346  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-23T06:44:29, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-23T06:42:54.281472+00:00: 20 working, 1 empty, 0 broken
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

## auto-data-sync-task-20261123-064346  data-sync (task 'Alpha Data Copy', run at 2026-11-23T06:40:41)  ->  0 (in step)   (2026-11-23T06:44:36, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-23 06:40 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 52 file(s), 97.2 MB written since 2026-11-23T06:25:46Z, to alpha-serv-01
  PART of a backlog: 269 file(s), 14.1 MB still to send, from 2026-11-23T06:38:01Z; the next pass carries on
```

## auto-deck-liveness-20261123-063345  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-23T06:34:32, 13s)
```
DECKS: 4 live, 2 stale, 1 static, 1 no feed
DECK LIVE: deck evidence (/hubs/pulse) -> every hub check passed  [decks: alpha, terminal, spatial, embodiment, knowledge, core, reality, automation, apps, android, admin, atlas]
    22/22 hub checks ok, report 4 s old, fresh for 150 s
DECK LIVE: command deck (/command-center/summary) -> manager and resources fresh  [decks: command]
    manager snapshot 2 s old
DECK STALE: devices (/devices/network/topology) -> no device has reported within its window (status waiting-for-heartbeat)  [decks: network, hardware, atlas]
    39 device(s), newest heartbeat 3829834 s old, fresh for 90 s
DECK LIVE: CrowPanel feed (/panel/crowpanel/state) -> feed live  [decks: CrowPanel]
    assistant heartbeat 52 s old, live within 420 s
DECK STALE: CrowPanel display (LAN reads) -> no panel has read the feed since the backend started  [decks: CrowPanel]
DECK LIVE: site (https://127.0.0.1:4173) -> the page and every asset it names load  [decks: all UI decks]
    7 asset(s) checked
DECK STATIC: static decks -> no live data by design  [decks: educational, image-creator, video-creator]
DECK NO FEED: Alpha Lite Deck (COM6) -> USB serial only, no network feed; never opened by this check  [decks: Alpha Lite Deck]
receipt: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory\local\deck-liveness\latest.json
```

## auto-data-sync-task-20261123-063345  data-sync (task 'Alpha Data Copy', run at 2026-11-23T06:30:41)  ->  0 (in step)   (2026-11-23T06:34:55, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-23 06:30 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  not serving here, and nothing unsent from when it did: nothing to send
```

## auto-data-sync-task-20261123-062846  data-sync (task 'Alpha Data Copy', run at 2026-11-23T06:20:41)  ->  0 (in step)   (2026-11-23T06:29:17, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-23 06:21 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 89 file(s), 32.5 MB written since 2026-11-23T06:05:19Z, to alpha-serv-01
  PART of a backlog: 276 file(s), 104.9 MB still to send, from 2026-11-23T06:25:46Z; the next pass carries on
```

## auto-deck-audit-20261123-062401  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-23T06:27:13, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-23T06:23:32.328437+00:00: 20 working, 1 empty, 0 broken
WORKING avatar: answers with data (animation_contract.animations 0, animation_contract.missing_actions 4, presence.available_channels 2, profile.visual_contract.palette 4)
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

## auto-deck-liveness-20261123-061346  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-23T06:14:35, 1s)
```
DECK DOWN: backend (/health) -> nothing listens on 8001  [decks: all decks]
```

## auto-data-sync-task-20261123-061346  data-sync (task 'Alpha Data Copy', run at 2026-11-23T06:10:41)  ->  0 (in step)   (2026-11-23T06:14:41, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-23 06:10 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 44 file(s), 98.4 MB written since 2026-11-23T06:00:58Z, to alpha-serv-01
  PART of a backlog: 274 file(s), 12.5 MB still to send, from 2026-11-23T06:05:19Z; the next pass carries on
```

## auto-deck-audit-20261123-060846  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-23T06:09:14, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-23T06:08:53.332778+00:00: 20 working, 1 empty, 0 broken
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
WORKING terminal: answers with data (logs 51)
WORKING hubs (deck evidence): answers with data (assistant_loop.latest.recommendations 4, devices.connected_names 0, devices.disconnected_names 0, devices.statements 0)
WORKING music playlist: answers with data (songs 96)  [songs-mp3: 87 of 87 songs have their MP3; made 0 now, 0 failed, 0 waiting]
WORKING crowpanel: answers with data (touch.bus.addresses 2, touch.firmware_diagnostics 4)
```

## auto-data-sync-task-20261123-060346  data-sync (task 'Alpha Data Copy', run at 2026-11-23T06:00:41)  ->  0 (in step)   (2026-11-23T06:04:42, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-23 06:00 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 295 file(s), 22.8 MB written since 2026-11-23T05:50:44Z, to alpha-serv-01
  PART of a backlog: 9 file(s), 83.9 MB still to send, from 2026-11-23T06:00:58Z; the next pass carries on
```

## auto-deck-audit-20261123-055845  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-23T05:59:36, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-23T05:58:13.662012+00:00: 20 working, 1 empty, 0 broken
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
WORKING terminal: answers with data (logs 50)
WORKING hubs (deck evidence): answers with data (assistant_loop.latest.recommendations 4, devices.connected_names 0, devices.disconnected_names 0, devices.statements 0)
WORKING music playlist: answers with data (songs 96)  [songs-mp3: 87 of 87 songs have their MP3; made 0 now, 0 failed, 0 waiting]
WORKING crowpanel: answers with data (touch.bus.addresses 2, touch.firmware_diagnostics 4)
```

## auto-data-sync-task-20261123-055346  data-sync (task 'Alpha Data Copy', run at 2026-11-23T05:50:41)  ->  0 (in step)   (2026-11-23T05:54:36, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-23 05:50 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 299 file(s), 97.9 MB written since 2026-11-23T05:39:10Z, to alpha-serv-01
```

## auto-deck-audit-20261123-054845  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-23T05:49:23, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-23T05:47:55.948397+00:00: 20 working, 1 empty, 0 broken
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


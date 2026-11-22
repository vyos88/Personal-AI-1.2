# laptop41 autopilot 20261122-203845

Host: DESKTOP-41HPLCN   Alpha: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software

checkout c1aa4356 did NOT update (self-update exit 1): node.exe : self-update: working copy has uncommitted changes /     + FullyQualifiedErrorId : NativeCommandError; local changes:  M scripts/laptop41-doctor.ps1,  M test/laptop41-doctor.test.js, ?? scripts/alpha_song_cover_file.mjs, ?? scripts/alpha_song_cover_jobs.py, ?? scripts/alpha_song_cover_preview.mjs, ?? scripts/alpha_song_cover_preview.py, ?? scripts/alpha_song_cover_render.py, ?? scripts/run-worker1-gpu.ps1, ?? scripts/song-cover-preview-input.png, ?? scripts/song-cover-preview-output/, ?? scripts/worker1-gpu-demand.mjs, ?? scripts/worker1-gpu-demand.mjs.before-cover-preview, ?? scripts/worker1-gpu-demand.mjs.before-song-cover-colours, ?? scripts/worker1-small-output/, ?? scripts/worker1-small-render.py
queue: 110 action(s) on control/laptop41, all of them already run

## auto-deck-audit-20261122-203845  deck-audit (Alpha)  ->  0 (20 working, 1 empty, 0 broken)   (2026-11-22T20:39:10, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-11-22T20:34:15.947610+00:00: 20 working, 1 empty, 0 broken
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

## auto-data-sync-task-20261122-203346  data-sync (task 'Alpha Data Copy', run at 2026-11-22T20:30:42)  ->  0 (in step)   (2026-11-22T20:34:18, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-22 20:30 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  SENT 137 file(s), 26.9 MB written since 2026-11-22T03:00:45Z, to alpha-serv-01
  PART of a backlog: 384 file(s), 149.5 MB still to send, from 2026-11-22T19:45:11Z; the next pass carries on
```

## auto-deck-liveness-20261122-202353  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-11-22T20:27:09, 13s)
```
DECKS: 1 down, 1 static, 1 no feed
DECK DOWN: backend (/health) -> the backend does not answer (no answer)  [decks: all decks]
DECK STATIC: static decks -> no live data by design  [decks: educational, image-creator, video-creator]
DECK NO FEED: Alpha Lite Deck (COM6) -> USB serial only, no network feed; never opened by this check  [decks: Alpha Lite Deck]
receipt: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory\local\deck-liveness\latest.json
```

## auto-home-wifi-20261122-202353  home-wifi (standing)  ->  0 (on the home network, backend reachable)   (2026-11-22T20:27:23, 27s)
```
on 'STARLINK' while 'Starlink V' is visible: rejoining it with its saved profile
rejoin: Success (-32 dBm)
on 'Starlink V'; the backend does not listen on 192.168.2.151: restarting it
stopped pid 21388 on 8001
something already restarted it
backend listening on 8001
after: on 'Starlink V'; the backend listens on 192.168.2.151
```

## auto-data-sync-task-20261122-202353  data-sync (task 'Alpha Data Copy', run at 2026-11-22T20:20:41)  ->  0 (in step)   (2026-11-22T20:27:52, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-22 20:20 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  not serving here, and nothing unsent from when it did: nothing to send
```

## auto-live-sync-20261122-201845  live-sync (standing)  ->  2 (needs a person)   (2026-11-22T20:19:04, 11s)
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

## auto-home-wifi-20261122-201845  home-wifi (standing)  ->  0 (none)   (2026-11-22T20:19:14, 7s)
```
on 'STARLINK'; rejoining 'Starlink V' was tried less than 10 minutes ago
```

## auto-live-sync-20261122-201345  live-sync (standing)  ->  1 (could not run)   (2026-11-22T20:14:02, 12s)
```
STOP: could not fetch claude/frie...(30): git fetch --filter=blob:none https://github.com/vyos88/Alpha failed: fatal: unable to access 'https://github.com/vyos88/Alpha/': Failed to connect to github.com port 443 after 11174 ms: Could not connect to server
```

## auto-home-wifi-20261122-201345  home-wifi (standing)  ->  0 (none)   (2026-11-22T20:14:14, 14s)
```
on no Wi-Fi while 'Starlink V' is visible: rejoining it with its saved profile
rejoin: NetworkNotAvailable (-32 dBm)
on no Wi-Fi; 'Starlink V' is not visible, so this network stays for the internet
```

## auto-data-sync-task-20261122-201345  data-sync (task 'Alpha Data Copy', run at 2026-11-22T20:10:41)  ->  0 (in step)   (2026-11-22T20:14:30, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-22 20:10 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  not serving here, and nothing unsent from when it did: nothing to send
```

## auto-live-sync-20261122-201345  live-sync (standing)  ->  1 (could not run)   (2026-11-22T20:14:02, 12s)
```
STOP: could not fetch claude/frie...(30): git fetch --filter=blob:none https://github.com/vyos88/Alpha failed: fatal: unable to access 'https://github.com/vyos88/Alpha/': Failed to connect to github.com port 443 after 11174 ms: Could not connect to server
```

## auto-home-wifi-20261122-201345  home-wifi (standing)  ->  0 (none)   (2026-11-22T20:14:14, 14s)
```
on no Wi-Fi while 'Starlink V' is visible: rejoining it with its saved profile
rejoin: NetworkNotAvailable (-32 dBm)
on no Wi-Fi; 'Starlink V' is not visible, so this network stays for the internet
```

## auto-data-sync-task-20261122-201345  data-sync (task 'Alpha Data Copy', run at 2026-11-22T20:10:41)  ->  0 (in step)   (2026-11-22T20:14:30, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-22 20:10 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  not serving here, and nothing unsent from when it did: nothing to send
```

## auto-data-sync-task-20261122-200345  data-sync (task 'Alpha Data Copy', run at 2026-11-22T20:00:41)  ->  0 (in step)   (2026-11-22T20:04:17, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-22 20:00 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  not serving here, and nothing unsent from when it did: nothing to send
```

## auto-data-sync-task-20261122-195345  data-sync (task 'Alpha Data Copy', run at 2026-11-22T19:50:41)  ->  0 (in step)   (2026-11-22T19:54:27, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-22 19:50 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  not serving here, and nothing unsent from when it did: nothing to send
```

## auto-home-wifi-20261122-194845  home-wifi (standing)  ->  0 (none)   (2026-11-22T19:49:18, 3s)
```
on 'Starlink V'; standby: Alpha serves from the primary, so the backend here stays off
```

## auto-bridges-20261122-194345  bridges (standing)  ->  0 (restarted)   (2026-11-22T19:44:00, 0s)
```
'alpha-image bridge' task was Ready; last run 11/19/2026 01:39:56, last result 0xC000013A
  log: 2026-11-19T01:40:05 starting the image bridge (machines: host,worker1)
  log: image bridge on http://127.0.0.1:7861/sdapi/v1/ -> http://100.70.101.6:8787 (machines: host,worker1)
'alpha-image bridge' was not listening on 7861: restarted, it answers now
```

## auto-home-wifi-20261122-194345  home-wifi (standing)  ->  0 (on the home network, backend reachable)   (2026-11-22T19:44:19, 3s)
```
on 'Starlink V'; the backend listens on 192.168.2.151
```

## auto-data-sync-task-20261122-194345  data-sync (task 'Alpha Data Copy', run at 2026-11-22T19:40:41)  ->  0 (in step)   (2026-11-22T19:44:24, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-22 19:40 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  not serving here, and nothing unsent from when it did: nothing to send
```

## auto-data-sync-task-20261122-193345  data-sync (task 'Alpha Data Copy', run at 2026-11-22T19:30:41)  ->  0 (in step)   (2026-11-22T19:34:12, 0s)
```
DATA SYNC DESKTOP-41HPLCN 2026-11-22 19:30 (memory\ at C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory)
  nothing received
  not serving here, and nothing unsent from when it did: nothing to send
```


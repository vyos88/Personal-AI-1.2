# laptop41 autopilot 20261008-063351

Host: DESKTOP-41HPLCN   Alpha: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software

checkout ae2f3fd is current

## auto-bridges-20261008-063351  bridges (standing)  ->  0 (restarted)   (2026-10-08T06:34:12, 0s)
```
'alpha-music bridge' task was Ready; last run 10/07/2026 02:15:29, last result 0xC000013A
  log: 2026-10-07T00:33:54 starting the music bridge (machines: host,worker1)
  log: 2026-10-07T01:28:54 starting the music bridge (machines: host,worker1)
  log: music bridge on http://127.0.0.1:8790/music/ -> http://100.93.104.24:8787
  log: subscriptions off: every click generates
  log: 2026-10-07T02:15:29 the bridge exited (-1); restarting in 5s
  log: 2026-10-07T02:15:34 starting the music bridge (machines: host,worker1)
'alpha-music bridge' was not listening on 8790: restarted, it answers now
'alpha-image bridge' task was Ready; last run 10/07/2026 16:59:36, last result 0xC000013A
  log: image bridge on http://127.0.0.1:7861/sdapi/v1/ -> http://100.93.104.24:8787 (machines: host,worker1)
  log: 2026-10-06T21:51:14 starting the image bridge (machines: host,worker1)
  log: 2026-10-07T01:29:01 starting the image bridge (machines: host,worker1)
  log: image bridge on http://127.0.0.1:7861/sdapi/v1/ -> http://100.93.104.24:8787 (machines: host,worker1)
  log: 2026-10-07T16:59:36 the bridge exited (-1); restarting in 5s
  log: 2026-10-07T16:59:41 starting the image bridge (machines: host,worker1)
'alpha-image bridge' was not listening on 7861: restarted, it answers now
```

## 20261008-01-ollama-keepalive  ollama-keepalive  ->  0   (2026-10-08T06:34:31, 39s)
```
set OLLAMA_KEEP_ALIVE=24h for this user and the machine
stopped 2 Ollama process(es)
started the Ollama app
loaded 'llama3.2:3b' in 14s
ok: 'llama3.2:3b' is loaded and kept for 24 h after each use
```

## 20261008-codex-02-chat-model-keepalive  ollama-keepalive  ->  1   (2026-10-08T06:35:10, 6s)
```
set OLLAMA_KEEP_ALIVE=24h for this user and the machine
stopped 2 Ollama process(es)
started the Ollama app
PROBLEM: could not load 'qwen3:8b': The remote server returned an error: (404) Not Found.
```

## 20261008-codex-03-post-model-doctor  doctor  ->  0   (2026-10-08T06:35:17, 55s)
```
=== 5c. Image creator ===
  ok: image bridge answers on 127.0.0.1:7861
  ok: machines that make images (the image bridge's view): host
=== 5d. Brain topology (neurological deck) ===
  ok: brain deck: the backend's anatomy map: 9 regions, 11 links, every one joins two regions
  ok: brain deck: the deck's source draws the links the backend sends and checks them (Region links)
  ok: brain deck: the site serves the fixed deck (BrainNeuralModel-BizulwOh.js, Brai...(25).js)
=== 6. CrowPanel ===
    COM7
    COM24   in use by another program?
  device: USB-SERIAL CH340 (COM24)
  device: USB Serial Device (COM7)
  --- devices by address (USB: port, VID:PID, instance; LAN: IP, MAC)
  usb  COM24  1a86:7523  5&228C54A3&0&4               USB-SERIAL CH340 (COM24)
  usb  COM7   303a:1001  8&13DABE55&0&0000            USB Serial Device (COM7)
  self 192.168.2.151   30:c9:ab:54:31:71  Wi-Fi
  lan  192.168.2.1     74:24:9f:59:99:d6  Reachable
  lan  192.168.2.97    dc:b4:d9:01:3c:38  Reachable
  lan  192.168.2.157   64:d8:1b:e8:89:14  Stale
  the tunnel's panel firmware (firmware/crowpanel) is live only if its agents:read key in the keys list above was used in the last few seconds
  --- Alpha's deck feed (/panel/crowpanel/public-state)
  ok: Alpha's deck feed is live (assistant heartbeat 40s old)
  backend listens on: ::1, 100.69.243.25, 127.0.0.1, 192.168.2.151
  ok: the panel's way in answers: http://192.168.2.151:8001/health 200 (Wi-Fi)
  ok: home-network devices that called the backend in the last couple of minutes: 192.168.2.97 (29 connections)
=== 7. Memory, disk, heaviest processes ===
  ok: 1.8 of 15.8 GB RAM free
  ok: C: 129.7 GB free
  llama-server                  2,442 MB  pid 1040
  llama-server                  2,242 MB  pid 20808
  claude                          740 MB  pid 8028
  msedge                          425 MB  pid 15320
  MsMpEng                         415 MB  pid 6040
  explorer                        321 MB  pid 10108
  Memory Compression              283 MB  pid 3840
  claude                          274 MB  pid 12912
=== 8. Image generation ===
  IMAGE_GEN_URL = http://127.0.0.1:7861/sdapi/v1/txt2img  (from .env.local)
  port 7861 : pid 21308 node.exe: "C:\Program Files\nodejs\node.exe" C:\services\alpha-tunnel\scripts\image-bridge.mjs
  ok: Stable Diffusion API answers on http://127.0.0.1:7861 (200)
=== SUMMARY ===
  this pass took 45s
  ok: no problems found
  + fixed since last run: music bridge is not running on 127.0.0.1:8790: Generate cannot queue anything
  + fixed since last run: image backend not running: nothing answers on http://127.0.0.1:7861 (chat images fail)
  + fixed since last run: self-heal is installed but its log is 123 min old: check the task's last result as Administrator (3 = config unreadable)
  + fixed since last run: image bridge is not running on 127.0.0.1:7861: images are not shared between machines
=== RECOMMENDATIONS (ranked; re-ranked every run) ===
  1. [hardening] Store the coordinator admin key for your user so scheduled runs include agents/keys/tasks: [Environment]::SetEnvironmentVariable('ALPHA_ADMIN_TOKEN', (Read-Host 'key'), 'User').
  2. [hardening] Ask Alpha (chat) for a recap of the doctor posts weekly, and read the self-heal log (alpha-ops\logs\selfheal.jsonl) for repairs that repeat.
  3. [hardening] Keep laptop 41 on AC with sleep off (repair-alpha-host step 5); a sleeping host is an outage that no checker can fix.
  4. [hardening] Test a reboot once everything is green: every check here should pass again within 5 minutes with nobody logged in.
  5. [hardening] Rotate the panel and agent keys after the coordinator move: keys issued by the old coordinator are void and should be revoked.
  6. [hardening] Set Windows Update active hours around when Alpha is used, so a forced restart lands when nobody needs it.
  7. [hardening] Remove what does not belong on the host once it is green: the ChatGPT app and other heavy tools in section 7 compete with Alpha for the same 16 GB.
report: C:\AlphaData\alpha-ops\reports\lapt...(31).txt
posted to Alpha: True
  To https://github.com/vyos88/Personal-AI-1.2
     23cef85..52ee5d0  HEAD -> status/laptop41
pushed to status/laptop41 - tell Claude 'doctor pushed'
```

## 20261008-02-alpha-runtime  alpha-runtime  ->  0   (2026-10-08T06:36:11, 0s)
```

```

## 20261008-60-chat-task  chat-task  ->  0   (2026-10-08T06:36:12, 3s)
```
task 'Alpha Ollama': C:\Users\Vyo\AppData\Local\Programs\Ollama\ollama.exe serve, as DESKTOP-41HPLCN\Vyo, at startup
self-heal now probes http://127.0.0.1:11434/api/tags and restarts chat through 'Alpha Ollama' (C:\AlphaData\alpha-ops\selfheal.json)
Ollama answers now; nothing started
```

## auto-brain-topology-20261008-063351  brain-topology (standing)  ->  0 (deck ok)   (2026-10-08T06:36:14, 1s)
```
OK: the backend's anatomy map: 9 regions, 11 links, every one joins two regions
OK: the deck's source draws the links the backend sends and checks them (Region links)
OK: the site serves the fixed deck (BrainNeuralModel-BizulwOh.js, Brai...(25).js)
```

## auto-live-sync-20261008-063351  live-sync (standing)  ->  0 (in sync)   (2026-10-08T06:36:15, 196s)
```
KNOWLEDGE: 4 document(s) differ here from the branch and are kept as they are: alpha_crowpanel_touch_hardware_verdict.json, alpha_deck_hub_repair_playbook.json, alph...(37).json, alph...(41).json
    Alpha: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software
    changes: a3e1350..ab67005 of claude/frie...(30) (last applied here: a3e1350)
      applies  M backend/api/__init__.py
      applies  A backend/api/coding_context.py
      applies  A backend/api/debts.py
      applies  M backend/api/music_generation.py
      applies  A backend/coding_context_pack.py
      applies  M backend/music_singing.py
      applies  A backend/tests/test_coding_context_pack.py
      applies  A backend/tests/test_debts_api.py
      applies  M backend/tests/test_singing_mp3.py
      applies  A frontend/src/debtMerge.js
      applies  M frontend/src/debtStorage.js
      applies  A frontend/src/debtSync.js
      applies  A frontend/src/debtSync.test.js
      applies  M frontend/src/pages/DebtContactLinks.jsx
      applies  M frontend/src/pages/DebtsHubPanel.jsx
      applies  M frontend/vite.config.js
      backup: C:\AlphaData\alpha-ops\backups\alph...(37)
      ok: wrote 16 file(s)
      ok: 9 Python file(s) parse
      packages unchanged and installed: building (no npm ci)...
      ok: frontend built
    DONE. Undo with:  node scripts/apply-alpha-update.mjs --rollback "C:\AlphaData\alpha-ops\backups\alph...(37)" --restart
      stopped pid 5412, which held port 8001
      restarted task 'Alpha Backend'
      stopped pid 23200, which held port 4173
      restarted task 'Alpha'
      Check http://127.0.0.1:8001/health and the site in a minute. The self-heal task also restarts anything left down.
DELIVERED: a3e1350..ab67005 of claude/frie...(30)
CAPTURED: 3 changed and 0 new source file(s) from DESKTOP-41HPLCN, pushed as 20c58f5 on claude/frie...(30)
```

## auto-deck-audit-20261008-063351  deck-audit (Alpha)  ->  0 (21 working, 0 empty, 0 broken)   (2026-10-08T06:39:46, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-10-08T05:32:13.933478+00:00: 21 working, 0 empty, 0 broken
WORKING avatar: answers with data (animation_contract.animations 0, animation_contract.missing_actions 4, presence.available_channels 2, profile.visual_contract.palette 4)
WORKING command: answers with data (attention 6)
WORKING control-center: answers with data (11 field(s))
WORKING devices: answers with data (boards 9)
WORKING operations: answers with data (events 20)
WORKING memory: answers with data (gaps 2, sources 7)
WORKING core: answers with data (blockers 3, metacognition.gaps 1)
WORKING beta-assistant: answers with data (allowed_tasks 5, detected_ports 0, restricted_tasks 5)
WORKING coding: answers with data (idea_method 8, languages.embedded 3, languages.javascript 5, languages.powershell 3)
WORKING extensions: answers with data (safeguards 5, skills.sources 5)
WORKING virtual-reality: answers with data (projection.axes 3, projection.camera_evidence_blocks 0, projection.measurement_quality.protocols 7, projection.rf_map.edges 3)
WORKING automation: answers with data (items 5)
WORKING learning: answers with data (queued_jobs 0)
WORKING diagnostics: answers with data (discovered 2, registry_summary.connected_names 2, registry_summary.disconnected_names 0, registry_summary.statements 2)
WORKING kol-kos: answers with data (system.boolean_algebra.operators 7, system.opcodes 23, system.routing_tiers 4, ternary_model.states 3)
WORKING phone: answers with data (7 field(s))
WORKING network: answers with data (links 39, nodes 39, resources.awaiting_first_heartbeat 29, resources.capability_set 9)
WORKING terminal: answers with data (logs 84)
WORKING hubs (deck evidence): answers with data (assistant_loop.latest.recommendations 3, devices.connected_names 2, devices.disconnected_names 0, devices.statements 2)
WORKING music playlist: answers with data (songs 96)  [songs-mp3: 87 of 87 songs have their MP3; made 0 now, 0 failed, 0 waiting]
WORKING crowpanel: answers with data (touch.bus.addresses 2, touch.firmware_diagnostics 4)
```

## auto-home-wifi-20261008-063351  home-wifi (standing)  ->  0 (on the home network, backend reachable)   (2026-10-08T06:39:46, 6s)
```
on 'Starlink V'; the backend listens on 192.168.2.151
```

## auto-live-sync-20261008-002345  live-sync (standing)  ->  2 (needs a person)   (2026-10-08T00:24:13, 6s)
```
KNOWLEDGE: 4 document(s) differ here from the branch and are kept as they are: alpha_crowpanel_touch_hardware_verdict.json, alpha_deck_hub_repair_playbook.json, alph...(37).json, alph...(41).json
WAITING: 5147fef was tried here and failed; the next commit on claude/frie...(30) is tried when it comes
SKIPPED: nothing is captured while this machine is not on 5147fef
```

## auto-live-sync-20261008-001844  live-sync (standing)  ->  2 (needs a person)   (2026-10-08T00:19:01, 6s)
```
KNOWLEDGE: 4 document(s) differ here from the branch and are kept as they are: alpha_crowpanel_touch_hardware_verdict.json, alpha_deck_hub_repair_playbook.json, alph...(37).json, alph...(41).json
    Alpha: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software
    STOP: could not fetch claude/frie...(30): git fetch --filter=blob:none https://github.com/vyos88/Alpha failed: fatal: unable to access 'https://github.com/vyos88/Alpha/': Empty reply from server
      Alpha is a private repository: this machine needs git credentials for github.com (sign in once with `git credential-manager` or `gh auth login`).
FAILED: 5147fef could not be applied, and what was written was put back (above)
SKIPPED: nothing is captured while this machine is not on 5147fef
```

## auto-deck-liveness-20261008-001844  deck-liveness (standing)  ->  0 (every deck live)   (2026-10-08T00:19:08, 4s)
```
DECKS: 6 live, 1 static, 1 no feed
DECK LIVE: deck evidence (/hubs/pulse) -> every hub check passed  [decks: alpha, terminal, spatial, embodiment, knowledge, core, reality, automation, apps, android, admin, atlas]
    22/22 hub checks ok, report 86 s old, fresh for 150 s
DECK LIVE: command deck (/command-center/summary) -> manager and resources fresh  [decks: command]
    manager snapshot 6 s old
DECK LIVE: devices (/devices/network/topology) -> devices reporting  [decks: network, hardware, atlas]
    16 device(s), newest heartbeat 5 s old, fresh for 90 s
DECK LIVE: CrowPanel feed (/panel/crowpanel/state) -> feed live  [decks: CrowPanel]
    assistant heartbeat 13 s old, live within 420 s
DECK LIVE: CrowPanel display (LAN reads) -> a panel is reading the feed  [decks: CrowPanel]
    last read 0 s ago from the home network
DECK LIVE: site (https://127.0.0.1:4173) -> the page and every asset it names load  [decks: all UI decks]
    8 asset(s) checked
DECK STATIC: static decks -> no live data by design  [decks: educational, image-creator, video-creator]
DECK NO FEED: Alpha Lite Deck (COM6) -> USB serial only, no network feed; never opened by this check  [decks: Alpha Lite Deck]
receipt: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory\local\deck-liveness\latest.json
```

## auto-deck-audit-20261008-000845  deck-audit (Alpha)  ->  0 (21 working, 0 empty, 0 broken)   (2026-10-08T00:09:13, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-10-07T23:05:55.321966+00:00: 21 working, 0 empty, 0 broken
WORKING avatar: answers with data (animation_contract.animations 0, animation_contract.missing_actions 4, presence.available_channels 2, profile.visual_contract.palette 4)
WORKING command: answers with data (attention 5)
WORKING control-center: answers with data (11 field(s))
WORKING devices: answers with data (boards 9)
WORKING operations: answers with data (events 20)
WORKING memory: answers with data (gaps 2, sources 7)
WORKING core: answers with data (blockers 1, metacognition.gaps 1)
WORKING beta-assistant: answers with data (allowed_tasks 5, detected_ports 0, restricted_tasks 5)
WORKING coding: answers with data (idea_method 8, languages.embedded 3, languages.javascript 5, languages.powershell 3)
WORKING extensions: answers with data (safeguards 5, skills.sources 5)
WORKING virtual-reality: answers with data (projection.axes 3, projection.camera_evidence_blocks 0, projection.measurement_quality.protocols 7, projection.rf_map.edges 3)
WORKING automation: answers with data (items 5)
WORKING learning: answers with data (queued_jobs 0)
WORKING diagnostics: answers with data (discovered 2, registry_summary.connected_names 2, registry_summary.disconnected_names 0, registry_summary.statements 2)
WORKING kol-kos: answers with data (system.boolean_algebra.operators 7, system.opcodes 23, system.routing_tiers 4, ternary_model.states 3)
WORKING phone: answers with data (7 field(s))
WORKING network: answers with data (links 16, nodes 16, resources.awaiting_first_heartbeat 6, resources.capability_set 9)
WORKING terminal: answers with data (logs 41)
WORKING hubs (deck evidence): answers with data (assistant_loop.latest.recommendations 3, devices.connected_names 2, devices.disconnected_names 0, devices.statements 2)
WORKING music playlist: answers with data (songs 96)  [songs-mp3: 87 of 87 songs have their MP3; made 0 now, 0 failed, 0 waiting]
WORKING crowpanel: answers with data (touch.bus.addresses 2, touch.firmware_diagnostics 4)
```

## auto-brain-topology-20261008-000345  brain-topology (standing)  ->  0 (deck ok)   (2026-10-08T00:04:06, 0s)
```
OK: the backend's anatomy map: 9 regions, 11 links, every one joins two regions
OK: the deck's source draws the links the backend sends and checks them (Region links)
OK: the site serves the fixed deck (BrainNeuralModel-BizulwOh.js)
```

## auto-live-sync-20261008-000345  live-sync (standing)  ->  0 (in sync)   (2026-10-08T00:04:06, 5s)
```
KNOWLEDGE: 4 document(s) differ here from the branch and are kept as they are: alpha_crowpanel_touch_hardware_verdict.json, alpha_deck_hub_repair_playbook.json, alph...(37).json, alph...(41).json
IN SYNC: this machine runs a3e1350 of claude/frie...(30)
CAPTURED: 1 changed and 0 new source file(s) from DESKTOP-41HPLCN, pushed as a3e1350 on claude/frie...(30)
    1 credential-looking line(s) cleared by the owner's list go with this capture
```

## auto-live-sync-20261007-235848  live-sync (standing)  ->  0 (in sync)   (2026-10-07T23:59:04, 102s)
```
KNOWLEDGE: 4 document(s) differ here from the branch and are kept as they are: alpha_crowpanel_touch_hardware_verdict.json, alpha_deck_hub_repair_playbook.json, alph...(37).json, alph...(41).json
    Alpha: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software
    changes: ca87445..cfb5371 of claude/frie...(30) (last applied here: ca87445)
      applies  M backend/learning_evidence.py
      applies  M backend/tests/test_learning_evidence.py
      applies  M frontend/src/components/AtlasWebGLTree.jsx
      applies  M frontend/src/components/BrainNeuralModel.jsx
      applies  M frontend/src/components/NeuralBrainCanvas.jsx
      applies  A frontend/src/deckRuntimeGuards.test.js
      applies  M frontend/src/pages/Login.jsx
      backup: C:\AlphaData\alpha-ops\backups\alph...(37)
      ok: wrote 7 file(s)
      ok: 2 Python file(s) parse
      packages unchanged and installed: building (no npm ci)...
      ok: frontend built
    DONE. Undo with:  node scripts/apply-alpha-update.mjs --rollback "C:\AlphaData\alpha-ops\backups\alph...(37)" --restart
      stopped pid 13168, which held port 8001
      restarted task 'Alpha Backend'
      stopped pid 9116, which held port 4173
      restarted task 'Alpha'
      Check http://127.0.0.1:8001/health and the site in a minute. The self-heal task also restarts anything left down.
DELIVERED: ca87445..cfb5371 of claude/frie...(30)
CAPTURED: 1 changed and 0 new source file(s) from DESKTOP-41HPLCN, pushed as a3e1350 on claude/frie...(30)
    1 credential-looking line(s) cleared by the owner's list go with this capture
```

## auto-deck-liveness-20261007-235848  deck-liveness (standing)  ->  2 (not every deck is live)   (2026-10-08T00:00:46, 12s)
```
DECKS: 4 live, 2 stale, 1 static, 1 no feed
DECK STALE: deck evidence (/hubs/pulse) -> the probe loop is not running (no cadence published)  [decks: alpha, terminal, spatial, embodiment, knowledge, core, reality, automation, apps, android, admin, atlas]
    22/22 hub checks ok, report 27 s old, fresh for ? s
DECK STALE: command deck (/command-center/summary) -> stale: resource governor  [decks: command]
    manager snapshot 4 s old
DECK LIVE: devices (/devices/network/topology) -> devices reporting  [decks: network, hardware, atlas]
    16 device(s), newest heartbeat 1 s old, fresh for 90 s
DECK LIVE: CrowPanel feed (/panel/crowpanel/state) -> feed live  [decks: CrowPanel]
    assistant heartbeat 3 s old, live within 420 s
DECK LIVE: CrowPanel display (LAN reads) -> a panel is reading the feed  [decks: CrowPanel]
    last read 0 s ago from the home network
DECK LIVE: site (https://127.0.0.1:4173) -> the page and every asset it names load  [decks: all UI decks]
    8 asset(s) checked
DECK STATIC: static decks -> no live data by design  [decks: educational, image-creator, video-creator]
DECK NO FEED: Alpha Lite Deck (COM6) -> USB serial only, no network feed; never opened by this check  [decks: Alpha Lite Deck]
receipt: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory\local\deck-liveness\latest.json
```

## auto-deck-audit-20261007-235848  deck-audit (Alpha)  ->  0 (21 working, 0 empty, 0 broken)   (2026-10-08T00:00:59, 0s)
```
DECK AUDIT by Alpha on DESKTOP-41HPLCN at 2026-10-07T22:54:37.816132+00:00: 21 working, 0 empty, 0 broken
WORKING avatar: answers with data (animation_contract.animations 0, animation_contract.missing_actions 4, presence.available_channels 2, profile.visual_contract.palette 4)
WORKING command: answers with data (attention 5)
WORKING control-center: answers with data (11 field(s))
WORKING devices: answers with data (boards 9)
WORKING operations: answers with data (events 20)
WORKING memory: answers with data (gaps 2, sources 7)
WORKING core: answers with data (blockers 1, metacognition.gaps 1)
WORKING beta-assistant: answers with data (allowed_tasks 5, detected_ports 0, restricted_tasks 5)
WORKING coding: answers with data (idea_method 8, languages.embedded 3, languages.javascript 5, languages.powershell 3)
WORKING extensions: answers with data (safeguards 5, skills.sources 5)
WORKING virtual-reality: answers with data (projection.axes 3, projection.camera_evidence_blocks 0, projection.measurement_quality.protocols 7, projection.rf_map.edges 3)
WORKING automation: answers with data (items 5)
WORKING learning: answers with data (queued_jobs 0)
WORKING diagnostics: answers with data (discovered 4, registry_summary.connected_names 4, registry_summary.disconnected_names 0, registry_summary.statements 5)
WORKING kol-kos: answers with data (system.boolean_algebra.operators 7, system.opcodes 23, system.routing_tiers 4, ternary_model.states 3)
WORKING phone: answers with data (7 field(s))
WORKING network: answers with data (links 16, nodes 16, resources.awaiting_first_heartbeat 6, resources.capability_set 9)
WORKING terminal: answers with data (logs 87)
WORKING hubs (deck evidence): answers with data (assistant_loop.latest.recommendations 3, devices.connected_names 4, devices.disconnected_names 0, devices.statements 5)
WORKING music playlist: answers with data (songs 96)  [songs-mp3: 87 of 87 songs have their MP3; made 0 now, 0 failed, 0 waiting]
WORKING crowpanel: answers with data (touch.bus.addresses 2, touch.firmware_diagnostics 4)
```

## auto-deck-liveness-20261007-232852  deck-liveness (standing)  ->  0 (every deck live)   (2026-10-07T23:29:17, 4s)
```
DECKS: 6 live, 1 static, 1 no feed
DECK LIVE: deck evidence (/hubs/pulse) -> every hub check passed  [decks: alpha, terminal, spatial, embodiment, knowledge, core, reality, automation, apps, android, admin, atlas]
    22/22 hub checks ok, report 58 s old, fresh for 150 s
DECK LIVE: command deck (/command-center/summary) -> manager and resources fresh  [decks: command]
    manager snapshot 5 s old
DECK LIVE: devices (/devices/network/topology) -> devices reporting  [decks: network, hardware, atlas]
    16 device(s), newest heartbeat 5 s old, fresh for 90 s
DECK LIVE: CrowPanel feed (/panel/crowpanel/state) -> feed live  [decks: CrowPanel]
    assistant heartbeat 17 s old, live within 420 s
DECK LIVE: CrowPanel display (LAN reads) -> a panel is reading the feed  [decks: CrowPanel]
    last read 0 s ago from the home network
DECK LIVE: site (https://127.0.0.1:4173) -> the page and every asset it names load  [decks: all UI decks]
    8 asset(s) checked
DECK STATIC: static decks -> no live data by design  [decks: educational, image-creator, video-creator]
DECK NO FEED: Alpha Lite Deck (COM6) -> USB serial only, no network feed; never opened by this check  [decks: Alpha Lite Deck]
receipt: C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\memory\local\deck-liveness\latest.json
```


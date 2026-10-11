Claude (cloud) report, 2026-10-11 23:57 UTC

ALPHA-AI.UK IS DOWN: answers 530 since about 23:53 UTC, per Worker1's live page (23:53) and doctor (23:56). Nobody serves Alpha: alpha-serv-01 is the server and Worker1 is standby. Codex / claude-alpha-serv: check alpha-serv-01's backend and cloudflared connector and post findings. Worker1 must NOT stand up (alpha-standup) unless V says 'cover'.

3-6-9 PROVEN LIVE. Two reporters now, per V ("Both"): the Operating Cycle and 'Alpha 3-6-9 Reporter' (#89, posts [alpha-369]). alpha-report retired; #90 closed.

Worker1 ComfyUI: on demand only (V, settled 03:36); the task stays Disabled. CPU work only on alpha-serv-01.
Owner-approved 03:41 (claude-alpha-serv): "agents on, big changes still asked": background automation on at alpha-serv-01; consequential upgrades still refused. The Worker1-to-Host merge (merge-wt, not live) is claude-alpha-serv's.
Codex's 'Laptop Policy Lock' on Worker2: CPU only on alpha-serv-01, laptop GPU/Singing on queued demand only (SYSTEM guard). Worker2's real reboot (04:42) verified. Song check PASSED 05:42 on CUDA; singing result recovery live. Full test suite still blocked by a missing Blender source ('viore'); Alpha asks V. Alpha's replies still misread state.

alpha-serv-01 is the sole server; its coordinator ran (agent AlphaServer) at last check. Public site 530 now (top).

WORKER1 (Laptop41): fresh (doctor 23:56, live/autopilot 23:54 UTC), STANDBY on purpose since 00:57 (V's 10 Oct order); no split-brain. #267: its bridges are now reported 'off: standby', not a fault. Doctor's only PROBLEM, the absent cover task 'Alpha Standby', has no remedy left (V ruled out standby-install): ASKS asks V whether it should become a Note.
control/host h32 still queued.

Merged: #253-#265; #267-#270, #273 autopilot/doctor fixes for a standby; #271 3-6-9 closed; #272 saves alpha-serv-01's GPU-demand code (confirmed matching, Alpha#94).

NEEDS V: re-issue agent keys; .env.local to alpha-serv-01 by USB, collect the memory copy there; Alpha's GPU gate (#234, fix in vyos88/Alpha); Worker2's uncommitted usb-inventory.ps1; #160; Alpha#77/#85.

Open: #249 (draft), #229 (draft), #160 (conflicts), #136, #86, #83.
Owner's rule: every session posts in the tunnel before and after working on either laptop.

Still stands:
 - From V: Alpha may read GitHub PRs in vyos88/Personal-AI-1.2 and vyos88/Alpha, read only.
 - FROM V (09 Oct, via Codex): the host is alpha-serv-01; laptop-gj8dfmlk is Worker2, its Alpha and coordinator stay stopped; Worker1 stays a worker (covers only if V says 'cover'). When Alpha on the Server comes up, it leads.
 - From V: on Worker2 (laptop-gj8dfmlk), GPU work uses the RTX 3050 (GPU 0), never the Intel UHD.
 - From V: on Worker1, COM24 = network bridge, COM20 = Arduino Uno, COM6 = Alpha Lite Deck, COM4 = LoRa (passive only, never transmit). COM7 is a TinyUSB device, NOT the CrowPanel. Only COM7 may be opened; no sweep may touch COM4, COM6, COM20 or COM24. Do not reflash or re-provision anything.
 - Do not start Q1 or Q7 until Alpha#24/#61 land.
 - Drive space (C3): Alpha and Codex, do NOT move or delete anything. Inventory only: each backup, archive or old copy over 500 MB under C:\ (path, size, last modified), and the external drive letter. Never list data\auth.json, .env files or keys. V moves files by hand.

Jack's laptop and the phones publish no status.

Alpha: post asks as "ASK: ..." in the tunnel. ASKS line 1; C3 and C5, read-only. claude-alpha-serv: the merge handoff.

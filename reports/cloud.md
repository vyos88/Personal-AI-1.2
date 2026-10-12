Claude (cloud) report, 2026-10-12 17:57 UTC

alpha-ai.uk: 200 from alpha-serv-01 (short 530 last night, recovered; Codex: cause if known).

3-6-9 PROVEN LIVE. Two reporters now, per V ("Both"): the Operating Cycle and 'Alpha 3-6-9 Reporter' (#89, posts [alpha-369]). alpha-report retired; #90 closed.

Worker1 ComfyUI: on demand only (V, settled 03:36); the task stays Disabled. CPU work only on alpha-serv-01.
Owner-approved 03:41 (claude-alpha-serv): "agents on, big changes still asked": background automation on at alpha-serv-01; consequential upgrades still refused. The Worker1-to-Host merge (merge-wt, not live) is claude-alpha-serv's.
Worker2 'Laptop Policy Lock' (Codex): CPU only on alpha-serv-01, GPU/Singing on queued demand only; reboot verified. Song check PASSED 05:42 on CUDA; singing result recovery live. Full test suite still blocked by a missing Blender source ('viore'); Alpha asks V. Alpha's replies still misread state.

alpha-serv-01 is the sole server; its coordinator ran (agent AlphaServer) at last check.

WORKER1 (Laptop41): fresh (doctor 17:41, live 17:54 UTC). NEW since 17:43 UTC: live page says STANDBY BUT SERVING, an Alpha backend runs on Worker1 again while alpha-serv-01 serves (alpha-ai.uk 200). Two Alphas. Doctor's open PROBLEM is still the absent cover task 'Alpha Standby' (Note? V decides). A CPU-90% PROBLEM flaps (owner's ChatGPT app).
control/host h32 still queued.

Merged: #253-#265; #267-#270, #273, #275, #276 autopilot/doctor fixes for a standby (#276: live page shows ages, OWED when a copy did not go); #271 3-6-9 closed; #272 saves alpha-serv-01's GPU-demand code (confirmed matching, Alpha#94).

NEEDS V: go/no-go on the music-bridge billing pair, #274 + Alpha#95 (plan from Alpha's entitlements; tested, mergeable); re-issue agent keys; .env.local to alpha-serv-01 by USB, collect the memory copy there; Alpha's GPU gate (#234, fix in vyos88/Alpha); Worker2's uncommitted usb-inventory.ps1; #160; Alpha#77/#85.

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

Alpha/Codex: whoever started Worker1's backend, say so in the tunnel; else ask V about alpha-standdown. Alpha: ASKS line 1; C3 and C5, read-only. claude-alpha-serv: the merge handoff.

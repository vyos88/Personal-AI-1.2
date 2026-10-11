Claude (cloud) report, 2026-10-11 03:56 UTC

3-6-9 PROVEN LIVE (codex-alpha-policy 03:49: real gaps 3m14s, 6m18s, 9m24s, 3m18s). Two reporters now, per V ("Both"): the Operating Cycle and 'Alpha 3-6-9 Reporter' (#89, posts [alpha-369]). The interim alpha-report is RETIRED (claude-alpha-serv 03:45). #90 closed.

WORKER1 COMFYUI, SETTLED by V (~03:36 UTC): "on demand only". The task stays Disabled (claude-code f6458608); it runs only for queued demand. Supersedes "keep comfyui on worker1". CPU work only on alpha-serv-01.
NEW, owner-approved (claude-alpha-serv 03:41-03:44): "agents on, big changes still asked": ALPHA_BACKGROUND_AUTOMATION_ENABLED=true on alpha-serv-01, backend restarted, healthy, alpha-ai.uk 200. Auto-improve runs; consequential work (apply-pending-upgrades) is still refused. claude-code stopped and handed the unfinished Worker1-to-Host merge (C:\AlphaData\publish\merge-wt, not swapped in) to claude-alpha-serv.

alpha-ai.uk answers 200; alpha-serv-01 is the sole server. Per #265 its coordinator runs (Alpha Tunnel Coordinator task, /healthz 1.7.0).

WORKER1 (Laptop41) BACK on GitHub: doctor 03:41 UTC 1 open (the cover task 'Alpha Standby' is not installed on it), CPU back under the hold; live page 03:51 says STANDBY, no split-brain; autopilot 03:51: bridges still down. But the tunnel's compute fleet still lists desktop-41hplcn as silent 2 h after its agent restart (03:28): check that the agent reaches alpha-serv-01.
enable-image for Worker1 (20261011-c1) cancelled by Codex as superseded; control/host h32 still queued.

Merged tonight: #253-#262; #263/#264 V's tunnel directive; #265 receipts. 

NEEDS V: re-issue agent keys; .env.local to alpha-serv-01 by USB, collect the memory copy there; Alpha's GPU gate (#234, fix in vyos88/Alpha); Worker2's uncommitted usb-inventory.ps1; #160; Alpha#77/#85.

Open: #249 (draft), #229 (draft), #160 (conflicts), #136, #86, #83. codex-02 failed (qwen3:8b not pulled).
Owner's rule: every session posts in the tunnel before and after working on either laptop.

Still stands:
 - From V: Alpha may read GitHub PRs in vyos88/Personal-AI-1.2 and vyos88/Alpha, read only.
 - FROM V (09 Oct, via Codex): the host is alpha-serv-01; laptop-gj8dfmlk is Worker2, its Alpha and coordinator stay stopped; Worker1 stays a worker (covers only if V says 'cover'). When Alpha on the Server comes up, it leads.
 - From V: on Worker2 (laptop-gj8dfmlk), GPU work uses the RTX 3050 (GPU 0), never the Intel UHD.
 - From V: on Worker1, COM24 = network bridge, COM20 = Arduino Uno, COM6 = Alpha Lite Deck, COM4 = LoRa (passive only, never transmit). COM7 is a TinyUSB device, NOT the CrowPanel. Only COM7 may be opened; no sweep may touch COM4, COM6, COM20 or COM24. Do not reflash or re-provision anything.
 - Do not start Q1 or Q7 until Alpha#24/#61 land.
 - Drive space (C3): Alpha and Codex, do NOT move or delete anything. Inventory only: each backup, archive or old copy over 500 MB under C:\ (path, size, last modified), and the external drive letter. Never list data\auth.json, .env files or keys. V moves files by hand.

Jack's laptop and the phones publish no status.

Alpha: post asks as "ASK: ..." in the tunnel. claude-alpha-serv: the merge handoff from claude-code; why Worker1's agent is not in the compute fleet. Codex: ASKS line 1; C3 and C5, read-only.

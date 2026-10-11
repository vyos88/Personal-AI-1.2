Claude (cloud) report, 2026-10-11 05:40 UTC

3-6-9 PROVEN LIVE (3m14s, 6m18s, 9m24s, 3m18s). Two reporters now, per V ("Both"): the Operating Cycle and 'Alpha 3-6-9 Reporter' (#89, posts [alpha-369]). The interim alpha-report is RETIRED (claude-alpha-serv 03:45). #90 closed.

Worker1 ComfyUI: on demand only (V, settled 03:36); the task stays Disabled. CPU work only on alpha-serv-01.
Owner-approved 03:41 (claude-alpha-serv): "agents on, big changes still asked": background automation on at alpha-serv-01; consequential upgrades still refused. The Worker1-to-Host merge (merge-wt, not live) is claude-alpha-serv's, started 05:38: its base lacked ~85 untracked server modules, being fixed.
NEW since 04:00 UTC (tunnel): Codex's 'Laptop Policy Lock' on Worker2: CPU only on alpha-serv-01, laptop GPU/Singing on queued demand only (SYSTEM guard). Worker2's real reboot (04:42) was verified: image and singing ran on its RTX 3050, then idled. Restart Check PASSED 05:08. Song check (Alpha Morning, 3 min, Worker2RTX, Jack authorized): take 1 broke the GPU-only rule (decoder fell back to CPU), stopped; Codex pinned decoding to CUDA. Take 2 finished on CUDA at 05:35 (69 MB WAV) and the GPU idled; a 502 was misread as failure, Codex is recovering the saved result. Alpha's replies still misread state.

alpha-ai.uk 200 from alpha-serv-01, the sole server; its coordinator runs (agent AlphaServer).

WORKER1 (Laptop41): fresh (doctor 05:26, live/autopilot 05:36 UTC). Doctor: 1 open, the cover task 'Alpha Standby' is not installed (queue standby-install, or stand it down: V decides). Live page STANDBY, no split-brain; bridges still down. Agent attached (heartbeat 5 s, 04:49).
Worker1's enable-image (c1) was cancelled; control/host h32 still queued.

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

Alpha: post asks as "ASK: ..." in the tunnel. Codex: confirm the recovered song and post it; ASKS line 1; C3 and C5, read-only. claude-alpha-serv: the merge handoff.

Claude (cloud) report, 2026-10-11 02:56 UTC

ASK FROM V TO CODEX (10 Oct): start the coordinator on alpha-serv-01 (docs/HOST_SETUP.md), report the /healthz receipt, then point Worker1's agent and bridges at it. Keys are V's; never post them.

alpha-ai.uk answers 200 (alpha-serv-01 is the SOLE server; Worker2 laptop-gj8dfmlk stays stopped). V's 'Alpha Execution Repair' task for Codex: status/cloud 1204e73. No coordinator confirmed yet.

WORKER1 (Laptop41) HAS GONE QUIET on all channels since ~00:26 UTC (doctor, live page, autopilot; 2.5 h now). Its last reports showed SPLIT-BRAIN (live page: "STANDBY BUT SERVING"). Doctor 00:26 UTC: role.json still says standby, but Worker1's backend (8001) and a cloudflared process are running again, so alpha-ai.uk traffic may be split with alpha-serv-01. Cause unknown. Also CPU 94% (over the 90% hold); RAM 2.2/15.8 GB free; C: 122.7 GB free. cloudSeen=ea6b0d1 (current). HANDOFF_2026-10-11.
Queued for Worker1 01:18 UTC (V): control 20261011-c1-enable-image, ComfyUI back on (CPU) and alpha.image offered again; it cannot run until Worker1 reports. ComfyUI held ~3.8 GB there before; watch RAM.

Merged tonight: #253-#262 (split of #99: music cuda/cpu, autopilot heartbeat, cover decision, live-sync timeout, ASKS/STATUS board); #263 V's directive in docs/ASKS.md: Alpha reports in the tunnel on its own on a 3, 6, 9 minute rhythm, answers Claude and Codex (no ping-pong), shows live sessions. #99 to be closed as superseded. FROM V: when Alpha on the Server comes up, it leads.

NEEDS V: find what started Worker1's backend and cloudflared and, if Worker1 stays a worker, re-run alpha-standdown with V present; the coordinator on alpha-serv-01 (Codex), then re-issue keys; .env.local to alpha-serv-01 by USB, collect the memory copy there; Alpha's GPU gate (#234, fix in vyos88/Alpha); Worker2's uncommitted usb-inventory.ps1; #160; Alpha#77/#85.

Open: #249 (draft), #229 (draft), #160 (conflicts), #136, #86, #83. codex-02 failed (qwen3:8b not pulled).
Owner's rule: every session posts in the coordination tunnel before and after it works on either laptop.

Still stands:
 - From V: Alpha may read GitHub PRs in vyos88/Personal-AI-1.2 and vyos88/Alpha, read only.
 - FROM V (09 Oct, via Codex): the host is alpha-serv-01; laptop-gj8dfmlk is Worker2, its Alpha and coordinator stay stopped; Worker1 stays a worker (covers only if V says 'cover'). When Alpha on the Server comes up, it leads.
 - From V: on Worker2 (laptop-gj8dfmlk), GPU work uses the RTX 3050 (GPU 0), never the Intel UHD.
 - From V: on Worker1, COM24 = network bridge, COM20 = Arduino Uno, COM6 = Alpha Lite Deck, COM4 = LoRa (passive only, never transmit). COM7 is a TinyUSB device, NOT the CrowPanel. Only COM7 may be opened; no sweep may touch COM4, COM6, COM20 or COM24. Do not reflash or re-provision anything.
 - Do not start Q1 or Q7 until Alpha#24/#61 land.
 - Drive space (C3): Alpha and Codex, do NOT move or delete anything. Inventory only: each backup, archive or old copy over 500 MB under C:\ (path, size, last modified), and the external drive's letter. Never list data\auth.json, .env files or keys. V moves files by hand.

Jack's laptop and the phones publish no status.

Alpha: post asks as "ASK: ..." in the tunnel. Do NOT restart Worker2's coordinator. Codex: ASKS.md #263 line 1, say which Alpha copy (branch, head) runs on alpha-serv-01 and where its tunnel log is; C3 and C5, read-only.

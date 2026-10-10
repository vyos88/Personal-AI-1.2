Claude (cloud) report, 2026-10-10 02:56 UTC

ASK FROM V TO CODEX (~01:50 UTC): START THE COORDINATOR ON alpha-serv-01 (100.70.101.6): tunnel checkout at main, its .env with a persistent auth store, the alpha-coordinator task (docs/HOST_SETUP.md), then /healthz on :8787 over the tailnet; then point Worker1's agent and bridges at it. Keys and .env.local are V's; never post them. Report the /healthz receipt.

ALPHA IS BACK: https://alpha-ai.uk/ answers 200, served from alpha-serv-01 (Worker1's doctor, 02:26 UTC); the 530 lasted ~00:02 to ~02:20 UTC. alpha-serv-01 is the SOLE server, Worker1 stays a standby worker, Worker2 (laptop-gj8dfmlk) stays stopped. V's task for Codex on alpha-serv-01, 'Alpha Execution Repair' (topology, coding execution, coordination tunnel, prep for Alpha 2.0), is on status/cloud 1204e73. No coordinator is confirmed yet: the /healthz receipt from alpha-serv-01 is still owed.

Worker1 (Laptop41) doctor fresh (02:26 UTC), in standby mode (fewer checks): 1 problem, its cover task 'Alpha Standby' idle 145 min, which is on purpose (#252). RAM 5.1/15.8 GB, C: 132.6 GB free. cloudSeen=1204e73 (current). Bridges restarted; memory copy in step. Doctor advice: rotate panel and agent keys after the coordinator move.

Merged 09-10 Oct by another cloud session: #238 self-heal; #239/#240 stand-down/stand-up; #241 automatic cover; #242-#248, #250 memory copy over Taildrop; #243 tailnet-peers; #251 stand-up fix; #252 docs. FROM V: when Alpha on the Server comes up, it leads.

NEEDS V: the coordinator on alpha-serv-01 (Codex), then re-issue agent and panel keys; Worker1's cloudflared service is broken (exit 1067), matters only for a cover; .env.local to alpha-serv-01 by USB, collect the memory copy there; Alpha's GPU gate (#234, fix in vyos88/Alpha); Worker2's uncommitted usb-inventory.ps1; #160; Alpha#77/#85.

Open: #249 (draft, line-ending repair, incomplete Windows suite), #229 (draft, author's), #160 (conflicts), #136, #99 (draft), #86, #83. Asks: codex-02 failed (qwen3:8b not pulled; Codex: name a pulled model); enrollment deferred (owner password).
Owner's rule: every session posts in the coordination tunnel before and after it works on either laptop.

Still stands:
 - From V: Alpha may read GitHub PRs in vyos88/Personal-AI-1.2 and vyos88/Alpha, read only.
 - FROM V (09 Oct, via Codex): the host is alpha-serv-01; laptop-gj8dfmlk is Worker2, its Alpha and coordinator stay stopped; Worker1 stays a worker (covers only if V says 'cover'). When Alpha on the Server comes up, it leads.
 - From V: on Worker2 (laptop-gj8dfmlk), GPU work uses the RTX 3050 (GPU 0), never the Intel UHD.
 - From V: on Worker1, COM24 = network bridge, COM20 = Arduino Uno, COM6 = Alpha Lite Deck, COM4 = LoRa (passive only, never transmit). COM7 is a TinyUSB device, NOT the CrowPanel. Only COM7 may be opened; no sweep may touch COM4, COM6, COM20 or COM24. Do not reflash or re-provision anything.
 - Do not start Q1 or Q7 until Alpha#24/#61 land.
 - Drive space (C3): Alpha and Codex, do NOT move or delete anything. Inventory only: each backup, archive or old copy over 500 MB under C:\ (path, size, last modified), and the external drive's letter. Never list data\auth.json, .env files or keys. V moves files by hand.

Jack's laptop and the phones publish no status.

Alpha: post asks as "ASK: ..." in the tunnel. Do NOT restart Worker2's coordinator. Codex: C3 and C5, read-only.

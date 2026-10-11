Claude (cloud) report, 2026-10-11 01:56 UTC

ASK FROM V TO CODEX (10 Oct): start the coordinator on alpha-serv-01 (docs/HOST_SETUP.md), report the /healthz receipt, then point Worker1's agent and bridges at it. Keys are V's; never post them.

alpha-ai.uk answers 200 (alpha-serv-01 is the SOLE server; Worker2 laptop-gj8dfmlk stays stopped). V's 'Alpha Execution Repair' task for Codex on alpha-serv-01 is on status/cloud 1204e73. No coordinator confirmed yet.

WORKER1 (Laptop41) HAS GONE QUIET on all channels since ~00:26 UTC (doctor, live page, autopilot; 90 min). Its last reports showed SPLIT-BRAIN (live page: "STANDBY BUT SERVING"). Doctor 00:26 UTC: role.json still says standby, but Worker1's backend (8001) and a cloudflared process are running again, so alpha-ai.uk traffic may be split between Worker1 and alpha-serv-01 (site still answers 200). Nothing queued a stand-up; cause unknown (by hand, a stale task, or Alpha's own runtime). Also: CPU 94%, over Alpha's 90% hold; cover task idle (on purpose, #252); RAM 2.2/15.8 GB, C: 122.7 GB free. cloudSeen=ea6b0d1 (current). HANDOFF_2026-10-11.

Merged since 09 Oct: #238-#248, #250-#252; NEW tonight #253-#262, the split of #99 (#256 music records cuda/cpu; #258 autopilot heartbeat without Alpha; #259 doctor treats a disabled cover as a decision; #260 live-sync never waits forever; #262 ASKS/STATUS board). #99 to be closed as superseded. FROM V: when Alpha on the Server comes up, it leads.

NEEDS V: find what started Worker1's backend and cloudflared and, if Worker1 stays a worker, re-run alpha-standdown with V present; the coordinator on alpha-serv-01 (Codex), then re-issue keys; .env.local to alpha-serv-01 by USB, collect the memory copy there; Alpha's GPU gate (#234, fix in vyos88/Alpha); Worker2's uncommitted usb-inventory.ps1; #160; Alpha#77/#85.

Open: #249 (draft, line-ending repair, incomplete Windows suite), #229 (draft, author's), #160 (conflicts), #136, #86, #83. Asks: codex-02 failed (qwen3:8b not pulled; Codex: name a pulled model); enrollment deferred (owner password).
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

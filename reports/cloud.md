Claude (cloud) report, 2026-10-10 00:56 UTC

ALPHA IS DOWN PUBLICLY: alpha-ai.uk answers 530 since ~00:02 UTC; nobody serves it. Owner instruction relayed by Codex (00:53 UTC): alpha-serv-01 (100.70.101.6) is the SOLE server and Worker1 stays a worker; alpha-serv-01's private /health answers 200, so the 530 is its public connector/config, not a reason to bring back a laptop host. Codex's job re-applied Worker1's stand-down (ok). Worker2 (laptop-gj8dfmlk) stays stopped. #251 (merged) fixed stand-up, so if V says 'cover', Worker1 can serve until alpha-serv-01's connector works; nobody re-queues that without V.

Worker1 (Laptop41) doctor fresh (00:41 UTC), 3 problems: (1) alpha-ai.uk 530 and Worker1 is standby; (2) its automatic cover task 'Alpha Standby' has not run for 40 min (disabled); (3) CPU 91%, at Alpha's 90% hold. Cleared: stale build, self-heal log, site/backend checks. RAM 4.4/15.8 GB, C: 132.6 GB free. cloudSeen=d62f7f6 (behind; this report is newer). Memory copy to alpha-serv-01: ~1.9 GB left, its task running.

Merged 09-10 Oct by another cloud session: #238 self-heal; #239/#240 stand-down/stand-up; #241 automatic cover; #242-#248, #250 memory copy over Taildrop; #243 tailnet-peers; #251 stand-up fix. alpha-serv-01 must collect the copy and needs a tunnel checkout for the coordinator. FROM V: when Alpha on the Server comes up, it leads.

NEEDS V: fix alpha-serv-01's public connector (cloudflared) so alpha-ai.uk answers, or say 'cover'; bring up its coordinator; Worker1's cloudflared SERVICE is broken (exit 1067; reinstall with V), or a cover has no public connector; hand-over: .env.local to alpha-serv-01 by USB, collect the memory copy there, Alpha stops its runtime on Worker1, then the switch; Alpha's GPU gate (#234, fix in vyos88/Alpha); Worker2's uncommitted usb-inventory.ps1; #160; Alpha#77/#85.

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

Claude (cloud) report, 2026-10-13 02:57 UTC

alpha-ai.uk: 200 from alpha-serv-01 (last night's short 530 recovered).

3-6-9 PROVEN LIVE: Operating Cycle + 'Alpha 3-6-9 Reporter' (#89), per V. alpha-report retired; #90 closed.

Worker1 ComfyUI: on demand only (V); task stays Disabled. CPU work only on alpha-serv-01.
Owner-approved: "agents on, big changes still asked" (automation on at alpha-serv-01). The Worker1-to-Host merge (merge-wt, not live) is claude-alpha-serv's.
Worker2 'Laptop Policy Lock': CPU only on alpha-serv-01, GPU/Singing on demand only; song check passed.

alpha-serv-01 is the sole server.

WORKER1 (Laptop41): fresh (doctor 02:11, live 02:54 UTC). 'STANDBY BUT SERVING' since 17:43: the doctor's 'backend' is AlphaPanelFeed's python (panel feed), not software/backend; ports 8001/4173 and cloudflared are clean. False positive; #277 MERGED 19:30 UTC makes standby probe the port; Worker1 still runs c1aa435 at 02:11 (7h after #277: self-update running?); clears once it updates. #278 merged (live page shows checkout updating). Do NOT queue alpha-standdown for it; V decides. Also open: cover task 'Alpha Standby' absent (Note? V decides); CPU-90% flaps (owner's apps).
control/host h32 still queued.

Merged: Alpha#101, #102, #104, #111; NEW Alpha#116: Music Creator live panel: fleet line, 'Made on the fleet', Remove vocals (billing untouched). Alpha#103 OPEN: memory/books rewrite; fixes a prune that deleted users' memories. Needs V's review. OPEN, need V (credentials): Alpha#109 Spotify token stored encrypted at rest; Alpha#110 new Ring integration (unofficial API, takes the Ring password). Neither tested on a real account. NEW: Alpha#113 OPEN, Execute tab as a real owner shell in the web UI; needs V's security review.
Earlier merged: #253-#278.

NEEDS V: review Alpha#103, #109, #110, #113; go/no-go on the music-bridge billing pair, #274 + Alpha#95; re-issue agent keys; .env.local to alpha-serv-01 by USB; Alpha's GPU gate (#234, fix in vyos88/Alpha); Worker2's uncommitted usb-inventory.ps1; #160; Alpha#77/#85.

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

Alpha/Codex: no standdown on Worker1 for the panel feed; leave Alpha#103/#109/#110/#113 for V. Alpha: ASKS line 1; C3 and C5, read-only. claude-alpha-serv: the merge handoff.

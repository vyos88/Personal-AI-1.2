Claude (cloud) report, 2026-10-12 20:57 UTC

alpha-ai.uk: 200 from alpha-serv-01 (last night's short 530 recovered).

3-6-9 PROVEN LIVE: Operating Cycle + 'Alpha 3-6-9 Reporter' (#89), per V. alpha-report retired; #90 closed.

Worker1 ComfyUI: on demand only (V); task stays Disabled. CPU work only on alpha-serv-01.
Owner-approved 03:41 (claude-alpha-serv): "agents on, big changes still asked": background automation on at alpha-serv-01; consequential upgrades still refused. The Worker1-to-Host merge (merge-wt, not live) is claude-alpha-serv's.
Worker2 'Laptop Policy Lock' (Codex): CPU only on alpha-serv-01, GPU/Singing on queued demand only; reboot verified. Song check passed on CUDA. Full test suite still blocked by a missing Blender source ('viore'); Alpha asks V.

alpha-serv-01 is the sole server (agent AlphaServer).

WORKER1 (Laptop41): fresh (doctor 20:41, live 20:54 UTC). 'STANDBY BUT SERVING' since 17:43: the doctor's 'backend' is AlphaPanelFeed's python (panel feed), not software/backend; ports 8001/4173 and cloudflared are clean. False positive; #277 MERGED 19:30 UTC makes standby probe the port; Worker1 still runs c1aa435 at 20:41; it clears after its next self-update. #278 MERGED 20:30 (main d99e83c): the live page now says whether the checkout is updating. Do NOT queue alpha-standdown for it; V decides. Also open: cover task 'Alpha Standby' absent (Note? V decides); CPU-90% flaps (owner's apps).
control/host h32 still queued.

New: Alpha#101, #102, #104 merged. Alpha#103 OPEN: memory/books rewrite, 37 files; fixes a prune that deleted users' memories >7 days. Needs V's review before merge (main 12639e6 handoff).
Earlier merged: #253-#276 (standby autopilot/doctor fixes; #272 GPU-demand code, Alpha#94).

NEEDS V: review Alpha#103; go/no-go on the music-bridge billing pair, #274 + Alpha#95 (plan from Alpha's entitlements; tested, mergeable); re-issue agent keys; .env.local to alpha-serv-01 by USB, collect the memory copy there; Alpha's GPU gate (#234, fix in vyos88/Alpha); Worker2's uncommitted usb-inventory.ps1; #160; Alpha#77/#85.

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

Alpha/Codex: no standdown on Worker1 for the panel feed; leave Alpha#103 for V. Alpha: ASKS line 1; C3 and C5, read-only. claude-alpha-serv: the merge handoff.

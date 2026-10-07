Claude (cloud, session "beautiful-noether") note for Alpha, 2026-10-07 16:16 UTC

CrowPanel, after the router renumbered the house network to 192.168.1.x:
- Done (job 54, tunnel #191): Worker1's backend now listens on 192.168.1.151 too. The boot wrapper's --host gained it, a .bak was kept, nothing was removed. The panel feed answers 200 from that address. Alpha was LIVE throughout.
- Not done: the panel still dials 192.168.2.151. COM7 sent nothing at all back to 15 STATUS requests (jobs 55 and cp3; #200 now reports what a port sends). Alpha's full-deck firmware keeps its console on the CH340 UART, not the native USB port, so COM7 may not be the port to talk to it on. FLEET.md's "COM7 = deck STATUS/ALPHA" line is unconfirmed.
- Needs V, one of: in Alpha, Hardware Hub > CrowPanel Alpha Deck > "Connect this panel to Wi-Fi", with the Alpha address http://192.168.1.151:8001; or name the panel's port, and allow it to be opened. No session opens COM4, COM6, COM20 or COM24 meanwhile.
Alpha: nothing to run.

----
Claude (cloud) report, 2026-10-07 15:57 UTC

Worker1 (Laptop41) report is fresh (doctor 15:57 UTC). Alpha is live. Chat answered in 6.8 s.

NEEDS V, NEW: Worker1 is short of RAM and disk. RAM: 1.3 of 15.8 GB free; a python process holds 3.3 GB and llama-server 1.9 GB. C: 8.4 GB free (16.4 GB at 13:41). V decides what to close or clear; Alpha and Codex do not move or delete anything. The C3 inventory (below) is what tells V where the space went.

CrowPanel: the backend now listens on 192.168.1.151 (job 54 plus #191: the boot wrapper's --host gets the address too). Job 55 panel-endpoint FAILED: the board on COM7 did not answer STATUS within 30 s ("wrong board, wrong firmware, or not booting"). The panel still has not called the backend (48 runs). The deck feed shows "assistant-loop-not-started", which is V's interactive-first setting. NEEDS V: look at the panel (is it on and booted?), then rerun panel-endpoint.

Alpha move (#189, #192, #193, #195, #197): Phase 0 check done. On the Host, h19 prepare-alpha-here passed (16:49 local): code up to date, backend venv ready (Python 3.12), site built, llama3.2:3b present. The move must also stop Worker1's Health Guard and Alpha's always-on scripts (#193). Nothing has been switched over yet.
Promo reel (#190, #199): job 56 made a 25 s reel. Two image scenes timed out while the Host's image agent restarted, and the retries rode over it.

Merged since 14:57: #190-#195, #197, #199. New handoff: docs/HANDOFF_2026-10-07_low-ram-disk-laptop41.md. Open: #160 (conflicts in autopilot.ps1), #136, #99; #86, #83. Alpha#76, #77 and #80 are waiting for V.

Needs V: RAM and disk on Worker1; the CrowPanel on COM7; a DHCP reservation for Worker1; the assistant loop for the deck feed; #160's conflict; Alpha#76/#77/#80; review #136; close Alpha#63; Alpha#47/#24; store the coordinator admin key on Worker1.
Owner's rule: every session posts in the coordination tunnel before and after it works on either laptop.

Still stands:
 - From V: Alpha may read GitHub pull requests in vyos88/Personal-AI-1.2 and vyos88/Alpha (titles, state, diffs). Read only: no merging, approving or commenting.
 - STANDING RULE FROM V (07 Oct): Alpha is hosted mainly by the Host (laptop-gj8dfmlk), which also runs the coordinator. Worker1 (Laptop41) covers Alpha only while the Host is down. When the Host is back with a heartbeat, it takes over again automatically. Plan: HANDOFF_2026-10-07d_alpha-moves-to-host.md (#189).
 - From V: on the Host, GPU work uses the NVIDIA RTX 3050 (GPU 0), never the Intel UHD (GPU 1). Images and MusicGen take turns with its 4 GB (#156).
 - From V: Worker1's boards are COM24 network bridge, COM20 Arduino Uno, COM6 Alpha Lite Deck, COM4 LoRa (passive only, never transmit) and COM7 CrowPanel. Only COM7 is ever opened. Do not reflash or re-provision anything. Set ALPHA_GSM_PORT to use a modem (Alpha#82).
 - Do not start task-queue Q1 or Q7 until Alpha#24/#61 land. No busy work for the 70% target.
 - Drive space (BACKLOG C3): Alpha and Codex, do NOT move or delete anything. Inventory only: each backup, archive or old copy over 500 MB under C:\ (path, size, last modified), and the external drive's letter. Never list data\auth.json, .env files or keys. V moves files by hand.

The phones publish no status.

Alpha: post in the tunnel per the owner's rule; start no heavy work on Worker1 while RAM is low. Codex: C3 and C5, read-only.

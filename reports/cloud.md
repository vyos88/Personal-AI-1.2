Claude (cloud) report, 2026-10-07 14:57 UTC

Worker1 (Laptop41) report is fresh (doctor 14:41 UTC). Alpha is live: backend, site and alpha-ai.uk 200. Chat answered in 3.0 s with 0 s load. RAM 3.9 of 15.8 GB free, C: 16.4 GB free. The deck feed heartbeat was fine at 14:41.

CrowPanel: still dark (44 doctor runs). Cause found at 14:50 UTC: the ROUTER RENUMBERED the house network from 192.168.2.x to 192.168.1.x (same router, same MAC). There is no old network to rejoin. Worker1 is now 192.168.1.151, and the backend still binds 192.168.2.151.
Fix is queued on Worker1, not run yet:
 - Job 52 panel-host (#188): adds 192.168.1.151 to HOST and ALPHA_TRUSTED_HOSTS (nothing removed, backup first) and restarts Alpha Backend, about 1 minute down.
 - Job 53 panel-endpoint: sends the panel on COM7 only its new address. No Wi-Fi credential is sent.
A DHCP reservation on the router would stop this recurring.

NEW, from V (#189, docs/HANDOFF_2026-10-07d_alpha-moves-to-host.md): Alpha moves to the Host, with Worker1 as warm copy and standby. scripts/alpha-move-check.ps1 is a read-only job that lists what a machine lacks to run Alpha and what a move must carry. Inventories 51 (Worker1) and h14 (Host) ran OK at 14:34 UTC.

Merged since 08:57: #186 and #187 (communication check, inventory results), #188 (panel-host: a renumbered network fixed without anyone at the machine), #189 (Alpha on both laptops, one coordinator). Open: #160 (conflicts in autopilot.ps1), #136, #99; #86, #83. Alpha#76, #77 and #80 are waiting for V.

Needs V: a DHCP reservation for Worker1; the assistant loop for the CrowPanel feed (interactive-first is V's call); whether COM24 is the ELEGOO bridge; #160's conflict; Alpha#76/#77/#80; review #136; close Alpha#63; Alpha#47/#24; review Alpha#68, #73; store the coordinator admin key on Worker1.
Owner's rule: every session posts in the coordination tunnel before and after it works on either laptop.

Still stands:
 - From V: Alpha may read GitHub pull requests in vyos88/Personal-AI-1.2 and vyos88/Alpha (titles, state, diffs). Read only: no merging, approving or commenting.
 - Roles, from V (updated 07 Oct, #189): Host = laptop-gj8dfmlk (RTX 3050) runs the coordinator and will run Alpha too. Worker1 = Laptop41 is the warm copy and standby for both. All work goes through the one coordinator. Until the move is done, Worker1 still serves Alpha.
 - From V: on the Host, GPU work uses the NVIDIA RTX 3050 (GPU 0), never the Intel UHD (GPU 1). Images and MusicGen take turns with its 4 GB (#156).
 - From V: Worker1's boards are COM24 network bridge, COM20 Arduino Uno, COM6 Alpha Lite Deck, COM4 LoRa (passive only, never transmit) and COM7 CrowPanel. Only COM7 is ever opened. Do not reflash or re-provision anything. Set ALPHA_GSM_PORT to use a modem (Alpha#82).
 - Do not start task-queue Q1 or Q7 until Alpha#24/#61 land. No busy work for the 70% target.
 - Drive space (BACKLOG C3): Alpha and Codex, do NOT move or delete anything. Inventory only: each backup, archive or old copy over 500 MB under C:\ (path, size, last modified), and the external drive's letter. Never list data\auth.json, .env files or keys. V moves files by hand.

The phones publish no status.

Alpha: post in the tunnel per the owner's rule; do not restart the backend by hand while job 52 runs. Codex: C3 and C5, read-only.

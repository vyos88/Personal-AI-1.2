Claude (cloud, session "beautiful-noether") note for Alpha, 2026-10-07 04:23 UTC

- Alpha has been LIVE on every 5-minute page since 03:39 local (backend, site and alpha-ai.uk 200; self-heal running, no repairs). One blip at 04:18 local was the planned restart after delivery.
- The rollback copy of the site has not been saved since 02:30 UTC: Windows keeps refusing the rename of dist.last-good.tmp (EPERM), even with #183's retries. Tunnel #184 (merged) copies it into place instead, index.html last, so a copy cut short counts as none; dist is only read. Worker1 picks it up on its next self-update. The note on the live page should go after the next snapshot.
- New since 04:04 UTC: the CrowPanel display stopped reading the feed (decks "2 stale"). That fits the Wi-Fi move in the 03:57 report: Worker1 is now on 192.168.1.x and the panel was last on 192.168.2.x. Nothing re-provisioned; that waits for V.
Alpha: nothing to run.

----
Claude (cloud) report, 2026-10-07 03:57 UTC

Worker1 (Laptop41) report is fresh (doctor 03:56 UTC). Chat answered in 5.7 s with 0 s load. RAM 3.2 of 15.8 GB free, C: 17.0 GB free. Relay works; cloudSeen = db2e172 (the 02:57 report).

NEW, NEEDS V: Worker1 is on a different Wi-Fi network. Its address is now 192.168.1.151 (router 192.168.1.1); it was 192.168.2.151. The backend still listens on the old address only, so the CrowPanel (192.168.2.97, last seen on the old network) cannot reach it. If the move is meant to stay: add 192.168.1.151 to HOST in .env.local (scripts/fix-panel-host.mjs does it), restart the backend, and re-provision the panel with that network and ALPHA http://192.168.1.151:8001. A DHCP reservation stops the address moving. If the laptop joined the other network by accident, rejoin the 192.168.2.x one. Do not re-provision the panel without V.

Decks (03:44 UTC): 5 live (hubs, command, devices, CrowPanel display, site), 1 stale (the CrowPanel FEED: the assistant-loop heartbeat is stale; the doctor now names who holds the background lane, #182), 3 static by design, the Alpha Lite Deck has no feed.
Live sync: in sync (03:23 UTC). Host: ComfyUI back on the RTX 3050 since 02:54 UTC; music (#159) live on both machines.

Merged since 02:57: #180 (self-heal says why an action failed), #181 (fleet stop list), #182, #183 (self-heal snapshot retries). Open: #160 (conflicts in autopilot.ps1), #136, #99; #86, #83. Alpha#76, #77 and #80 are waiting for V.

Needs V: the Wi-Fi move above; the assistant loop for the CrowPanel feed; whether COM24 is the ELEGOO bridge; #160's conflict; Alpha#76/#77/#80; review #136; close Alpha#63; Alpha#47/#24; review Alpha#68, #73; store the coordinator admin key on Worker1. The bridges close with 0xC000013A (console close).
Owner's rule: every session posts in the coordination tunnel before and after it works on either laptop.

Still stands:
 - From V: Alpha may read GitHub pull requests in vyos88/Personal-AI-1.2 and vyos88/Alpha (titles, state, diffs). Read only: no merging, approving or commenting.
 - Roles, from V: Host = laptop-gj8dfmlk (RTX 3050), the owner's laptop; runs the coordinator. Worker1 = Laptop41, serves Alpha and is the standby; the coordinator fails over to it (F30).
 - From V: on the Host, GPU work uses the NVIDIA RTX 3050 (GPU 0), never the Intel UHD (GPU 1). Images and MusicGen take turns with its 4 GB (#156).
 - From V: Worker1's boards are COM24 network bridge, COM20 Arduino Uno, COM6 Alpha Lite Deck, COM4 LoRa (passive only, never transmit) and COM7 CrowPanel. Only COM7 is ever opened. Do not reflash or re-provision anything. Set ALPHA_GSM_PORT to use a modem (Alpha#82).
 - Do not start task-queue Q1 or Q7 until Alpha#24/#61 land. No busy work for the 70% target.
 - Drive space (BACKLOG C3): Alpha and Codex, do NOT move or delete anything. Inventory only: each backup, archive or old copy over 500 MB under C:\ (path, size, last modified), and the external drive's letter. Never list data\auth.json, .env files or keys. V moves files by hand.

The phones publish no status.

Alpha: post in the tunnel per the owner's rule; nothing else to run. Codex: C3 and C5, read-only.

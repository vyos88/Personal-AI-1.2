Claude (cloud) report, 2026-10-07 22:57 UTC

Worker1 (Laptop41) report is fresh (doctor 22:56 UTC): no problems found. Alpha is live. Chat answered in 3.1 s with 0 s load. RAM 3.1 of 15.8 GB free.
Decks: EVERY deck is live (22:28 UTC). The deck-by-deck audit (#212) found 21 working, 0 empty, 0 broken.

CrowPanel: FIXED after about 17 hours. The cause was not a renumbered router. At 03:54 UTC the "Starlink V" Wi-Fi (192.168.2.x, the panel's network) dropped for a moment, and Windows fell back to the other "STARLINK" network (192.168.1.x) and stayed there. A session with a shell on Worker1 (Desktop Commander, from V) rejoined "Starlink V" at 22:10 UTC. Worker1 is 192.168.2.151 again, and the panel (192.168.2.97) calls the backend dozens of times a minute. Keeping Worker1 on "Starlink V" (and off the fallback network) stops this recurring.

Disk: at V's request Docker's data disk on Worker1 was deleted (docker_data.vhdx, 114.9 GB, last written 1 Sept). C: free went from about 17 GB to 132 GB. Docker Desktop is still installed; its old images, containers and volumes are gone. Nothing else was touched.

Alpha move (#189): Phase 2 has started. #213 adds receive-alpha-data, the data step on the Host. h22 fleet inventory on the Host ran OK.
Merged since 21:57: #210 (panel opens its port by device name at any COM number), #213. V merged Alpha#76 (player retry UI). Alpha#80 is held: COM7 is not the panel. Open: #160 (conflicts in autopilot.ps1), #136, #99; #86, #83. Alpha#77 is waiting for V.

Needs V: keep Worker1 on "Starlink V"; a DHCP reservation for Worker1; #160's conflict; Alpha#77; review #136; close Alpha#63; Alpha#47/#24; store the coordinator admin key on Worker1.
Owner's rule: every session posts in the coordination tunnel before and after it works on either laptop.

Still stands:
 - From V: Alpha may read GitHub pull requests in vyos88/Personal-AI-1.2 and vyos88/Alpha (titles, state, diffs). Read only: no merging, approving or commenting.
 - STANDING RULE FROM V (07 Oct): Alpha is hosted mainly by the Host (laptop-gj8dfmlk), which also runs the coordinator. Worker1 (Laptop41) covers Alpha only while the Host is down. When the Host is back with a heartbeat, it takes over again automatically. Plan: HANDOFF_2026-10-07d_alpha-moves-to-host.md (#189).
 - From V: on the Host, GPU work uses the NVIDIA RTX 3050 (GPU 0), never the Intel UHD (GPU 1). Images and MusicGen take turns with its 4 GB (#156).
 - From V: on Worker1, COM24 = network bridge, COM20 = Arduino Uno, COM6 = Alpha Lite Deck, COM4 = LoRa (passive only, never transmit). COM7 is a TinyUSB device, NOT the CrowPanel (the panel is on Wi-Fi). Only COM7 may ever be opened, and no panel-identify sweep may touch COM4, COM6, COM20 or COM24. Do not reflash or re-provision anything.
 - Do not start task-queue Q1 or Q7 until Alpha#24/#61 land. No busy work for the 70% target.
 - Drive space (BACKLOG C3): Alpha and Codex, do NOT move or delete anything. Inventory only: each backup, archive or old copy over 500 MB under C:\ (path, size, last modified), and the external drive's letter. Never list data\auth.json, .env files or keys. V moves files by hand.

The phones publish no status.

Alpha: post in the tunnel per the owner's rule; nothing else to run. Codex: C3 and C5, read-only.

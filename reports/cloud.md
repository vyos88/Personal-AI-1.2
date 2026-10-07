Claude (cloud) report, 2026-10-07 19:57 UTC

Worker1 (Laptop41) report is fresh (doctor 19:41 UTC). Alpha is live. Chat answered in 5.4 s with 0 s load. RAM 1.9 of 15.8 GB free (no longer flagged), C: 9.0 GB free.

Deck feed: V said yes to turning interactive-first mode off (#203, #204). Job 60 (17:14 UTC) set ALPHA_INTERACTIVE_FIRST_MODE=false in .env.local (backup kept) and restarted Alpha Backend, so the assistant loop now runs. It was live at 17:26, but since 18:02 UTC the heartbeat is stale again (1450 s old at 19:41; live means under 420 s), and the doctor now flags it NEEDS A PERSON. 'book-autoread' waits on host resource pressure, so low RAM on Worker1 is holding the loop back.

CrowPanel: the backend listens on 192.168.1.151, but the panel has still not called it (54 runs). #201 adds panel-up --identify, which asks each board whether it is the panel. NEEDS V: check the panel on COM7 is on and booted.

RAM at 17:26 was 1.1 GB free. The largest process is a python (pid 18408) at 4.1 GB, then llama-server at 1.9 GB. C: 8.6 GB free.
The "Alpha site x2" duplicate is NOT a stray preview: stop-stray-site (job 60, with #202) shows it is a vite dev server on 5173 (178 MB, since 00:32 UTC), and it was left alone. So it is not what is eating RAM. V decides whether the python process and the 5173 dev server should keep running.

Alpha move (#189): Host prepared at 15:49 UTC; nothing switched yet.

Merged since 15:57: #196, #198, #200 (panel-endpoint reports what a silent port sent), #201, #202, #203, #204. Open: #160 (conflicts in autopilot.ps1), #136, #99; #86, #83. Alpha#76, #77 and #80 are waiting for V.

Needs V: the CrowPanel on COM7; RAM (python 4.1 GB) and C: space on Worker1; a DHCP reservation for Worker1; #160's conflict; Alpha#76/#77/#80; review #136; close Alpha#63; Alpha#47/#24; store the coordinator admin key on Worker1.
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

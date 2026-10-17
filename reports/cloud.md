Claude (cloud) report, 2026-10-17 12:00 UTC

alpha-ai.uk: 200 from alpha-serv-01 now, but it blipped 7 times in a week (14-17 Oct), each gone by the next pass. Check on alpha-serv-01: backend healthy but public side failing = cloudflared at fault (HANDOFF_2026-10-16).

3-6-9 proven live (#89).
Worker1 ComfyUI: on demand only (V); task stays Disabled. CPU work only on alpha-serv-01.
Owner-approved: "agents on, big changes still asked".
Worker2 'Laptop Policy Lock': CPU only on alpha-serv-01, GPU/Singing on demand only; song check passed.

alpha-serv-01 is the sole server.

WORKER1 (Laptop41): fresh (doctor 11:57, live 11:55 UTC; this relay's report was seen). 3 open. 'STANDBY BUT SERVING' is a false positive (AlphaPanelFeed's python); #277 fixes it; Worker1 STILL runs c1aa435 (12 Oct), 5 days after #277: its self-update is not landing; someone on Worker1 should check. Do NOT queue alpha-standdown for it; V decides. Also open: cover task 'Alpha Standby' absent (expected, V decides); CPU 96% (owner's apps).
control/host h32 still queued.

NEW merged (17 Oct): #30 (which device listing to use), #31 (grow logger fix + WiFi survey), #35 (listen() retry crash); #37 closed. docs/HANDOFF_2026-10-17_recommendations-for-alpha.md gathers the host to-dos. Alpha#120 merged (tunnel sync); Alpha#122 open sync draft.
Merged before: Alpha#101-#102, #104, #111, #116 (Music Creator). Alpha#103 OPEN: memory/books rewrite; OPEN (credentials): Alpha#109 Spotify, #110 Ring (untested on real accounts). Alpha#113 OPEN: owner shell in the web UI.

NEEDS V: Alpha#117 ALPHA 2.0 RELEASE (APK/installers never built; Actions never ran: check Billing; Android signing) is a ship decision; review Alpha#103, #109, #110, #113; go/no-go on the music-bridge billing pair, #274 + Alpha#95; re-issue agent keys; .env.local to alpha-serv-01 by USB; Alpha's GPU gate (#234, fix in vyos88/Alpha); Worker2's uncommitted usb-inventory.ps1; #160; Alpha#77/#85.

Open: #153, #249, #229 (drafts), #160 (conflicts), #136, #86, #83; a long September draft tail on both repos for V to sort out.
Owner's rule: every session posts in the tunnel before and after working on either laptop.

Still stands:
 - From V: Alpha may read GitHub PRs in vyos88/Personal-AI-1.2 and vyos88/Alpha, read only.
 - FROM V (09 Oct, via Codex): the host is alpha-serv-01; laptop-gj8dfmlk is Worker2, its Alpha and coordinator stay stopped; Worker1 stays a worker (covers only if V says 'cover'). When Alpha on the Server comes up, it leads.
 - From V: on Worker2 (laptop-gj8dfmlk), GPU work uses the RTX 3050 (GPU 0), never the Intel UHD.
 - From V: on Worker1, COM24 = network bridge, COM20 = Arduino Uno, COM6 = Alpha Lite Deck, COM4 = LoRa (passive only, never transmit). COM7 is a TinyUSB device, NOT the CrowPanel. Only COM7 may be opened; no sweep may touch COM4, COM6, COM20 or COM24. Do not reflash or re-provision anything.
 - Do not start Q1 or Q7 until Alpha#24/#61 land.
 - Drive space (C3): Alpha and Codex, do NOT move or delete anything. Inventory only: each backup, archive or old copy over 500 MB under C:\ (path, size, last modified), and the external drive letter. Never list data\auth.json, .env files or keys. V moves files by hand.

Jack's laptop and the phones publish no status.

Alpha/Codex: no standdown on Worker1 for the panel feed; on alpha-serv-01, compare backend and public health at the next blip; leave Alpha#103/#109/#110/#113/#117 for V. Alpha: ASKS line 1; C3 and C5, read-only.

Claude (cloud) report, 2026-10-17 12:57 UTC

alpha-ai.uk: 200 from alpha-serv-01 now, but it blipped 7 times in a week (14-17 Oct), each self-resolved; if backend is fine and public fails, it's cloudflared.

Worker1 ComfyUI: on demand only (V); task stays Disabled. CPU work only on alpha-serv-01.
Owner-approved: "agents on, big changes still asked".
Worker2 'Laptop Policy Lock': CPU only on alpha-serv-01, GPU/Singing on demand only.

alpha-serv-01 is the sole server.

WORKER1 (Laptop41): fresh (doctor 12:11, live 12:48 UTC; relay seen). 3 open. 'STANDBY BUT SERVING' is a false positive (panel feed); its fix (#277) can't land: Worker1 STILL on c1aa435 (12 Oct), 32 behind: self-update refuses because 13 untracked files look like a person mid-task. V decides what happens to them (#279, ASKS). No alpha-standdown. Also open: cover task 'Alpha Standby' absent (expected, V decides); CPU 99% (owner's apps).
control/host h32 still queued.

NEW: Alpha#117 ALPHA 2.0 MERGED by V (12:22 UTC); V wants it the stable version everywhere. Not built yet: no APK/installers/tag; Alpha#128 says billing block fixed, #129 (draft) first green build. Rollout waits on V, step by step (HANDOFF_2026-10-17b). Alpha#124/#126 knowledge merged; #125 draft. Merged #279, #280.
Merged 17 Oct: #30 , #31, #35. HANDOFF_2026-10-17 lists host to-dos.
Alpha#103 OPEN: memory/books rewrite; OPEN (credentials): Alpha#109 Spotify, #110 Ring. Alpha#113 OPEN: owner shell in the web UI.

NEEDS V: 2.0 rollout go (Android signing secrets missing); Worker1's 13 untracked files; review Alpha#103, #109, #110, #113; go/no-go on the music-bridge billing pair, #274 + Alpha#95; re-issue agent keys; .env.local to alpha-serv-01 by USB; Alpha's GPU gate (#234, fix in vyos88/Alpha); Worker2's uncommitted usb-inventory.ps1; #160; Alpha#77/#85.

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

Alpha/Codex: no standdown on Worker1 for the panel feed; on alpha-serv-01, compare backend and public health at the next blip; no 2.0 rollout until V says go; leave Alpha#103/#109/#110/#113 for V. Alpha: ASKS line 1; C3 and C5, read-only.

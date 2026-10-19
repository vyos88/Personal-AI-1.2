Claude (cloud) report, 2026-10-19 21:58 UTC

alpha-ai.uk: 404 at 20:56 UTC 19 Oct, 200 from alpha-serv-01 again by 21:11. Blips recur since 14 Oct.

Worker1 ComfyUI: on demand only (V); task stays Disabled. CPU work only on alpha-serv-01.
Owner: "agents on, big changes still asked".
Worker2 'Laptop Policy Lock': GPU/Singing on demand only.

alpha-serv-01 is the sole server.

WORKER1 (Laptop41): doctor 21:41, live 21:53 UTC, fresh. NEW, 3 open: TWO ALPHAS - standby Worker1 now runs the site (node alpha-preview.mjs :4173) AND a cloudflared, so alpha-ai.uk traffic is split with alpha-serv-01; started near the 404, by whom unknown. Also: cover task 'Alpha Standby' absent. Still on c1aa435, 32 behind: self-update refuses 13 untracked + 2 tracked edits (#287). Port 8001 is Alpha's CrowPanel feed (#288), so alpha-standup would fail to bind it.
control/host h32 queued, cannot run: #286 proves the Host autopilot on laptop-gj8dfmlk is not running.

17 Oct: Alpha#117 (2.0) merged, green build #129, not tagged; rollout waits on V. Brain deck on alpha-serv-01.
18 Oct: #285 MERGED (Games deck live on alpha-serv-01; 3 Codex proposals wait for V). Drafts: Alpha#134/#135/#137/#138.
Alpha#103 OPEN: memory/books rewrite; OPEN (credentials): Alpha#109 Spotify, #110 Ring. Alpha#113 OPEN: owner shell in the web UI.

NEEDS V: NEW Worker1 site+cloudflared beside alpha-serv-01: cover or stand down? #289 (ASKS): panel-host is on the menu but a standby refuses it; give alpha-serv-01 a home-WiFi address for the panel, or bring Alpha back to Worker1? Also: look at laptop-gj8dfmlk's autopilot; review the 3 Codex proposals; 2.0 rollout go (Android signing secrets missing); Worker1's 2 edits + 13 untracked files (#287); review Alpha#103, #109, #110, #113; go/no-go on the music-bridge billing pair, #274 + Alpha#95; re-issue agent keys; .env.local to alpha-serv-01 by USB; GPU gate #234; Worker2's uncommitted usb-inventory.ps1; #160; Alpha#77/#85.

Open: #153, #249, #229, #160 (conflicts), #136, #86, #83; old drafts: V.
Owner: post in the tunnel before/after work on either laptop.

Still stands:
 - From V: Alpha may read GitHub PRs in vyos88/Personal-AI-1.2 and vyos88/Alpha, read only.
 - FROM V (09 Oct, via Codex): the host is alpha-serv-01; laptop-gj8dfmlk is Worker2, its Alpha and coordinator stay stopped; Worker1 stays a worker (covers only if V says 'cover'). When Alpha on the Server comes up, it leads.
 - From V: on Worker2 (laptop-gj8dfmlk), GPU work uses the RTX 3050 (GPU 0), never the Intel UHD.
 - From V: on Worker1, COM24 = network bridge, COM20 = Arduino Uno, COM6 = Alpha Lite Deck, COM4 = LoRa (passive only, never transmit). COM7 is a TinyUSB device, NOT the CrowPanel. Only COM7 may be opened; no sweep may touch COM4, COM6, COM20 or COM24. No reflash or re-provision.
 - Do not start Q1 or Q7 until Alpha#24/#61 land.
 - Drive space (C3): Alpha and Codex, do NOT move or delete anything. Inventory only: each backup, archive or old copy over 500 MB under C:\ (path, size, last modified), and the external drive letter. Never list data\auth.json, .env files or keys. V moves files by hand.

Jack's laptop and the phones publish no status.

Alpha/Codex: start nothing more on Worker1 and post in the tunnel what started its site+cloudflared; no standdown for the panel feed; on alpha-serv-01, compare backend and public health at the next blip; no 2.0 rollout until V says go; leave Alpha#103/#109/#110/#113 for V. Alpha: ASKS line 1; C3 and C5, read-only.

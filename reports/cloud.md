Claude (cloud) report, 2026-11-16 07:57 UTC

LAPTOP41 IS BACK after ~26 days silent. Doctor posts again since 06:59 UTC 16 Nov (last 07:41, fresh), live page 07:44. doctor-state has cloudSeen=bfe3ea6, so this relay now reaches it. Checkout still c1aa435 (12 Oct), behind main.
Open now (3):
 1. NEEDS A PERSON: TWO ALPHAS. role=standby since 07:38 and alpha-ai.uk 200 from alpha-serv-01, yet backend (python) and site (node) still run on Laptop41, open 4 runs since 06:58. PIDs changed between passes (17668->11276, 8968->11044): something restarts them after the stand-down.
 2. CPU 93-100%, over the 90% hold: agent stops taking tunnel tasks; data copy to alpha-serv-01 slow (100 MB still owed).
 3. Cleared since 07:28: low RAM; cover check now sees alpha-serv-01's backend.
Doctor hardening: admin key for scheduled runs; cloudflared Automatic; AC, sleep off; reboot test; rotate keys.

NEW: #153 'Status/laptop41' (open) touched 07:42 by the laptop's pushes. Alpha#73 draft (live watcher on Worker1) updated 07:00. main unchanged at c1949c9 (13 Nov). #301 DRAFT, #302 (GPU Bridge Policy) OPEN for V. Alpha#159 draft at c1949c9.

Worker1 ComfyUI on demand only; CPU work only on alpha-serv-01, the sole server. Owner: agents on, big changes asked.
20 Oct, unverified: #287 self-update refuses local edits; #288 port 8001 = CrowPanel feed; #286 h32 blocked.
V SAID GO on Alpha 2.0: step 1 green; steps 2-3 need claude-alpha-serv at alpha-serv-01 with V present; step 4 needs Android signing secrets (HANDOFF_2026-10-17b). Codex proposals BLOCKED: 31 Oct runs all verified=0.

NEEDS V: FIRST, on DESKTOP-41HPLCN decide which Alpha serves: alpha-standdown again and find what restarts backend/site (boot task or cover), or alpha-standup and stop alpha-serv-01's. Then: CPU hog; #302; 2.0 step 2; #289 panel WiFi address; laptop-gj8dfmlk autopilot; Android signing secrets; Worker1 edits (#287); Alpha#103/#109/#110/#113/#165; billing #274 + Alpha#95; re-issue agent keys; .env.local by USB; GPU gate #234.
Open: #153, #249, #229, #136, #86, #83; Alpha#161, #73.

Still stands:
 - From V: Alpha may read GitHub PRs in vyos88/Personal-AI-1.2 and vyos88/Alpha, read only.
 - FROM V (09 Oct, via Codex): the host is alpha-serv-01; laptop-gj8dfmlk is Worker2, its Alpha and coordinator stay stopped; Worker1 stays a worker (covers only if V says 'cover'). When Alpha on the Server comes up, it leads.
 - From V: on Worker2 (laptop-gj8dfmlk), GPU work uses the RTX 3050 (GPU 0), never the Intel UHD.
 - From V: on Worker1, COM24 = network bridge, COM20 = Arduino Uno, COM6 = Alpha Lite Deck, COM4 = LoRa (passive only, never transmit). COM7 is a TinyUSB device, NOT the CrowPanel. Only COM7 may be opened; no sweep may touch COM4, COM6, COM20 or COM24. No reflash or re-provision.
 - Do not start Q1 or Q7 until Alpha#24/#61 land.
 - Drive space (C3): Alpha and Codex, do NOT move or delete anything. Inventory only: each backup, archive or old copy over 500 MB under C:\ (path, size, last modified), and the external drive letter. Never list data\auth.json, .env files or keys. V moves files by hand.

Jack's laptop and the phones publish no status (JackRTX3050 is now in the GPU policy).

Alpha/Codex: Alpha, read-only: post which process starts the backend/site on DESKTOP-41HPLCN after stand-down and the top CPU users with an Administrator view; do not stop or start Alpha there yourself, V decides. Codex: the 3 questions in HANDOFF_2026-10-17b; why codex-run fails (read-only).

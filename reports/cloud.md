Claude (cloud) report, 2026-11-22 03:57 UTC

LAPTOP41 report fresh: doctor 03:41 UTC 22 Nov, live 03:54; cloudSeen=c1580a5. Checkout still c1aa435 (12 Oct), behind main.
NEEDS A PERSON (doctor flag): TWO ALPHAS, unchanged since 16 Nov. Stand-downs keep being undone within minutes (doctor flips 0/2 open every run). alpha-ai.uk 200 from alpha-serv-01. Alpha#159 (updated 11:06 21 Nov) still names Alpha's own watchdog as the likely cause.
BRIEF OUTAGE 20 Nov ~15:00: alpha-ai.uk answered 530 (nobody serving); recovered next run.
LOW RAM BACK, NEEDS A PERSON again since 02:56 22 Nov (1.0-1.5 of 15.8 GB free); it had cleared on 21 Nov. CPU 77%, still crosses the 90% hold some runs. Recurring: cover task 'Alpha Standby' missing on this machine; cover cannot always see alpha-serv-01's :8001. Data copy owes 94 MB.
Doctor hardening: admin key for scheduled runs; cloudflared Automatic; AC, sleep off; reboot test; rotate keys.

No merges or new PRs since 17 Nov; main unchanged at c1949c9 (13 Nov). #301 draft (Laptop41 outage record) touched 13:38 21 Nov, title unchanged; #302 (GPU Bridge Policy) OPEN for V; Alpha#159 draft updated 21 Nov; Alpha#73 draft idle.

Worker1 ComfyUI on demand only; CPU work only on alpha-serv-01, the sole server. Owner: agents on, big changes asked.
20 Oct, unverified: #287 self-update refuses local edits; #288 port 8001 = CrowPanel feed; #286 h32 blocked.
V SAID GO on Alpha 2.0: step 1 green; steps 2-3 need claude-alpha-serv at alpha-serv-01 with V present; step 4 needs Android signing secrets (HANDOFF_2026-10-17b). Codex proposals BLOCKED: 31 Oct runs all verified=0.

NEEDS V: FIRST, on DESKTOP-41HPLCN decide which Alpha serves: stop Alpha's watchdog there (Alpha#159) before alpha-standdown, or alpha-standup and stop alpha-serv-01's. Then: #302; 2.0 step 2; #289 panel WiFi address; laptop-gj8dfmlk autopilot; Android signing secrets; Worker1 edits (#287); Alpha#103/#109/#110/#113/#165; billing #274 + Alpha#95; re-issue agent keys; .env.local by USB; GPU gate #234.
Open: #153, #249, #229, #136, #86, #83; Alpha#161, #73.

Still stands:
 - From V: Alpha may read GitHub PRs in vyos88/Personal-AI-1.2 and vyos88/Alpha, read only.
 - FROM V (09 Oct, via Codex): the host is alpha-serv-01; laptop-gj8dfmlk is Worker2, its Alpha and coordinator stay stopped; Worker1 stays a worker (covers only if V says 'cover'). When Alpha on the Server comes up, it leads.
 - From V: on Worker2 (laptop-gj8dfmlk), GPU work uses the RTX 3050 (GPU 0), never the Intel UHD.
 - From V: on Worker1, COM24 = network bridge, COM20 = Arduino Uno, COM6 = Alpha Lite Deck, COM4 = LoRa (passive only, never transmit). COM7 is a TinyUSB device, NOT the CrowPanel. Only COM7 may be opened; no sweep may touch COM4, COM6, COM20 or COM24. No reflash or re-provision.
 - Do not start Q1 or Q7 until Alpha#24/#61 land.
 - Drive space (C3): Alpha and Codex, do NOT move or delete anything. Inventory only: each backup, archive or old copy over 500 MB under C:\ (path, size, last modified), and the external drive letter. Never list data\auth.json, .env files or keys. V moves files by hand.

Jack's laptop and the phones publish no status (JackRTX3050 is now in the GPU policy).

Alpha/Codex: Alpha, read-only: confirm whether your watchdog restarts backend/site on DESKTOP-41HPLCN after stand-down (Alpha#159), and the top CPU users; do not stop or start Alpha there yourself, V decides. Codex: the 3 questions in HANDOFF_2026-10-17b; why codex-run fails (read-only).

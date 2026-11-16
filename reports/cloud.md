Claude (cloud) report, 2026-11-16 10:57 UTC

LAPTOP41 BACK, report fresh: doctor 10:41 UTC, live 10:53; cloudSeen=e9cb2ea (it reads this relay). Checkout still c1aa435 (12 Oct), behind main.
NEEDS A PERSON (doctor flag): TWO ALPHAS. Stand-downs at 08:10, 08:31, 09:37, 10:37; each is undone within minutes. Backend on Laptop41 continuously since 09:57 (new PIDs), site comes and goes; alpha-ai.uk 200 from alpha-serv-01 throughout. Alpha#159 (retitled 10:05) names the likely cause: Alpha's own watchdog restarts them and the stand-down never stops it.
Flapping, not new: CPU and RAM cross the 90% hold most hours; data copy catches up (ON at 10:50). Once at 10:27: cover task 'Alpha Standby' missing, back by 10:41.
Doctor hardening: admin key for scheduled runs; cloudflared Automatic; AC, sleep off; reboot test; rotate keys.

NEW: #301 DRAFT (retitled 08:38: '...close it on the machine's return'), touched 10:37. Alpha#159 draft retitled 10:05: '...Laptop41 two Alphas: likely Alpha's own watchdog restarts them, stand-down never stops it'. Alpha#73 draft updated 07:00. main unchanged at c1949c9 (13 Nov). #302 (GPU Bridge Policy) OPEN for V.

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

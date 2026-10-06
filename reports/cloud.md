Claude (cloud) report, 2026-10-06 18:00 UTC

AFTER (session "Image generation bug"): music jobs 17/18 on Worker1.
 - Already fixed by the Laptop41 session, and queued at 17:47 UTC as jobs 19 (enable-music), 20 (music route) and 21 (enable-image): MusicGen now goes into a venv of its own (C:\AlphaData\creators-venv), and Repair-PipConflicts puts back pins on Python312, the Python Alpha's backend runs on; the agent is restarted through the 'alpha-agent' service (#132); vite.config.js carries the proxy itself (Alpha 207cafb). On a copy of the live tree without musicBridge.js, 207cafb's config loads where af139ec's failed exactly as job 18 did.
 - Watch job 19's line "putting back N requirement(s) ...": it should name only anyio. If it names fastapi, starlette, pydantic or uvicorn, it changed Alpha's server framework under the live backend: pin it back before the backend restarts.
 - Merged #133. apply-update now brings, whole, a file that a changed script imports and the host never had, so a repeat of job 18 cannot happen. Signed out, the doctor (5b/5c) asks the music and image bridges which machines make music and images, instead of reporting "no machine offers alpha.music" every run.
 - Merged #131: the doctor checks Alpha's CrowPanel deck feed end to end (625/625 tests with PowerShell).
 - GPUs on Worker1 (V's screenshot, 18:48 BST): GPU 0, Intel UHD, at 78% is drawing the screen and the browser/dashboard. GPU 1, AMD Radeon RX 640 (2 GB), at 0% is used by nothing: Ollama has no Windows ROCm path for it and OLLAMA_VULKAN is unset; MusicGen's torch is the CPU build; the creators' scripts look only for NVIDIA. Alpha's own notes rate this laptop CPU-class. Chat, music and images all run on the CPU (95% in the screenshot), so heavy generation belongs on the Host's RTX 3050.

NEW, failed-login check fixed: tunnel PR #121 is merged (main 6f48cde). This is BACKLOG H9. On 2026-10-06 scripts\check-alpha-logins.ps1 said "none" while 1,789 sign-ins had failed from 127.0.0.1 as VyoS. It missed them for two reasons. Worker1's backend writes failed sign-ins only to Alpha's audit_events, and the check never read that table. And the Alpha Governed Agents windows start with -EncodedCommand, which hides their script names. The check now reads audit_events, grouped by address and account, with a line "in the last 15 minutes: N". It also decodes -EncodedCommand and lists each window by its 'ALPHA ...' title. Tested: 612/612 on main with it merged, with PowerShell 7.4. It has not been run on Worker1 yet.
To run it on Laptop41 once the autopilot has pulled main (read-only; it never prints .env.local):
  powershell -ExecutionPolicy Bypass -File C:\services\alpha-tunnel\scripts\check-alpha-logins.ps1
"in the last 15 minutes: 0" means the stewards' stale-password sign-ins have stopped. A non-zero count with "ALPHA ..." windows listed means they have not: restart the stewards (open item 1).

Tunnel check, 17:00 UTC (autopilot line updated 17:45):
 - Relay: working. The doctor relayed the 16:35 handoff (c9e1e3a). The 16:58 cloud report (167007a) and this one go out on its next pass.
 - Worker1 (doctor 16:42 UTC): 0 open. Backend /health 200. Chat model answered in 9.3 s (load 7.3 s). Public alpha-ai.uk serves the same build as the machine. ComfyUI answers behind Alpha's bridge on 7860. Self-heal is running with no repairs. RAM 4.3 of 15.8 GB free, C: 26.8 GB free.
 - Coordinator 100.93.104.24:8787: healthz ok (1.7.0). Agents, keys and tasks are unseen because the doctor is not signed in (store the admin key; first hardening item).
 - Autopilot: its checkout updates itself again (the tools/ ignore fixed it; now 824ee29). 15-ollama-keepalive and 16-watcher-machine-names both ended 0 (17:58 BST); 17 and 18 failed, see above.

Open (status/claude-laptop41, HANDOFF_2026-10-06b):
 1. Restart the Agent Manager and stewards so the flicker fix loads (close the agent windows, then open "Alpha Governed Agents"). This needs a person.
 2. Route B, the rest: merge alpha-full's other fixes (#52 public-tunnel guard, #57-59, #64 image-backend probe, #67 security-panel IP and client, #68, #71 Coding editor fallback, #72 repair playbook, login hardening) onto the live branch.
 3. The Host (laptop-gj8dfmlk) agent is silent; check that it answers on the tailnet.
Open here: drafts #116, #99, #66 and older; #86, #83.

Still needs V: the steward restart; Alpha#47/#24 (subscriber summary; premium-gated music tracks); close Alpha#63 (Alpha#64, the same image fix, is merged on alpha-full and #63 now conflicts); review Alpha#66, #68 and #73; the Host agent; storing the coordinator admin key on Worker1; running the H9 check above and confirming the failed sign-ins stopped; the README.md:59 snapshot line (never --allow without V's yes); S1-S7 when the server arrives (today).
Owner's rule: every session posts in the coordination tunnel before and after it works on either laptop.

Still stands:
 - Do not start task-queue Q1 or Q7 until Alpha#24/#61 land. Alpha#61 records V's choice of Alpha's plans over the bridge's Stripe plans.
 - The queue file exists only on unmerged PR #25. CrowPanel PRs #18 and #26 duplicate each other. No busy work for the 70% target.
 - Drive space (BACKLOG C3): Alpha and Codex, do NOT move or delete anything. Inventory only: each backup, archive or old copy over 500 MB under C:\ (path, size, last modified), and the external drive's letter. Never list data\auth.json, .env files or keys. V moves files by hand.

Host, phones: no status branch.

Alpha: post in the tunnel per the owner's rule; nothing else to run. Codex: C3 and C5, read-only.

Claude (cloud) report, 2026-10-04 09:57 UTC

Laptop41's report is fresh (doctor run 10:56 local, pushed 09:56 UTC). It runs the new doctor from C:\services\alpha-tunnel. cloudSeen is still null after ~7 hours: the doctor has not picked up a cloud report yet. V: check its cloud relay step (docs/CLOUD_RELAY.md).

Big change: Alpha is served. A Claude repair session on Laptop41 (addendum at 09:14 UTC) found :4173 was up all along on https (node, vite preview); every earlier "nothing serves 4173" came from probes using http. The doctor now probes https: :4173, dist and alpha-ai.uk all serve the same current build, and the 'Alpha' and 'Alpha Backend' tasks are Running. Down from 6 open to 3, all NEEDS A PERSON:
 1. Alpha Self-Heal. The doctor says not registered; the repair session says it is registered but exits 3 every pass because its selfheal.json has a BOM. Fix is in PR #66 (branch claude/wizardly-brown-o23nhl, now also carries the self-heal BOM and https-probe fixes). V: pull #66 once merged and fix selfheal.json in place.
 2. Live main.py still has the dictionary bug: doctor -Fix as Administrator (apply-chat-fix.ps1, backup first).
 3. The 'Alpha' task runs C:\ProgramData\AlphaBoot\run-alpha.cmd, not the real frontend folder; repair-alpha-host.ps1 re-points it.
Also from the repair session: the 'Alpha Backend' boot task fails on a missing jwt module, so today's backend was started by hand and will not survive a reboot. An unknown cloudflared process carries the public site while the cloudflared service is Stopped. No chat model is installed (Ollama). Hub Detail "Unable to preload CSS" = stale chunk, Ctrl+Shift+R. Full notes: docs/handoffs/CODEX_2026-10-04-laptop41.txt on claude/wizardly-brown-o23nhl.
Resources: RAM 1.7 of 15.8 GB free (it has flapped all morning). C: 8.7 GB free and falling (19 GB on 2026-10-02). Coordinator :8787 is still the 1.7.0 process, so #72 queue journaling is not active until it is restarted.

Nothing new merged on main since 02:51 UTC (#79-#82: CI, docs/STATUS.md, apply-alpha-update.mjs, docs/BACKLOG.md). For V at Laptop41, BACKLOG H1-H4: H1 apply-alpha-update.mjs --apply --restart (brings in Alpha #36-#41); H2 publish the live source to alpha-from-host; H3 the repair; H4 GitHub billing/Actions and this repo's default branch -> main.
Open PRs here: #66 (updated 09:14), #76, #59, #70, #58.

Still stands:
 - Do not start task-queue Q1 or Q7. Two plan systems: bridge Stripe plans (#67, merged) vs Alpha's api/monetization.py (Alpha #24, open). V decides.
 - The queue file is only on unmerged PR #25. CrowPanel PRs #18 and #26 duplicate each other. No busy work for the 70% target.
 - Drive space (BACKLOG C3): Alpha / Codex, do NOT move or delete anything. Reply with an inventory only: each backup, archive or old copy over 500 MB under C:\ (path, size, last modified), and the external drive's letter. Never list or copy data\auth.json, .env files or keys. V moves files by hand.
 - The six failed sign-ins of 2026-10-04 00:19-00:25 UTC: V to confirm whether they were V.

Jack's laptop and the phones publish no status yet (no status/<name> branch for them).

Codex: BACKLOG reports C1-C3, read-only (C3 = drive inventory, now urgent with C: under 9 GB). Alpha: nothing to run; the three open items need V.

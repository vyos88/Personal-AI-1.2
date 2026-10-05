Claude (cloud) report, 2026-10-05 18:58 UTC

NEW on main: #101 publish-alpha flags Alpha's local credentials and databases before a push. #102 snapshot-alpha-live.mjs publishes only live versions of files alpha-full tracks, to a new branch, stopping on any credential; #103 (18:03) shows findings masked and lets --allow clear a reviewed line; apply-alpha-update refused on Laptop41 (36 files edited there).
#100 (merged 16:27), docs/HANDOFF_2026-10-05d_stewards.md. Alpha#58 (merged, alpha-full): Alpha's stewards no longer lock the owner out (they re-signed-in after every error); loopback sign-ins no longer count toward the lockout; failing stewards show as failing. Alpha#57: one layout on phones. apply-alpha-update.mjs now also updates scripts\. BACKLOG ST1-ST6, C5. PR #99 (lockout cleared on password change) updated 18:36, still open.

Still needs V first: Alpha PR #52 (draft). Public alpha-ai.uk routes run code from the request body behind only the owner password; V decides on merge.

Worker1 (Laptop41) report is fresh (pushed 18:56 UTC). Worker1 has now pulled main: the Self-Heal false positive is gone (3 open, was 4). cloudSeen still null after ~39 hours: no cloud report has reached Alpha yet. V: check the doctor's cloud relay step (docs/CLOUD_RELAY.md).
The doctor is still "Not signed in" to the coordinator (since 13:56 UTC), so agents/tasks are not reported. Coordinator healthz OK, 1.7.0. Last seen 12:41 UTC: worker1 and host attached, queue empty.
Alpha on Worker1 healthy: self-heal probes green, site serves the same bundle as dist. RAM 2.7 of 15.8 GB free, C: 8.1 GB free.

Worker1: 3 open, all NEEDS A PERSON (69 runs):
 1. Build older than source: rebuild dist.
 2. Live main.py dictionary bug: doctor -Fix as Administrator.
 3. 'Alpha' task does not point at the real frontend folder: repair-alpha-host.ps1.
Also: 'Alpha Backend' boot task needs jwt; an unknown cloudflared process carries the site; no Ollama chat model.

For V on Worker1, in order: Alpha #52 decision; re-login the doctor (`node src/admin/run.js login`) or store a key; H1 = apply-alpha-update.mjs --apply --restart (now includes stewards; it refused on 36 locally edited files, so --skip-scripts then ST1, or snapshot-alpha-live.mjs first), then restart and check the stewards (handoff steps 2-3); V1, F30; S1-S7 when the server arrives.
Open here: #99, #86 claude.exec, #83 alpha.grow-render (needs a merge decision), drafts #66, #64, #62, #50, #49, #45; older #37, #35, #32, #31, #30.

Still stands:
 - Do not start task-queue Q1 or Q7. Two plan systems: bridge Stripe plans (#67, merged) vs Alpha's api/monetization.py (Alpha #24, open). V decides.
 - Queue file only on unmerged PR #25; CrowPanel PRs #18 and #26 duplicate each other; no busy work for the 70% target.
 - Drive space (BACKLOG C3): Alpha / Codex, do NOT move or delete anything. Inventory only: each backup, archive or old copy over 500 MB under C:\ (path, size, last modified), and the external drive's letter. Never list data\auth.json, .env files or keys. V moves files by hand.
 - The six failed sign-ins of 2026-10-04 00:19-00:25 UTC: V to confirm whether they were V (the steward sign-in loop is one possible source).

Host and the phones publish no status branch yet; Host is visible only through the coordinator.

Codex: answer C3 (drive inventory) and C5 (read-only: does any steward still retry sign-in in a loop?); do not touch the Alpha #52 routes. Alpha: nothing to run; the items above need V.

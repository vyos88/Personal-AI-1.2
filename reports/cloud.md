Claude (cloud) report, 2026-10-09 23:56 UTC

UPDATE FOR V AND CODEX (Claude, cloud session, 2026-10-10 00:50 UTC): the stand-up bug is fixed and merged (#251). A stand-up now always enables Alpha Backend, Alpha and Alpha Self-Heal, reads every stand-down record since the last stand-up, and the job starts the cloudflared service. But Worker1 was stood down AGAIN at 00:38:39 UTC, by hand (role.json standby, primary alpha-serv-01; no autopilot job ran it). So Claude has NOT re-queued the cover: that would undo a newer decision. alpha-ai.uk is still 530, and alpha-serv-01 does not serve. V: say 'cover' and Claude queues alpha-standup on Worker1. It refuses if alpha-ai.uk already answers. Otherwise bring alpha-serv-01's site and connector up. Worker1 doctor (00:41 UTC): CPU 91%, at Alpha's 90% hold; RAM 4.4 GB free. Memory copy to alpha-serv-01: 1,933 MB left, the task is running.

UPDATE FOR CODEX (Claude, cloud session, 2026-10-10 00:25 UTC): job 20261010-16-standup-cover exited 1. role.json is set aside, so Worker1 is PRIMARY again, but Alpha Backend, Alpha and Alpha Self-Heal stayed DISABLED (the stand-down record did not list them as enabled), nothing listens on 8001/4173, and cloudflared was not started (Stopped, Manual, last exit 0). alpha-ai.uk still 530. Fix at the keyboard (V is on RDP): enable and start the tasks Alpha Backend, Alpha and Alpha Self-Heal, then start the cloudflared service; or the repair-host job. Not queued by Claude without V's yes.

NOTE FOR CODEX AND ALPHA (Claude, cloud session, 2026-10-10 ~00:25 UTC), with V's yes: alpha-ai.uk answers 530 since Worker1 stood down at 00:02 UTC; alpha-serv-01's backend (8001) and coordinator (8787) do not answer over the tailnet, and Worker1's automatic cover (Alpha Standby) is disabled. So Worker1 COVERS: control/laptop41 job 20261010-16-standup-cover (alpha-standup, no force; it refuses if alpha-ai.uk already answers). Hand over to alpha-serv-01 again once its backend, site and cloudflared connector answer (alpha-standdown with "primary": "alpha-serv-01", V present). Also: Claude's control/host job h31 (restart-coordinator on Worker2) is withdrawn; it never ran. Worker2's coordinator stays stopped.

CORRECTION: my earlier ask to start the coordinator on laptop-gj8dfmlk is WITHDRAWN. Codex relayed an owner instruction (control/laptop41, 2026-10-09): laptop-gj8dfmlk is now Worker2, its Alpha server and coordinator were stopped by V, and they must NOT be restored. The new host is alpha-serv-01. So no coordinator answers anywhere yet (since ~17:42 UTC); agents, music and images wait until it runs on alpha-serv-01.

Worker1 (Laptop41) doctor fresh (23:26 UTC), 3 problems: (1) no coordinator (above); (2) image backend down on 7861 (it was behind Worker2); (3) the site build is older than the source, so the site serves the old Alpha until dist is rebuilt. RAM low (1.6/15.8 GB); chat slow (7.3 s). Alpha live, decks 21 working, C: 124.3 GB free. cloudSeen=ba5a449 (current).

New server: alpha-serv-01 (Windows, online; HANDOFF_2026-10-09e). Memory copy to it: 2.7 GB left; big files timed out the 15-min check, so #250 runs it as its own task 'Alpha Data Copy' (job 15 queued on Worker1). alpha-serv-01 must collect what arrives, and needs a tunnel checkout before the coordinator can run there. FROM V: when Alpha on the Server comes up, it leads.

Merged today by another cloud session: #238 self-heal no longer goes silent; #239/#240 Worker1 stand-down/stand-up (rehearsed, ok); #241 automatic cover; #242 memory copy over Taildrop; #243 tailnet-peers; #245-#248, #250 copy fixes.

NEEDS V: bring up the coordinator on alpha-serv-01; rebuild Worker1's site (dist) and close non-Alpha apps there; Worker1's cloudflared SERVICE is broken (exit 1067; reinstall with V), or a cover has no public connector; hand-over: .env.local to alpha-serv-01 by USB, collect the memory copy there, Alpha stops its runtime on Worker1, then the switch; Alpha's GPU gate (#234, fix in vyos88/Alpha); Worker2's uncommitted usb-inventory.ps1; #160; Alpha#77/#85.

Open: #249 (draft, line-ending repair, incomplete Windows suite), #229 (draft, author's), #160 (conflicts), #136, #99 (draft), #86, #83. Asks: codex-02 failed (qwen3:8b not pulled; Codex: name a pulled model); enrollment deferred (owner password).
Owner's rule: every session posts in the coordination tunnel before and after it works on either laptop.

Still stands:
 - From V: Alpha may read GitHub PRs in vyos88/Personal-AI-1.2 and vyos88/Alpha, read only.
 - FROM V (09 Oct, via Codex): the host is alpha-serv-01; laptop-gj8dfmlk is Worker2, its Alpha and coordinator stay stopped; Worker1 covers. When Alpha on the Server comes up, it leads.
 - From V: on Worker2 (laptop-gj8dfmlk), GPU work uses the RTX 3050 (GPU 0), never the Intel UHD.
 - From V: on Worker1, COM24 = network bridge, COM20 = Arduino Uno, COM6 = Alpha Lite Deck, COM4 = LoRa (passive only, never transmit). COM7 is a TinyUSB device, NOT the CrowPanel. Only COM7 may be opened; no sweep may touch COM4, COM6, COM20 or COM24. Do not reflash or re-provision anything.
 - Do not start Q1 or Q7 until Alpha#24/#61 land.
 - Drive space (C3): Alpha and Codex, do NOT move or delete anything. Inventory only: each backup, archive or old copy over 500 MB under C:\ (path, size, last modified), and the external drive's letter. Never list data\auth.json, .env files or keys. V moves files by hand.

Jack's laptop and the phones publish no status.

Alpha: post asks as "ASK: ..." in the tunnel. Do NOT restart Worker2's coordinator. Codex: C3 and C5, read-only.

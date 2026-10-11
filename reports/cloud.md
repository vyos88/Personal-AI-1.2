Claude (cloud) report, 2026-10-11 03:28 UTC

3-6-9 (V's correction: 3, 6, 9 min, then 3, 6, 9 again): codex-alpha-policy's Alpha Operating Cycle on alpha-serv-01 already does it live (tunnel: cycles #0-#3 posted with gaps 3, 6, 9, then 3 again: the repeat is confirmed live). The merged fix on alpha-full is Alpha#89 (7a46f5d), the duplicate #90 is closed by V. Still, do NOT schedule tunnel_report_cadence.py: it would be a second reporter. Still wrong: the separate 'alpha-report' (claude-alpha-serv) still grows (#5 next 12, #6 next 15 min); its owner should make it repeat 3, 6, 9 or retire it.

FROM V (11 Oct, ~03:35 UTC, to this session), the decision: "keep comfyui on worker1, cpu only on server". So ComfyUI on Worker1 is the one exception and stays running; CPU work runs only on alpha-serv-01. This settles the 03:15 conflict between claude-code (ComfyUI on) and codex-alpha-policy (laptop ComfyUI off): do not stop Worker1's ComfyUI task. Earlier V line "on Laptop41 restart autopilot doctor and agent as worker" stands within this: no CPU jobs on Laptop41.

alpha-ai.uk answers 200; alpha-serv-01 is the sole server. Per #265 its coordinator runs (Alpha Tunnel Coordinator task, /healthz 1.7.0).

WORKER1 (Laptop41) quiet since ~00:26 UTC: per #265 its Alpha tasks, autopilot included, were Stopped and Disabled in the owner pause, so this is expected. Its last report showed backend and cloudflared running while role.json said standby; CPU 94%.
Waiting on the autopilots: control/laptop41 20261011-c1-enable-image and control/host 20261011-h32-enable-image (ComfyUI).

Merged tonight: #253-#262; #263/#264 V's tunnel directive; #265 receipts. 

NEEDS V: find what started Worker1's backend and cloudflared and, if Worker1 stays a worker, re-run alpha-standdown with V present; the coordinator on alpha-serv-01 (Codex), then re-issue keys; .env.local to alpha-serv-01 by USB, collect the memory copy there; Alpha's GPU gate (#234, fix in vyos88/Alpha); Worker2's uncommitted usb-inventory.ps1; #160; Alpha#77/#85.

Open: #249 (draft), #229 (draft), #160 (conflicts), #136, #86, #83. codex-02 failed (qwen3:8b not pulled).
Owner's rule: every session posts in the tunnel before and after working on either laptop.

Still stands:
 - From V: Alpha may read GitHub PRs in vyos88/Personal-AI-1.2 and vyos88/Alpha, read only.
 - FROM V (09 Oct, via Codex): the host is alpha-serv-01; laptop-gj8dfmlk is Worker2, its Alpha and coordinator stay stopped; Worker1 stays a worker (covers only if V says 'cover'). When Alpha on the Server comes up, it leads.
 - From V: on Worker2 (laptop-gj8dfmlk), GPU work uses the RTX 3050 (GPU 0), never the Intel UHD.
 - From V: on Worker1, COM24 = network bridge, COM20 = Arduino Uno, COM6 = Alpha Lite Deck, COM4 = LoRa (passive only, never transmit). COM7 is a TinyUSB device, NOT the CrowPanel. Only COM7 may be opened; no sweep may touch COM4, COM6, COM20 or COM24. Do not reflash or re-provision anything.
 - Do not start Q1 or Q7 until Alpha#24/#61 land.
 - Drive space (C3): Alpha and Codex, do NOT move or delete anything. Inventory only: each backup, archive or old copy over 500 MB under C:\ (path, size, last modified), and the external drive letter. Never list data\auth.json, .env files or keys. V moves files by hand.

Jack's laptop and the phones publish no status.

Alpha: post asks as "ASK: ..." in the tunnel. Codex: V's line above, no second 3-6-9 reporter; ASKS line 1; C3 and C5, read-only.

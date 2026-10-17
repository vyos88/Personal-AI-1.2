# Handoff — Laptop41 repair sequence, from the cloud→host relay's live findings

Written from a cloud session at the human's request. Not a general audit —
this is the specific repair sequence for the specific problems the new
`status/laptop41` relay (PR #74) actually reported as of 2026-10-02 ~20:00
UTC. Read that branch's `reports/latest.txt` for the current numbers before
running this; it may have already changed.

## What the live telemetry showed

- Backend (`:8001`) and the coordinator (`:8787`) are both healthy.
- `C:\AlphaData\Alpha` — the path the doctor expects Alpha to live at —
  **does not exist**, and nothing serves the frontend on `:4173`.
- The public `alpha-ai.uk` site serves a *different* JS bundle than this
  machine has on disk, meaning Cloudflare cache or another origin answers
  for it, not this box's `:4173`.
- The **Alpha Backend** and **Alpha Self-Heal** scheduled tasks were never
  registered — `repair-alpha-host.ps1` has never completed here.
- The admin CLI has no credential set, so nobody can list agents/stats/
  tasks/keys from this machine without signing in first.
- 4.1 of 15.8 GB RAM free. Several CrowPanel COM ports read "in use by
  another program" — not urgent, not covered below.

## The sequence — run as Administrator, on Laptop41

```powershell
# 1. Work from the real checkout, not the stale C:\AlphaData\doctor copy
cd C:\services\alpha-tunnel
git pull

# 2. Sign in so the admin CLI/doctor stop saying "No credential"
node src/admin/run.js login --email <you>
# (saves a session file -- PR #65 -- so this isn't needed every time)

# 3. Find where Alpha ACTUALLY runs from -- don't guess the path.
# The doctor's own suggested fix and the cloud relay's note disagreed
# slightly (one said ...VyoS-advance-tech-ai, the other
# ...VyoS-advance-tech-ai\software), so confirm for real.
Get-NetTCPConnection -LocalPort 8001 -State Listen | Select-Object OwningProcess
Get-Process -Id <the PID above> | Select-Object Id, Path
Get-ChildItem -Recurse -Depth 4 -Filter "alpha_coordination_tunnel.ps1" `
  -Path "C:\Users\Vyo\Downloads\VyoS-advance-tech-ai" -ErrorAction SilentlyContinue

# Whatever folder actually contains BOTH scripts\alpha_coordination_tunnel.ps1
# AND the running backend's main.py is the real $AlphaRoot. Set it once:
$AlphaRoot = "C:\Users\Vyo\Downloads\VyoS-advance-tech-ai"   # <-- correct if step 3 found a different folder

# 4. Report-only pass first -- changes nothing, just shows what's wrong
powershell -ExecutionPolicy Bypass -File scripts\repair-alpha-host.ps1 -AlphaRoot $AlphaRoot -ReportOnly

# 5. If that report looks sane, run it for real.
# Registers the missing "Alpha Backend" and "Alpha Self-Heal" scheduled
# tasks, gets the frontend running on :4173, and fixes the stale-bundle
# mismatch.
powershell -ExecutionPolicy Bypass -File scripts\repair-alpha-host.ps1 -AlphaRoot $AlphaRoot
# Undo if anything looks wrong afterward:
#   powershell -ExecutionPolicy Bypass -File scripts\repair-alpha-host.ps1 -Rollback

# 6. Re-point the doctor's own schedule at the real checkout + real root
powershell -ExecutionPolicy Bypass -File scripts\laptop41-doctor.ps1 -InstallSchedule -AlphaRoot $AlphaRoot

# Confirm the new scheduled task exists and fires once before deleting the old one:
Get-ScheduledTask -TaskName "*doctor*" | Select-Object TaskName, State
# Only once that's confirmed working:
Remove-Item -Recurse -Force C:\AlphaData\doctor

# 7. Verify
node src/admin/run.js agents
node src/admin/run.js doctor --agent laptop41
# Then check in a browser: http://127.0.0.1:4173 and https://alpha-ai.uk
```

## Deliberately left out of this sequence

- **The Stripe (#67, merged) vs. `api/monetization.py` (Alpha #24, open)
  plan-system decision.** The cloud relay already flagged these as two
  competing billing systems and asked V to pick one. That's a product
  decision, not a repair step, and isn't resolved here.
- **The disk-cleanup / backup move.** The cloud relay asked Alpha and Codex
  for an inventory only — no automatic moving or deleting of files, and
  nothing touches `data\auth.json`, `.env` files or keys.
- **The CrowPanel "COM port in use" lines.** Read as stale handles from
  another monitoring tool rather than a real conflict; not blocking, not
  addressed here.

If this doc is stale by the time someone reads it — `status/laptop41`'s
`reports/latest.txt` moves every 15-20 minutes — trust the live branch over
this file's "what the telemetry showed" section, not the other way around.

# Cloud <-> host relay: how a scheduled Claude session talks to Laptop41

A cloud Claude session cannot reach the tailnet or alpha-ai.uk (its network
policy blocks both). Laptop41 can reach GitHub and Alpha's coordination
tunnel. So GitHub carries messages both ways, on two branches that only ever
hold the latest report:

| Direction | Branch | Written by | Read by |
|---|---|---|---|
| host -> cloud | `status/laptop41` (`reports/latest.txt`, `reports/doctor-state.json`) | `scripts/laptop41-doctor.ps1 -Watch`, every 15 min | the cloud routine |
| cloud -> host | `status/cloud` (`reports/cloud.md`) | the "Alpha fleet relay" routine, every 30 min | `laptop41-doctor.ps1 -Watch`, which posts each new report to Alpha's coordination tunnel as `claude-cloud`, where Alpha and Codex read it |
| cloud -> host | `status/claude-laptop41` (`reports/handoff.md`) | the cloud session that runs Laptop41 through the autopilot | the same doctor run, posted as `claude-laptop41` |

The doctor posts each report once (it remembers the commit ids in
`doctor-state.json` as `cloudSeen` and `handoffSeen`), redacts tokens first,
and retries on the next run if the post failed. `relay` in the same file says
what the last attempt did, so a cloud session can read it on `status/laptop41`.

Alpha's `alpha_coordination_tunnel.ps1` is in `scripts\` beside `software\`.
Until 2026-10-06 the doctor looked only under `-AlphaRoot` (`software\`), never
found it, and so posted nothing for two days (`cloudSeen` and `lastPost` stayed
null). It now looks in `scripts\` beside `-AlphaRoot` first.

## Turning it on at Laptop41

The relay is in the doctor on `main`. The scheduled doctor currently runs
from the old copy in `C:\AlphaData\doctor`, so:

```powershell
cd C:\services\alpha-tunnel
git pull
powershell -ExecutionPolicy Bypass -File scripts\laptop41-doctor.ps1 -InstallSchedule
```

and remove `C:\AlphaData\doctor` once the new schedule has run.

## What it does not reach yet

Jack's laptop and the phones publish no status anywhere a cloud session can
read, so the cloud report can only say what Laptop41 and GitHub show. A
machine joins by pushing its own `status/<name>` branch the way the doctor
does.

The routine never merges PRs, never pushes to `main`, and never writes secrets.

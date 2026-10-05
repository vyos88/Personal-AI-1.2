# Handoff — 2026-10-05 (g): when Worker1 (Laptop41) goes down

`HANDOFF_2026-10-05c_failover.md` covers the **Host** going down. This covers
the other direction: Laptop41 off, asleep or off the tailnet. Today that stops
every `alpha.coordination` action, because Alpha's coordination log
(`memory/local/coordination/events.jsonl`) and the only agent that writes it
are both on Laptop41. The plan behind this file is Alpha's
`BuildArtifacts/installers/Alpha-Full/docs/WORKER1_FAILOVER_PLAN.md`
(vyos88/Alpha#60). Nothing in it has been run on the laptops yet.

| | Host = laptop-gj8dfmlk (100.93.104.24) | Worker1 = Laptop41, desktop-41hplcn (100.69.243.25) |
|---|---|---|
| Normally | keeps a copy of Worker1's log, and a standby that watches Worker1 | writes the log through `worker1`, sends a copy to the Host every 10 minutes |
| Worker1 goes down | after about 2 minutes the standby starts agent `worker1-standby`: notes (`Post`, `Ack`, `Status`) keep working, claims wait | — |
| Worker1 comes back | after about 2 minutes the standby stops `worker1-standby`; within 20 minutes the notes it took are in Worker1's log | the merge appends them, once |

## Needs first

Both merged and pulled on both laptops (`git pull` in `C:\services\alpha-tunnel`):

- **#109**: `ALPHA_COORDINATION_ACTIONS`, so the standby takes notes and not claims.
- **#110**: `scripts/merge-coordination-events.mjs`, which puts the notes back.

## How it works, and what it does not do

- **One writer, almost always.** The standby only starts after Worker1 stops
  answering. If Worker1's Alpha is down but its agent is up, both agents can
  take a note for a few minutes, each into its own log. Nothing is lost: the
  merge below brings the standby's notes over either way.
- **Claims never move.** `claims.json` is state, not a log. During an outage a
  `Claim` or `Release` fails at once with "Claim waits for the main
  coordination agent to be back".
- **Worker1's log stays the master.** It is only ever appended to. The Host's
  copy is replaced by Worker1's on every sync, except while the Host has notes
  Worker1 does not; those go to Worker1 first.
- **Alpha itself does not move.** Chat and alpha-ai.uk stay down until
  Worker1 is back. That is Stage 2 of the plan (needs BACKLOG H2).

## The address the standby checks

**Chosen: `http://100.69.243.25:8001/health`**, Alpha's backend on Worker1.
8001 and `/health` are what `laptop41-doctor.ps1` checks (`$BackendPort`).
It is a guess until the check below passes, because the backend may listen on
`127.0.0.1` only. It is set by `--probe-url` in H3, so changing it is one
argument.

**Check it from the Host before H3:**

```powershell
curl.exe -s -m 5 http://100.69.243.25:8001/health; "exit $LASTEXITCODE"
```

It must print a body and `exit 0`. If it prints nothing, **do not install
H3**: the standby would decide Worker1 is down while it is fine. Use instead
the first of these that answers from the Host, and put it in `--probe-url`:

1. `http://desktop-41hplcn:8001/health` (the same backend by name).
2. Any other HTTP endpoint Worker1 serves on its tailnet address that answers
   `200` while Laptop41 is up.

If none answers, the backend needs to listen on Worker1's tailnet address too;
that is a change to Alpha's start-up and is not part of this handoff.

## Part W — on WORKER1 (Laptop41): send the log, take notes back

Save as `C:\AlphaData\alpha-ops\records-sync.ps1`:

```powershell
# docs/HANDOFF_2026-10-05g_worker1-down.md, Part W. Merges notes the Host's
# standby took, then sends this log to the Host.
$alpha = '<folder holding Alpha>'   # the one apply-alpha-update.mjs uses
$log = Join-Path $alpha 'memory\local\coordination\events.jsonl'
$inbox = 'C:\AlphaData\alpha-ops\records-inbox'
$ops = 'C:\AlphaData\alpha-ops'
New-Item -ItemType Directory -Force $inbox | Out-Null
& tailscale.exe file get --conflict=overwrite $inbox 2>&1 | Out-Null
$incoming = Join-Path $inbox 'standby-events.jsonl'
if (Test-Path $incoming) {
  $m = [System.Threading.Mutex]::new($false, 'Global\AlphaCoordinationTunnel')
  if (-not $m.WaitOne([TimeSpan]::FromSeconds(60))) { "$((Get-Date).ToString('s')) tunnel busy; merge next time" | Add-Content "$ops\records-sync.log"; return }
  try {
    $out = node C:\services\alpha-tunnel\scripts\merge-coordination-events.mjs --master $log --incoming $incoming 2>&1
    $ok = $LASTEXITCODE -eq 0
  } finally { $m.ReleaseMutex() }
  "$((Get-Date).ToString('s')) merge: $out" | Add-Content "$ops\records-sync.log"
  if ($ok) {
    Remove-Item $incoming
    powershell -NoProfile -File (Join-Path $alpha 'scripts\alpha_coordination_tunnel.ps1') -Action Status -Actor alpha | Out-Null
  }
}
& tailscale.exe file cp $log laptop-gj8dfmlk: 2>&1 | Out-Null
```

The merge holds the tunnel's own mutex, so no note lands mid-append, and
`Status` rebuilds `status.json`. A refused merge (a damaged file) leaves the
master untouched and keeps the incoming file for a person to look at.

Schedule it every 10 minutes, as you (Taildrop hands files to the signed-in user):

```powershell
$a = New-ScheduledTaskAction -Execute powershell.exe -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\AlphaData\alpha-ops\records-sync.ps1'
$t = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 10)
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
Register-ScheduledTask -TaskName 'Alpha records to Host' -Action $a -Trigger $t -Settings $s -Force
Start-ScheduledTask 'Alpha records to Host'
```

### ➡️ Switch to the Host

## Part H — on HOST (laptop-gj8dfmlk)

### H1. The standby's folder and agent

A second checkout runs the standby agent, so its `.env.agent` is its own and
the `host` agent's is untouched. The coordination script finds its log
relative to itself, so the records folder needs only the script.

```powershell
git clone --branch main https://github.com/vyos88/Personal-AI-1.2 C:\services\alpha-records-standby
$rec = 'C:\AlphaData\alpha-records'
New-Item -ItemType Directory -Force "$rec\scripts", "$rec\memory\local\coordination" | Out-Null
# The script from Alpha's alpha-full branch:
# BuildArtifacts/installers/Alpha-Full/scripts/alpha_coordination_tunnel.ps1
Copy-Item '<that file>' "$rec\scripts\alpha_coordination_tunnel.ps1"
cd C:\services\alpha-tunnel
node src/admin/run.js whoami                     # note your userId
node src/admin/run.js issue-key --user <userId> --scopes agent:connect --name worker1-standby-agent
```

`C:\services\alpha-records-standby\.env.agent`, typing the key in:

```ini
ALPHA_HOST_URL=http://127.0.0.1:8787
ALPHA_AGENT_NAME=worker1-standby
ALPHA_AGENT_KEY=<the worker1-standby-agent key>
ALPHA_AGENT_CAPABILITIES=alpha.coordination
ALPHA_EXTRA_HANDLERS=alpha-coordination
ALPHA_REPO_ROOT=C:\AlphaData\alpha-records
ALPHA_COORDINATION_ACTIONS=Post,Ack,Status
```

Do not start this agent by hand. Only the standby (H3) starts it.

### H2. Keep the copy, send notes back

Save as `C:\AlphaData\alpha-ops\records-standby.ps1`:

```powershell
# docs/HANDOFF_2026-10-05g_worker1-down.md, H2. While the standby is not
# serving: if it holds notes Worker1 lacks, send them; otherwise take
# Worker1's log as the new copy.
$inbox = 'C:\AlphaData\alpha-ops\records-inbox'
$copy = 'C:\AlphaData\alpha-records\memory\local\coordination\events.jsonl'
$ops = 'C:\AlphaData\alpha-ops'
New-Item -ItemType Directory -Force $inbox | Out-Null
& tailscale.exe file get --conflict=overwrite $inbox 2>&1 | Out-Null
$serving = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*alpha-records-standby*src*agent*index.js*' }
if ($serving) { return }
$master = Join-Path $inbox 'events.jsonl'
if (-not (Test-Path $master)) { return }
if (Test-Path $copy) {
  $plan = node C:\services\alpha-tunnel\scripts\merge-coordination-events.mjs --master $master --incoming $copy --dry-run | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { "$((Get-Date).ToString('s')) copy unreadable; left alone" | Add-Content "$ops\records-standby.log"; return }
  if ($plan.added -gt 0) {
    $send = Join-Path $ops 'standby-events.jsonl'
    Copy-Item $copy $send -Force
    & tailscale.exe file cp $send desktop-41hplcn: 2>&1 | Out-Null
    "$((Get-Date).ToString('s')) sent $($plan.added) notes to Worker1" | Add-Content "$ops\records-standby.log"
    return
  }
}
Copy-Item $master $copy -Force
```

Schedule it the same way as Part W, task name `Alpha records from Worker1`,
file `records-standby.ps1`.

### H3. The standby

Only after the address check above passed:

```powershell
$node = (Get-Command node).Source
$standbyArgs = '"C:\services\alpha-records-standby\scripts\standby-alpha.mjs" --root C:\services\alpha-records-standby --start src/agent/index.js --probe-url http://100.69.243.25:8001/health --control-url https://github.com --probe-ms 30000 --failures 4 --recover 4'
$a = New-ScheduledTaskAction -Execute $node -Argument $standbyArgs -WorkingDirectory 'C:\services\alpha-records-standby'
$t = New-ScheduledTaskTrigger -AtStartup
$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'Alpha records standby' -Action $a -Trigger $t -Principal $p -Settings $s -Force
Start-ScheduledTask 'Alpha records standby'
```

`--control-url https://github.com` keeps the Host from promoting when the Host
is the one offline.

## Part D — the drill

1. On **Worker1**: `Stop-Service alpha-agent`, then `tailscale down`.
2. Wait 3 minutes. On the **Host**, in `C:\services\alpha-tunnel`:
   `node src/admin/run.js agents` lists `worker1-standby`;
   `node src/admin/run.js coord --action Post --actor host --message "failover drill"`
   succeeds; `--action Claim --paths README.md` fails with "Claim waits for
   the main coordination agent to be back".
3. On **Worker1**: `tailscale up`, `Start-Service alpha-agent`.
4. Wait 3 minutes: `agents` no longer lists `worker1-standby`.
5. Wait 20 more: Worker1's `events.jsonl` has the drill note exactly once,
   with `"machine":"laptop-gj8dfmlk"`, and
   `C:\AlphaData\alpha-ops\records-sync.log` has a `merge:` line saying
   `"added":1`.

## Checked (cloud session, 2026-10-05)

- #109 and #110: `npm test` passes on each (580 and 588 pass, 0 fail).
- The merge script was run as a subprocess against real files: it appends
  once, a second run adds nothing, `--dry-run` writes nothing, and a damaged
  incoming file leaves the master untouched.

Not checked: anything in Parts W, H and D, which need the two laptops; the
probe address; Taildrop between the laptops.

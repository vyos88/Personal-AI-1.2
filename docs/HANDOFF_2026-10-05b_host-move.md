# Handoff — 2026-10-05 (b): the coordinator moves to laptop-gj8dfmlk

> **Done 2026-10-05.** The owner ran Parts A-E. Part D passed (worker1
> attached, sysinfo from DESKTOP-41HPLCN, coord Status through the Host), and
> both peer reports run. Not done: B8, an agent on Host. It is BACKLOG F2:
> the `.env.agent` on gj8 holds a key from its old 2026-09-15 store, which is
> void. Where the steps below differ from what was actually run (the old
> coordinator was kept up by a `run-coordinator.cmd` loop, a scheduled task
> and a Startup `.vbs`, not nssm), `memory/knowledge/alpha_session_record_2026_10_05_host_move.json`
> in vyos88/Alpha records what happened.

For whoever is at the two laptops: the owner, and Claude or Codex running on
either one. Work through it in order. Each part says which laptop it runs on,
so you know when to switch.

This **replaces** `HANDOFF_2026-10-05_worker1.md`. There is no separate new
worker laptop: the name Worker1 now belongs to Laptop41.

## The new roles

| Name | Machine | Runs after the move |
|---|---|---|
| **Host** | `laptop-gj8dfmlk` (tailnet 100.93.104.24, formerly "Jacks laptop") | the coordinator: `node src/host/index.js`, with `data/auth.json`, `receipts.json` and `tasks.json`; an agent named `host` if it lends work |
| **Worker1** | Laptop41, `desktop-41hplcn` (tailnet 100.69.243.25) | **Alpha itself, unchanged** (backend, frontend, alpha-ai.uk), and its agent, renamed to `worker1`, which dials Host |

Only the coordinator moves (`COORDINATOR_MIGRATION.md`). Alpha stays on
Laptop41, and so does the agent beside it. That agent has to stay there,
because `alpha.coordination` runs `scripts/alpha_coordination_tunnel.ps1`
inside the Alpha working copy. Alpha's watcher and Network hub already show
these names (`vyos88/Alpha`, `frontend/src/config/fleetNames.js`).

**Rules for whoever runs this.** Never paste a key, `auth.json` or a `.env`
into a chat, a commit or a doc. Move them by USB. Run each block one line at a
time and read what it says before going on. If a step fails, stop and report
it. Do not improvise around it.

---

## Part A — on LAPTOP41 (becomes Worker1)

### A1. Save how things look now

```powershell
cd C:\services\alpha-tunnel
git fetch origin main; git checkout main; git pull --ff-only
New-Item -ItemType Directory -Force C:\AlphaData\alpha-ops | Out-Null
node src/admin/run.js agents | Tee-Object C:\AlphaData\alpha-ops\before-move-agents.txt
node src/admin/run.js tasks  | Tee-Object C:\AlphaData\alpha-ops\before-move-tasks.txt
```

If `tasks` shows something running that must not run twice, let it finish
first.

### A2. Find every way the coordinator is kept running here

Three things can bring a stopped coordinator back. Check all three.

```powershell
Get-Service alpha-* -ErrorAction SilentlyContinue
foreach ($s in (Get-Service alpha-* -ErrorAction SilentlyContinue).Name) { "$s -> " + (nssm get $s AppParameters) }
Get-CimInstance Win32_Process -Filter "name='node.exe' or name='cmd.exe'" | Where-Object CommandLine -match 'host\\index.js|run-coordinator' | Select-Object ProcessId, CommandLine
Get-ScheduledTask | Where-Object { ($_.Actions.Execute + ' ' + $_.Actions.Arguments) -match 'host\\index.js|run-coordinator' } | Select-Object TaskName
Get-ChildItem ([Environment]::GetFolderPath('Startup')) | Select-Object Name
```

The coordinator is whatever runs `src\host\index.js`. That is a service whose
`AppParameters` end in `host\index.js` (it may be named `alpha-coordinator` or
`alpha-host`), a `run-coordinator.cmd` window, a scheduled task, or a Startup
entry. The agent is whatever runs `src\agent\index.js`. **Leave the agent
running.**

### A3. Stop the coordinator so it stays stopped

For a **service** (an Administrator PowerShell; use its real name):

```powershell
nssm stop <coordinator service>
sc.exe config <coordinator service> start= demand
nssm get <agent service> DependOnService      # if it names the coordinator:
nssm set <agent service> DependOnService ""
```

For a **`run-coordinator.cmd` window**: close the window. Ending only `node`
does not work, because the loop restarts it.

Remove any scheduled task or Startup entry that A2 found:

```powershell
Disable-ScheduledTask -TaskName '<name>'
```

Prove it is down and stays down:

```powershell
Start-Sleep 20; curl.exe -s -m 5 http://127.0.0.1:8787/healthz; "exit $LASTEXITCODE"
```

A non-zero exit, with no JSON before it, means it is down.

### A4. Copy the three state files to a USB stick

```powershell
Copy-Item C:\services\alpha-tunnel\data\auth.json, C:\services\alpha-tunnel\data\receipts.json, C:\services\alpha-tunnel\data\tasks.json E:\ -Verbose
```

Use the USB stick's drive letter in place of `E:`. A file that does not exist
yet is fine to skip, except `auth.json`, which must exist. **`auth.json` is
every key in the fleet.** Keep the originals here: they are the rollback.

### ➡️ Switch to laptop-gj8dfmlk

---

## Part B — on LAPTOP-GJ8DFMLK (becomes Host)

### B1. Confirm the machine and its address

```powershell
hostname                    # expect LAPTOP-GJ8DFMLK
tailscale ip -4             # expect 100.93.104.24; write down what it prints
node --version              # needs v20 or later
```

### B2. Get the tunnel on `main`

If `C:\services\alpha-tunnel` does not exist:

```powershell
git clone --branch main https://github.com/vyos88/Personal-AI-1.2 C:\services\alpha-tunnel
```

If it exists:

```powershell
cd C:\services\alpha-tunnel
git status --short --branch
```

If the output shows local changes, or `ahead`, stop and report it. Do not
reset over local work. Otherwise:

```powershell
git fetch origin main; git checkout main; git pull --ff-only
```

### B3. Put the state files in place

```powershell
cd C:\services\alpha-tunnel
New-Item -ItemType Directory -Force data | Out-Null
Copy-Item E:\auth.json, E:\receipts.json, E:\tasks.json data\ -Verbose
```

### B4. Write `.env`

Open it with `notepad .env`. It must contain these lines, using the address from
B1, and **no** `ALPHA_BOOTSTRAP_TOKEN` line:

```ini
ALPHA_HOST_PORT=8787
ALPHA_HOST_BIND=127.0.0.1,100.93.104.24
ALPHA_AUTH_STORE=./data/auth.json
ALPHA_HOST_URL=http://127.0.0.1:8787
```

### B5. Start it once by hand, and read what it says

```powershell
node src/host/index.js
```

Expect it to log both bound addresses. If you see `cannot bind ... not an
address on this machine`, the IP in `.env` is wrong. If you see a parse error
naming `auth.json`, recopy it (A4 and B3). Leave this window open for B6, then
press Ctrl+C to stop it.

### B6. Check that the accounts came across

Run this in a second window while B5 is still running:

```powershell
cd C:\services\alpha-tunnel
node src/admin/run.js login --email <owner email>
node src/admin/run.js whoami
```

When `whoami` shows the existing account, the store survived. Then stop B5
with Ctrl+C.

### B7. Keep it always on

In an Administrator PowerShell, with nssm installed (`HOST_SETUP.md` §9):

```powershell
$NODE = (Get-Command node).Source; $APP = 'C:\services\alpha-tunnel'
New-Item -ItemType Directory -Force "$APP\logs" | Out-Null
nssm install alpha-coordinator "$NODE" "$APP\src\host\index.js"
nssm set alpha-coordinator AppDirectory $APP
nssm set alpha-coordinator AppStdout "$APP\logs\host.log"
nssm set alpha-coordinator AppStderr "$APP\logs\host.log"
nssm set alpha-coordinator AppExit Default Restart
nssm set alpha-coordinator AppRestartDelay 5000
sc.exe config alpha-coordinator start= delayed-auto
nssm start alpha-coordinator
curl.exe -s http://127.0.0.1:8787/healthz
```

Without nssm, use `run-coordinator.cmd`. Edit the `cd /d` path in it first.

**The Host must not sleep.** When the coordinator laptop sleeps, the whole
fleet stops (`COORDINATOR_MIGRATION.md`, "The lid"). Keep it plugged in, then:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /setacvalueindex SCHEME_CURRENT 4f971e89-eebd-4455-a8de-9e59040e7347 5ca83367-6e45-459f-a27b-476b1d01c936 0
powercfg /setactive SCHEME_CURRENT
```

### B8. The Host's own agent (only if it lends work)

If `.env.agent` exists here, set its URL to loopback and its name, then
restart that agent:

```ini
ALPHA_HOST_URL=http://127.0.0.1:8787
ALPHA_AGENT_NAME=host
```

### B9. Make one key for each laptop's 3-minute report

This key can read agents and post tasks, and nothing else:

```powershell
node src/admin/run.js whoami                     # note your userId
node src/admin/run.js issue-key --user <userId> --scopes "agents:read,tasks:read,tasks:write" --name host-report
node src/admin/run.js issue-key --user <userId> --scopes "agents:read,tasks:read,tasks:write" --name worker1-report
```

Store the `host-report` key on this machine, typing it at the prompt:

```powershell
[Environment]::SetEnvironmentVariable('ALPHA_REPORT_TOKEN', (Read-Host 'host-report key'), 'User')
```

Copy the `worker1-report` key to the USB stick for C3.

### ⬅️ Switch to Laptop41

---

## Part C — on LAPTOP41 again (now Worker1)

### C1. Point the agent at the Host, and rename it

Edit `C:\services\alpha-tunnel\.env.agent` and change only these two lines.
Leave `ALPHA_AGENT_KEY` alone: the key is still valid, because the store moved.

```ini
ALPHA_HOST_URL=http://100.93.104.24:8787
ALPHA_AGENT_NAME=worker1
```

If the agent service holds its settings itself, change it there instead
(`nssm get <agent service> AppEnvironmentExtra`). Then restart the agent:
`nssm restart <agent service>`, or restart `install-always-on.ps1`'s keeper.

### C2. Point `.env` at the Host, and remove the old coordinator lines

In `C:\services\alpha-tunnel\.env`, set the line below and **delete**
`ALPHA_HOST_PORT`, `ALPHA_HOST_BIND`, `ALPHA_AUTH_STORE` and
`ALPHA_BOOTSTRAP_TOKEN`. The admin CLI, the doctor, the watchdog and
`alpha-manager` all read this file (`COORDINATOR_MIGRATION.md` §5b).

```ini
ALPHA_HOST_URL=http://100.93.104.24:8787
```

### C3. Store the worker1 report key

```powershell
[Environment]::SetEnvironmentVariable('ALPHA_REPORT_TOKEN', (Read-Host 'worker1-report key'), 'User')
```

Then delete the key from the USB stick, along with `auth.json` and the other
two state files once Part D passes.

---

## Part D — check, from either laptop

```powershell
cd C:\services\alpha-tunnel
node src/admin/run.js agents                                   # worker1 listed (and host, if B8)
node src/admin/run.js task --type sysinfo --agent worker1      # comes back from Laptop41
node src/admin/run.js coord --action Status --actor host       # the tunnel still reaches Alpha
```

Allow up to 90 seconds for a restarted agent to show up. `coord` succeeding is
the one check that matters most: it proves the coordination tunnel still
reaches Alpha on Laptop41 through the coordinator's new home. If it fails with
"no attached agent currently offers alpha.coordination", the worker1 agent has
no `ALPHA_EXTRA_HANDLERS=alpha-coordination`. Add it to `.env.agent` on
Laptop41 and restart the agent.

**Rollback**, if Part D cannot be made to pass: stop `alpha-coordinator` on the
Host. On Laptop41, set the old coordinator back to `start= delayed-auto` and
start it, put `ALPHA_HOST_URL=http://127.0.0.1:8787` back in both files,
restart the agent, and report what failed.

---

## Part E — the 3-minute report, on both laptops

Each laptop checks the fleet every 3 minutes: is it attached, is the other
one, and is the coordinator answering. It writes one line to
`C:\AlphaData\alpha-ops\peer-report.log` every time. It also posts to the
coordination tunnel, where the other laptop, Alpha's activity watcher (Network
hub), Codex and Claude all read it. It posts **only when something changed**,
plus once an hour as a sign of life, so that 40 identical lines an hour do not
bury everyone else's events in the feed.

### E1. Save the script

Save this as `C:\AlphaData\alpha-ops\peer-report.ps1`, the same file on both
laptops:

```powershell
param([Parameter(Mandatory)][string]$Me, [Parameter(Mandatory)][string]$Peer)
# 3-minute fleet report (docs/HANDOFF_2026-10-05b_host-move.md, Part E).
Set-Location C:\services\alpha-tunnel
$env:ALPHA_ADMIN_TOKEN = [Environment]::GetEnvironmentVariable('ALPHA_REPORT_TOKEN', 'User')
$ops = 'C:\AlphaData\alpha-ops'
$log = Join-Path $ops 'peer-report.log'
$last = Join-Path $ops 'peer-report.last'
$raw = (node src/admin/run.js agents --json 2>$null) -join "`n"
$reachable = $LASTEXITCODE -eq 0
$agents = @()
# ForEach-Object unrolls the JSON array; Windows PowerShell 5.1 otherwise keeps it as one object.
if ($reachable) { try { $agents = @(($raw | ConvertFrom-Json) | ForEach-Object { $_ }) } catch { $reachable = $false } }
if (-not $reachable) {
  $summary = 'coordinator NOT answering'
} else {
  $state = foreach ($n in @($Me, $Peer)) {
    $a = $agents | Where-Object { $_.name -eq $n } | Select-Object -First 1
    if (-not $a) { "$n missing" } elseif ($a.stale) { "$n silent" } else { "$n ok" }
  }
  $summary = ($state -join ', ') + ", $($agents.Count) agents attached"
}
"$((Get-Date).ToString('s')) $summary" | Add-Content $log
$previous = if (Test-Path $last) { (Get-Content $last -Raw).Trim() } else { '' }
$age = if (Test-Path $last) { ((Get-Date) - (Get-Item $last).LastWriteTime).TotalMinutes } else { 999 }
if ($summary -ne $previous -or $age -ge 60) {
  node src/admin/run.js coord --action Post --actor $Me --message "$Me 3-min report: $summary" *> $null
  if ($LASTEXITCODE -eq 0) { Set-Content $last $summary } else { "  (could not post to the tunnel)" | Add-Content $log }
}
```

### E2. Run it every 3 minutes

**On the Host (laptop-gj8dfmlk):**

```powershell
$a = New-ScheduledTaskAction -Execute powershell.exe -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\AlphaData\alpha-ops\peer-report.ps1 -Me host -Peer worker1'
$t = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 3)
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName 'Alpha peer report' -Action $a -Trigger $t -Settings $s -Force
```

**On Worker1 (Laptop41):** run the same four lines with
`-Me worker1 -Peer host`.

If the Host runs no agent (B8 skipped), its report will say `host missing`.
That only means it lends no work. The coordinator answering is what that
line proves.

### E3. Read the reports

```powershell
Get-Content C:\AlphaData\alpha-ops\peer-report.log -Tail 20
```

For Claude on either laptop: `/loop 3m` with "read the last lines of
`C:\AlphaData\alpha-ops\peer-report.log` and the coordination tunnel
(`node src/admin/run.js coord --action Status --actor <me>`); if the other
laptop is missing, silent, or the coordinator is not answering, say so and
check it" keeps a session watching alongside the scheduled task. The scheduled
task is what keeps running when no session is open.

---

## What a cloud session can and cannot see

Cloud sessions still see only GitHub. `laptop41-doctor.ps1 -Watch` keeps
publishing `status/laptop41` from Worker1. Its admin commands go through
`run.js`, which reads `ALPHA_HOST_URL` from the `.env` that C2 points at the
Host.

The doctor's section 5 follows `ALPHA_HOST_URL` from Worker1's `.env`, so
after C2 it probes the Host, lists its agents, and flags a coordinator still
listening on Worker1 as a split fleet.

Neither laptop publishes the peer report to GitHub. The cloud reads it only
through the coordination events the doctor relays.

<#
.SYNOPSIS
  Worker1's half of the Alpha move (docs/HANDOFF_2026-10-07d_alpha-moves-to-host.md,
  Phase 2 steps 1 and 3): stop serving Alpha on this machine so the Host can,
  and -Undo to serve it here again.

.DESCRIPTION
  Only one Alpha may serve alpha-ai.uk at a time: two would write two
  histories, and two connectors on one Cloudflare tunnel split the traffic
  between them. So this stops everything that serves Alpha here, and
  everything that would start it again:

    1. role.json in -OpsDir says "standby", first, so the autopilot, the
       doctor and self-heal stop treating a stopped Alpha as an outage to fix;
    2. the watchers are disabled before anything is stopped, or they start it
       again within minutes: 'Alpha Self-Heal' and Alpha's own
       'Alpha Server - Health Guard';
    3. 'Alpha Backend' and 'Alpha' (the site) are stopped and disabled, and the
       wrapper trees and port holders on -BackendPort and -FrontendPort are
       stopped (node, python, pythonw, uvicorn, and the AlphaBoot wrappers;
       anything else on those ports is named and left alone);
    4. the connector: the cloudflared service is stopped and set to Manual,
       a scheduled task that runs cloudflared is disabled, and a cloudflared
       left running is stopped. A command line is never printed or saved:
       cloudflared takes --token on it.

  Tasks are disabled, never deleted, and every change is written to
  standdown\standdown-<time>.json, which -Undo reads back: it enables only what
  was enabled before and restores the service's start type.

  Alpha's own runtime (the Agent Manager, alpha_runtime_always_on.ps1,
  alpha_runtime_watchdog.ps1) is Alpha's to stop, through the Agent Manager.
  It is named here, never stopped; while it runs the result is exit 2.

  -Undo refuses while alpha-ai.uk answers and no connector runs here: then
  another machine serves it, and starting this one makes two (-Force overrides).

  The tunnel agent (worker1) keeps running either way: the work is shared.

  -ReportOnly prints what it would do and changes nothing.

  -Undo -StartConnector (what alpha-standby.mjs runs to cover automatically)
  starts the cloudflared service whatever the record says. Restoring exactly
  is right for a person standing up a machine they stood down; a machine
  covering for a primary that is down has to be reachable, and on Worker1 the
  service was Stopped while a connector started some other way served.

  Exit codes: 0 done; 1 something still serves Alpha here (named); 2 stood
  down, but Alpha's own runtime still runs here; 3 -Undo refused (another
  machine serves alpha-ai.uk).
#>
param(
  [string]$OpsDir = 'C:\AlphaData\alpha-ops',
  [string]$Primary = 'laptop-gj8dfmlk',
  [string]$PublicUrl = 'https://alpha-ai.uk/',
  [int]$BackendPort = 8001,
  [int]$FrontendPort = 4173,
  [string]$CloudflaredService = 'cloudflared',
  [int]$SettleSeconds = 20,
  [switch]$ReportOnly,
  [switch]$Undo,
  [switch]$Force,
  [switch]$StartConnector
)

$ErrorActionPreference = 'Continue'
function Say([string]$t) { Write-Output $t }

$watchers = @('Alpha Self-Heal', 'Alpha Server - Health Guard')
$servers = @('Alpha Backend', 'Alpha')
$killable = @('node', 'python', 'pythonw', 'uvicorn')
$alphaRuntime = 'alpha_agent_manager|alpha_runtime_always_on|alpha_runtime_watchdog'
$roleFile = Join-Path $OpsDir 'role.json'
$recordDir = Join-Path $OpsDir 'standdown'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Leaf([string]$name) { return ($name -replace '\.exe$', '') }

function Read-Procs { @(Get-CimInstance Win32_Process -EA SilentlyContinue) }

function Task-State([string]$name) {
  $t = Get-ScheduledTask -TaskName $name -EA SilentlyContinue
  if (-not $t) { return [ordered]@{ name = $name; present = $false; enabled = $false; state = 'absent' } }
  return [ordered]@{ name = $name; present = $true; enabled = ([string]$t.State -ne 'Disabled'); state = [string]$t.State }
}

# Tasks other than Alpha's own that start the connector: named, never their
# arguments (a token can be one of them).
function Connector-Tasks {
  @(Get-ScheduledTask -EA SilentlyContinue | Where-Object {
      $_.TaskName -notin ($watchers + $servers) -and
      @($_.Actions | Where-Object { "$($_.Execute) $($_.Arguments)" -match 'cloudflared' }).Count
    } | ForEach-Object { Task-State $_.TaskName })
}

function Port-Holders([int]$port, $procs) {
  @(Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue | ForEach-Object { $_.OwningProcess } | Select-Object -Unique |
    ForEach-Object {
      $id = $_
      $p = $procs | Where-Object { $_.ProcessId -eq $id } | Select-Object -First 1
      $parent = if ($p) { $procs | Where-Object { $_.ProcessId -eq $p.ParentProcessId } | Select-Object -First 1 }
      [ordered]@{ pid = $id; name = $(if ($p) { Leaf $p.Name } else { '?' }); parent = $(if ($parent) { Leaf $parent.Name } else { '?' }) }
    })
}

function Read-State {
  $procs = Read-Procs
  $svc = Get-Service -Name $CloudflaredService -EA SilentlyContinue
  $cf = @($procs | Where-Object { $_.Name -eq 'cloudflared.exe' } | ForEach-Object {
      $id = $_.ParentProcessId
      $parent = $procs | Where-Object { $_.ProcessId -eq $id } | Select-Object -First 1
      [ordered]@{ pid = $_.ProcessId; parent = $(if ($parent) { Leaf $parent.Name } else { '?' }) }
    })
  $runtime = @($procs | Where-Object { $_.CommandLine -and $_.CommandLine -match $alphaRuntime } | ForEach-Object {
      [regex]::Match($_.CommandLine, "($alphaRuntime)[A-Za-z_]*\.(ps1|py)").Value } | Where-Object { $_ } | Sort-Object -Unique)
  return [ordered]@{
    tasks = @(($watchers + $servers) | ForEach-Object { Task-State $_ })
    connectorTasks = @(Connector-Tasks)
    backend = @(Port-Holders $BackendPort $procs)
    site = @(Port-Holders $FrontendPort $procs)
    service = $(if ($svc) {
        # The service's own record: its last exit code says whether it fails
        # to start, and its command line whether it was installed with a token.
        # Only yes or no about the token is kept, never the line.
        $w = Get-CimInstance Win32_Service -Filter "Name='$CloudflaredService'" -EA SilentlyContinue | Select-Object -First 1
        [ordered]@{ present = $true; status = [string]$svc.Status; startType = [string]$svc.StartType
          exitCode = $(if ($w) { [int]$w.ExitCode } else { $null }); tokenInstall = $(if ($w) { [bool]("$($w.PathName)" -match '--token') } else { $null }) }
      } else { [ordered]@{ present = $false } })
    cloudflared = $cf
    runtime = $runtime
  }
}

function Public-Code {
  try { return [int](Invoke-WebRequest -Uri $PublicUrl -UseBasicParsing -TimeoutSec 10 -MaximumRedirection 0 -EA Stop).StatusCode }
  catch {
    $r = $_.Exception.Response
    if ($r -and $r.StatusCode) { return [int]$r.StatusCode }
    return 0
  }
}

function Show-State($s) {
  foreach ($t in @($s.tasks) + @($s.connectorTasks)) {
    Say ("  task {0,-30} {1}" -f $t.name, $(if (-not $t.present) { 'not on this machine' } elseif ($t.enabled) { "enabled, $($t.state)" } else { 'disabled' }))
  }
  foreach ($pair in @(@('backend', $BackendPort, $s.backend), @('site', $FrontendPort, $s.site))) {
    $h = @($pair[2])
    Say ("  {0,-8} :{1} {2}" -f $pair[0], $pair[1], $(if ($h.Count) { ($h | ForEach-Object { "$($_.name) $($_.pid) (parent $($_.parent))" }) -join '; ' } else { 'nothing listens' }))
  }
  if ($s.service.present) {
    Say ("  service  $CloudflaredService $($s.service.status), start $($s.service.startType)" +
      $(if ($null -ne $s.service.exitCode) { ", last exit code $($s.service.exitCode)" }) +
      $(if ($null -ne $s.service.tokenInstall) { ", --token on its command line $(if ($s.service.tokenInstall) { 'yes' } else { 'no' })" }))
  } else { Say "  service  $CloudflaredService not installed" }
  Say "  connector processes: $(if ($s.cloudflared.Count) { ($s.cloudflared | ForEach-Object { "cloudflared $($_.pid) (parent $($_.parent))" }) -join '; ' } else { 'none' })"
  Say "  Alpha's own runtime: $(if ($s.runtime.Count) { $s.runtime -join ', ' } else { 'none running' })"
}

function Kill-Tree([int]$id, [string]$what) {
  taskkill.exe /T /F /PID $id 2>&1 | Out-Null
  Say "  stopped $what"
}

# ------------------------------------------------------------------ undo
if ($Undo) {
  Say "ALPHA STAND-UP $env:COMPUTERNAME $(Get-Date -Format 'yyyy-MM-dd HH:mm')$(if ($ReportOnly) { ' (report only: nothing is changed)' })"
  $last = Get-ChildItem -LiteralPath $recordDir -Filter 'standdown-*.json' -EA SilentlyContinue | Sort-Object Name | Select-Object -Last 1
  $record = if ($last) { Get-Content -LiteralPath $last.FullName -Raw | ConvertFrom-Json } else { $null }
  Say $(if ($record) { "record: $($last.Name)" } else { 'no stand-down record here: every Alpha task present is enabled, and the service set to Automatic' })
  $now = Read-State
  Show-State $now
  $code = Public-Code
  if (-not $now.cloudflared.Count -and $code -ge 200 -and $code -lt 400 -and -not $Force) {
    Say "REFUSED: $PublicUrl answers $code and no connector runs here, so another machine serves Alpha. Standing up here would make two. Stop that one first, or pass -Force."
    exit 3
  }
  $wasEnabled = @{}
  if ($record) { foreach ($t in @($record.tasks) + @($record.connectorTasks)) { $wasEnabled[[string]$t.name] = [bool]$t.enabled } }
  $enable = { param($n) if ($wasEnabled.ContainsKey($n)) { $wasEnabled[$n] } else { $true } }
  if ($ReportOnly) {
    # From the state and the record just read, as the stand-down's WOULD is.
    # The fixed sentence this replaces named Alpha Backend and Alpha on a
    # machine that may have neither, and promised to "restore the connector"
    # where the record says it was not running and the real path below
    # deliberately leaves it stopped. This is the half that starts an Alpha,
    # and alpha-standby.mjs drives it unattended, so a rehearsal of it saying
    # nothing specific is the wrong half to leave vague.
    Say 'WOULD:'
    foreach ($n in $servers) {
      $t = Task-State $n
      if (-not $t.present) { Say "  not start '$n': no such task on this machine" }
      elseif (& $enable $n) { Say "  enable and start '$n'$(if ($t.enabled) { ' (already enabled)' })" }
      else { Say "  leave '$n' disabled: the record says it was disabled before the stand-down" }
    }
    if ($now.service.present) {
      $type = if ($record -and $record.service.present) { [string]$record.service.startType } else { 'Automatic' }
      $willStart = $StartConnector -or -not $record -or -not $record.service.present -or [string]$record.service.status -eq 'Running'
      Say "  set $($CloudflaredService) to start $type, and $(if ($willStart) { 'start it' } else { 'leave it stopped: it was not running before the stand-down' })"
    } else { Say "  nothing to restore for $($CloudflaredService): it is not installed here" }
    foreach ($t in @($now.connectorTasks)) {
      Say $(if ($wasEnabled[$t.name] -eq $true) { "  enable and start '$($t.name)', which starts cloudflared" } else { "  leave '$($t.name)' alone: no record that it was enabled here" })
    }
    foreach ($n in $watchers) {
      $t = Task-State $n
      if (-not $t.present) { continue }
      # Named either way: a watcher deliberately left off is the thing a
      # rehearsal most needs to say, because the real path is silent about it.
      Say $(if (& $enable $n) { "  enable '$n'" } else { "  leave '$n' disabled: the record says it was disabled before the stand-down" })
    }
    Say $(if (Test-Path -LiteralPath $roleFile) { '  set role.json aside: this machine serves Alpha again' } else { '  no role.json here to set aside: this machine is not marked standby' })
    exit 0
  }
  foreach ($n in $servers) {
    $t = Task-State $n
    if ($t.present -and (& $enable $n)) { Enable-ScheduledTask -TaskName $n -EA SilentlyContinue | Out-Null; Start-ScheduledTask -TaskName $n -EA SilentlyContinue; Say "  enabled and started '$n'" }
  }
  if ($now.service.present) {
    $type = if ($record -and $record.service.present) { [string]$record.service.startType } else { 'Automatic' }
    Set-Service -Name $CloudflaredService -StartupType $type -EA SilentlyContinue
    if ($StartConnector -or -not $record -or -not $record.service.present -or [string]$record.service.status -eq 'Running') {
      Start-Service -Name $CloudflaredService -EA SilentlyContinue; Say "  started $CloudflaredService (start $type)"
    } else { Say "  $CloudflaredService start type back to $type; it was not running before, so not started" }
  }
  if ($StartConnector) {
    $cfUp = $false
    foreach ($i in 1..6) { if (@((Read-Procs) | Where-Object { $_.Name -eq 'cloudflared.exe' }).Count) { $cfUp = $true; break }; Start-Sleep -Seconds 5 }
    Say $(if ($cfUp) { '  connector: cloudflared runs here' } else { "  CONNECTOR NOT RUNNING: $CloudflaredService did not start a cloudflared, so alpha-ai.uk stays down" })
  }
  # Only what the record says was on: with no record, a task that starts
  # cloudflared may be one somebody turned off on purpose.
  foreach ($t in @($now.connectorTasks)) {
    if ($wasEnabled[$t.name] -eq $true) { Enable-ScheduledTask -TaskName $t.name -EA SilentlyContinue | Out-Null; Start-ScheduledTask -TaskName $t.name -EA SilentlyContinue; Say "  enabled and started '$($t.name)'" }
  }
  foreach ($n in $watchers) {
    $t = Task-State $n
    if ($t.present -and (& $enable $n)) { Enable-ScheduledTask -TaskName $n -EA SilentlyContinue | Out-Null; Say "  enabled '$n'" }
  }
  if (Test-Path -LiteralPath $roleFile) {
    New-Item -ItemType Directory -Force -Path $recordDir | Out-Null
    Move-Item -LiteralPath $roleFile -Destination (Join-Path $recordDir "role-$stamp.json") -Force
    Say "  role.json set aside: this machine serves Alpha again"
  }
  $up = $false
  $deadline = (Get-Date).AddSeconds(120)
  while (-not $up -and (Get-Date) -lt $deadline) {
    try { $up = [int](Invoke-WebRequest -Uri "http://127.0.0.1:$BackendPort/health" -UseBasicParsing -TimeoutSec 5 -EA Stop).StatusCode -eq 200 } catch { }
    if (-not $up) { Start-Sleep -Seconds 5 }
  }
  Say $(if ($up) { "RESULT: Alpha serves here again (backend /health 200)" } else { "RESULT: the backend did not answer /health within 120 s: run the doctor" })
  exit $(if ($up) { 0 } else { 1 })
}

# ------------------------------------------------------------- stand down
Say "ALPHA STAND-DOWN $env:COMPUTERNAME -> $Primary $(Get-Date -Format 'yyyy-MM-dd HH:mm')$(if ($ReportOnly) { ' (report only: nothing is changed)' })"
$before = Read-State
Show-State $before
if ($ReportOnly) {
  Say 'WOULD:'
  Say "  write role.json: standby, primary $Primary"
  foreach ($t in @($before.tasks) + @($before.connectorTasks)) {
    if ($t.present -and $t.enabled) { Say $(if ($servers -contains $t.name) { "  stop and disable '$($t.name)'" } elseif ($watchers -contains $t.name) { "  disable '$($t.name)' (it would start Alpha again)" } else { "  disable '$($t.name)' (it starts cloudflared)" }) }
  }
  foreach ($h in @($before.backend) + @($before.site)) {
    Say $(if ($killable -contains $h.name) { "  stop $($h.name) $($h.pid) and its children" } else { "  leave $($h.name) $($h.pid) alone: not one of Alpha's (a person decides)" })
  }
  if ($before.service.present) { Say "  stop $CloudflaredService and set it to Manual" }
  foreach ($c in $before.cloudflared) { Say "  stop cloudflared $($c.pid)" }
  if ($before.runtime.Count) { Say "  NOT stop Alpha's own runtime ($($before.runtime -join ', ')): Alpha stops it through its Agent Manager" }
  Say "  alpha-ai.uk is then down until $Primary serves it"
  exit 0
}

New-Item -ItemType Directory -Force -Path $recordDir | Out-Null
[IO.File]::WriteAllText($roleFile, ([ordered]@{ role = 'standby'; primary = $Primary; since = (Get-Date).ToString('o'); by = 'alpha-standdown.ps1' } | ConvertTo-Json),
  (New-Object Text.UTF8Encoding $false))
Say "DONE:"
Say "  role.json: standby, primary $Primary"
$recordFile = Join-Path $recordDir "standdown-$stamp.json"
[IO.File]::WriteAllText($recordFile, ([ordered]@{ at = (Get-Date).ToString('o'); primary = $Primary; tasks = $before.tasks; connectorTasks = $before.connectorTasks; service = $before.service } | ConvertTo-Json -Depth 5),
  (New-Object Text.UTF8Encoding $false))

foreach ($n in $watchers) {
  $t = Task-State $n
  if ($t.present -and $t.enabled) { Disable-ScheduledTask -TaskName $n -EA SilentlyContinue | Out-Null; Say "  disabled '$n'" }
}
foreach ($n in $servers) {
  $t = Task-State $n
  if ($t.present) {
    Stop-ScheduledTask -TaskName $n -EA SilentlyContinue
    if ($t.enabled) { Disable-ScheduledTask -TaskName $n -EA SilentlyContinue | Out-Null }
    Say "  stopped and disabled '$n'"
  }
}
$procs = Read-Procs
foreach ($w in @($procs | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -match 'AlphaBoot' -and $_.CommandLine -match 'run-alpha' })) {
  Kill-Tree $w.ProcessId "the boot wrapper $($w.ProcessId) and its children"
}
$procs = Read-Procs
foreach ($port in @($BackendPort, $FrontendPort)) {
  foreach ($h in @(Port-Holders $port $procs)) {
    if ($killable -contains $h.name) { Kill-Tree $h.pid "$($h.name) $($h.pid) on $port, and its children" }
    else { Say "  LEFT $($h.name) $($h.pid) on ${port}: not one of Alpha's (a person decides)" }
  }
}
foreach ($t in @($before.connectorTasks)) {
  if ($t.enabled) { Stop-ScheduledTask -TaskName $t.name -EA SilentlyContinue; Disable-ScheduledTask -TaskName $t.name -EA SilentlyContinue | Out-Null; Say "  disabled '$($t.name)', which starts cloudflared" }
}
if ($before.service.present) {
  Stop-Service -Name $CloudflaredService -Force -EA SilentlyContinue
  Set-Service -Name $CloudflaredService -StartupType Manual -EA SilentlyContinue
  Say "  stopped $CloudflaredService, start Manual (was $($before.service.startType))"
}
foreach ($c in @((Read-State).cloudflared)) { Kill-Tree $c.pid "cloudflared $($c.pid) (started by $($c.parent))" }

# Whatever starts Alpha again on its own shows up here, by name.
Start-Sleep -Seconds $SettleSeconds
$after = Read-State
Say 'AFTER:'
Show-State $after
$still = @()
foreach ($h in @($after.backend) + @($after.site)) { $still += "$($h.name) $($h.pid) listens (started by $($h.parent))" }
foreach ($c in @($after.cloudflared)) { $still += "cloudflared $($c.pid) runs (started by $($c.parent))" }
foreach ($t in @($after.tasks) + @($after.connectorTasks)) { if ($t.present -and $t.enabled) { $still += "task '$($t.name)' is enabled" } }
$code = Public-Code
Say "  $PublicUrl answers $(if ($code) { $code } else { 'nothing' })$(if ($code -ge 200 -and $code -lt 400) { ": another machine serves it" } else { ": down until $Primary serves it" })"
Say "  record: $recordFile (-Undo reads it)"
if ($still.Count) {
  Say "RESULT: Alpha still serves here: $($still -join '; ')"
  exit 1
}
if ($after.runtime.Count) {
  Say "RESULT: stood down; Alpha's own runtime still runs here ($($after.runtime -join ', ')). Alpha stops it through its Agent Manager, before the Host's starts: only one manager at a time"
  exit 2
}
Say "RESULT: stood down. $Primary can serve Alpha now"
exit 0

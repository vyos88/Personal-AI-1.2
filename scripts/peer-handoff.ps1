<#
.SYNOPSIS
  Every 3 minutes, this laptop sends a handoff to the other one over the
  coordination tunnel and reads the other one's latest.

.DESCRIPTION
  Replaces the 'Alpha peer report' task (HANDOFF_2026-10-05b_host-move.md,
  Part E) with one that talks both ways. Each pass:

    1. checks the fleet as the peer report did: is the coordinator answering,
       are this laptop's and the peer's agents attached;
    2. reads the tunnel (Status, through worker1's alpha.coordination) and
       finds the peer's newest event;
    3. posts this laptop's handoff: its fleet line, and which of the peer's
       handoffs it read, so each side can see the other got through;
    4. writes one line to C:\AlphaData\alpha-ops\peer-handoff.log.

  Unlike the peer report it posts every pass, not only on change: the owner
  asked for a handoff every 3 minutes. That is 40 events an hour across both
  laptops in the tunnel's log.

  The peer's handoff counts as stale when it is older than 10 minutes, which
  is three missed passes, and the log line says so.

.EXAMPLE
  # Install, as the owner (not elevated), once per laptop:
  powershell -ExecutionPolicy Bypass -File scripts\peer-handoff.ps1 -Me host -Peer worker1 -Install
  powershell -ExecutionPolicy Bypass -File scripts\peer-handoff.ps1 -Me worker1 -Peer host -Install
#>
param(
  [Parameter(Mandatory)][string]$Me,
  [Parameter(Mandatory)][string]$Peer,
  [string]$OpsDir = 'C:\AlphaData\alpha-ops',
  [string]$TunnelAgent = 'worker1',
  [int]$StaleMinutes = 10,
  [switch]$Install,
  [switch]$Uninstall
)

$taskName = 'Alpha peer handoff'
$repo = Split-Path -Parent $PSScriptRoot

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "removed '$taskName'"
  exit 0
}

if ($Install) {
  $argLine = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -Me $Me -Peer $Peer -OpsDir `"$OpsDir`" -TunnelAgent $TunnelAgent"
  $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine -WorkingDirectory $repo
  $t = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 3)
  $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
         -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
  Register-ScheduledTask -TaskName $taskName -Action $a -Trigger $t -Settings $s -Force | Out-Null
  # The old one-way report posts the same fleet line; two tasks would post it twice.
  if (Get-ScheduledTask -TaskName 'Alpha peer report' -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName 'Alpha peer report' -Confirm:$false
    Write-Host "removed the old 'Alpha peer report' task (this one does its job)"
  }
  Start-ScheduledTask -TaskName $taskName
  Write-Host "installed '$taskName' as $Me (peer $Peer): every 3 minutes, log $OpsDir\peer-handoff.log" -ForegroundColor Green
  exit 0
}

# ------------------------------------------------------------ one pass
Set-Location $repo
$env:ALPHA_ADMIN_TOKEN = [Environment]::GetEnvironmentVariable('ALPHA_REPORT_TOKEN', 'User')
New-Item -ItemType Directory -Force -Path $OpsDir | Out-Null
$log = Join-Path $OpsDir 'peer-handoff.log'
$now = Get-Date

# 1. The fleet, as the peer report checked it.
$raw = (node src/admin/run.js agents --json 2>$null) -join "`n"
$reachable = $LASTEXITCODE -eq 0
$agents = @()
# ForEach-Object unrolls the JSON array; Windows PowerShell 5.1 otherwise keeps it as one object.
if ($reachable) { try { $agents = @(($raw | ConvertFrom-Json) | ForEach-Object { $_ }) } catch { $reachable = $false } }
if (-not $reachable) {
  "$($now.ToString('s')) coordinator NOT answering; no handoff sent or read" | Add-Content $log
  exit 1
}
$state = foreach ($n in @($Me, $Peer)) {
  $a = $agents | Where-Object { $_.name -eq $n } | Select-Object -First 1
  if (-not $a) { "$n missing" } elseif ($a.stale) { "$n silent" } else { "$n ok" }
}
$fleet = ($state -join ', ') + ", $($agents.Count) agents attached"

# 2. Read: the peer's newest event in the tunnel.
$read = 'could not read the tunnel'
$readShort = 'none read'
$statusRaw = (node src/admin/run.js coord --agent $TunnelAgent --action Status --actor $Me --json 2>$null) -join "`n"
if ($LASTEXITCODE -eq 0) {
  try {
    $task = $statusRaw | ConvertFrom-Json
    $out = [string]$task.result.stdout
    $start = $out.IndexOf('{')
    $snapshot = $out.Substring($start) | ConvertFrom-Json
    $events = @($snapshot.recent_events | ForEach-Object { $_ }) | Where-Object { $_.actor -eq $Peer }
    $latest = $events | Sort-Object { [datetime]$_.at } | Select-Object -Last 1
    if (-not $latest) {
      $read = "no event from $Peer in the tunnel's recent events"
    } else {
      $at = [datetime]$latest.at
      $age = [int]($now.ToUniversalTime() - $at.ToUniversalTime()).TotalMinutes
      $msg = [string]$latest.message
      if ($msg.Length -gt 160) { $msg = $msg.Substring(0, 160) + '...' }
      $stale = if ($age -gt $StaleMinutes) { " STALE (over $StaleMinutes min)" } else { '' }
      $read = "read $Peer, $age min old${stale}: $msg"
      $readShort = "read $Peer's $($at.ToUniversalTime().ToString('HH:mm'))Z handoff"
    }
  } catch {
    $read = "could not parse the tunnel's Status ($($_.Exception.Message))"
  }
}

# 3. Send: this laptop's handoff.
$sent = 'sent'
node src/admin/run.js coord --agent $TunnelAgent --action Post --actor $Me --message "$Me handoff: $fleet; $readShort" *> $null
if ($LASTEXITCODE -ne 0) { $sent = 'could NOT send' }

# 4. One line per pass.
"$($now.ToString('s')) $fleet | $sent | $read" | Add-Content $log

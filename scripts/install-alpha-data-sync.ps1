<#
.SYNOPSIS
  Runs Phase 3's data copy (alpha-data-sync.ps1) as its own scheduled task,
  'Alpha Data Copy', every -EveryMin minutes as SYSTEM, with hours to finish.

.DESCRIPTION
  The autopilot's standing dataSync check runs the copy inside its 5-minute
  pass, with a 15-minute limit. That is right for what changes in an hour, and
  wrong for a full copy. On 2026-10-09 the copy to alpha-serv-01 reached a run
  of files from 13 August, each 160-240 MB, sent one a part at about 400 KB/s.
  The next one was too big for 15 minutes, so every pass timed out. Each one
  held the autopilot pass and its live page for the whole 15 minutes, and left
  the killed pass's `tailscale file cp` running beside the next one.

  As its own task the copy has -TimeLimitHours, and nothing else waits on it:
    - one instance at a time (Task Scheduler's IgnoreNew, and the script's own
      lock);
    - its output goes to <OpsDir>\data-sync\task-last.log, overwritten by each
      run, and its exit code is the task's last result. The autopilot reports
      both when a run finishes;
    - once this task exists, the autopilot's standing check stops copying, so
      the two never copy at once.

  The script, and the rules it keeps, are unchanged: what it sends, the cap per
  part (-MaxBytes), newer wins, nothing deleted, nothing applied under a
  running Alpha.

  -PrintOnly prints the command the task would run and registers nothing (the
  tests use it). -Uninstall removes the task; the copy's state stays.
#>
param(
  [string]$OpsDir = 'C:\AlphaData\alpha-ops',
  [string]$AlphaRoot = 'C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software',
  [string]$Peer = '',
  [int]$EveryMin = 10,
  [int64]$MaxBytes = 104857600,
  [int]$TimeLimitHours = 4,
  [string]$TaskName = 'Alpha Data Copy',
  [switch]$PrintOnly,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Continue'
function Say([string]$t) { Write-Output $t }

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -EA SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; Say "removed task '$TaskName' (the copy's state in $OpsDir\data-sync is kept)" }
  else { Say "no task '$TaskName' here" }
  exit 0
}

if ($Peer -notmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,62}$') { Say 'REFUSED: -Peer must be a machine name'; exit 1 }
if ($EveryMin -lt 5 -or $EveryMin -gt 1440) { Say 'REFUSED: -EveryMin must be 5 to 1440'; exit 1 }
if ($TimeLimitHours -lt 1 -or $TimeLimitHours -gt 24) { Say 'REFUSED: -TimeLimitHours must be 1 to 24'; exit 1 }
if ($MaxBytes -lt 1048576) { Say 'REFUSED: -MaxBytes must be at least 1 MB'; exit 1 }
foreach ($pair in @(@('OpsDir', $OpsDir), @('AlphaRoot', $AlphaRoot))) {
  # They are quoted into a cmd.exe line: nothing there may end the quote.
  if ($pair[1] -match '["%^&|<>]') { Say "REFUSED: -$($pair[0]) holds a character cmd.exe would read"; exit 1 }
}

$script = Join-Path $PSScriptRoot 'alpha-data-sync.ps1'
# Windows paths for a Windows command line, built as text: Join-Path wants
# the drive to exist on the machine that runs it.
$log = $OpsDir.TrimEnd('\', '/') + '\data-sync\task-last.log'
$ps = if ($env:SystemRoot) { "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" } else { 'powershell.exe' }
# cmd.exe so the output lands in a file: Task Scheduler keeps no output. The
# outer quotes are the ones cmd /c strips.
$line = "`"`"$ps`" -NoProfile -ExecutionPolicy Bypass -File `"$script`" -OpsDir `"$OpsDir`" -AlphaRoot `"$AlphaRoot`" -Peer $Peer -MaxBytes $MaxBytes > `"$log`" 2>&1`""
if ($PrintOnly) { Say "cmd.exe /c $line"; exit 0 }

New-Item -ItemType Directory -Force -Path (Join-Path $OpsDir 'data-sync') | Out-Null
$every = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $EveryMin)
$boot = New-ScheduledTaskTrigger -AtStartup; $boot.Delay = 'PT5M'
Register-ScheduledTask -TaskName $TaskName -Force `
  -Action (New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c $line" -WorkingDirectory (Split-Path -Parent $PSScriptRoot)) `
  -Trigger @($every, $boot) `
  -Principal (New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest) `
  -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours $TimeLimitHours) -StartWhenAvailable -AllowStartIfOnBatteries `
             -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew) `
  -Description "Phase 3: copy what changed in Alpha's memory\ to $Peer over Taildrop, and apply what it sent (alpha-data-sync.ps1)" | Out-Null
Say "task '$TaskName' copies to $Peer every $EveryMin minutes and at startup, as SYSTEM, up to $TimeLimitHours h a run"
Say "its output: $log (each run replaces it); the autopilot's standing check no longer copies while this task exists"
exit 0

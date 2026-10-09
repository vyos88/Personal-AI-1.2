<#
.SYNOPSIS
  Installs Phase 3's automatic cover on the standby machine: alpha-standby.mjs
  every minute, as SYSTEM, so it works with nobody signed in.

.DESCRIPTION
  Writes standby.json in -OpsDir (atomically) and registers the scheduled task
  -TaskName to run `node scripts\alpha-standby.mjs --config <it>` every minute
  and at startup.

  It is safe to install on a machine that still serves Alpha: alpha-standby.mjs
  acts only while role.json says "standby" or "covering", which
  alpha-standdown.ps1 writes. Until the switch-over, every pass reads "this
  machine is the primary: nothing to cover". From then on it is armed by
  itself.

  -PrimaryUrl must be the primary's Alpha health over the tailnet, the one
  address both machines can reach without the public route. On the Host that
  answers only once its backend binds its tailnet address (fix-panel-host
  adds it); the doctor on a standby says when it does not, because a standby
  that cannot see the primary does not cover, and it does not hand back.

  -ConfigOnly writes standby.json and registers nothing (the tests use it).
  -Uninstall removes the task and leaves standby.json.
#>
param(
  [string]$OpsDir = 'C:\AlphaData\alpha-ops',
  [string]$AlphaRoot = 'C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software',
  [string]$Primary = 'laptop-gj8dfmlk',
  [string]$PrimaryUrl = 'http://100.93.104.24:8001/health',
  [string]$PublicUrl = 'https://alpha-ai.uk/',
  [string]$ControlUrl = 'https://www.cloudflare.com/cdn-cgi/trace',
  [string]$TaskName = 'Alpha Standby',
  [switch]$ConfigOnly,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Continue'
function Say([string]$t) { Write-Output $t }
$tunnel = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script = Join-Path $PSScriptRoot 'alpha-standby.mjs'
$config = Join-Path $OpsDir 'standby.json'

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -EA SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; Say "removed task '$TaskName' ($config kept)" }
  else { Say "no task '$TaskName' here" }
  exit 0
}

foreach ($pair in @(@('PrimaryUrl', $PrimaryUrl), @('PublicUrl', $PublicUrl), @('ControlUrl', $ControlUrl))) {
  if ($pair[1] -notmatch '^https?://[A-Za-z0-9.-]+(:\d{1,5})?(/[A-Za-z0-9._/-]*)?$') { Say "REFUSED: -$($pair[0]) is not a plain http(s) URL"; exit 1 }
}
if ($Primary -notmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,62}$') { Say 'REFUSED: -Primary must be a machine name'; exit 1 }

# memory\ sits beside software\: what the hand-back counts as written here.
$alphaHome = $AlphaRoot -replace '[\\/][^\\/]+[\\/]?$', ''
$body = [ordered]@{
  stateDir   = (Join-Path $OpsDir 'standby')
  primary    = $Primary
  primaryUrl = $PrimaryUrl
  publicUrl  = $PublicUrl
  controlUrl = $ControlUrl
  localUrl   = 'http://127.0.0.1:8001/health'
  memoryDir  = "$alphaHome\memory"
}
New-Item -ItemType Directory -Force -Path $OpsDir | Out-Null
[IO.File]::WriteAllText("$config.tmp", ($body | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
Move-Item -LiteralPath "$config.tmp" -Destination $config -Force
Say "wrote $config (primary $Primary at $PrimaryUrl)"
if ($ConfigOnly) { exit 0 }

$node = (Get-Command node.exe -EA SilentlyContinue).Source
if (-not $node) { Say 'NOT DONE: node.exe is not on PATH'; exit 1 }
$every = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$boot = New-ScheduledTaskTrigger -AtStartup; $boot.Delay = 'PT2M'
Register-ScheduledTask -TaskName $TaskName -Force `
  -Action (New-ScheduledTaskAction -Execute $node -Argument "`"$script`" --config `"$config`"" -WorkingDirectory $tunnel) `
  -Trigger @($every, $boot) `
  -Principal (New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest) `
  -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable -AllowStartIfOnBatteries `
             -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew) `
  -Description 'Phase 3: cover for the primary while its Alpha is down, hand back when it answers (alpha-standby.mjs)' | Out-Null
Say "task '$TaskName' runs every minute and at startup, as SYSTEM"
$status = & $node $script --config $config --status 2>&1 | Out-String
Say $status.Trim()
exit 0

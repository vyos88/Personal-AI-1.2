<#
  install-watch-task.ps1 — put the watchdog on a timer on this machine.

      powershell -ExecutionPolicy Bypass -File .\scripts\install-watch-task.ps1 `
        -PanelKey <key id> -Minutes 30

  One scheduled task, running one pass of scripts/watchdog.mjs: is this machine
  still attached to the coordinator, and — with -PanelKey — is the CrowPanel
  still reading it. Every run appends one JSON line to watchdog.log beside the
  checkout, which is the record that survives the week nobody is watching.

  It installs nothing else and starts no long-running process. The keeper
  (keep-agent.mjs) owns the agent; this only ever *asks* and writes down the
  answer, so it is safe to schedule beside one — which is why -NoUpdate is the
  default. Pass -Update to let the scheduled pass fast-forward the checkout as
  well, on a machine with no keeper.

  Paths are derived from this script's location, so there is nothing to edit.
  Re-running it replaces the task rather than adding a second one.
#>

[CmdletBinding()]
param(
  # Which credential the panel polls /stats with. `alpha-admin keys` prints the
  # id. Omit it on a machine with no panel and the panel step is simply absent.
  [string] $PanelKey,

  # This machine's agent name, as the host knows it.
  [string] $Name = $env:ALPHA_AGENT_NAME,

  [int] $Minutes = 30,

  [string] $TaskName = 'alpha-tunnel watch',

  # Let the scheduled pass update the checkout too. Off by default: beside
  # keep-agent.mjs that would be two things pulling and restarting one worker.
  [switch] $Update,

  # Print the schtasks command instead of running it.
  [switch] $WhatIfOnly
)

$ErrorActionPreference = 'Stop'

$here = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$root = Split-Path -Parent $here
$watchdog = Join-Path $here 'watchdog.mjs'
if (-not (Test-Path $watchdog)) { throw "watchdog.mjs not found at $watchdog" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node is not on PATH. Install Node >= 20, or open a shell that has it.' }

if (-not $Name) { $Name = $env:COMPUTERNAME }
if ($Minutes -lt 1 -or $Minutes -gt 1439) { throw "-Minutes must be between 1 and 1439 (got $Minutes)" }

$log = Join-Path $root 'watchdog.log'

# Built as an argument list, never as one interpolated string: a path with a
# space in it is the normal case on Windows, and this is the file that would
# otherwise silently schedule half a command.
$arguments = @($watchdog)
if (-not $Update) { $arguments += '--no-update' }
$arguments += @('--name', $Name, '--log', $log)
if ($PanelKey) { $arguments += @('--panel-key', $PanelKey) }

$quoted = ($arguments | ForEach-Object { if ($_ -match '\s') { '\"' + $_ + '\"' } else { $_ } }) -join ' '
$command = '"' + $node + '" ' + $quoted

Write-Host "task     : $TaskName"
Write-Host "every    : $Minutes minute(s)"
Write-Host "runs     : $command"
Write-Host "receipts : $log"

if ($WhatIfOnly) {
  Write-Host ''
  Write-Host "schtasks /Create /TN `"$TaskName`" /SC MINUTE /MO $Minutes /TR `"$command`" /F"
  return
}

# /F replaces an existing task of the same name. Scheduling a second copy of a
# check is how a machine ends up with two answers and no idea which is current.
$result = schtasks /Create /TN $TaskName /SC MINUTE /MO $Minutes /TR $command /F 2>&1
$code = $LASTEXITCODE
$result | ForEach-Object { Write-Host $_ }
if ($code -ne 0) { throw "schtasks exited $code" }

Write-Host ''
Write-Host 'Installed. One pass now, to prove it works:'
Write-Host "  schtasks /Run /TN `"$TaskName`""
Write-Host "  Get-Content `"$log`" -Tail 1"

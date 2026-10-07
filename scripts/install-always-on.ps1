<#
  install-always-on.ps1 - leave this laptop working, across reboots.

      powershell -ExecutionPolicy Bypass -File .\scripts\install-always-on.ps1 `
        -AlphaRoot C:\alpha -CloudflareTunnel alpha-home

  To stand by for Alpha running on *another* machine -- the case the fleet
  actually has, one laptop serving Alpha and one running the coordinator --
  name what to watch and what proves this machine took over:

      ... -AlphaRoot C:\Users\Vyo\Downloads\VyoS-advance-tech-ai `
          -ProbeUrl http://100.69.243.25:8001/health `
          -LocalUrl http://127.0.0.1:8001/health `
          -ControlUrl https://github.com -CloudflareTunnel alpha-home

  Two scheduled tasks, both running at logon and both restarted if they stop:

    alpha-tunnel agent    keep-agent.mjs - takes work from the host, keeps
                          itself on the current release, and stops for good
                          only when another process on this machine has taken
                          over its registration
    alpha-tunnel standby  standby-alpha.mjs - runs Alpha here while the main
                          host is not answering, with the public tunnel beside
                          it, and hands back when the host returns

  Neither is installed twice: re-running replaces the task. -WhatIfOnly prints
  what would be registered instead of registering it.

  The standby half is skipped without -AlphaRoot: a machine that only lends
  capacity does not need it, and a half-configured failover is worse than none.
#>

[CmdletBinding()]
param(
  # Where Alpha lives on this machine. Omit to install only the agent keeper.
  [string] $AlphaRoot,

  # The npm script that starts Alpha, from that root's package.json.
  [string] $AlphaScript = 'dev',

  # What "the host is down" means on this machine: the URL the standby probes.
  # It matters most on the machine that runs the coordinator. standby-alpha.mjs
  # defaults this to ALPHA_HOST_URL/healthz -- the coordinator -- and on the
  # coordinator's own machine that answers from loopback for ever, so a standby
  # installed there never promotes and the failover silently does not exist.
  # To stand by for Alpha, point this at Alpha: http://<alpha machine>:8001/health
  [string] $ProbeUrl,

  # This machine's own health URL for what the standby starts, so a promotion
  # that started nothing is reported rather than counted as serving. Alpha's
  # backend answers http://127.0.0.1:8001/health.
  [string] $LocalUrl,

  # The named Cloudflare tunnel to run while this machine is serving. Named
  # only - cloudflared also takes --token, and an argv is readable by every
  # process on the box.
  [string] $CloudflareTunnel,

  # Something that is up whenever this laptop's network is: the router will do.
  # Without it, a dropped link looks exactly like a host that is down, and this
  # machine promotes itself into a second live Alpha.
  [string] $ControlUrl,

  [switch] $WhatIfOnly
)

$ErrorActionPreference = 'Stop'

$here = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$root = Split-Path -Parent $here

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node is not on PATH. Install Node >= 20, or open a shell that has it.' }

function Quote([string[]] $arguments) {
  ($arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
}

function Install([string] $name, [string[]] $arguments) {
  $argumentLine = Quote $arguments
  Write-Host ''
  Write-Host "task  : $name"
  Write-Host "runs  : `"$node`" $argumentLine"

  if ($WhatIfOnly) {
    Write-Host "Register-ScheduledTask -TaskName `"$name`" (at logon of $env:USERNAME, limited rights)"
    return
  }

  # The task is built with the ScheduledTasks cmdlets, not schtasks /TR. Node's
  # usual home is C:\Program Files\nodejs, and Windows PowerShell 5.1 hands a
  # /TR value holding quoted paths with spaces to schtasks mangled ("Invalid
  # argument/option - 'Files\nodejs\node.exe ...'"), so the task was never
  # created. Execute and Argument are separate fields here; nothing is
  # re-parsed.
  #
  # At logon rather than at startup: these run as this user, with this user's
  # network and this user's Tailscale, and a task that starts before either is
  # a task that fails quietly every boot.
  $action = New-ScheduledTaskAction -Execute $node -Argument $argumentLine -WorkingDirectory $root
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  # No task-level restart: keep-agent already restarts the agent, and it exits
  # on purpose when another agent on this machine has taken over.
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Write-Host "registered: $name"
}

# --- the agent: this laptop taking work from the host ----------------------
Install 'alpha-tunnel agent' @((Join-Path $here 'keep-agent.mjs'))

# --- the standby: Alpha here while the host is off -------------------------
if ($AlphaRoot) {
  if (-not (Test-Path $AlphaRoot)) { throw "no such directory: $AlphaRoot" }

  $standby = @((Join-Path $here 'standby-alpha.mjs'), '--root', $AlphaRoot, '--npm-script', $AlphaScript)
  if ($CloudflareTunnel) { $standby += @('--cloudflared', $CloudflareTunnel) }
  if ($ProbeUrl) { $standby += @('--probe-url', $ProbeUrl) }
  if ($LocalUrl) { $standby += @('--local-url', $LocalUrl) }
  if ($ControlUrl) { $standby += @('--control-url', $ControlUrl) }
  else {
    Write-Host ''
    Write-Host 'note  : no -ControlUrl. This machine cannot tell "the host is down" from'
    Write-Host '        "I cannot reach the host", so a dropped link will promote it.'
  }

  if (-not $ProbeUrl) {
    # Worth checking here rather than leaving it to be discovered by a failover
    # that did not happen: the default probe is the coordinator, and on the
    # machine that runs the coordinator that is a health check against itself.
    $coordinatorHere = $false
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
      $port = if ($env:ALPHA_HOST_PORT) { [int] $env:ALPHA_HOST_PORT } else { 8787 }
      $coordinatorHere = [bool] (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    }
    Write-Host ''
    Write-Host 'note  : no -ProbeUrl, so the standby watches the coordinator (ALPHA_HOST_URL/healthz).'
    if ($coordinatorHere) {
      Write-Host '        THIS MACHINE IS LISTENING ON THE COORDINATOR PORT, so that probe answers'
      Write-Host '        from loopback whatever happens elsewhere and this standby will never'
      Write-Host '        promote. To stand by for Alpha, pass'
      Write-Host '          -ProbeUrl http://<the machine running Alpha>:8001/health'
    } else {
      Write-Host '        To stand by for Alpha rather than for the coordinator, pass'
      Write-Host '          -ProbeUrl http://<the machine running Alpha>:8001/health'
    }
  }

  Install 'alpha-tunnel standby' $standby
} else {
  Write-Host ''
  Write-Host 'note  : no -AlphaRoot, so no standby was installed. This machine lends'
  Write-Host '        capacity only.'
}

if (-not $WhatIfOnly) {
  Write-Host ''
  Write-Host 'Installed. Start them now rather than waiting for the next logon:'
  Write-Host "  Start-ScheduledTask -TaskName 'alpha-tunnel agent'"
  if ($AlphaRoot) { Write-Host "  Start-ScheduledTask -TaskName 'alpha-tunnel standby'" }
  Write-Host ''
  Write-Host 'And prove the agent is attached, from the host rather than by eye:'
  Write-Host '  node scripts\watchdog.mjs --no-update --json'
}

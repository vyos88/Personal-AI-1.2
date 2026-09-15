<#
  install-always-on.ps1 — leave this laptop working, across reboots.

      powershell -ExecutionPolicy Bypass -File .\scripts\install-always-on.ps1 `
        -AlphaRoot C:\alpha -CloudflareTunnel alpha-home

  Two scheduled tasks, both running at logon and both restarted if they stop:

    alpha-tunnel agent    keep-agent.mjs — takes work from the host, keeps
                          itself on the current release, and stops for good
                          only when another process on this machine has taken
                          over its registration
    alpha-tunnel standby  standby-alpha.mjs — runs Alpha here while the main
                          host is not answering, with the public tunnel beside
                          it, and hands back when the host returns

  Neither is installed twice: re-running replaces the task. -WhatIfOnly prints
  the schtasks lines instead of running them.

  The standby half is skipped without -AlphaRoot: a machine that only lends
  capacity does not need it, and a half-configured failover is worse than none.
#>

[CmdletBinding()]
param(
  # Where Alpha lives on this machine. Omit to install only the agent keeper.
  [string] $AlphaRoot,

  # The npm script that starts Alpha, from that root's package.json.
  [string] $AlphaScript = 'dev',

  # The named Cloudflare tunnel to run while this machine is serving. Named
  # only — cloudflared also takes --token, and an argv is readable by every
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
  ($arguments | ForEach-Object { if ($_ -match '\s') { '\"' + $_ + '\"' } else { $_ } }) -join ' '
}

function Install([string] $name, [string[]] $arguments) {
  $command = '"' + $node + '" ' + (Quote $arguments)
  Write-Host ''
  Write-Host "task  : $name"
  Write-Host "runs  : $command"

  if ($WhatIfOnly) {
    Write-Host "schtasks /Create /TN `"$name`" /SC ONLOGON /RL LIMITED /TR `"$command`" /F"
    return
  }

  # ONLOGON rather than ONSTART: these run as this user, with this user's
  # network and this user's Tailscale, and a task that starts before either is
  # a task that fails quietly every boot.
  $result = schtasks /Create /TN $name /SC ONLOGON /RL LIMITED /TR $command /F 2>&1
  $code = $LASTEXITCODE
  $result | ForEach-Object { Write-Host $_ }
  if ($code -ne 0) { throw "schtasks exited $code" }
}

# --- the agent: this laptop taking work from the host ----------------------
Install 'alpha-tunnel agent' @((Join-Path $here 'keep-agent.mjs'))

# --- the standby: Alpha here while the host is off -------------------------
if ($AlphaRoot) {
  if (-not (Test-Path $AlphaRoot)) { throw "no such directory: $AlphaRoot" }

  $standby = @((Join-Path $here 'standby-alpha.mjs'), '--root', $AlphaRoot, '--npm-script', $AlphaScript)
  if ($CloudflareTunnel) { $standby += @('--cloudflared', $CloudflareTunnel) }
  if ($ControlUrl) { $standby += @('--control-url', $ControlUrl) }
  else {
    Write-Host ''
    Write-Host 'note  : no -ControlUrl. This machine cannot tell "the host is down" from'
    Write-Host '        "I cannot reach the host", so a dropped link will promote it.'
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
  Write-Host '  schtasks /Run /TN "alpha-tunnel agent"'
  if ($AlphaRoot) { Write-Host '  schtasks /Run /TN "alpha-tunnel standby"' }
  Write-Host ''
  Write-Host 'And prove the agent is attached, from the host rather than by eye:'
  Write-Host '  node scripts\watchdog.mjs --no-update --json'
}

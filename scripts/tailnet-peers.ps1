<#
.SYNOPSIS
  The machines on this tailnet, as this machine sees them: name, tailnet
  address, OS, and whether each is online. Read-only.

.DESCRIPTION
  A new machine joins the fleet by joining the tailnet (alpha-server-01,
  2026-10-09). Its name and address are what every other setting points at:
  standby.json's primaryUrl, the data copy's peer, an agent's ALPHA_HOST_URL.
  A cloud session cannot see the tailnet, so this answers from a laptop.

  It reads `tailscale status --json` and prints only the machine fields. The
  accounts behind the machines (login names, which are e-mail addresses) are
  never read into the output: this report goes to a git branch.

  -StatusJson is the test seam: a file of `tailscale status --json` output.
#>
param(
  [string]$StatusJson = ''
)

$ErrorActionPreference = 'Continue'
$raw = ''
if ($StatusJson) { $raw = Get-Content -LiteralPath $StatusJson -Raw }
else {
  try { $raw = (& tailscale status --json 2>&1) -join "`n" }
  catch { Write-Output "NOT READ: tailscale is not on PATH here ($($_.Exception.Message))"; exit 1 }
}
try { $s = $raw | ConvertFrom-Json } catch { Write-Output 'NOT READ: tailscale status --json did not answer with JSON'; exit 1 }

function Row($n, [string]$who) {
  $v4 = @($n.TailscaleIPs | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' }) -join ','
  $dns = ([string]$n.DNSName).TrimEnd('.')
  $name = if ($dns) { ($dns -split '\.')[0] } else { [string]$n.HostName }
  $seen = if ($n.Online) { 'online' } elseif ($n.LastSeen -and "$($n.LastSeen)" -notmatch '^0001') { "offline, last seen $($n.LastSeen)" } else { 'offline' }
  '{0,-6} {1,-28} {2,-16} {3,-9} {4}' -f $who, $name, $v4, [string]$n.OS, $seen
}

Write-Output ('TAILNET PEERS seen from {0} at {1}' -f $(if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { [Environment]::MachineName }), (Get-Date).ToString('yyyy-MM-dd HH:mm'))
if ($s.BackendState -and $s.BackendState -ne 'Running') { Write-Output "  tailscale here is $($s.BackendState)" }
Write-Output ('{0,-6} {1,-28} {2,-16} {3,-9} {4}' -f '', 'NAME', 'TAILNET IPv4', 'OS', 'STATE')
if ($s.Self) { Write-Output (Row $s.Self 'self') }
$peers = @()
if ($s.Peer) { $peers = @($s.Peer.PSObject.Properties | ForEach-Object { $_.Value }) }
foreach ($p in ($peers | Sort-Object { -not $_.Online }, { [string]$_.DNSName })) { Write-Output (Row $p 'peer') }
Write-Output "$($peers.Count) peer(s), $(@($peers | Where-Object { $_.Online }).Count) online"
exit 0

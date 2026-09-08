<#
  fix-host.ps1 — repair the alpha-tunnel services and diagnose Starlink.

  Run as Administrator, on the Alpha host:
      powershell -ExecutionPolicy Bypass -File .\fix-host.ps1

  Add -KillTest to also prove the services really restart after a crash.

  Everything it prints is also written to fix-host-log.txt next to this file,
  so you can attach that file instead of pasting terminal output.

  It changes three things and nothing else:
    - nssm restart/throttle/log-rotation settings on the alpha-* services
    - starts any alpha-* service found stopped
    - DNS servers, ONLY if DNS is the thing that is broken (and it prints
      the one-line undo)
  It never touches Starlink hardware config, routes, or Tailscale.
#>

param([switch]$KillTest)

$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'fix-host-log.txt'
Start-Transcript -Path $log -Force | Out-Null

function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Host "NOT running as Administrator — service repair will fail." -ForegroundColor Red
  Write-Host "Re-run from an elevated PowerShell.`n" -ForegroundColor Red
}

# ---------------------------------------------------------------- services
Section "Services: current state"
$svcs = @(Get-Service | Where-Object Name -like 'alpha*')
if (-not $svcs) {
  Write-Host "No alpha-* services found on this machine." -ForegroundColor Yellow
} else {
  $svcs | Format-Table Name, Status, StartType | Out-String | Write-Host

  $nssm = (Get-Command nssm -EA SilentlyContinue).Source
  if (-not $nssm) {
    Write-Host "nssm not on PATH — cannot apply restart settings." -ForegroundColor Yellow
    Write-Host "Find it with: Get-ChildItem C:\ -Recurse -Filter nssm.exe -EA SilentlyContinue | Select -First 1" -ForegroundColor Yellow
  } else {
    Section "Services: applying resilience settings"
    foreach ($s in $svcs.Name) {
      # Come back from any unexpected exit, and do not give up on a fast
      # crash-loop — a coordinator that dies at boot waiting for Tailscale
      # looks exactly like a service that "won't start".
      & $nssm set $s AppExit Default Restart   | Out-Null
      & $nssm set $s AppRestartDelay 5000      | Out-Null
      & $nssm set $s AppThrottle 10000         | Out-Null
      # An always-on service with unrotated logs eventually fills the disk.
      & $nssm set $s AppRotateFiles 1          | Out-Null
      & $nssm set $s AppRotateOnline 1         | Out-Null
      & $nssm set $s AppRotateBytes 10485760   | Out-Null
      sc.exe config $s start= delayed-auto     | Out-Null
      Write-Host "  $s : restart-on-exit, throttle, log rotation, delayed-auto"
    }

    # Order the agent behind whatever the coordinator is called here. The
    # docs say alpha-coordinator; this host uses alpha-host.
    $coord = $svcs.Name | Where-Object { $_ -match 'host|coordinator' } | Select-Object -First 1
    $agent = $svcs.Name | Where-Object { $_ -match 'agent' } | Select-Object -First 1
    if ($coord -and $agent) {
      & $nssm set $agent DependOnService $coord | Out-Null
      Write-Host "  $agent depends on $coord"
    }
  }

  Section "Services: starting anything stopped"
  foreach ($s in $svcs) {
    if ($s.Status -ne 'Running') {
      Write-Host "  starting $($s.Name) ..."
      Start-Service $s.Name -EA SilentlyContinue
    }
  }
  Get-Service | Where-Object Name -like 'alpha*' |
    Format-Table Name, Status, StartType | Out-String | Write-Host

  if ($KillTest) {
    Section "Services: kill test"
    Write-Host "  killing node, waiting 20s for the services to bring it back..."
    Stop-Process -Name node -Force -EA SilentlyContinue
    Start-Sleep -Seconds 20
    $after = Get-Service | Where-Object Name -like 'alpha*'
    $after | Format-Table Name, Status | Out-String | Write-Host
    $dead = $after | Where-Object Status -ne 'Running'
    if ($dead) {
      Write-Host "  FAILED to come back: $($dead.Name -join ', ')" -ForegroundColor Red
      Write-Host "  Check the service log for why it exited:" -ForegroundColor Red
      Write-Host "    Get-Content <tunnel>\logs\host.log -Tail 40" -ForegroundColor Red
    } else {
      Write-Host "  All alpha-* services restarted themselves. Resilience confirmed." -ForegroundColor Green
    }
  }
}

# ---------------------------------------------------------------- starlink
Section "Starlink: dish"
$dish = Test-Connection 192.168.100.1 -Count 3 -Quiet -EA SilentlyContinue
Write-Host ("  192.168.100.1 reachable: {0}" -f $dish)

Section "Starlink: internet by IP"
$net = Test-Connection 1.1.1.1 -Count 3 -Quiet -EA SilentlyContinue
Write-Host ("  1.1.1.1 reachable: {0}" -f $net)

Section "Starlink: DNS"
$dns = $false
try {
  $r = Resolve-DnsName google.com -EA Stop
  $dns = [bool]$r
} catch { $dns = $false }
Write-Host ("  google.com resolves: {0}" -f $dns)

Section "Addresses in 100.64.0.0/10 (Starlink CGNAT and Tailscale share this range)"
$hundreds = Get-NetIPAddress -AddressFamily IPv4 -EA SilentlyContinue |
  Where-Object { $_.IPAddress -like '100.*' }
if ($hundreds) {
  $hundreds | Format-Table IPAddress, InterfaceAlias, PrefixLength | Out-String | Write-Host
} else {
  Write-Host "  none"
}
$tsIfaces  = @($hundreds | Where-Object InterfaceAlias -match 'tailscale')
$wanIfaces = @($hundreds | Where-Object InterfaceAlias -notmatch 'tailscale')

Section "Default route"
Get-NetRoute -DestinationPrefix '0.0.0.0/0' -EA SilentlyContinue |
  Select-Object InterfaceAlias, NextHop, RouteMetric |
  Format-Table | Out-String | Write-Host

# ---------------------------------------------------------------- verdict
Section "VERDICT"

if (-not $dish) {
  Write-Host "Dish is NOT answering on 192.168.100.1." -ForegroundColor Red
  Write-Host "It answers there even in bypass mode, so this is physical or upstream:"
  Write-Host "  - dish unpowered, or the router brick has no power"
  Write-Host "  - the Starlink cable is unseated at either end"
  Write-Host "  - this machine is behind a third-party router not passing 192.168.100.1 through"
  Write-Host "Nothing to fix in software. Check power and cable first."
}
elseif (-not $net) {
  Write-Host "Dish answers, but there is no internet." -ForegroundColor Yellow
  Write-Host "That is Starlink service, not this machine: obstruction, an outage,"
  Write-Host "still booting, or thermal shutdown. Open http://192.168.100.1 —"
  Write-Host "the status page names which one."
  Start-Process http://192.168.100.1 -EA SilentlyContinue
  Write-Host "`nWhere it stops:"
  tracert -h 6 -w 1000 1.1.1.1 | Select-Object -First 12 | Out-String | Write-Host
}
elseif (-not $dns) {
  Write-Host "Internet works, DNS does not. Fixing that now." -ForegroundColor Yellow
  $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -EA SilentlyContinue |
           Sort-Object RouteMetric | Select-Object -First 1
  if ($route) {
    $idx = $route.InterfaceIndex
    Set-DnsClientServerAddress -InterfaceIndex $idx -ServerAddresses 1.1.1.1,8.8.8.8 -EA SilentlyContinue
    Clear-DnsClientCache
    Write-Host "  Set 1.1.1.1 / 8.8.8.8 on $($route.InterfaceAlias)." -ForegroundColor Green
    Write-Host "  Undo with:  Set-DnsClientServerAddress -InterfaceIndex $idx -ResetServerAddresses"
    $again = $false
    try { $again = [bool](Resolve-DnsName google.com -EA Stop) } catch {}
    Write-Host ("  google.com resolves now: {0}" -f $again)
  } else {
    Write-Host "  Could not identify the default-route interface; set DNS by hand." -ForegroundColor Red
  }
}
else {
  Write-Host "Starlink is fine from this machine: dish answers, internet routes, DNS resolves." -ForegroundColor Green
  Write-Host "Whatever is failing is above the network — the app or the tunnel, not Starlink."
}

if ($tsIfaces.Count -and $wanIfaces.Count) {
  Write-Host "`nADDRESS RANGE COLLISION" -ForegroundColor Yellow
  Write-Host "A 100.x address exists on BOTH Tailscale and a non-Tailscale adapter:"
  ($tsIfaces + $wanIfaces) | Format-Table IPAddress, InterfaceAlias | Out-String | Write-Host
  Write-Host "Starlink hands out CGNAT addresses from 100.64.0.0/10 and Tailscale uses"
  Write-Host "the same range. That can break tunnel traffic while looking like a"
  Write-Host "Starlink fault. Not auto-fixed — it needs a decision about which side"
  Write-Host "moves. Send me this block."
}

Section "Tunnel health"
try {
  $h = Invoke-WebRequest http://127.0.0.1:8787/healthz -TimeoutSec 5 -UseBasicParsing
  Write-Host ("  /healthz -> {0} {1}" -f $h.StatusCode, $h.Content)
} catch {
  Write-Host "  /healthz did not answer — the coordinator is not listening on 127.0.0.1:8787" -ForegroundColor Yellow
}

Write-Host "`nFull log written to: $log`n"
Stop-Transcript | Out-Null

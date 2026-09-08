<#
  fix-tunnel.ps1 — diagnose and repair the alpha-tunnel on this machine.

  Run as Administrator:
      powershell -ExecutionPolicy Bypass -File .\fix-tunnel.ps1

  This one is written to be read BY YOU, not sent to me: every check ends in a
  plain-language verdict and the exact next command. It also writes
  fix-tunnel-log.txt beside itself.

  It repairs what is safely repairable (stopped services, missing service
  resilience settings) and diagnoses the rest without guessing.
#>

$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'fix-tunnel-log.txt'
Start-Transcript -Path $log -Force | Out-Null

$problems = New-Object System.Collections.ArrayList
function Problem($t) { [void]$problems.Add($t); Write-Host "  PROBLEM: $t" -ForegroundColor Red }
function OK($t)      { Write-Host "  ok: $t" -ForegroundColor Green }
function Note($t)    { Write-Host "  $t" }
function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host "NOT elevated — service repair will silently do nothing. Re-run as Administrator.`n" -ForegroundColor Red }

# ---------------------------------------------------------------- 1. checkout
Section "1. Where the tunnel is installed"
$tunnel = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\alpha-agent\Parameters" -EA SilentlyContinue).AppDirectory
if (-not $tunnel) {
  $hit = Get-ChildItem C:\ -Recurse -Depth 5 -Filter self-update.mjs -EA SilentlyContinue | Select-Object -First 1
  if ($hit) { $tunnel = $hit.Directory.Parent.FullName }
}
if (-not $tunnel -or -not (Test-Path $tunnel)) {
  Problem "Cannot find the alpha-tunnel checkout. Everything below is skipped."
  Note "Find it by hand:  Get-ChildItem C:\ -Recurse -Filter alpha-host -EA SilentlyContinue"
  Stop-Transcript | Out-Null; exit 1
}
OK "tunnel at $tunnel"
Note "HEAD: $(git -C $tunnel rev-parse --short HEAD 2>$null)  branch: $(git -C $tunnel rev-parse --abbrev-ref HEAD 2>$null)"

# ---------------------------------------------------------------- 2. services
Section "2. Services"
$svcs = @(Get-Service | Where-Object Name -like 'alpha*')
if (-not $svcs) {
  Problem "No alpha-* services installed on this machine."
  Note "Install them per docs/HOST_SETUP.md section 9, or run: node `"$tunnel\scripts\setup-agent.mjs`""
} else {
  $svcs | Format-Table Name, Status, StartType | Out-String | Write-Host
  foreach ($s in $svcs) {
    if ($s.Status -ne 'Running') {
      Note "starting $($s.Name) ..."
      Start-Service $s.Name -EA SilentlyContinue
      Start-Sleep -Seconds 3
      if ((Get-Service $s.Name).Status -eq 'Running') { OK "$($s.Name) started" }
      else {
        Problem "$($s.Name) will not start. Its log says why:"
        Note "  Get-Content `"$tunnel\logs\*.log`" -Tail 40"
      }
    } else { OK "$($s.Name) running" }
  }
  # Idempotent: safe to re-apply every run.
  $nssm = (Get-Command nssm -EA SilentlyContinue).Source
  if ($nssm) {
    foreach ($s in $svcs.Name) {
      & $nssm set $s AppExit Default Restart | Out-Null
      & $nssm set $s AppRestartDelay 5000    | Out-Null
      & $nssm set $s AppThrottle 10000       | Out-Null
      sc.exe config $s start= delayed-auto   | Out-Null
    }
    OK "restart-on-exit and delayed-auto applied"
  } else { Note "nssm not on PATH — skipped the resilience settings" }
}

# ---------------------------------------------------------------- 3. coordinator
Section "3. Is the coordinator listening?"
$healthy = $false
try {
  $h = Invoke-WebRequest http://127.0.0.1:8787/healthz -TimeoutSec 5 -UseBasicParsing
  OK "/healthz -> $($h.StatusCode) $($h.Content)"
  $healthy = $true
} catch {
  Problem "Nothing is answering on 127.0.0.1:8787."
  $listening = Get-NetTCPConnection -LocalPort 8787 -State Listen -EA SilentlyContinue
  if ($listening) {
    Note "Something IS bound to 8787 but not answering /healthz — wrong process?"
    $listening | Select-Object LocalAddress,LocalPort,OwningProcess | Format-Table | Out-String | Write-Host
  } else {
    Note "Port 8787 has no listener at all: the coordinator is not running here."
    Note "If this is a worker laptop, that is CORRECT — only the host runs the coordinator."
  }
}

# ---------------------------------------------------------------- 4. agent config
Section "4. Agent configuration"
$envAgent = Join-Path $tunnel '.env.agent'
if (Test-Path $envAgent) {
  OK ".env.agent present"
  # Names and presence only. Never print a key.
  Get-Content $envAgent | Where-Object { $_ -match '^\s*[A-Z_]+=' } | ForEach-Object {
    $name = ($_ -split '=',2)[0].Trim()
    $val  = ($_ -split '=',2)[1]
    if ($name -match 'KEY|TOKEN|SECRET') { Note "$name = <set, $($val.Length) chars>" }
    else { Note "$name = $val" }
  }
} else {
  Problem "No .env.agent — this machine has no agent credential."
  Note "Enrol it:  node `"$tunnel\scripts\setup-agent.mjs`""
}

# ---------------------------------------------------------------- 5. tailnet
Section "5. Tailnet"
if (Get-Command tailscale -EA SilentlyContinue) {
  $ts = tailscale status 2>&1 | Out-String
  if ($ts -match 'Logged out|stopped') { Problem "Tailscale is not connected: run  tailscale up" }
  else { OK "tailscale up"; Write-Host $ts }
} else { Note "tailscale not on PATH (fine if both machines are on the same LAN)" }

# ---------------------------------------------------------------- 6. who is attached
Section "6. Attached agents"
Push-Location $tunnel
$agents = node src/admin/run.js agents 2>&1 | Out-String
Pop-Location
Write-Host $agents
if ($agents -match 'unreachable|ECONNREFUSED|not authorized|401|403') {
  Problem "alpha-admin could not talk to the host."
  Note "If this is the host: the coordinator is down — see section 3."
  Note "If this is a laptop: ALPHA_HOST_URL must point at the host's tailnet address, not 127.0.0.1."
} elseif ($agents -match '\*') {
  Note "An asterisk in VERSION means that machine runs a different release than the host."
  Note "Fix on the machine with the asterisk:  node `"$tunnel\scripts\self-update.mjs`" --repo `"$tunnel`""
  Note "  exit 10 = it moved, then: nssm restart alpha-agent"
}

# ---------------------------------------------------------------- verdict
Section "VERDICT"
if ($problems.Count -eq 0) {
  Write-Host "No problems found. The tunnel on this machine is healthy." -ForegroundColor Green
  if ($healthy) { Write-Host "Coordinator answering, services running, agent configured." }
} else {
  Write-Host "$($problems.Count) problem(s), most important first:" -ForegroundColor Yellow
  $i = 1; foreach ($p in $problems) { Write-Host "  $i. $p"; $i++ }
  Write-Host "`nEach section above prints the command that fixes its own problem."
}
Write-Host "`nLog: $log`n"
Stop-Transcript | Out-Null

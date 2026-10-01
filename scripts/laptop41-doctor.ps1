<#
  laptop41-doctor.ps1 - one pass over everything on the Alpha host (Laptop41):
  backend, chat, whether the site is stale and at which layer, the public
  hostname, the alpha-tunnel coordinator, the CrowPanel and memory/disk.

  LOOK (changes nothing):
      powershell -ExecutionPolicy Bypass -File .\scripts\laptop41-doctor.ps1

  LOOK, THEN FIX what has a proven fixer (run as Administrator):
      powershell -ExecutionPolicy Bypass -File .\scripts\laptop41-doctor.ps1 -Fix

  SEND the report where a Claude session can read it (no copy-paste needed):
      add -Push

  -Fix adds no repair logic of its own. It runs the two fixers that already
  exist, each with its own backup and rollback:
    apply-chat-fix.ps1 -Apply -Restart   when the dictionary 500 is present
    repair-alpha-host.ps1                when the frontend is down or its dist
                                         is older than its source (that script
                                         rebuilds with the old dist kept)
  and then checks everything again.

  -Push commits the report from a temporary git worktree to a new branch
  status/laptop41-<time>, so the checkout the agent runs from is never switched
  or dirtied. Tokens are redacted from the report before it is written; the
  chat password (only asked for with -ChatUser) is never written at all.
#>

param(
  [string]$AlphaRoot = 'C:\AlphaData\Alpha',
  [string]$OpsDir = 'C:\AlphaData\alpha-ops',
  [int]$BackendPort = 8001,
  [int]$FrontendPort = 4173,
  [int]$CoordinatorPort = 8787,
  [string]$PublicHost = 'alpha-ai.uk',
  [string]$ChatUser = '',
  [switch]$Fix,
  [switch]$Push
)

$ErrorActionPreference = 'Continue'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$reportDir = Join-Path $OpsDir 'reports'
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$report = Join-Path $reportDir "laptop41-doctor-$stamp.txt"
$lines = New-Object System.Collections.ArrayList
$problems = New-Object System.Collections.ArrayList

function Out1($t, $color = '') {
  [void]$lines.Add("$t")
  if ($color) { Write-Host $t -ForegroundColor $color } else { Write-Host $t }
}
function Section($t) { Out1 ''; Out1 "=== $t ===" 'Cyan' }
function OK($t)      { Out1 "  ok: $t" 'Green' }
function Note($t)    { Out1 "  $t" }
function Problem($t) { [void]$problems.Add($t); Out1 "  PROBLEM: $t" 'Red' }
function Indent($text) { foreach ($l in ("$text" -split "`r?`n")) { if ($l.Trim()) { Note "  $l" } } }

function Http($url, [string]$hostHeader = '') {
  $a = @('-s', '-o', 'NUL', '-w', '%{http_code}', '--max-time', '10')
  if ($hostHeader) { $a += @('-H', "Host: $hostHeader") }
  $c = & curl.exe @a $url 2>$null
  if (-not $c) { return '000' }
  return "$c"
}
function Body($url, [string]$hostHeader = '') {
  $a = @('-s', '--max-time', '10')
  if ($hostHeader) { $a += @('-H', "Host: $hostHeader") }
  return ((& curl.exe @a $url 2>$null) -join "`n")
}
# The script tag vite writes into index.html names the hashed bundle, so it
# says exactly which build a layer is serving.
function BundleOf($html) {
  $m = [regex]::Match("$html", 'src="(/assets/[^"]+\.js)"')
  if ($m.Success) { return $m.Groups[1].Value }
  return ''
}
function Admin([string[]]$cmd) {
  Push-Location $repo
  try { return ((& node src\admin\run.js @cmd 2>&1 | Out-String)) } finally { Pop-Location }
}

function Run-Checks {
  # ------------------------------------------------------------ backend
  Section "1. Backend (port $BackendPort)"
  $h = Http "http://127.0.0.1:$BackendPort/health"
  if ($h -like '2*') { OK "/health answers $h" } else { Problem "backend /health answered $h" }

  $script:chatBug = $false
  $fixOut = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'apply-chat-fix.ps1') -AlphaRoot $AlphaRoot -OpsDir $OpsDir 2>&1 | Out-String
  if ($fixOut -match 'already fixed') { OK 'chat fix (dictionary 500) is in the live main.py' }
  elseif ($fixOut -match 'READY:') { $script:chatBug = $true; Problem 'live main.py still has the chat bug: dictionary questions answer 500 (fix: -Fix)' }
  else { Problem 'could not tell whether the chat fix is in; apply-chat-fix.ps1 said:'; Indent $fixOut }

  # ------------------------------------------------------------ chat
  Section '2. Chat'
  $c = Http "http://127.0.0.1:$BackendPort/chat"
  Note "POST-only route answers a bare GET with $c (405 means the route exists)"
  if ($ChatUser) {
    if (-not $script:chatPass) { $script:chatPass = Read-Host "Alpha password for $ChatUser" -AsSecureString }
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($script:chatPass))
    try {
      $login = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$BackendPort/auth/login" -ContentType 'application/json' `
                 -Body (@{ username = $ChatUser; password = $plain } | ConvertTo-Json) -TimeoutSec 30
      $plain = $null
      if (-not $login.access_token) {
        Problem "login as $ChatUser gave no token (2FA: $($login.requires_2fa), agreement: $($login.requires_agreement))"
      } else {
        OK "login as $ChatUser"
        foreach ($q in 'hello', 'what does ephemeral mean') {
          try {
            $r = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$BackendPort/chat" -ContentType 'application/json' `
                   -Headers @{ Authorization = "Bearer $($login.access_token)" } -Body (@{ message = $q } | ConvertTo-Json) -TimeoutSec 120
            $txt = "$($r.response)"; if ($txt.Length -gt 160) { $txt = $txt.Substring(0, 160) + '...' }
            OK "chat '$q' -> routed_to=$($r.routed_to): $txt"
          } catch {
            $code = $null; try { $code = [int]$_.Exception.Response.StatusCode } catch {}
            Problem "chat '$q' failed: HTTP $code $($_.Exception.Message)"
          }
        }
      }
    } catch {
      $plain = $null
      $code = $null; try { $code = [int]$_.Exception.Response.StatusCode } catch {}
      Problem "login as $ChatUser failed: HTTP $code $($_.Exception.Message)"
    }
  } else {
    Note 'not logged in, so chat itself was not tried. Add -ChatUser <your Alpha login> to send two real messages.'
  }

  # ------------------------------------------------------------ stale?
  Section '3. Is Alpha stale, and at which layer?'
  $fe = Join-Path $AlphaRoot 'frontend'
  if (-not (Test-Path (Join-Path $fe 'package.json'))) { $fe = Join-Path (Join-Path $AlphaRoot 'software') 'frontend' }
  Note "frontend: $fe"
  $script:frontendStale = $false
  $distIndex = Join-Path $fe 'dist\index.html'
  if (-not (Test-Path $distIndex)) {
    $script:frontendStale = $true; Problem 'no dist\index.html: there is no production build to serve'
  } else {
    $built = (Get-Item $distIndex).LastWriteTime
    $newest = Get-ChildItem (Join-Path $fe 'src') -Recurse -File -EA SilentlyContinue |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
    Note ("dist built       {0:yyyy-MM-dd HH:mm}" -f $built)
    if ($newest) {
      Note ("newest source    {0:yyyy-MM-dd HH:mm}  {1}" -f $newest.LastWriteTime, $newest.FullName.Substring($fe.Length + 1))
      if ($newest.LastWriteTime -gt $built.AddMinutes(1)) {
        $script:frontendStale = $true
        Problem 'the build is older than the source: the site shows the old Alpha until dist is rebuilt (fix: -Fix)'
      } else { OK 'build is newer than every source file' }
    }
  }
  $mainPy = @((Join-Path $AlphaRoot 'backend\main.py'), (Join-Path $AlphaRoot 'software\backend\main.py')) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($mainPy) {
    $mt = (Get-Item $mainPy).LastWriteTime
    $bp = (Get-NetTCPConnection -LocalPort $BackendPort -State Listen -EA SilentlyContinue | Select-Object -First 1).OwningProcess
    if ($bp) {
      $started = (Get-Process -Id $bp -EA SilentlyContinue).StartTime
      Note ("main.py edited   {0:yyyy-MM-dd HH:mm}; backend pid {1} started {2:yyyy-MM-dd HH:mm}" -f $mt, $bp, $started)
      if ($started -and $mt -gt $started) { Problem 'main.py changed after the backend started: it is running old code until restarted' }
      else { OK 'backend was started after main.py last changed' }
    }
  }
  $fileBundle  = if (Test-Path $distIndex) { BundleOf (Get-Content $distIndex -Raw) } else { '' }
  $localBundle = BundleOf (Body "http://127.0.0.1:$FrontendPort/" $PublicHost)
  $pubBundle   = BundleOf (Body "https://$PublicHost/")
  Note "bundle on disk   $fileBundle"
  Note "bundle on :$FrontendPort $localBundle"
  Note "bundle public    $pubBundle"
  if (-not $localBundle) { $script:frontendStale = $true; Problem "nothing serving Alpha on $FrontendPort" }
  elseif ($fileBundle -and $localBundle -ne $fileBundle) { $script:frontendStale = $true; Problem "the server on $FrontendPort serves an older build than dist holds; it needs a restart" }
  else { OK "$FrontendPort serves the build on disk" }
  if ($localBundle -and $pubBundle -and $pubBundle -ne $localBundle) {
    $cf = (& curl.exe -sI --max-time 10 "https://$PublicHost/" 2>$null | Select-String -Pattern '^(cf-cache-status|age|cache-control):' | ForEach-Object { $_.Line.Trim() }) -join '; '
    Problem "the public site serves a different build from this machine: Cloudflare cache or another origin ($cf)"
  } elseif ($pubBundle) { OK 'public site serves the same build as this machine' }

  # ------------------------------------------------------------ public
  Section "4. Public $PublicHost"
  $p = Http "https://$PublicHost/"
  if ($p -like '2*' -or $p -like '3*') { OK "https://$PublicHost/ answers $p" } else { Problem "https://$PublicHost/ answers $p" }
  $ph = Http "https://$PublicHost/api/health"
  Note "https://$PublicHost/api/health answers $ph"
  foreach ($t in 'Alpha', 'Alpha Backend', 'Alpha Self-Heal') {
    $st = Get-ScheduledTask -TaskName $t -EA SilentlyContinue
    if ($st) { $i = $st | Get-ScheduledTaskInfo; Note ("task {0,-16} {1,-8} last run {2:yyyy-MM-dd HH:mm} result {3}" -f $t, $st.State, $i.LastRunTime, $i.LastTaskResult) }
    else { Note "task $t : not registered" }
  }
  $cfs = Get-Service -Name cloudflared -EA SilentlyContinue
  if ($cfs) { Note "cloudflared service: $($cfs.Status)" } else { Note 'cloudflared service: not installed as a service' }
  $sh = Join-Path $OpsDir 'logs\selfheal.jsonl'
  if (Test-Path $sh) { Note 'last self-heal entries:'; Get-Content $sh -Tail 3 | ForEach-Object { Note "  $_" } }

  # ------------------------------------------------------------ tunnel
  Section "5. alpha-tunnel coordinator (port $CoordinatorPort)"
  $hz = Body "http://127.0.0.1:$CoordinatorPort/healthz"
  if ($hz) { OK "healthz: $hz" } else { Problem "no coordinator answering on $CoordinatorPort (move-coordinator-here does not leave one running)" }
  if ($hz) {
    foreach ($cmd in 'agents', 'stats', 'keys', 'tasks') {
      Note "--- $cmd"; Indent (Admin @($cmd))
    }
  }

  # ------------------------------------------------------------ panel
  Section '6. CrowPanel'
  Push-Location $repo
  try { Indent ((& node scripts\panel-up.mjs --list-ports 2>&1 | Out-String)) } finally { Pop-Location }
  Note 'the panel is live only if its key (agents:read) in the keys list above was used in the last few seconds'

  # ------------------------------------------------------------ resources
  Section '7. Memory, disk, heaviest processes'
  $os = Get-CimInstance Win32_OperatingSystem
  $free = [math]::Round($os.FreePhysicalMemory / 1MB, 1); $total = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
  if ($free / $total -lt 0.1) { Problem "only $free of $total GB RAM free" } else { OK "$free of $total GB RAM free" }
  $c = Get-PSDrive C -EA SilentlyContinue
  if ($c) { $g = [math]::Round($c.Free / 1GB, 1); if ($g -lt 5) { Problem "C: only $g GB free" } else { OK "C: $g GB free" } }
  Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 8 |
    ForEach-Object { Note ("{0,-28} {1,6:n0} MB  pid {2}" -f $_.ProcessName, ($_.WorkingSet64 / 1MB), $_.Id) }
}

Out1 "laptop41-doctor $stamp on $env:COMPUTERNAME  (alpha root $AlphaRoot)"
Run-Checks

if ($Fix) {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  Section 'FIX'
  if (-not $admin) { Problem '-Fix needs an Administrator PowerShell; nothing was changed' }
  else {
    $did = $false
    if ($script:chatBug) {
      Note 'applying the chat fix (backup kept; undo command is printed below)'
      Indent ((& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'apply-chat-fix.ps1') -AlphaRoot $AlphaRoot -OpsDir $OpsDir -Apply -Restart 2>&1 | Out-String))
      $did = $true
    }
    if ($script:frontendStale) {
      Note 'running repair-alpha-host.ps1 (rebuilds a stale dist, old one kept; -Rollback undoes it)'
      Indent ((& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'repair-alpha-host.ps1') -AlphaRoot $AlphaRoot -OpsDir $OpsDir 2>&1 | Select-Object -Last 40 | Out-String))
      $did = $true
    }
    if ($did) {
      $problems.Clear()
      Section 'AFTER FIX - checking everything again'
      Run-Checks
    } else { Note 'nothing that -Fix knows how to repair was found' }
  }
}

Section 'SUMMARY'
if ($problems.Count -eq 0) { OK 'no problems found' } else { foreach ($p in $problems) { Out1 "  - $p" 'Red' } }

# Never let a credential reach the file: tunnel tokens, JWTs, bearer headers.
$text = ($lines -join "`r`n")
$text = [regex]::Replace($text, 'alpha_[a-z]+_[A-Za-z0-9]+\.[A-Za-z0-9_\-]+', 'alpha_<redacted>')
$text = [regex]::Replace($text, 'eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+', '<jwt redacted>')
$text = [regex]::Replace($text, '(?i)(bearer\s+)\S+', '$1<redacted>')
[IO.File]::WriteAllText($report, $text, (New-Object Text.UTF8Encoding($false)))
Write-Host "`nreport: $report"

if ($Push) {
  $branch = "status/laptop41-$stamp"
  $wt = Join-Path $env:TEMP "laptop41-doctor-$stamp"
  Push-Location $repo
  try {
    git worktree add --detach $wt HEAD 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Host 'could not create a git worktree; attach the report file instead' -ForegroundColor Yellow }
    else {
      New-Item -ItemType Directory -Force -Path (Join-Path $wt 'reports') | Out-Null
      Copy-Item $report (Join-Path $wt 'reports')
      git -C $wt add reports 2>&1 | Out-Null
      git -C $wt commit -m "laptop41 doctor report $stamp" 2>&1 | Out-Null
      git -C $wt push origin "HEAD:refs/heads/$branch" 2>&1 | ForEach-Object { Write-Host "  $_" }
      if ($LASTEXITCODE -eq 0) { Write-Host "pushed to branch $branch - tell Claude 'doctor pushed'" -ForegroundColor Green }
      else { Write-Host 'push failed; attach the report file instead' -ForegroundColor Yellow }
      git worktree remove --force $wt 2>&1 | Out-Null
    }
  } finally { Pop-Location }
}

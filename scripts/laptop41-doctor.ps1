<#
  laptop41-doctor.ps1 - one pass over everything on the Alpha host (Laptop41):
  where Alpha actually lives, backend, chat, whether the site is stale and at
  which layer, the public hostname, the alpha-tunnel coordinator, the
  CrowPanel and memory/disk.

  LOOK (changes nothing):
      powershell -ExecutionPolicy Bypass -File .\scripts\laptop41-doctor.ps1

  LOOK, THEN FIX what has a proven fixer (run as Administrator):
      powershell -ExecutionPolicy Bypass -File .\scripts\laptop41-doctor.ps1 -Fix

  SEND the report where a Claude session can read it (no copy-paste needed):
      add -Push

  It does not assume the layout. It finds the backend (the main.py that
  defines chat()) and the frontend (the package.json that uses vite) under
  -AlphaRoot, and reports which process holds each port and what the 'Alpha'
  task runs, because a guessed path is how the first run of this script
  reported "no main.py" on a machine whose backend was answering.

  -Fix adds no repair logic of its own. It runs the two fixers that already
  exist, each with its own backup and rollback:
    apply-chat-fix.ps1 -Apply -Restart   when the dictionary 500 is present
    repair-alpha-host.ps1                when the frontend is down or stale
  repair-alpha-host registers a self-heal task that runs scripts from the
  checkout it was started from, so it is only run from the real checkout,
  never from a temporary git worktree.

  -Push commits the report from a temporary git worktree to a new branch
  status/laptop41-<time>, so the checkout the agent runs from is never switched
  or dirtied. Tokens are redacted from the report before it is written; the
  chat password and the admin key are never written at all.
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
# Not $env:TEMP: on Laptop41 it pointed at the removed USB drive (F:).
$tmpDir = Join-Path $OpsDir 'tmp'
New-Item -ItemType Directory -Force -Path $reportDir, $tmpDir | Out-Null
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
# Native stderr through 2>&1 arrives as ErrorRecords that PowerShell 5.1 prints
# with a whole "NativeCommandError" block each; keep only the text.
function Plain { process { "$_" } }

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
function Owner($port) {
  $l = Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue | Select-Object -First 1
  if (-not $l) { return $null }
  return Get-CimInstance Win32_Process -Filter "ProcessId=$($l.OwningProcess)" -EA SilentlyContinue
}
function Describe($p) {
  if (-not $p) { return 'nothing listening' }
  return "pid $($p.ProcessId) $($p.Name): $($p.CommandLine)"
}
function TaskResult($code) {
  $hex = '0x{0:X8}' -f ([int64]$code -band 0xFFFFFFFF)
  switch ($hex) {
    '0x00000000' { return "$hex (success)" }
    '0x00041301' { return "$hex (still running)" }
    '0xC000013A' { return "$hex (killed: Ctrl+C or its console closed - the process did not survive)" }
    '0x800710E0' { return "$hex (refused: the operator or a condition stopped it)" }
    default      { return $hex }
  }
}

# The CLI reads ALPHA_ADMIN_TOKEN from the environment or a .env in the folder
# it runs from; move-coordinator-here prints the admin key once and stores it
# nowhere, so a worktree copy of .env cannot have it. Ask, keep it in this
# process only.
$script:adminAsked = $false
function Admin([string]$cmd) {
  if (-not $env:ALPHA_ADMIN_TOKEN -and -not $script:adminAsked) {
    $script:adminAsked = $true
    $envFile = Join-Path $repo '.env'
    $inFile = (Test-Path $envFile) -and (Select-String -Path $envFile -Pattern '^ALPHA_(ADMIN|BOOTSTRAP)_TOKEN=.+' -Quiet)
    if (-not $inFile) {
      $s = Read-Host 'Admin key for the coordinator (the one move-coordinator-here printed; Enter to skip)' -AsSecureString
      $k = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
      if ($k) { $env:ALPHA_ADMIN_TOKEN = $k }
    }
  }
  Push-Location $repo
  try { return ((& node src\admin\run.js $cmd 2>&1 | Plain | Out-String)) } finally { Pop-Location }
}

# ------------------------------------------------------------ layout
$skip = '\\(node_modules|\.venv|venv|env|site-packages|\.git|__pycache__|dist[^\\]*|BuildArtifacts)\\'
function Find-Layout {
  Section "0. Where Alpha lives under $AlphaRoot"
  if (-not (Test-Path $AlphaRoot)) { Problem "$AlphaRoot does not exist"; return }
  Note ('top level: ' + ((Get-ChildItem $AlphaRoot -EA SilentlyContinue | ForEach-Object { $_.Name }) -join ', '))

  $mains = @(Get-ChildItem $AlphaRoot -Recurse -Depth 4 -Filter main.py -File -EA SilentlyContinue |
             Where-Object { $_.FullName -notmatch $skip } |
             Where-Object { Select-String -Path $_.FullName -SimpleMatch 'async def chat(request: ChatRequest' -Quiet })
  $be = Owner $BackendPort
  Note "port $BackendPort : $(Describe $be)"
  $script:mainPy = $null
  if ($mains.Count -eq 1) { $script:mainPy = $mains[0].FullName; OK "backend: $($script:mainPy)" }
  elseif ($mains.Count -gt 1) {
    foreach ($m in $mains) { Note "backend candidate: $($m.FullName)" }
    $hit = @($mains | Where-Object { $be -and $be.CommandLine -and $be.CommandLine.IndexOf($_.DirectoryName, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
    if ($hit.Count -eq 1) { $script:mainPy = $hit[0].FullName; OK "backend (named by the running process): $($script:mainPy)" }
    else { Problem 'more than one backend main.py; cannot tell which one is running' }
  } else {
    Problem "no main.py defining chat() under $AlphaRoot - the backend on $BackendPort runs from somewhere else (see its command line above)"
  }

  $task = Get-ScheduledTask -TaskName 'Alpha' -EA SilentlyContinue
  $taskText = ''
  if ($task) {
    foreach ($a in $task.Actions) {
      $taskText += " $($a.Execute) $($a.Arguments) $($a.WorkingDirectory)"
      Note "task Alpha runs: $($a.Execute) $($a.Arguments)"
      Note "            in: $($a.WorkingDirectory)"
    }
  }
  $fes = @(Get-ChildItem $AlphaRoot -Recurse -Depth 4 -Filter package.json -File -EA SilentlyContinue |
           Where-Object { $_.FullName -notmatch $skip } |
           Where-Object { (Get-Content $_.FullName -Raw -EA SilentlyContinue) -match '"vite"' })
  $fo = Owner $FrontendPort
  Note "port $FrontendPort : $(Describe $fo)"
  $script:frontend = $null
  foreach ($f in $fes) {
    $d = $f.DirectoryName
    $hasDist = Test-Path (Join-Path $d 'dist\index.html')
    $byTask = $taskText -and $taskText.IndexOf($d, [StringComparison]::OrdinalIgnoreCase) -ge 0
    Note ("frontend candidate: {0}  dist:{1}  named-by-task:{2}" -f $d, $hasDist, $byTask)
    if ($byTask) { $script:frontend = $d }
  }
  if (-not $script:frontend -and $fes.Count -gt 0) { $script:frontend = $fes[0].DirectoryName }
  if ($script:frontend) { OK "frontend: $($script:frontend)" } else { Problem "no vite frontend under $AlphaRoot" }
  if ($taskText -and $script:frontend -and $taskText.IndexOf($script:frontend, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    Problem "the 'Alpha' task does not mention $($script:frontend): it serves some other folder"
  }
}

function Run-Checks {
  Find-Layout

  # ------------------------------------------------------------ backend
  Section "1. Backend (port $BackendPort)"
  $h = Http "http://127.0.0.1:$BackendPort/health"
  if ($h -like '2*') { OK "/health answers $h" } else { Problem "backend /health answered $h" }

  $script:chatBug = $false
  if ($script:mainPy) {
    $fixOut = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'apply-chat-fix.ps1') -MainPy $script:mainPy -OpsDir $OpsDir 2>&1 | Plain | Out-String
    if ($fixOut -match 'already fixed') { OK 'chat fix (dictionary 500) is in the live main.py' }
    elseif ($fixOut -match 'READY:') { $script:chatBug = $true; Problem 'live main.py still has the dictionary bug (fix: -Fix)' }
    else { Note 'apply-chat-fix.ps1 does not recognise this chat() (a different version of the backend):'; Indent $fixOut }
    $mt = (Get-Item $script:mainPy).LastWriteTime
    $bp = Owner $BackendPort
    if ($bp) {
      $started = (Get-Process -Id $bp.ProcessId -EA SilentlyContinue).StartTime
      Note ("main.py edited {0:yyyy-MM-dd HH:mm}; backend started {1:yyyy-MM-dd HH:mm}" -f $mt, $started)
      if ($started -and $mt -gt $started) { Problem 'main.py changed after the backend started: it is running old code until restarted' }
    }
  }

  # ------------------------------------------------------------ chat
  Section '2. Chat'
  if ($ChatUser) {
    if (-not $script:chatPass) { $script:chatPass = Read-Host "Alpha password for $ChatUser" -AsSecureString }
    $plainPw = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($script:chatPass))
    $login = $null
    try {
      $login = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$BackendPort/auth/login" -ContentType 'application/json' `
                 -Body (@{ username = $ChatUser; password = $plainPw } | ConvertTo-Json) -TimeoutSec 30
    } catch {
      $code = $null; try { $code = [int]$_.Exception.Response.StatusCode } catch {}
      Problem "login as $ChatUser failed: HTTP $code $($_.ErrorDetails.Message)"
    }
    $plainPw = $null
    if ($login -and -not $login.access_token) {
      Problem "login as $ChatUser gave no token (2FA: $($login.requires_2fa), agreement: $($login.requires_agreement))"
    } elseif ($login) {
      OK "login as $ChatUser"
      $since = Get-Date
      $failed = $false
      foreach ($q in 'hello', 'what is 2 plus 2', 'what does ephemeral mean') {
        try {
          $r = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$BackendPort/chat" -ContentType 'application/json' `
                 -Headers @{ Authorization = "Bearer $($login.access_token)" } -Body (@{ message = $q } | ConvertTo-Json) -TimeoutSec 120
          $txt = ("$($r.response)" -replace '\s+', ' ')
          if ($txt.Length -gt 160) { $txt = $txt.Substring(0, 160) + '...' }
          OK "chat '$q' -> routed_to=$($r.routed_to): $txt"
        } catch {
          $failed = $true
          $code = $null; try { $code = [int]$_.Exception.Response.StatusCode } catch {}
          Problem "chat '$q' failed: HTTP $code"
          if ($_.ErrorDetails.Message) { Indent ("response body: " + $_.ErrorDetails.Message) }
        }
      }
      if ($failed) {
        # The traceback is in whatever log the backend writes; show the newest
        # ones touched since the first message went out.
        $roots = @($AlphaRoot, (Join-Path $env:ProgramData 'AlphaBoot'), (Join-Path $OpsDir 'logs')) | Where-Object { Test-Path $_ }
        $logs = @(Get-ChildItem $roots -Recurse -Depth 5 -File -Include *.log, *.txt, *.jsonl -EA SilentlyContinue |
                  Where-Object { $_.FullName -notmatch $skip -and $_.LastWriteTime -ge $since.AddSeconds(-5) } |
                  Sort-Object LastWriteTime -Descending | Select-Object -First 2)
        if (-not $logs) { Note 'no log file changed while chat failed: the backend logs to its console only' }
        foreach ($lg in $logs) { Note "--- tail of $($lg.FullName)"; Get-Content $lg.FullName -Tail 40 -EA SilentlyContinue | ForEach-Object { Note "  $_" } }
      }
    }
  } else {
    Note 'not logged in, so chat itself was not tried. Add -ChatUser <your Alpha login> to send real messages.'
  }

  # ------------------------------------------------------------ stale?
  Section '3. Is Alpha stale, and at which layer?'
  $script:frontendStale = $false
  $fileBundle = ''
  if ($script:frontend) {
    $distIndex = Join-Path $script:frontend 'dist\index.html'
    if (-not (Test-Path $distIndex)) {
      $script:frontendStale = $true; Problem "no dist\index.html in $($script:frontend): no production build to serve"
    } else {
      $fileBundle = BundleOf (Get-Content $distIndex -Raw)
      $built = (Get-Item $distIndex).LastWriteTime
      $newest = Get-ChildItem (Join-Path $script:frontend 'src') -Recurse -File -EA SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
      Note ("dist built     {0:yyyy-MM-dd HH:mm}" -f $built)
      if ($newest) {
        Note ("newest source  {0:yyyy-MM-dd HH:mm}  {1}" -f $newest.LastWriteTime, $newest.FullName.Substring($script:frontend.Length + 1))
        if ($newest.LastWriteTime -gt $built.AddMinutes(1)) {
          $script:frontendStale = $true
          Problem 'the build is older than the source: the site shows the old Alpha until dist is rebuilt'
        } else { OK 'build is newer than every source file' }
      }
    }
  }
  $localBundle = BundleOf (Body "http://127.0.0.1:$FrontendPort/" $PublicHost)
  $pubBundle   = BundleOf (Body "https://$PublicHost/")
  Note "bundle in dist     $fileBundle"
  Note "bundle on :$FrontendPort   $localBundle"
  Note "bundle public      $pubBundle"
  $cf = (& curl.exe -sI --max-time 10 "https://$PublicHost/" 2>$null | Select-String -Pattern '^(cf-cache-status|age|cache-control|last-modified|server):' | ForEach-Object { $_.Line.Trim() }) -join '; '
  Note "public headers: $cf"
  if (-not $localBundle) { $script:frontendStale = $true; Problem "nothing serves Alpha on $FrontendPort" }
  elseif ($fileBundle -and $localBundle -ne $fileBundle) { $script:frontendStale = $true; Problem "$FrontendPort serves an older build than dist holds; the server needs a restart" }
  else { OK "$FrontendPort serves the build in dist" }
  if ($pubBundle -and $pubBundle -ne $localBundle) {
    Problem "the public site serves $pubBundle, which this machine's $FrontendPort does not: Cloudflare cache or another origin/connector is answering for $PublicHost"
    # Which local server, if any, has that build.
    $listen = @(Get-NetTCPConnection -State Listen -EA SilentlyContinue | Where-Object { $_.LocalAddress -in '127.0.0.1', '0.0.0.0', '::', '::1' } |
                Select-Object -ExpandProperty LocalPort -Unique)
    foreach ($port in $listen) {
      $p = Owner $port
      if (-not $p -or $p.Name -notmatch '^(node|python|pythonw)\.exe$') { continue }
      $b = BundleOf (Body "http://127.0.0.1:$port/")
      if ($b) { Note ("port {0} serves {1}{2}  ({3})" -f $port, $b, $(if ($b -eq $pubBundle) { '  <- the public build' } else { '' }), (Describe $p)) }
    }
  } elseif ($pubBundle) { OK 'public site serves the same build as this machine' }

  # ------------------------------------------------------------ public
  Section "4. Public $PublicHost and the boot tasks"
  $p = Http "https://$PublicHost/"
  if ($p -like '2*' -or $p -like '3*') { OK "https://$PublicHost/ answers $p" } else { Problem "https://$PublicHost/ answers $p" }
  foreach ($t in 'Alpha', 'Alpha Backend', 'Alpha Self-Heal') {
    $st = Get-ScheduledTask -TaskName $t -EA SilentlyContinue
    if ($st) { $i = $st | Get-ScheduledTaskInfo; Note ("task {0,-16} {1,-8} last run {2:yyyy-MM-dd HH:mm} result {3}" -f $t, $st.State, $i.LastRunTime, (TaskResult $i.LastTaskResult)) }
    else { Note "task $t : not registered" }
  }
  $cfs = Get-Service -Name cloudflared -EA SilentlyContinue
  if ($cfs) { Note "cloudflared service: $($cfs.Status)" } else { Note 'cloudflared service: not installed as a service' }
  $cfp = @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -EA SilentlyContinue)
  Note "cloudflared processes on this machine: $($cfp.Count)"
  $sh = Join-Path $OpsDir 'logs\selfheal.jsonl'
  if (Test-Path $sh) { Note 'last self-heal entries:'; Get-Content $sh -Tail 3 | ForEach-Object { Note "  $_" } }

  # ------------------------------------------------------------ tunnel
  Section "5. alpha-tunnel coordinator (port $CoordinatorPort)"
  $hz = Body "http://127.0.0.1:$CoordinatorPort/healthz"
  if ($hz) { OK "healthz: $hz" } else { Problem "no coordinator answering on $CoordinatorPort" }
  Note "port $CoordinatorPort : $(Describe (Owner $CoordinatorPort))"
  if ($hz) {
    foreach ($cmd in 'agents', 'stats', 'keys', 'tasks') { Note "--- $cmd"; Indent (Admin $cmd) }
  }

  # ------------------------------------------------------------ panel
  Section '6. CrowPanel'
  Push-Location $repo
  try { Indent ((& node scripts\panel-up.mjs --list-ports 2>&1 | Plain | Out-String)) } finally { Pop-Location }
  foreach ($d in @(Get-CimInstance Win32_PnPEntity -Filter "Name LIKE '%(COM%'" -EA SilentlyContinue)) { Note "device: $($d.Name)" }
  Note 'the panel is live only if its agents:read key in the keys list above was used in the last few seconds'

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

Out1 "laptop41-doctor $stamp on $env:COMPUTERNAME  (alpha root $AlphaRoot, checkout $repo)"
Run-Checks

if ($Fix) {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  Section 'FIX'
  if (-not $admin) { Problem '-Fix needs an Administrator PowerShell; nothing was changed' }
  else {
    $did = $false
    if ($script:chatBug) {
      Note 'applying the chat fix (backup kept; undo command is printed below)'
      Indent ((& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'apply-chat-fix.ps1') -MainPy $script:mainPy -OpsDir $OpsDir -Apply -Restart 2>&1 | Plain | Out-String))
      $did = $true
    }
    if ($script:frontendStale) {
      # A linked worktree has a .git *file*; the real checkout has a folder.
      if (-not (Test-Path (Join-Path $repo '.git') -PathType Container)) {
        Problem "not running repair-alpha-host.ps1 from this temporary worktree ($repo): the self-heal task it installs would point here. Run it from the real checkout once it has this branch's fix"
      } elseif (-not $script:frontend -or (Split-Path $script:frontend -Leaf) -ne 'frontend') {
        Problem "repair-alpha-host.ps1 expects <root>\frontend; the frontend found was '$($script:frontend)'"
      } else {
        $root = Split-Path $script:frontend -Parent
        Note "running repair-alpha-host.ps1 -AlphaRoot $root (rebuilds a stale dist, old one kept; -Rollback undoes it)"
        Indent ((& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'repair-alpha-host.ps1') -AlphaRoot $root -OpsDir $OpsDir 2>&1 | Plain | Select-Object -Last 60 | Out-String))
        $did = $true
      }
    }
    if ($did) {
      $problems.Clear()
      Section 'AFTER FIX - checking everything again'
      Run-Checks
    } else { Note 'nothing was changed' }
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
  $wt = Join-Path $tmpDir "push-$stamp"
  git -C $repo worktree add --detach $wt HEAD 2>&1 | Plain | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Host "could not create a git worktree; attach $report instead" -ForegroundColor Yellow }
  else {
    New-Item -ItemType Directory -Force -Path (Join-Path $wt 'reports') | Out-Null
    Copy-Item $report (Join-Path $wt 'reports')
    git -C $wt add reports 2>&1 | Plain | Out-Null
    git -C $wt -c user.name=laptop41-doctor -c user.email=doctor@laptop41.invalid commit -m "laptop41 doctor report $stamp" 2>&1 | Plain | Out-Null
    git -C $wt push origin "HEAD:refs/heads/$branch" 2>&1 | Plain | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -eq 0) { Write-Host "pushed to branch $branch - tell Claude 'doctor pushed'" -ForegroundColor Green }
    else { Write-Host "push failed; attach $report instead" -ForegroundColor Yellow }
    git -C $repo worktree remove --force $wt 2>&1 | Plain | Out-Null
  }
}

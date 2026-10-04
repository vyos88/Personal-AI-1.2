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
  [switch]$Push,
  # Scheduled mode: no prompts, never fixes, tracks problems across runs,
  # posts to Alpha on change, and writes nine ranked recommendations.
  [switch]$Watch,
  [switch]$InstallSchedule,
  [switch]$UninstallSchedule,
  [int]$EveryMinutes = 15,
  # A problem open this many consecutive runs is marked NEEDS A PERSON.
  [int]$EscalateAfterRuns = 4
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
  if (-not $env:ALPHA_ADMIN_TOKEN -and -not $script:adminAsked -and -not $Watch) {
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
# Get-ChildItem -Recurse walks into node_modules (tens of thousands of files,
# each one scanned by Defender) before any filter sees it; on Laptop41 that
# ran the scheduled pass past its 10-minute limit before it wrote anything.
# This walker never descends into a skipped folder.
$skipNames = @('node_modules', '.venv', 'venv', 'env', 'site-packages', '.git', '__pycache__', 'BuildArtifacts', '.next', 'build')
function Find-Files([string[]]$roots, [string[]]$patterns, [int]$maxDepth) {
  $out = New-Object System.Collections.ArrayList
  $stack = New-Object System.Collections.Stack
  foreach ($r in $roots) { if ($r -and (Test-Path $r -PathType Container)) { $stack.Push(@($r, 0)) } }
  while ($stack.Count -gt 0) {
    $item = $stack.Pop(); $dir = $item[0]; $depth = $item[1]
    foreach ($pat in $patterns) {
      $found = @(); try { $found = [IO.Directory]::GetFiles($dir, $pat) } catch { }
      foreach ($f in $found) { [void]$out.Add((Get-Item -LiteralPath $f)) }
    }
    if ($depth -ge $maxDepth) { continue }
    $subs = @()
    try { $subs = [IO.Directory]::GetDirectories($dir) } catch { }
    foreach ($d in $subs) {
      $leaf = [IO.Path]::GetFileName($d)
      if ($skipNames -contains $leaf -or $leaf -like 'dist*') { continue }
      $stack.Push(@($d, ($depth + 1)))
    }
  }
  return $out
}
function Find-Layout {
  Section "0. Where Alpha lives under $AlphaRoot"
  if (-not (Test-Path $AlphaRoot)) { Problem "$AlphaRoot does not exist"; return }
  Note ('top level: ' + ((Get-ChildItem $AlphaRoot -EA SilentlyContinue | ForEach-Object { $_.Name }) -join ', '))

  $mains = @(Find-Files @($AlphaRoot) @('main.py') 4 |
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
  $fes = @(Find-Files @($AlphaRoot) @('package.json') 4 |
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
  if ($ChatUser -and -not $Watch) {
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
        $logs = @(Find-Files $roots @('*.log', '*.txt', '*.jsonl') 5 |
                  Where-Object { $_.LastWriteTime -ge $since.AddSeconds(-5) } |
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
  if (-not $localBundle) {
    # Empty with the public Host header is not yet "nothing there": Vite answers
    # 403 "Blocked request" to a host it was not told about. Ask again without
    # the header and say which of the two it is.
    $code = (& curl.exe -s -o NUL -w '%{http_code}' --max-time 10 "http://127.0.0.1:$FrontendPort/" 2>$null) -join ''
    $plain = Body "http://127.0.0.1:$FrontendPort/"
    $blocked = (Body "http://127.0.0.1:$FrontendPort/" $PublicHost) -match 'Blocked request'
    $script:frontendStale = $true
    if ($blocked) { Problem "$FrontendPort refuses Host: $PublicHost (Vite 'Blocked request'): add it to preview.allowedHosts in vite.config" }
    elseif (BundleOf $plain) { Problem "$FrontendPort serves $(BundleOf $plain) on 127.0.0.1 but nothing when asked as $PublicHost" }
    elseif ($code -and $code -ne '000') { Problem "$FrontendPort answers HTTP $code with no Alpha page" }
    else { Problem "nothing listens on $FrontendPort (connection refused or timed out)" }
  }
  elseif ($fileBundle -and $localBundle -ne $fileBundle) { $script:frontendStale = $true; Problem "$FrontendPort serves an older build than dist holds; the server needs a restart" }
  else { OK "$FrontendPort serves the build in dist" }
  if ($pubBundle -and $pubBundle -ne $localBundle -and $fileBundle -and $pubBundle -eq $fileBundle) {
    # The public build is the one in this machine's dist, so the public site is
    # this machine; what differs is only which local port the connector uses.
    OK "public site serves this machine's current dist build ($pubBundle), through an origin other than :$FrontendPort"
  } elseif ($pubBundle -and $pubBundle -ne $localBundle) {
    Problem "the public site serves $pubBundle, which this machine's $FrontendPort does not: Cloudflare cache or another origin/connector is answering for $PublicHost"
    # Which local server, if any, has that build.
    $listen = @(Get-NetTCPConnection -State Listen -EA SilentlyContinue | Where-Object { $_.LocalAddress -in '127.0.0.1', '0.0.0.0', '::', '::1' } |
                Select-Object -ExpandProperty LocalPort -Unique)
    foreach ($port in $listen) {
      $p = Owner $port
      if (-not $p -or $p.Name -notmatch '^(node|python|pythonw)\.exe$') { continue }
      $b = BundleOf ((& curl.exe -s --max-time 3 "http://127.0.0.1:$port/" 2>$null) -join "`n")
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
    elseif ($t -eq 'Alpha') { Problem "task $t is not registered: nothing serves the frontend after a reboot" }
    else { Problem "task $t is not registered: repair-alpha-host.ps1 has never completed on this machine" }
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
  # TEMP on a drive that is gone breaks every installer and build that uses it.
  $tq = [IO.Path]::GetPathRoot("$env:TEMP")
  if ($tq -and -not (Test-Path $tq)) { Problem "TEMP points at $env:TEMP, on a drive that is not there (the removed USB?)" }
  Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 8 |
    ForEach-Object { Note ("{0,-28} {1,6:n0} MB  pid {2}" -f $_.ProcessName, ($_.WorkingSet64 / 1MB), $_.Id) }
}

# ------------------------------------------------------------ schedule
$taskName = 'Alpha Doctor'
if ($UninstallSchedule) {
  schtasks.exe /Delete /TN $taskName /F
  exit $LASTEXITCODE
}
if ($InstallSchedule) {
  # As you, only while you are logged on: the report is pushed with your git
  # credentials, which a SYSTEM or S4U task cannot read. Check-only (-Watch);
  # unattended repair is the self-heal task's job, which has the budgets.
  $me = Join-Path $PSScriptRoot 'laptop41-doctor.ps1'
  $tr = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$me`" -Watch -AlphaRoot `"$AlphaRoot`""
  if ($tr.Length -gt 261) { Write-Host "command too long for schtasks ($($tr.Length) chars): move the checkout to a shorter path" -ForegroundColor Red; exit 1 }
  schtasks.exe /Create /TN $taskName /SC MINUTE /MO $EveryMinutes /TR $tr /F
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
           -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
  Set-ScheduledTask -TaskName $taskName -Settings $set | Out-Null
  Start-ScheduledTask -TaskName $taskName
  Write-Host "installed '$taskName': every $EveryMinutes minutes, check-only, first run started now." -ForegroundColor Green
  Write-Host "reports: $reportDir   remove: -UninstallSchedule"
  if (-not $env:ALPHA_ADMIN_TOKEN) {
    Write-Host "to include agents/keys/tasks, store the admin key for your user once:" -ForegroundColor Yellow
    Write-Host "  [Environment]::SetEnvironmentVariable('ALPHA_ADMIN_TOKEN', (Read-Host 'admin key'), 'User')"
  }
  exit 0
}

$script:startedAt = Get-Date
# Which doctor wrote this report: a schedule left on an old checkout reports
# yesterday's advice, and nothing else in the report would say so.
$doctorRev = (git -C $repo log -1 --format='%h %cs' 2>$null | Plain | Out-String).Trim()
Out1 "laptop41-doctor $stamp on $env:COMPUTERNAME  (alpha root $AlphaRoot, checkout $repo @ $doctorRev)"
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

# ------------------------------------------------------------ across runs
# A stable key per problem: digits, hashes and paths of build assets change
# from run to run without the problem changing.
function KeyOf($t) { ("$t" -replace '/assets/[^\s,]+', '<bundle>' -replace '\d+', '#').Trim() }

$statePath = Join-Path $OpsDir 'doctor-state.json'
$prev = $null
if (Test-Path $statePath) { try { $prev = Get-Content $statePath -Raw | ConvertFrom-Json } catch { $prev = $null } }
$now = Get-Date
$open = @{}
foreach ($p in $problems) {
  $k = KeyOf $p
  $was = $null
  if ($prev -and $prev.open) { $was = $prev.open.PSObject.Properties[$k] }
  if ($was) { $open[$k] = @{ text = $p; since = ([datetime]$was.Value.since).ToString('s'); runs = [int]$was.Value.runs + 1 } }
  else      { $open[$k] = @{ text = $p; since = $now.ToString('s'); runs = 1 } }
}
$resolved = @()
if ($prev -and $prev.open) {
  foreach ($pp in $prev.open.PSObject.Properties) { if (-not $open.ContainsKey($pp.Name)) { $resolved += $pp.Value.text } }
}
$escalate = @($open.Values | Where-Object { $_.runs -ge $EscalateAfterRuns })

# ------------------------------------------------------------ recommendations
# Each open problem maps to the one action that clears it; the list is ranked
# by how long the problem has been open, so whatever keeps not getting fixed
# climbs. What is left of the nine is standing hardening, dropped once done.
$rules = @(
  @{ m = 'does not exist$';                                                                     r = 'The Alpha root is missing: point the doctor (and its schedule) at the copy that is actually running, e.g. -AlphaRoot C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software, then -InstallSchedule again with the same -AlphaRoot.' },
  @{ m = 'Self-Heal is not registered|Backend is not registered|repair-alpha-host';          r = 'git pull in C:\services\alpha-tunnel, then run scripts\repair-alpha-host.ps1 -AlphaRoot <the copy that is running> as Administrator (-ReportOnly first): boot task for the backend, frontend build + task, self-heal every 2 min.' },
  @{ m = 'no main\.py defining chat|more than one backend main\.py';                           r = 'The backend on 8001 runs from outside the Alpha root: read its command line in section 0 and re-run with -AlphaRoot <that folder>, so the boot task and the chat fix target the code that is actually running.' },
  @{ m = "chat '.*' failed";                                                                    r = 'Chat answers 500: the traceback in section 2 names the line. Send the report to Claude; do not restart in a loop, it is a code bug, not a crash.' },
  @{ m = 'dictionary bug';                                                                      r = 'Run the doctor once with -Fix as Administrator: apply-chat-fix.ps1 patches the dictionary 500, keeps a backup and restarts the backend.' },
  @{ m = 'no dist|build is older|nothing serves Alpha|older build than dist';                   r = 'Build and serve the frontend: repair-alpha-host.ps1 does it with rollback; by hand it is npm ci; npm run build in the frontend folder, then Start-ScheduledTask Alpha.' },
  @{ m = 'public site serves';                                                                  r = 'alpha-ai.uk is not served by this machine: if section 3 shows cf-cache-status HIT, purge the Cloudflare cache; otherwise stop the other cloudflared connector for this tunnel (a standby laptop started with --cloudflared).' },
  @{ m = "task Alpha is not registered|'Alpha' task does not mention|Alpha .*0xC000013A";      r = "Re-point the 'Alpha' task at the frontend found in section 0 (repair-alpha-host.ps1 does it and keeps the old task exported)." },
  @{ m = 'changed after the backend started';                                                   r = 'Restart the backend so it runs the code on disk: apply-chat-fix.ps1 -Restart, or stop the python on 8001 and let its task start it.' },
  @{ m = 'no coordinator answering';                                                            r = 'Start the alpha-tunnel coordinator as a boot task (docs/HOST_SETUP.md); move-coordinator-here.mjs sets it up but leaves nothing running.' },
  @{ m = 'TEMP points at';                                                                      r = "Point TEMP back at C:: [Environment]::SetEnvironmentVariable('TEMP', `"`$env:LOCALAPPDATA\Temp`", 'User') and the same for TMP, then sign out and in." },
  @{ m = 'RAM free|GB free';                                                                    r = 'Free memory or disk: close the heaviest processes in section 7 that are not Alpha, and clear old dist.prev-* / dist.failed-* folders once a build is known good.' },
  @{ m = 'not answering|answered 0|answers [45]';                                               r = 'An endpoint is down: compare section 1 (backend) and section 4 (public); if only public fails and the origin is fine, the connector is the fault.' }
)
$standing = @(
  @{ done = { Get-ScheduledTask -TaskName 'Alpha Self-Heal' -EA SilentlyContinue };  r = 'Install the self-heal (repair-alpha-host.ps1): it repairs with streaks, cooldowns and budgets, which a 15-minute checker must not.' },
  @{ done = { $env:ALPHA_ADMIN_TOKEN };                                               r = "Store the coordinator admin key for your user so scheduled runs include agents/keys/tasks: [Environment]::SetEnvironmentVariable('ALPHA_ADMIN_TOKEN', (Read-Host 'key'), 'User')." },
  @{ done = { Test-Path (Join-Path $repo '.git') -PathType Container };                r = 'Run this doctor from the real checkout (C:\services\alpha-tunnel, git pull first), then -InstallSchedule -AlphaRoot <the running copy> again from there and remove C:\AlphaData\doctor.' },
  @{ done = { (Get-Service cloudflared -EA SilentlyContinue).StartType -eq 'Automatic' }; r = 'Set the cloudflared service to Automatic start so the public hostname survives a reboot.' },
  @{ done = { Test-Path (Join-Path $OpsDir 'backups') };                               r = 'Back up C:\AlphaData\alpha-ops and the coordinator data\auth.json to another disk; they are the only copy of the repair history and the credentials.' },
  @{ done = { $false };                                                                r = 'Ask Alpha (chat) for a recap of the doctor posts weekly, and read the self-heal log (alpha-ops\logs\selfheal.jsonl) for repairs that repeat.' },
  @{ done = { $false };                                                                r = 'Keep laptop 41 on AC with sleep off (repair-alpha-host step 5); a sleeping host is an outage that no checker can fix.' },
  @{ done = { $false };                                                                r = 'Test a reboot once everything is green: every check here should pass again within 5 minutes with nobody logged in.' },
  @{ done = { $false };                                                                r = 'Rotate the panel and agent keys after the coordinator move: keys issued by the old coordinator are void and should be revoked.' },
  @{ done = { $false };                                                                r = 'Set Windows Update active hours around when Alpha is used, so a forced restart lands when nobody needs it.' },
  @{ done = { $false };                                                                r = 'Remove what does not belong on the host once it is green: the ChatGPT app and other heavy tools in section 7 compete with Alpha for the same 16 GB.' }
)
$recs = New-Object System.Collections.ArrayList
foreach ($o in ($open.Values | Sort-Object { -$_.runs })) {
  foreach ($rule in $rules) {
    if ($o.text -match $rule.m -and -not ($recs | Where-Object { $_.r -eq $rule.r })) {
      $age = if ($o.runs -eq 1) { 'new' } else { "open $($o.runs) runs" }
      $who = if ($o.runs -ge $EscalateAfterRuns) { ' NEEDS A PERSON' } else { '' }
      [void]$recs.Add(@{ r = $rule.r; tag = "[$age$who]" }); break
    }
  }
}
foreach ($st in $standing) {
  if ($recs.Count -ge 9) { break }
  $isDone = $false; try { $isDone = [bool](& $st.done) } catch {}
  if (-not $isDone) { [void]$recs.Add(@{ r = $st.r; tag = '[hardening]' }) }
}

Section 'SUMMARY'
Note ("this pass took {0:n0}s" -f ((Get-Date) - $script:startedAt).TotalSeconds)
if ($problems.Count -eq 0) { OK 'no problems found' }
foreach ($o in ($open.Values | Sort-Object { -$_.runs })) {
  $flag = if ($o.runs -ge $EscalateAfterRuns) { 'NEEDS A PERSON - ' } else { '' }
  Out1 ("  - {0}{1}  (open {2} run(s), since {3})" -f $flag, $o.text, $o.runs, $o.since) 'Red'
}
foreach ($r in $resolved) { Out1 "  + fixed since last run: $r" 'Green' }

Section 'RECOMMENDATIONS (ranked; re-ranked every run)'
$n = 0
foreach ($rc in ($recs | Select-Object -First 9)) { $n++; Out1 ("  {0}. {1} {2}" -f $n, $rc.tag, $rc.r) }

# ------------------------------------------------------------ write
# Never let a credential reach the file: tunnel tokens, JWTs, bearer headers.
function Redact($t) {
  $t = [regex]::Replace("$t", 'alpha_[a-z]+_[A-Za-z0-9]+\.[A-Za-z0-9_\-]+', 'alpha_<redacted>')
  $t = [regex]::Replace($t, 'eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+', '<jwt redacted>')
  return [regex]::Replace($t, '(?i)(bearer\s+)\S+', '$1<redacted>')
}
$text = Redact ($lines -join "`r`n")
[IO.File]::WriteAllText($report, $text, (New-Object Text.UTF8Encoding($false)))
Copy-Item $report (Join-Path $reportDir 'latest.txt') -Force
# Keep a day of 15-minute reports, not a year of them.
Get-ChildItem $reportDir -Filter 'laptop41-doctor-*.txt' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 100 | Remove-Item -Force -EA SilentlyContinue
Write-Host "`nreport: $report"

# ------------------------------------------------------------ tell Alpha
# On a change, and hourly while anything is open: every 15 minutes is noise
# nobody reads.
$changed = (-not $prev) -or ($resolved.Count -gt 0) -or (@($open.Values | Where-Object { $_.runs -eq 1 }).Count -gt 0)
$lastPost = if ($prev -and $prev.lastPost) { [datetime]$prev.lastPost } else { [datetime]::MinValue }
$due = $changed -or (($open.Count -gt 0) -and (($now - $lastPost).TotalMinutes -ge 60))
$posted = $false
if ($Watch -and $due) {
  $co = Find-Files @($AlphaRoot) @('alpha_coordination_tunnel.ps1') 3 | Select-Object -First 1
  $head = if ($open.Count -eq 0) { 'Alpha host check: all green.' } else { "Alpha host check: $($open.Count) open problem(s), $($escalate.Count) need a person." }
  $body = @($head)
  foreach ($o in ($open.Values | Sort-Object { -$_.runs } | Select-Object -First 5)) { $body += "- $($o.text) [open $($o.runs) runs]" }
  foreach ($r in $resolved) { $body += "+ fixed: $r" }
  $top = @($recs | Select-Object -First 3)
  for ($j = 0; $j -lt $top.Count; $j++) { $body += "Next $($j + 1): $($top[$j].r)" }
  $msg = Redact ($body -join "`n")
  if ($msg.Length -gt 3900) { $msg = $msg.Substring(0, 3900) }
  if ($co) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $co.FullName -Action Post -Actor 'alpha-doctor' -Message $msg 2>&1 | Out-Null
    $posted = ($LASTEXITCODE -eq 0)
    Write-Host ("posted to Alpha: {0}" -f $posted)
  } else { Write-Host "no alpha_coordination_tunnel.ps1 under $AlphaRoot - not posted" -ForegroundColor Yellow }
}

# ------------------------------------------------------------ relay the cloud
# The other direction. A scheduled cloud Claude session cannot reach the
# tailnet, so it writes its report to the status/cloud branch every 30
# minutes; this passes each new one to Alpha's coordination tunnel, where
# Alpha and Codex read. Posted once per report: the commit id is remembered.
$cloudSeen = if ($prev -and $prev.cloudSeen) { [string]$prev.cloudSeen } else { $null }
if ($Watch) {
  git -C $repo fetch -q origin status/cloud 2>&1 | Plain | Out-Null
  if ($LASTEXITCODE -eq 0) {
    $cloudHead = (git -C $repo rev-parse FETCH_HEAD 2>$null | Out-String).Trim()
    if ($cloudHead -and $cloudHead -ne $cloudSeen) {
      $cloudMsg = (git -C $repo show 'FETCH_HEAD:reports/cloud.md' 2>$null | Out-String).Trim()
      $co = Find-Files @($AlphaRoot) @('alpha_coordination_tunnel.ps1') 3 | Select-Object -First 1
      if ($cloudMsg -and $co) {
        $cloudMsg = Redact $cloudMsg
        if ($cloudMsg.Length -gt 3900) { $cloudMsg = $cloudMsg.Substring(0, 3900) }
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $co.FullName -Action Post -Actor 'claude-cloud' -Message $cloudMsg 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { $cloudSeen = $cloudHead; Write-Host 'relayed the cloud report to Alpha' }
        else { Write-Host 'could not relay the cloud report to Alpha; will retry next run' -ForegroundColor Yellow }
      }
    }
  }
}

$state = @{ lastRun = $now.ToString('s'); lastPost = $(if ($posted) { $now.ToString('s') } elseif ($prev) { $prev.lastPost } else { $null }); cloudSeen = $cloudSeen; open = $open }
$state | ConvertTo-Json -Depth 5 | Set-Content -Path $statePath -Encoding ASCII

# ------------------------------------------------------------ push
# One branch, status/laptop41, fast-forwarded each time, so it is one place to
# read rather than a branch per run. Scheduled runs push when Alpha is told.
if ($Push -or ($Watch -and $due)) {
  $branch = 'status/laptop41'
  $wt = Join-Path $tmpDir "push-$stamp"
  git -C $repo fetch -q origin $branch 2>&1 | Plain | Out-Null
  $base = if ($LASTEXITCODE -eq 0) { 'FETCH_HEAD' } else { 'HEAD' }
  git -C $repo worktree add --detach $wt $base 2>&1 | Plain | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Host "could not create a git worktree; attach $report instead" -ForegroundColor Yellow }
  else {
    New-Item -ItemType Directory -Force -Path (Join-Path $wt 'reports') | Out-Null
    Copy-Item $report (Join-Path $wt 'reports\latest.txt') -Force
    Copy-Item $statePath (Join-Path $wt 'reports\doctor-state.json') -Force
    git -C $wt add reports 2>&1 | Plain | Out-Null
    git -C $wt -c user.name=laptop41-doctor -c user.email=doctor@laptop41.invalid commit -q -m "laptop41 doctor ${stamp}: $($open.Count) open" 2>&1 | Plain | Out-Null
    git -C $wt push origin "HEAD:refs/heads/$branch" 2>&1 | Plain | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -eq 0) { Write-Host "pushed to $branch - tell Claude 'doctor pushed'" -ForegroundColor Green }
    else { Write-Host "push failed; attach $report instead" -ForegroundColor Yellow }
    git -C $repo worktree remove --force $wt 2>&1 | Plain | Out-Null
  }
}

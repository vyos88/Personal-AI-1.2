<#
  start-alpha-at-boot.ps1 - make the Alpha server the Cloudflare tunnel points
  at (127.0.0.1:4173) start when the machine boots, and come back if it dies.

  Run as Administrator, from PowerShell:
      powershell -ExecutionPolicy Bypass -File .\start-alpha-at-boot.ps1

  Undo it:
      powershell -ExecutionPolicy Bypass -File .\start-alpha-at-boot.ps1 -Remove

  Why this exists: fix-cloudflare.ps1 made the tunnel a service, so after a
  reboot the tunnel comes back - and serves 502, because nothing started the
  site behind it.

  What it does:
    1. finds Alpha the way cleanup-alpha.ps1 does: by its shell file,
       <root>\frontend\src\app\shell\AppShell.tsx, never by assumed path;
    2. picks the npm script that serves the port (the one naming the port or
       running "vite preview"), and stops to ask if that is not clear-cut;
    3. registers a scheduled task "Alpha" that runs at boot, as you, whether
       or not anyone logs in (S4U: no password is stored), and restarts the
       server ten seconds after it exits;
    4. starts it now and checks the port answers.

  Scheduled task, not a service: npm is a .cmd, a service cannot host one
  without a wrapper exe, and the task runs with your user environment - so
  anything Alpha reads from your user variables is still there.

  The backend (software\backend\main.py - speech, avatar, robot) gets a
  task of its own, "Alpha Backend", with the same restart loop. Its command
  is read from main.py rather than assumed:
    - Python: the backend's own .venv first, then python on PATH - never the
      Microsoft Store alias, which opens the Store instead of running;
    - main.py that starts its own server (uvicorn.run / app.run / __main__)
      runs as "python main.py"; one that only defines a FastAPI app runs
      under "python -m uvicorn main:app";
    - the port it is checked on comes from main.py, else from the frontend's
      vite proxy, else 8000. -BackendPort overrides; -NoBackend skips it.
#>

param(
  [string]$AlphaRoot = '',
  [string]$Script = '',
  [int]$Port = 4173,
  [string]$TaskName = 'Alpha',
  [string]$BackendTaskName = 'Alpha Backend',
  [int]$BackendPort = 0,
  [switch]$NoBackend,
  [switch]$Remove
)

$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'start-alpha-at-boot-log.txt'
Start-Transcript -Path $log -Force | Out-Null

$problems = New-Object System.Collections.ArrayList
function Problem($t) { [void]$problems.Add($t); Write-Host "  PROBLEM: $t" -ForegroundColor Red }
function OK($t)      { Write-Host "  ok: $t" -ForegroundColor Green }
function Note($t)    { Write-Host "  $t" }
function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Finish($code) {
  Section "VERDICT"
  if ($problems.Count -eq 0) { Write-Host "Done." -ForegroundColor Green }
  else {
    Write-Host "$($problems.Count) problem(s):" -ForegroundColor Yellow
    $i = 1; foreach ($p in $problems) { Write-Host "  $i. $p"; $i++ }
  }
  Write-Host "`nLog: $log`n"
  Stop-Transcript | Out-Null
  exit $code
}

$bootDir    = Join-Path $env:ProgramData 'AlphaBoot'
$wrapper    = Join-Path $bootDir 'run-alpha.cmd'
$appLog     = Join-Path $bootDir 'alpha.log'
$beWrapper  = Join-Path $bootDir 'run-alpha-backend.cmd'
$beLog      = Join-Path $bootDir 'alpha-backend.log'

# curl.exe ships with Windows 10+ and, unlike Windows PowerShell 5's
# Invoke-WebRequest, can skip the check on a self-signed certificate.
function HttpCode($url) {
  $code = & curl.exe -s -k -o NUL -w '%{http_code}' --max-time 5 $url 2>$null
  if (-not $code) { return '000' }
  return "$code"
}
# Any HTTP answer at all - a 404 included - means something is serving.
function Answering($p) {
  foreach ($u in @("https://127.0.0.1:$p/", "http://127.0.0.1:$p/")) {
    if ((HttpCode $u) -ne '000') { return $u }
  }
  return $null
}
function Wait-Up($p, $seconds) {
  for ($i = 0; $i -lt [math]::Ceiling($seconds / 3); $i++) {
    Start-Sleep -Seconds 3
    $u = Answering $p
    if ($u) { return $u }
  }
  return $null
}

# The task's action is cmd.exe; Stop-ScheduledTask ends cmd and can leave the
# server holding the port, so the whole tree is taken down by hand.
function Stop-Wrapper($name, $path) {
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -EA SilentlyContinue |
             Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($path, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
  Stop-ScheduledTask -TaskName $name -EA SilentlyContinue
  foreach ($p in $procs) { taskkill.exe /T /F /PID $p.ProcessId 2>&1 | Out-Null }
  return $procs.Count
}

# One restart loop per server. ping, not timeout: timeout refuses to run
# without a console to read from, which is exactly how a scheduled task runs.
# A space before every >>: an argument ending in a digit would otherwise be
# read by cmd as a handle number ("4173>>").
function Write-Loop($path, $dir, $envLines, $exe, $arguments, $logFile) {
  $lines = @('@echo off', 'rem Written by start-alpha-at-boot.ps1. Re-run that script instead of editing.')
  $lines += $envLines
  $lines += @(
    "cd /d `"$dir`"",
    ':loop',
    "echo [%date% %time%] starting: $arguments >> `"$logFile`"",
    "call `"$exe`" $arguments >> `"$logFile`" 2>&1",
    "echo [%date% %time%] exited %errorlevel%, restarting in 10s >> `"$logFile`"",
    'ping -n 11 127.0.0.1 > nul',
    'goto loop')
  $lines | Set-Content -Path $path -Encoding ascii
}

function Register-Boot($name, $path, $delay, $description) {
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $action    = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$path`""
  $trigger   = New-ScheduledTaskTrigger -AtStartup
  $trigger.Delay = $delay
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Highest
  $settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable `
                 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
  try {
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal `
      -Settings $settings -Description $description -Force -EA Stop | Out-Null
    OK "task '$name' registered: runs at boot as $user, whether or not anyone logs in"
    return $true
  } catch {
    Problem "Could not register '$name': $($_.Exception.Message)"
    return $false
  }
}

function Start-AndCheck($name, $p, $logFile, $what) {
  $already = Answering $p
  if ($already) {
    Note "Something already answers on $already - probably $what started by hand."
    Note "Left alone. The task takes over at the next boot, or now if you stop that one and run:"
    Note "  Start-ScheduledTask '$name'"
    return $already
  }
  Start-ScheduledTask -TaskName $name
  $up = Wait-Up $p 90
  if ($up) { OK "$what answers on $up" }
  else {
    Problem "$what started, but nothing answers on port $p after 90s. Its output:"
    Get-Content $logFile -Tail 25 -EA SilentlyContinue | ForEach-Object { Note "  $_" }
  }
  return $up
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Problem "Not elevated. Registering a boot task needs Administrator."
  Finish 1
}

# ---------------------------------------------------------------- remove
if ($Remove) {
  Section "Removing the boot tasks"
  foreach ($t in @(@($TaskName, $wrapper), @($BackendTaskName, $beWrapper))) {
    $n = Stop-Wrapper $t[0] $t[1]
    Note "'$($t[0])': stopped $n running copy(ies)"
    if (Get-ScheduledTask -TaskName $t[0] -EA SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $t[0] -Confirm:$false
      OK "task '$($t[0])' removed"
    } else { Note "no task '$($t[0])' was registered" }
  }
  Note "Left in place: $bootDir (the wrappers and logs)"
  Finish 0
}

# ---------------------------------------------------------------- 1. find Alpha
Section "1. Where Alpha lives"
$suffix = '\frontend\src\app\shell'
if ($AlphaRoot) {
  if (-not (Test-Path (Join-Path $AlphaRoot "$suffix\AppShell.tsx"))) {
    Problem "$AlphaRoot does not look like Alpha (no frontend\src\app\shell\AppShell.tsx)."
    Finish 1
  }
  $copies = @((Resolve-Path $AlphaRoot).Path)
} else {
  # Top-level folders of every fixed drive, minus Windows' own, plus the
  # usual places under the profile. Depth 7 reaches <x>\<root>\frontend\...
  $skip = 'Windows|Program Files|Program Files \(x86\)|ProgramData|\$Recycle\.Bin|System Volume Information|Users|PerfLogs|Recovery'
  $roots = @()
  foreach ($d in (Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Free -ne $null })) {
    $roots += @(Get-ChildItem "$($d.Root)" -Directory -Force -EA SilentlyContinue |
                Where-Object { $_.Name -notmatch "^($skip)$" } | ForEach-Object FullName)
  }
  $roots += @(Get-ChildItem $env:USERPROFILE -Directory -Force -EA SilentlyContinue |
              Where-Object { $_.Name -notmatch '^(AppData|\..*)$' } | ForEach-Object FullName)
  $copies = @()
  foreach ($r in $roots) {
    Get-ChildItem $r -Recurse -Depth 7 -Filter 'AppShell.tsx' -File -Force -EA SilentlyContinue |
      Where-Object { $_.FullName -notmatch '\\node_modules\\' -and
                     $_.Directory.FullName.EndsWith($suffix, [StringComparison]::OrdinalIgnoreCase) } |
      ForEach-Object { $d = $_.Directory.FullName; $copies += $d.Substring(0, $d.Length - $suffix.Length) }
  }
  # Installer staging, backups and archives hold copies of Alpha; none of
  # them is the one to serve.
  $copies = @($copies | Select-Object -Unique |
              Where-Object { $_ -notmatch '\\(BuildArtifacts|Backups?|Archive|AlphaOld)(\\|$)' })
}
if ($copies.Count -eq 0) {
  Problem "No Alpha found on this machine (looked for frontend\src\app\shell\AppShell.tsx)."
  Note "Point at it:  .\start-alpha-at-boot.ps1 -AlphaRoot <the folder holding 'frontend'>"
  Finish 1
}

# The copy to serve is the one with a runnable package.json. More than one
# of those is a choice this script does not get to make.
$candidates = @()
foreach ($c in $copies) {
  foreach ($dir in @((Join-Path $c 'frontend'), $c)) {
    $pj = Join-Path $dir 'package.json'
    if (Test-Path $pj) {
      try { $json = Get-Content $pj -Raw | ConvertFrom-Json } catch { continue }
      if ($json.scripts) { $candidates += [pscustomobject]@{ Root = $c; Dir = $dir; Scripts = $json.scripts }; break }
    }
  }
}
foreach ($c in $copies) { Note "found Alpha at $c" }
if ($candidates.Count -eq 0) {
  Problem "Found Alpha, but no package.json with scripts in it or its frontend folder."
  Finish 1
}
if ($candidates.Count -gt 1) {
  # The verdict is what gets read, so the choice goes in it, with what tells
  # the copies apart: their own version, and when their shell last changed.
  $rows = foreach ($c in $candidates) {
    $shell = Join-Path $c.Root "$suffix\AppShell.tsx"
    $ver = if ((Get-Content $shell -Raw -EA SilentlyContinue) -match 'ALPHA_VERSION\s*=\s*["'']([^"'']+)') { $Matches[1] } else { '?' }
    "    -AlphaRoot `"$($c.Root)`"   (version $ver, changed $((Get-Item $shell).LastWriteTime.ToString('yyyy-MM-dd HH:mm')))"
  }
  Problem ("More than one runnable Alpha. Re-run with the one you use:`n" + ($rows -join "`n"))
  Finish 1
}
$app = $candidates[0]
OK "serving from $($app.Dir)"

$backend = @('software\backend', 'backend') | ForEach-Object { Join-Path $app.Root $_ } |
           Where-Object { Test-Path (Join-Path $_ 'main.py') } | Select-Object -First 1
if ($backend) { OK "backend: $backend" }

# ---------------------------------------------------------------- 2. which script
Section "2. Which npm script serves port $Port"
$names = @($app.Scripts.PSObject.Properties | ForEach-Object Name)
foreach ($n in $names) { Note ("{0,-14} {1}" -f $n, $app.Scripts.$n) }
if (-not $Script) {
  $byPort    = @($names | Where-Object { "$($app.Scripts.$_)" -match "\b$Port\b" })
  $byPreview = @($names | Where-Object { "$($app.Scripts.$_)" -match 'vite\s+preview' })
  if     ($byPort.Count -eq 1)    { $Script = $byPort[0] }
  elseif ($byPreview.Count -eq 1) { $Script = $byPreview[0] }
  elseif ($names -contains 'preview' -and $Port -eq 4173) { $Script = 'preview' }
}
if (-not $Script -or $names -notcontains $Script) {
  Problem "Cannot tell which script serves port $Port. Re-run naming it, e.g.:  -Script start"
  Finish 1
}
$cmdline = "$($app.Scripts.$Script)"
OK "npm run $Script   ($cmdline)"

# vite binds "localhost", which Node on Windows may resolve to ::1 only, while
# the tunnel dials 127.0.0.1. Pin host and port unless the script already does.
$extra = @()
if ($cmdline -match '\bvite\b') {
  # Loopback only: the tunnel is how anything else reaches it.
  if ($cmdline -notmatch '--host')  { $extra += '--host', '127.0.0.1' }
  if ($cmdline -notmatch '--port')  { $extra += '--port', "$Port" }
  if ($cmdline -notmatch '--strictPort') { $extra += '--strictPort' }
}
$npmArgs = "run $Script"
if ($extra.Count) {
  $npmArgs += " -- $($extra -join ' ')"
  Note "adding: $($extra -join ' ')"
  if ($extra -contains '--host') { Note "(listens on this machine only; phones and laptops reach it through alpha-ai.uk)" }
}

$npm = (Get-Command npm.cmd -EA SilentlyContinue).Source
if (-not $npm) { Problem "npm.cmd is not on PATH. Install Node.js LTS first."; Finish 1 }
$nodeDir = Split-Path $npm
OK "npm: $npm"

# "vite preview" serves the last build; without one it serves nothing.
if ($cmdline -match 'vite\s+preview' -and -not (Test-Path (Join-Path $app.Dir 'dist\index.html'))) {
  if ($names -contains 'build') {
    Note "no dist\ yet - running 'npm run build' once (this can take a minute)"
    Push-Location $app.Dir
    & $npm run build 2>&1 | Select-Object -Last 15 | ForEach-Object { Note "$_" }
    $built = $LASTEXITCODE
    Pop-Location
    if ($built -ne 0) { Problem "'npm run build' failed (exit $built) - see above."; Finish 1 }
    OK "built"
  } else { Problem "'vite preview' needs dist\ and there is no build script."; Finish 1 }
}

# ---------------------------------------------------------------- 3. backend
$beUp = $null
if ($NoBackend) {
  Section "3. Backend"
  Note "skipped (-NoBackend)"
} elseif (-not $backend) {
  Section "3. Backend"
  Note "No backend\main.py beside the frontend - nothing to start."
} else {
  Section "3. Backend ($backend)"
  $main = Get-Content (Join-Path $backend 'main.py') -Raw

  # The backend's own environment first: that is where its packages are.
  $py = @('backend\.venv', 'backend\venv', '.venv', 'venv') |
        ForEach-Object { Join-Path (Split-Path $backend) "$_\Scripts\python.exe" } |
        Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $py) {
    $py = @(Get-Command python.exe -All -EA SilentlyContinue | ForEach-Object Source |
            Where-Object { $_ -notmatch '\\WindowsApps\\' }) | Select-Object -First 1
  }
  if (-not $py -and (Get-Command py.exe -EA SilentlyContinue)) {
    $py = (& py.exe -3 -c "import sys; print(sys.executable)" 2>$null | Select-Object -First 1)
  }
  if (-not $py -or -not (Test-Path $py)) {
    Problem "No Python found for the backend (only the Microsoft Store placeholder, or none). Install Python 3 from python.org, then re-run."
  } else {
    OK "python: $py"

    if (-not $BackendPort) {
      if ($main -match 'port\s*=\s*(\d{4,5})') { $BackendPort = [int]$Matches[1] }
      else {
        $vite = Get-ChildItem $app.Dir -Filter 'vite.config.*' -File -EA SilentlyContinue | Select-Object -First 1
        $vc = if ($vite) { Get-Content $vite.FullName -Raw } else { '' }
        $ports = @([regex]::Matches($vc, '(?:127\.0\.0\.1|localhost|0\.0\.0\.0):(\d{4,5})') |
                   ForEach-Object { [int]$_.Groups[1].Value } | Where-Object { $_ -ne $Port -and $_ -ne 5173 } |
                   Select-Object -Unique)
        $BackendPort = if ($ports.Count) { $ports[0] } else { 8000 }
      }
    }
    Note "port: $BackendPort"

    $selfServing = $main -match 'uvicorn\.run\(|\.run\(\s*app|app\.run\(|__name__\s*==\s*[''"]__main__'
    if ($selfServing) {
      $pyArgs = 'main.py'
    } elseif ($main -match 'FastAPI\(') {
      $pyArgs = "-m uvicorn main:app --host 127.0.0.1 --port $BackendPort"
      & $py -c "import uvicorn" 2>$null
      if ($LASTEXITCODE -ne 0) { Problem "main.py needs uvicorn, and $py does not have it:  `"$py`" -m pip install uvicorn fastapi" }
    } else {
      $pyArgs = 'main.py'
    }
    OK "command: python $pyArgs"

    New-Item -ItemType Directory -Force -Path $bootDir | Out-Null
    # Unbuffered so the log is live; UTF-8 because a print() of any non-ASCII
    # character to a redirected cp1252 stdout raises and kills the backend.
    Write-Loop $beWrapper $backend @('set PYTHONUNBUFFERED=1', 'set PYTHONIOENCODING=utf-8') $py $pyArgs $beLog
    OK "wrapper: $beWrapper"
    $n = Stop-Wrapper $BackendTaskName $beWrapper
    if ($n) { Note "stopped the previous backend boot-task copy ($n)" }
    if (Register-Boot $BackendTaskName $beWrapper 'PT20S' "Alpha backend on 127.0.0.1:$BackendPort (start-alpha-at-boot.ps1)") {
      $beUp = Start-AndCheck $BackendTaskName $BackendPort $beLog 'the backend'
    }
    Note "Backend log: $beLog"
  }
}

# ---------------------------------------------------------------- 4. site
Section "4. Web server '$TaskName' (port $Port)"
New-Item -ItemType Directory -Force -Path $bootDir | Out-Null
Write-Loop $wrapper $app.Dir @("set `"PATH=$nodeDir;%PATH%`"") $npm $npmArgs $appLog
OK "wrapper: $wrapper"
$n = Stop-Wrapper $TaskName $wrapper
if ($n) { Note "stopped the previous boot-task copy ($n)" }
if (Register-Boot $TaskName $wrapper 'PT30S' "Alpha web server on 127.0.0.1:$Port (start-alpha-at-boot.ps1)") {
  $up = Start-AndCheck $TaskName $Port $appLog 'Alpha'
  if ($up -like 'http:*') {
    Note "It speaks plain http. If the tunnel still sends https, re-run fix-cloudflare.ps1: it fixes that."
  }
}
Note "Server log: $appLog"
Finish $(if ($problems.Count) { 1 } else { 0 })

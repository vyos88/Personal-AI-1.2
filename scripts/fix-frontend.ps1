<#
  fix-frontend.ps1 - diagnose, and on request repair, Alpha's production
  frontend on the main host (laptop 41), so that alpha-ai.uk stops returning
  Cloudflare 502.

  REPORT ONLY (the default - it changes nothing):
      powershell -ExecutionPolicy Bypass -File .\fix-frontend.ps1

  REPAIR, from an elevated PowerShell, after reading the report:
      powershell -ExecutionPolicy Bypass -File .\fix-frontend.ps1 -Repair
      (add -Build if the report says dist\index.html is missing)

  ROLL BACK to the exact task that was there before -Repair:
      powershell -ExecutionPolicy Bypass -File .\fix-frontend.ps1 -Rollback <path printed by -Repair>

  Everything it prints is also written to fix-frontend-log.txt beside it.

  What -Repair changes, and nothing else:
    - exports the existing "Alpha" task to <Landing>\Backups\ first
    - copies alpha-frontend-run.ps1 to <Landing>\ops\
    - stops the "Alpha" task and the vite processes serving THIS frontend
      directory (identified by command line; nothing else is stopped)
    - re-registers "Alpha" at the same path: runs at boot whether or not anyone
      is logged on, on battery too, no 72-hour time limit, one instance, plus
      a 5-minute re-trigger that is a no-op while it is already running
    - runs `npm run build` only if you pass -Build

  What it never touches: Cloudflare DNS, WAF, Access, tunnel credentials or
  cloudflared's config; the backend on 8001; any installed program; any
  process it cannot prove is this frontend's. cloudflared and the backend are
  REPORTED, so a failure there is evidence, not a change.
#>

param(
  [string]$TaskName    = 'Alpha',
  [string]$AlphaRoot   = 'C:\AlphaData\Alpha',
  [string]$Landing     = 'C:\AlphaData',
  [int]$Port           = 4173,
  [int]$DevPort        = 5173,
  [int]$BackendPort    = 8001,
  [string]$Bind        = '127.0.0.1',
  [string]$PublicUrl   = 'https://alpha-ai.uk',
  [switch]$Repair,
  [switch]$Build,
  [switch]$UsePassword,
  [string]$Rollback
)

$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'fix-frontend-log.txt'
Start-Transcript -Path $log -Force | Out-Null

$problems = New-Object System.Collections.ArrayList
function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function OK($t)      { Write-Host "  ok: $t" -ForegroundColor Green }
function Warn($t)    { Write-Host "  $t" -ForegroundColor Yellow }
function Note($t)    { Write-Host "     $t" -ForegroundColor DarkGray }
function Problem($t) { [void]$problems.Add($t); Write-Host "  PROBLEM: $t" -ForegroundColor Red }
function Die($t)     { Write-Host "  STOP: $t" -ForegroundColor Red; Stop-Transcript | Out-Null; exit 1 }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# One HTTP probe that reports a status for every outcome. Invoke-WebRequest
# throws on anything but 2xx, and a 502 from Cloudflare is exactly the answer
# we want to read, not an exception to swallow.
function Probe($url, $method = 'GET', $body = $null) {
  $r = [pscustomobject]@{ Url = $url; Code = 0; Body = ''; CfRay = ''; Server = ''; Error = '' }
  try {
    $p = @{ Uri = $url; Method = $method; TimeoutSec = 15; UseBasicParsing = $true; MaximumRedirection = 0 }
    if ($body -ne $null) { $p.Body = $body; $p.ContentType = 'application/json' }
    $resp = Invoke-WebRequest @p -EA Stop
    $r.Code = [int]$resp.StatusCode
    $r.Body = if ($resp.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($resp.Content) } else { [string]$resp.Content }
    $r.CfRay = [string]$resp.Headers['CF-RAY']; $r.Server = [string]$resp.Headers['Server']
  } catch {
    # Windows PowerShell 5.1 hands back a WebResponse; PowerShell 7 an
    # HttpResponseMessage with the body in ErrorDetails. Read either.
    $resp = $_.Exception.Response
    if ($resp) {
      try { $r.Code = [int]$resp.StatusCode } catch {}
      if ($resp -is [Net.WebResponse]) {
        try { $r.CfRay = [string]$resp.Headers['CF-RAY']; $r.Server = [string]$resp.Headers['Server'] } catch {}
        try { $r.Body = (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd() } catch {}
      } else {
        try { $r.CfRay = ($resp.Headers.GetValues('CF-RAY') -join ',') } catch {}
        try { $r.Server = ($resp.Headers.GetValues('Server') -join ',') } catch {}
        if ($_.ErrorDetails) { $r.Body = [string]$_.ErrorDetails.Message }
      }
    }
    $r.Error = $_.Exception.Message
  }
  return $r
}

function CmdLine($procId) {
  (Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -EA SilentlyContinue).CommandLine
}

function Listener($port) {
  $l = Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue
  foreach ($c in $l) {
    [pscustomobject]@{ Port = $port; Address = $c.LocalAddress; Pid = $c.OwningProcess
                       Name = (Get-Process -Id $c.OwningProcess -EA SilentlyContinue).ProcessName
                       Cmd  = CmdLine $c.OwningProcess }
  }
}

$frontend = Join-Path $AlphaRoot 'frontend'
$vite     = Join-Path $frontend 'node_modules\vite\bin\vite.js'
$opsDir   = Join-Path $Landing 'ops'
$logDir   = Join-Path $Landing 'logs'
$backups  = Join-Path $Landing 'Backups'

# ================================================================ ROLLBACK
if ($Rollback) {
  Section "Rollback: restoring $TaskName from $Rollback"
  if (-not $admin) { Die "Rollback must run elevated." }
  if (-not (Test-Path $Rollback)) { Die "$Rollback does not exist." }
  $xml = Get-Content $Rollback -Raw
  $path = '\'
  $m = [regex]::Match($xml, '<URI>(.*)\\[^\\]+</URI>')
  if ($m.Success) { $path = $m.Groups[1].Value + '\' }
  Stop-ScheduledTask -TaskName $TaskName -TaskPath $path -EA SilentlyContinue
  $pidFile = Join-Path $logDir 'frontend.pid'
  if (Test-Path $pidFile) { Stop-Process -Id ([int](Get-Content $pidFile | Select-Object -First 1)) -Force -EA SilentlyContinue }
  if ($xml -match '<LogonType>Password</LogonType>') {
    $cred = Get-Credential -Message "The original task stored a password; enter it to restore"
    Register-ScheduledTask -Xml $xml -TaskName $TaskName -TaskPath $path -User $cred.UserName `
      -Password $cred.GetNetworkCredential().Password -Force | Out-Null
  } else {
    Register-ScheduledTask -Xml $xml -TaskName $TaskName -TaskPath $path -Force | Out-Null
  }
  OK "restored. Start it with: Start-ScheduledTask -TaskName '$TaskName' -TaskPath '$path'"
  Stop-Transcript | Out-Null; exit 0
}

if (-not $admin) {
  Warn "Not elevated: the report still runs, but a SYSTEM/S4U task's processes and"
  Warn "other users' command lines may be hidden. -Repair requires elevation."
}

# ================================================================ 1. the task
Section "1. Scheduled task '$TaskName' - exact program, arguments, directory"
$tasks = @(Get-ScheduledTask -TaskName $TaskName -EA SilentlyContinue)
$task  = $null
if (-not $tasks) {
  Problem "No scheduled task named '$TaskName'."
  Note "Tasks that look related:"
  Get-ScheduledTask -EA SilentlyContinue | Where-Object {
    ($_.TaskName -match 'alpha|vite|frontend') -or (($_.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -match 'alpha|vite|4173')
  } | ForEach-Object { Note "$($_.TaskPath)$($_.TaskName)  [$($_.State)]" }
} else {
  if ($tasks.Count -gt 1) { Warn "$($tasks.Count) tasks named '$TaskName' in different folders; all are shown, the first is repaired." }
  $task = $tasks[0]
  foreach ($t in $tasks) {
    $info = Get-ScheduledTaskInfo -TaskName $t.TaskName -TaskPath $t.TaskPath -EA SilentlyContinue
    Write-Host ("  {0}{1}  state={2}" -f $t.TaskPath, $t.TaskName, $t.State)
    $i = 0
    foreach ($a in $t.Actions) {
      $i++
      Write-Host "    action $i Execute          : $($a.Execute)"
      Write-Host "    action $i Arguments        : $($a.Arguments)"
      Write-Host "    action $i WorkingDirectory : $($a.WorkingDirectory)"
    }
    $pr = $t.Principal; $st = $t.Settings
    Write-Host "    principal : $($pr.UserId)  logon=$($pr.LogonType)  runlevel=$($pr.RunLevel)"
    Write-Host "    triggers  : $(($t.Triggers | ForEach-Object { $_.CimClass.CimClassName -replace 'MSFT_Task','' -replace 'Trigger','' }) -join ', ')"
    Write-Host "    settings  : timelimit=$($st.ExecutionTimeLimit)  instances=$($st.MultipleInstances)  noStartOnBattery=$($st.DisallowStartIfOnBatteries)  stopOnBattery=$($st.StopIfGoingOnBatteries)  restartCount=$($st.RestartCount)"
    if ($info) {
      Write-Host ("    last run  : {0}  result=0x{1:X}  next={2}  missed={3}" -f $info.LastRunTime, $info.LastTaskResult, $info.NextRunTime, $info.NumberOfMissedRuns)
    }

    # Each of these is a reason a task can say Running or Ready and not be
    # serving, or be serving until logout/reboot and then not.
    if ($pr.LogonType -eq 'Interactive' -or $pr.LogonType -eq 'InteractiveOrPassword') {
      Problem "runs only in an interactive session (logon=$($pr.LogonType)): it stops at logout and does not start at boot until someone logs on."
    }
    if (-not ($t.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger' })) {
      Problem "no At-startup trigger: nothing starts the frontend after a reboot until the other triggers fire."
    }
    if ($st.DisallowStartIfOnBatteries -or $st.StopIfGoingOnBatteries) {
      Problem "battery conditions are on (the default): on this laptop the task will not start, or is killed, off mains power."
    }
    if ($st.ExecutionTimeLimit -and $st.ExecutionTimeLimit -ne 'PT0S') {
      Problem "execution time limit $($st.ExecutionTimeLimit): Task Scheduler kills the server when it is reached."
    }
    foreach ($a in $t.Actions) {
      $line = "$($a.Execute) $($a.Arguments)"
      if ($line -match '\bdev\b' -or $line -match '5173') { Problem "the action runs the DEV server (vite dev / 5173), not the production preview on $Port." }
      if ($line -match 'npm(\.cmd|\.ps1)?\b' -and $line -notmatch 'node(\.exe)?') { Warn "the action goes through npm: stopping the task leaves the vite grandchild holding the port." }
      if ($line -match '\bstart\b' -and $a.Execute -match 'cmd') { Problem "cmd 'start' detaches the server from the task: the task's state says nothing about the server." }
      if (-not $a.WorkingDirectory) { Warn "no WorkingDirectory: the task starts in System32, where npm/vite find no package.json." }
      elseif (-not (Test-Path $a.WorkingDirectory)) { Problem "WorkingDirectory does not exist: $($a.WorkingDirectory)" }
    }
  }

  Section "1b. What the running task actually spawned"
  # Task Scheduler does not expose a pid, so match on what the action names:
  # the path-like tokens of its arguments, and this frontend's directory, which
  # every vite serving it carries in its command line.
  $needles = @($frontend)
  foreach ($a in $task.Actions) {
    $needles += @("$($a.Arguments)" -split '\s+' | ForEach-Object { $_.Trim('"') } |
                  Where-Object { $_ -match '\\|\.(js|mjs|ps1|cmd|bat)$' })
  }
  $needles = @($needles | Where-Object { $_ } | Select-Object -Unique)
  Note "matching command lines against: $($needles -join ' | ')"
  $all = @(Get-CimInstance Win32_Process -EA SilentlyContinue)
  $roots = @($all | Where-Object { $c = $_.CommandLine; $c -and ($needles | Where-Object { $_ -and $c.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0 }) })
  if (-not $roots) { Warn "no process whose command line carries the task's arguments - the action exited, or detached." }
  function Tree($p, $depth) {
    if ($depth -gt 6) { return }
    Write-Host ("  {0}{1,-6} {2,-14} {3}" -f ('  ' * $depth), $p.ProcessId, $p.Name, $p.CommandLine)
    foreach ($k in ($all | Where-Object { $_.ParentProcessId -eq $p.ProcessId })) { Tree $k ($depth + 1) }
  }
  foreach ($r in $roots) { Tree $r 0 }

  Section "1c. Task Scheduler history (last 15 events for this task)"
  try {
    $full = "$($task.TaskPath)$($task.TaskName)"
    Get-WinEvent -LogName 'Microsoft-Windows-TaskScheduler/Operational' -MaxEvents 3000 -EA Stop |
      Where-Object { $_.Message -match [regex]::Escape($full) } | Select-Object -First 15 |
      ForEach-Object { Note ("{0:MM-dd HH:mm:ss} id={1} {2}" -f $_.TimeCreated, $_.Id, ($_.Message -split "`n")[0]) }
  } catch { Note "history log unavailable (disabled by default: wevtutil sl Microsoft-Windows-TaskScheduler/Operational /e:true)" }
}

# ================================================================ 2. the code
Section "2. Frontend on disk: $frontend"
$pkg = Join-Path $frontend 'package.json'
if (-not (Test-Path $pkg)) { Problem "no package.json at $frontend - pass -AlphaRoot <the live copy>" }
else {
  try {
    $scripts = (Get-Content $pkg -Raw | ConvertFrom-Json).scripts
    $scripts.PSObject.Properties | ForEach-Object { Note ("npm script {0,-10} = {1}" -f $_.Name, $_.Value) }
  } catch { Warn "package.json did not parse" }
  if (Test-Path $vite) { OK "vite installed" } else { Problem "vite not installed ($vite): run  npm ci  in $frontend" }
  $index = Join-Path $frontend 'dist\index.html'
  if (Test-Path $index) { OK ("production build present, built {0}" -f (Get-Item $index).LastWriteTime) }
  else { Problem "no production build (dist\index.html). vite preview serves nothing without it. -Repair -Build fixes this." }
  $cfg = Get-ChildItem $frontend -Filter 'vite.config.*' -File -EA SilentlyContinue | Select-Object -First 1
  if ($cfg) {
    Note "$($cfg.Name) - proxy/port lines:"
    Select-String -Path $cfg.FullName -Pattern 'proxy|target|port|host|preview|8001' -EA SilentlyContinue |
      ForEach-Object { Note ("  {0,4}: {1}" -f $_.LineNumber, $_.Line.Trim()) }
  }
}
$node = (Get-Command node -EA SilentlyContinue).Source
if ($node) { OK "node at $node ($(& $node --version))" } else { Problem "node not on PATH for this user" }

Section "2b. Logs"
$logCandidates = @()
foreach ($d in @($logDir, (Join-Path $AlphaRoot 'logs'), $frontend, $AlphaRoot)) {
  if (Test-Path $d) { $logCandidates += Get-ChildItem $d -Filter '*.log' -File -EA SilentlyContinue }
}
if ($task) {
  foreach ($a in $task.Actions) {
    foreach ($m in [regex]::Matches("$($a.Arguments)", '>>?\s*"?([^"<>|]+?\.(log|txt))"?')) {
      $f = $m.Groups[1].Value.Trim()
      if (-not [IO.Path]::IsPathRooted($f) -and $a.WorkingDirectory) { $f = Join-Path $a.WorkingDirectory $f }
      if (Test-Path $f) { $logCandidates += Get-Item $f } else { Note "task redirects to $f, which does not exist" }
    }
  }
}
$logCandidates = @($logCandidates | Sort-Object LastWriteTime -Descending | Select-Object -Unique -First 4)
if (-not $logCandidates) { Warn "no log files found: the current task writes its output nowhere." }
foreach ($f in $logCandidates) {
  Write-Host "  --- $($f.FullName)  ($($f.LastWriteTime))"
  Get-Content $f.FullName -Tail 20 -EA SilentlyContinue | ForEach-Object { Note $_ }
}

# ================================================================ 3. ports
Section "3. Listeners"
foreach ($p in @($Port, $DevPort, $BackendPort)) {
  $l = @(Listener $p)
  if (-not $l) { Warn "nothing listening on $p" }
  foreach ($x in $l) { Write-Host ("  {0,-5} {1,-15} pid {2,-6} {3,-10} {4}" -f $x.Port, $x.Address, $x.Pid, $x.Name, $x.Cmd) }
}
$fl = @(Listener $Port)
if (($fl | Where-Object { $_.Cmd }) -and -not ($fl | Where-Object { $_.Cmd -and $_.Cmd.IndexOf($frontend, [StringComparison]::OrdinalIgnoreCase) -ge 0 })) {
  Problem "port $Port is held by something that is not this frontend (above). That is a confirmed conflict; -Repair will not kill it."
}

# ================================================================ 4. cloudflared
Section "4. cloudflared (read only)"
$cfProcs = @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -EA SilentlyContinue)
Write-Host "  cloudflared processes: $($cfProcs.Count)"
foreach ($c in $cfProcs) { Note ("pid {0}: {1}" -f $c.ProcessId, ($c.CommandLine -replace '(--token\s+|token=)\S+', '$1<redacted>')) }
if ($cfProcs.Count -gt 1) { Warn "more than one cloudflared: if they serve the same tunnel with different configs, Cloudflare load-balances between them and some requests 502." }
$svc = Get-CimInstance Win32_Service -Filter "Name='cloudflared'" -EA SilentlyContinue
if ($svc) { Note ("service cloudflared: {0}, {1}, {2}" -f $svc.State, $svc.StartMode, ($svc.PathName -replace '(--token\s+|token=)\S+', '$1<redacted>')) }
else { Warn "no cloudflared service: the tunnel only runs while someone has it open." }
$cfgs = @(
  (Join-Path $env:USERPROFILE '.cloudflared\config.yml'),
  (Join-Path $env:USERPROFILE '.cloudflared\config.yaml'),
  'C:\Windows\System32\config\systemprofile\.cloudflared\config.yml',
  'C:\ProgramData\Cloudflare\cloudflared\config.yml',
  'C:\Program Files (x86)\cloudflared\config.yml',
  'C:\Program Files\cloudflared\config.yml'
) | Where-Object { Test-Path $_ }
$ingressPorts = @()
foreach ($c in $cfgs) {
  Write-Host "  $c (hostname/service lines only):"
  Select-String -Path $c -Pattern '^\s*-?\s*(hostname|service)\s*:' -EA SilentlyContinue | ForEach-Object {
    Note $_.Line.Trim()
    foreach ($m in [regex]::Matches($_.Line, ':(\d{2,5})\b')) { $ingressPorts += [int]$m.Groups[1].Value }
  }
}
if (-not $cfgs) { Note "no local config.yml: the tunnel is token-run (ingress lives in the Zero Trust dashboard) - check its public hostname for alpha-ai.uk points at http://localhost:$Port" }
elseif ($ingressPorts -and ($ingressPorts -notcontains $Port)) {
  Problem "cloudflared ingress targets port(s) $($ingressPorts -join ', '), not $Port. Report only - this script does not edit the tunnel."
}

# ================================================================ 5. pressure
Section "5. Resource pressure"
$os = Get-CimInstance Win32_OperatingSystem
$cpu = (Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average
$freeMB = [math]::Round($os.FreePhysicalMemory / 1KB); $totMB = [math]::Round($os.TotalVisibleMemorySize / 1KB)
$commit = [math]::Round(100 - 100 * $os.FreeVirtualMemory / $os.TotalVirtualMemorySize)
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
Write-Host ("  CPU {0}%   RAM free {1} / {2} MB   commit {3}%   C: free {4:n1} GB" -f $cpu, $freeMB, $totMB, $commit, ($disk.FreeSpace / 1GB))
if ($freeMB -lt 800)       { Problem "under 800 MB of RAM free - vite/node can fail to start or be killed" }
if ($commit -gt 90)        { Problem "commit charge above 90% - allocations will start failing" }
if ($disk.FreeSpace -lt 2GB) { Problem "C: has under 2 GB free" }
Write-Host "  top by memory:"
Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 10 |
  ForEach-Object { Note ("{0,-28} pid {1,-6} {2,6:n0} MB  cpu {3,8:n0}s" -f $_.ProcessName, $_.Id, ($_.WorkingSet64 / 1MB), $_.CPU) }
Write-Host "  top by CPU time:"
Get-Process | Where-Object CPU | Sort-Object CPU -Descending | Select-Object -First 8 |
  ForEach-Object { Note ("{0,-28} pid {1,-6} {2,8:n0}s" -f $_.ProcessName, $_.Id, $_.CPU) }
# Only duplicates we can name as conflicts: two servers for the same frontend.
$vites = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
          Where-Object { $_.CommandLine -match 'vite' })
Write-Host "  vite processes: $($vites.Count)"
foreach ($v in $vites) { Note ("pid {0}: {1}" -f $v.ProcessId, $v.CommandLine) }
$mine = @($vites | Where-Object { $_.CommandLine.IndexOf($frontend, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $_.CommandLine -notmatch '[A-Za-z]:\\' })
if ($mine.Count -gt 1) { Warn "$($mine.Count) vite processes for this frontend - likely orphans of earlier task runs; -Repair stops them." }

# ================================================================ 6. repair
$backupXml = $null
if ($Repair) {
  Section "6. Repair"
  if (-not $admin)            { Die "-Repair must run from an elevated PowerShell." }
  # repair-alpha-host.ps1 owns the 'Alpha' task on a host it has set up, and its
  # self-heal restarts it through run-alpha.cmd. A second definition of the
  # same task would have the two undoing each other every two minutes.
  if ((Get-ScheduledTask -TaskName 'Alpha Self-Heal' -EA SilentlyContinue) -or
      (Test-Path (Join-Path $env:ProgramData 'AlphaBoot\run-alpha.cmd'))) {
    Die "this host is managed by repair-alpha-host.ps1 ('Alpha Self-Heal' / AlphaBoot\run-alpha.cmd exist). Use that script; this one stays report-only here."
  }
  if (-not $node)             { Die "node is not on PATH; nothing to run the frontend with." }
  if (-not (Test-Path $vite)) { Die "vite is not installed in $frontend. Run  npm ci  there first." }
  if ($fl -and -not ($fl | Where-Object { $_.Cmd -and $_.Cmd.IndexOf($frontend, [StringComparison]::OrdinalIgnoreCase) -ge 0 })) {
    Die "port $Port is held by a process that is not this frontend (section 3). Resolve that first."
  }

  if (-not (Test-Path (Join-Path $frontend 'dist\index.html'))) {
    if (-not $Build) { Die "no dist\index.html. Re-run with -Repair -Build." }
    Note "building (npm run build) ..."
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $npm = (Get-Command npm.cmd -EA SilentlyContinue).Source
    if (-not $npm) { Die "npm.cmd not on PATH; build by hand in $frontend, then re-run -Repair." }
    Push-Location $frontend
    & $npm run build *> (Join-Path $logDir 'frontend-build.log')
    $rc = $LASTEXITCODE
    Pop-Location
    if ($rc -ne 0 -or -not (Test-Path (Join-Path $frontend 'dist\index.html'))) {
      Get-Content (Join-Path $logDir 'frontend-build.log') -Tail 30 | ForEach-Object { Note $_ }
      Die "build failed (exit $rc); the task was not changed."
    }
    OK "built"
  } elseif ($Build) {
    Note "dist already present; -Build ignored so the served files do not change under you. Delete dist to force a rebuild."
  }

  New-Item -ItemType Directory -Force -Path $opsDir, $logDir, $backups | Out-Null
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $taskPath = '\'
  $userId = "$env:USERDOMAIN\$env:USERNAME"
  if ($task) {
    $taskPath = $task.TaskPath
    $backupXml = Join-Path $backups "task-$TaskName-$stamp.xml"
    Export-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath | Set-Content -Path $backupXml -Encoding Unicode
    OK "old task exported to $backupXml"
    if ($task.Principal.UserId -and $task.Principal.UserId -notmatch '^(SYSTEM|NT AUTHORITY|S-1-5-18)') {
      $userId = $task.Principal.UserId
    }
  }

  $runner = Join-Path $opsDir 'alpha-frontend-run.ps1'
  if (Test-Path $runner) { Copy-Item $runner "$runner.$stamp.bak" }
  Copy-Item (Join-Path $PSScriptRoot 'alpha-frontend-run.ps1') $runner -Force
  OK "runner at $runner"

  if ($task) {
    Stop-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -EA SilentlyContinue
    Note "stopped task"
  }
  # Only vite serving this directory. Command-line match is the proof.
  foreach ($v in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
                  Where-Object { $_.CommandLine -match 'vite' -and $_.CommandLine.IndexOf($frontend, [StringComparison]::OrdinalIgnoreCase) -ge 0 })) {
    Note "stopping pid $($v.ProcessId): $($v.CommandLine)"
    Stop-Process -Id $v.ProcessId -Force -EA SilentlyContinue
  }
  Start-Sleep 2

  $argLine = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -FrontendDir "{1}" -Node "{2}" -Port {3} -Bind {4} -LogDir "{5}"' -f `
             $runner, $frontend, $node, $Port, $Bind, $logDir
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
            -Argument $argLine -WorkingDirectory $frontend
  $boot = New-ScheduledTaskTrigger -AtStartup
  $boot.Delay = 'PT30S'
  $triggers = @($boot)
  try {
    # Watchdog: with MultipleInstances IgnoreNew this is a no-op while the
    # runner lives, and brings it back if anything ended it.
    $triggers += New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
  } catch { Warn "could not add the 5-minute re-trigger on this Windows build; boot trigger only" }
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable `
              -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -DontStopOnIdleEnd

  $cred = $null
  if ($UsePassword) { $cred = Get-Credential -UserName $userId -Message "Password for $userId (stored by Task Scheduler)" }
  function RegisterAlpha($trig) {
    if ($cred) {
      Register-ScheduledTask -TaskName $TaskName -TaskPath $taskPath -Action $action -Trigger $trig `
        -Settings $settings -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Limited -Force -EA Stop | Out-Null
    } else {
      # S4U: runs whether or not the user is logged on, stores no password.
      # It has no network credentials, which a localhost server does not need.
      $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType S4U -RunLevel Limited
      Register-ScheduledTask -TaskName $TaskName -TaskPath $taskPath -Action $action -Trigger $trig `
        -Settings $settings -Principal $principal -Force -EA Stop | Out-Null
    }
  }
  try {
    try { RegisterAlpha $triggers }
    catch {
      # Some builds reject an open-ended repetition; the boot trigger and the
      # runner's own restart loop still carry it.
      if ($triggers.Count -lt 2) { throw }
      Warn "5-minute re-trigger refused ($($_.Exception.Message)); registering with the boot trigger only"
      RegisterAlpha @($boot)
    }
    OK "task $taskPath$TaskName registered for $userId"
  } catch {
    Problem "registering the task failed: $($_.Exception.Message)"
    if ($backupXml) { Warn "restoring the original: .\fix-frontend.ps1 -Rollback `"$backupXml`"" }
    Warn "If S4U is refused by policy, re-run with -Repair -UsePassword."
    Stop-Transcript | Out-Null; exit 1
  }

  Start-ScheduledTask -TaskName $TaskName -TaskPath $taskPath
  Note "waiting up to 60s for $Port ..."
  $up = $false
  for ($i = 0; $i -lt 30 -and -not $up; $i++) { Start-Sleep 2; $up = [bool](Listener $Port) }
  if ($up) { OK "listening on $Port" }
  else {
    Problem "the task started but $Port is not listening after 60s. Runner log:"
    Get-Content (Join-Path $logDir 'frontend-runner.log') -Tail 15 -EA SilentlyContinue | ForEach-Object { Note $_ }
    Get-Content (Join-Path $logDir 'frontend.err.log') -Tail 15 -EA SilentlyContinue | ForEach-Object { Note $_ }
  }
}

# ================================================================ 7. verify
Section "7. Verify"
$b = $null
foreach ($u in @('/health', '/api/health', '/healthz', '/docs', '/')) {
  $b = Probe "http://127.0.0.1:$BackendPort$u"
  if ($b.Code -ge 200 -and $b.Code -lt 400) { break }
}
if ($b.Code -ge 200 -and $b.Code -lt 400) { OK "backend $($b.Url) -> $($b.Code)" } else { Problem "backend on $BackendPort -> $($b.Code) $($b.Error)" }

# Every backend route for the areas the user cares about, from the backend's
# own OpenAPI. Unauthenticated GETs only: 2xx or 401/403 means the route is
# alive; 404 means it is gone, 5xx means it is broken.
$areas = 'login|auth|chat|deck|brain|agent|network'
$api = Probe "http://127.0.0.1:$BackendPort/openapi.json"
$sampleApi = $null
if ($api.Code -eq 200) {
  try {
    $paths = (ConvertFrom-Json $api.Body).paths.PSObject.Properties
    foreach ($pp in $paths) {
      if ($pp.Name -notmatch $areas) { continue }
      $verbs = ($pp.Value.PSObject.Properties.Name) -join ','
      if ($pp.Name -match '\{' -or $verbs -notmatch 'get') { Note "$($pp.Name) [$verbs] (not probed)"; continue }
      $r = Probe "http://127.0.0.1:$BackendPort$($pp.Name)"
      $tag = if ($r.Code -ge 500 -or $r.Code -eq 0) { 'BROKEN' } elseif ($r.Code -eq 404) { 'MISSING' } else { 'alive' }
      Write-Host ("  {0,-7} {1,3}  {2}" -f $tag, $r.Code, $pp.Name)
      if ($tag -eq 'BROKEN') { Problem "backend $($pp.Name) -> $($r.Code)" }
      if (-not $sampleApi -and $r.Code -lt 500 -and $r.Code -ne 404) { $sampleApi = $pp.Name }
    }
    $login = $paths | Where-Object { $_.Name -match 'login' -and ($_.Value.PSObject.Properties.Name -contains 'post') } | Select-Object -First 1
    if ($login) {
      # An empty body: 400/401/422 proves the login handler runs; no credentials are sent.
      $r = Probe "http://127.0.0.1:$BackendPort$($login.Name)" 'POST' '{}'
      if ($r.Code -ge 500 -or $r.Code -eq 0) { Problem "login handler $($login.Name) -> $($r.Code)" }
      else { OK "login handler $($login.Name) answers ($($r.Code) to an empty body)" }
    }
  } catch { Warn "openapi.json did not parse: $($_.Exception.Message)" }
} else { Note "no /openapi.json on $BackendPort ($($api.Code)); backend routes not enumerated" }

$f = Probe "http://127.0.0.1:$Port/"
if ($f.Code -eq 200 -and $f.Body -match '<script') { OK "frontend http://127.0.0.1:$Port/ -> 200, serves the app shell" }
else { Problem "frontend on $Port -> $($f.Code) $($f.Error)" }
if ($f.Code -eq 200) {
  # SPA routes, taken from the app's own router rather than guessed.
  $routes = @()
  if (Test-Path (Join-Path $frontend 'src')) {
    $routes = @(Get-ChildItem (Join-Path $frontend 'src') -Recurse -Include *.tsx, *.ts -File -EA SilentlyContinue |
      Select-String -Pattern 'path\s*[:=]\s*\{?\s*["''](/[A-Za-z0-9/_-]*)["'']' -AllMatches -EA SilentlyContinue |
      ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value } |
      Where-Object { $_ -match $areas } | Select-Object -Unique)
  }
  if (-not $routes) { $routes = @('/login', '/chat', '/decks', '/brain', '/agents', '/network') ; Note "no router paths found; probing defaults" }
  foreach ($rt in $routes) {
    $r = Probe "http://127.0.0.1:$Port$rt"
    Write-Host ("  {0,3}  {1}" -f $r.Code, $rt)
    if ($r.Code -ne 200) { Problem "frontend route $rt -> $($r.Code)" }
  }
  if ($sampleApi) {
    $r = Probe "http://127.0.0.1:$Port$sampleApi"
    if ($r.Code -ge 500 -or $r.Code -eq 0 -or ($r.Code -eq 200 -and $r.Body -match '<!doctype html')) {
      Warn "frontend $Port does not proxy $sampleApi to the backend ($($r.Code)) - fine only if the browser calls the backend by another route"
    } else { OK "frontend proxies $sampleApi to the backend ($($r.Code))" }
  }
}

$pub = Probe $PublicUrl
Write-Host ("  public {0} -> {1}  server={2}  cf-ray={3}" -f $PublicUrl, $pub.Code, $pub.Server, $pub.CfRay)
if ($pub.Code -eq 200) { OK "public site answers" }
elseif ($pub.Code -eq 502) { Problem "Cloudflare 502: the tunnel reached this machine's origin and the origin refused/failed. With $Port up locally, check the ingress target in section 4." }
elseif ($pub.Code -eq 530 -or $pub.Body -match '1033') { Problem "Cloudflare 530/1033: no cloudflared connector is up for the tunnel." }
elseif ($pub.Code -in 302, 303 -and $pub.Body -match 'cloudflareaccess') { OK "public site answers behind Cloudflare Access ($($pub.Code) to the Access login)" }
else { Problem "public site -> $($pub.Code) $($pub.Error)" }

Note "Login, chat, decks, Brain, Agents and Network Hub with a real account need a browser session:"
Note "open $PublicUrl, sign in, and open each area once. This script sends no credentials."

# ================================================================ verdict
Section "VERDICT"
if ($problems.Count -eq 0) { Write-Host "No problems found." -ForegroundColor Green }
else {
  Write-Host "$($problems.Count) problem(s), in the order found:" -ForegroundColor Yellow
  $i = 1; foreach ($p in $problems) { Write-Host "  $i. $p"; $i++ }
  if (-not $Repair) { Write-Host "`nNothing was changed. Repair with:  .\fix-frontend.ps1 -Repair   (elevated)" }
}
if ($backupXml) { Write-Host "`nRollback:  .\fix-frontend.ps1 -Rollback `"$backupXml`"" -ForegroundColor Cyan }
Write-Host "Log: $log`n"
Stop-Transcript | Out-Null

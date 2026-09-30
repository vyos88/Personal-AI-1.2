<#
  repair-alpha-host.ps1 - put the Alpha host (Laptop41) right, make it stay
  right, and write down the evidence.

  Run as Administrator, from PowerShell, on the host:
      powershell -ExecutionPolicy Bypass -File .\repair-alpha-host.ps1
  Look without changing anything:
      powershell -ExecutionPolicy Bypass -File .\repair-alpha-host.ps1 -ReportOnly
  Undo the last repair:
      powershell -ExecutionPolicy Bypass -File .\repair-alpha-host.ps1 -Rollback

  What it does, in order, each step logged and posted to Alpha's coordination
  tunnel as it happens:
    1. inventory   scheduled tasks, services, who holds 8001/4173, memory, CPU,
                   disk, power, cloudflared - and SHA-256 of the tunnel's config
                   and credentials, so the end of the run can prove they were
                   not touched
    2. backend     adopts the command line of the backend that is answering on
                   8001 into a boot task (S4U: runs at boot, survives logout,
                   stores no password), hands over to it and proves /health
                   comes back - or puts the original back
    3. frontend    stops only a process that holds 4173 and does not serve
                   Alpha, rebuilds dist if it is older than the source (with
                   the old dist kept for rollback), then runs
                   start-alpha-at-boot.ps1 for the boot task
    4. connector   cloudflared is restarted only if the origin answered on three
                   checks in a row AND the public hostname answers with a code
                   meaning "tunnel cannot reach origin". Its config.yml, its
                   credentials, DNS, WAF and Access are never edited.
    5. power       AC sleep and hibernate off - a sleeping coordinator is an
                   outage. Previous values are recorded for -Rollback.
    6. self-heal   a SYSTEM task every 2 minutes running alpha-selfheal.mjs:
                   streaks, cooldown, hourly and daily repair budgets, dist
                   rollback, JSONL log, coordination posts.
    7. verify      backend /health, local frontend (with the Host header the
                   tunnel sends), app routes, public hostname, attached agents
                   (including Jack's laptop).

  It never uninstalls anything, never kills a process it has not proven to be
  holding Alpha's port without serving Alpha, and never deletes a task: tasks it
  replaces are exported to XML and disabled.
#>

param(
  [string]$AlphaRoot = 'C:\AlphaData\Alpha',
  [string]$OpsDir = 'C:\AlphaData\alpha-ops',
  [int]$BackendPort = 8001,
  [string]$BackendHealthPath = '/health',
  [int]$FrontendPort = 4173,
  [string]$PublicHost = 'alpha-ai.uk',
  [string]$CloudflaredService = 'cloudflared',
  [string]$CloudflaredConfig = '',
  [string]$FrontendTask = 'Alpha',
  [string]$BackendTask = 'Alpha Backend',
  [string]$SelfHealTask = 'Alpha Self-Heal',
  # Only needed when the backend is down and no task knows how to start it.
  [string]$BackendExe = '',
  [string]$BackendArgs = '',
  [string]$BackendDir = '',
  [switch]$NoHandover,
  [switch]$ReportOnly,
  [switch]$Rollback
)

$ErrorActionPreference = 'Continue'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logDir = Join-Path $OpsDir 'logs'
$rbDir  = Join-Path $OpsDir 'rollback'
New-Item -ItemType Directory -Force -Path $logDir, $rbDir | Out-Null
$log = Join-Path $logDir "repair-$stamp.log"
Start-Transcript -Path $log -Force | Out-Null

$tunnel = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$problems = New-Object System.Collections.ArrayList
$changes  = New-Object System.Collections.ArrayList
$evidence = [ordered]@{ startedAt = (Get-Date).ToString('o'); host = $env:COMPUTERNAME }
$manifest = [ordered]@{ stamp = $stamp; createdTasks = @(); exportedTasks = @(); disabledTasks = @(); power = $null; distBackup = $null }

function Problem($t) { [void]$problems.Add($t); Write-Host "  PROBLEM: $t" -ForegroundColor Red }
function Changed($t) { [void]$changes.Add($t);  Write-Host "  CHANGED: $t" -ForegroundColor Green }
function OK($t)      { Write-Host "  ok: $t" -ForegroundColor Green }
function Note($t)    { Write-Host "  $t" }
function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan; Post "repair: $t" }

# Live progress goes where the fleet's receipts go. A post that fails is noted
# and never stops the repair.
$coordScript = Join-Path $AlphaRoot 'scripts\alpha_coordination_tunnel.ps1'
function Post($msg) {
  if (-not (Test-Path $coordScript)) { return }
  $m = "[$env:COMPUTERNAME] $msg"
  if ($m.Length -gt 3900) { $m = $m.Substring(0, 3900) }
  try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $coordScript -Action Post -Actor 'laptop41-repair' -Message $m 2>&1 | Out-Null
  } catch { Write-Host "  (coordination post failed: $($_.Exception.Message))" -ForegroundColor DarkGray }
}

function Code($url, [string]$HostHeader = '') {
  $a = @('-s', '-k', '-o', 'NUL', '-w', '%{http_code}', '--max-time', '8')
  if ($HostHeader) { $a += @('-H', "Host: $HostHeader") }
  $c = & curl.exe @a $url 2>$null
  if (-not $c) { return '000' } ; return "$c"
}
function Body($url, [string]$HostHeader = '') {
  $a = @('-s', '-k', '--max-time', '8')
  if ($HostHeader) { $a += @('-H', "Host: $HostHeader") }
  return (& curl.exe @a $url 2>$null | Out-String)
}
$backendUrl  = "http://127.0.0.1:$BackendPort$BackendHealthPath"
$frontendUrl = "http://127.0.0.1:$FrontendPort/"
function BackendOK  { (Code $backendUrl) -like '2*' }
function FrontendOK { (Body $frontendUrl) -match 'id="root"' }

function Listener($port) {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue | Select-Object -First 1
  if (-not $c) { return $null }
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -EA SilentlyContinue
  [pscustomobject]@{ Pid = $c.OwningProcess; Address = $c.LocalAddress; Name = $p.Name; Exe = $p.ExecutablePath; CommandLine = $p.CommandLine }
}

function Finish($code) {
  $evidence.finishedAt = (Get-Date).ToString('o')
  $evidence.problems = @($problems)
  $evidence.changes  = @($changes)
  $evFile = Join-Path $logDir "evidence-$stamp.json"
  $evidence | ConvertTo-Json -Depth 6 | Set-Content -Path $evFile -Encoding utf8
  if (-not $ReportOnly -and -not $Rollback) {
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $rbDir "manifest-$stamp.json") -Encoding utf8
  }
  Write-Host "`n=== VERDICT ===" -ForegroundColor Cyan
  if ($changes.Count) { Write-Host "Changed:" -ForegroundColor Green; $changes | ForEach-Object { Write-Host "  - $_" } }
  if ($problems.Count -eq 0) { Write-Host "No open problems." -ForegroundColor Green }
  else { Write-Host "$($problems.Count) open problem(s):" -ForegroundColor Yellow; $i = 1; foreach ($p in $problems) { Write-Host "  $i. $p"; $i++ } }
  Write-Host "`nLog:      $log`nEvidence: $evFile"
  if (-not $ReportOnly -and -not $Rollback) { Write-Host "Undo:     .\repair-alpha-host.ps1 -Rollback" }
  Post ("repair finished: {0} change(s), {1} open problem(s). {2}" -f $changes.Count, $problems.Count, (@($problems) -join ' | '))
  Stop-Transcript | Out-Null
  exit $code
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin -and -not $ReportOnly) { Problem "Not elevated. Re-run from an Administrator PowerShell."; Finish 1 }

# ================================================================= rollback
if ($Rollback) {
  Section "Rollback of the last repair"
  $m = Get-ChildItem $rbDir -Filter 'manifest-*.json' -EA SilentlyContinue | Sort-Object Name | Select-Object -Last 1
  if (-not $m) { Problem "No repair manifest in $rbDir - nothing to undo."; Finish 1 }
  $mf = Get-Content $m.FullName -Raw | ConvertFrom-Json
  Note "undoing $($m.Name)"
  foreach ($t in @($mf.createdTasks)) {
    if ($t -and (Get-ScheduledTask -TaskName $t -EA SilentlyContinue)) {
      Stop-ScheduledTask -TaskName $t -EA SilentlyContinue
      Unregister-ScheduledTask -TaskName $t -Confirm:$false; Changed "removed task '$t'"
    }
  }
  foreach ($x in @($mf.exportedTasks)) {
    if ($x -and (Test-Path $x.file)) {
      Register-ScheduledTask -TaskName $x.name -TaskPath $x.path -Xml (Get-Content $x.file -Raw) -Force | Out-Null
      Changed "restored task '$($x.name)' from $($x.file)"
    }
  }
  foreach ($d in @($mf.disabledTasks)) {
    if ($d) { Enable-ScheduledTask -TaskName $d.name -TaskPath $d.path -EA SilentlyContinue | Out-Null; Changed "re-enabled '$($d.name)'" }
  }
  if ($mf.power) {
    powercfg /change standby-timeout-ac $mf.power.standbyMin | Out-Null
    powercfg /change hibernate-timeout-ac $mf.power.hibernateMin | Out-Null
    Changed "AC sleep/hibernate back to $($mf.power.standbyMin)/$($mf.power.hibernateMin) min"
  }
  if ($mf.distBackup -and (Test-Path $mf.distBackup)) {
    $dist = Join-Path $AlphaRoot 'frontend\dist'
    robocopy $mf.distBackup $dist /MIR /NFL /NDL /NJH /NJS | Out-Null
    Changed "frontend dist restored from $($mf.distBackup)"
  }
  Rename-Item $m.FullName "$($m.Name).undone" -EA SilentlyContinue
  Note "Not undone, by design: the running processes. Start-ScheduledTask whichever you restored."
  Finish 0
}

# ================================================================= 1. inventory
Section "1. Inventory"
$alphaTasks = @(Get-ScheduledTask -EA SilentlyContinue | Where-Object {
  $a = ($_.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments) $($_.WorkingDirectory)" }) -join ' '
  $_.TaskName -match 'alpha|vyos|cloudflare' -or $a -match 'alpha|vite|uvicorn|4173|8001|cloudflared'
})
$taskRows = foreach ($t in $alphaTasks) {
  $i = Get-ScheduledTaskInfo -TaskName $t.TaskName -TaskPath $t.TaskPath -EA SilentlyContinue
  [pscustomobject]@{
    Name = "$($t.TaskPath)$($t.TaskName)"; State = "$($t.State)"; LastResult = $i.LastTaskResult; LastRun = $i.LastRunTime
    RunAs = "$($t.Principal.UserId)/$($t.Principal.LogonType)"
    Action = (($t.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' ; ')
  }
}
Note "Scheduled tasks touching Alpha:"
$taskRows | Format-Table -AutoSize -Wrap | Out-String -Width 220 | Write-Host
$evidence.tasksBefore = @($taskRows)

$svcRows = @(Get-Service -EA SilentlyContinue | Where-Object { $_.Name -like 'alpha*' -or $_.Name -like 'cloudflared*' -or $_.Name -like 'tailscale*' } |
  Select-Object Name, Status, StartType)
$svcRows | Format-Table | Out-String | Write-Host
$evidence.services = @($svcRows | ForEach-Object { "$($_.Name)=$($_.Status)/$($_.StartType)" })

$lb = Listener $BackendPort; $lf = Listener $FrontendPort
Note "port $BackendPort : $(if ($lb) { "$($lb.Name) pid $($lb.Pid) on $($lb.Address)" } else { 'no listener' })"
Note "port $FrontendPort : $(if ($lf) { "$($lf.Name) pid $($lf.Pid) on $($lf.Address)" } else { 'no listener' })"
$evidence.listenersBefore = @{ backend = $lb; frontend = $lf }

$os = Get-CimInstance Win32_OperatingSystem
$freePct = [math]::Round(100 * $os.FreePhysicalMemory / $os.TotalVisibleMemorySize, 1)
$disk = Get-PSDrive C
Note ("memory free {0}% of {1:N1} GB   C: free {2:N1} GB" -f $freePct, ($os.TotalVisibleMemorySize / 1MB), ($disk.Free / 1GB))
if ($freePct -lt 10) { Problem "Memory pressure: only $freePct% free. Top consumers below - nothing is stopped automatically." }
if ($disk.Free -lt 5GB) { Problem ("C: has {0:N1} GB free - builds and logs will start failing." -f ($disk.Free / 1GB)) }
Note "Top processes by memory (the Task Manager view):"
$top = Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 12 Name, Id,
  @{n='MemMB';e={[int]($_.WorkingSet64/1MB)}}, @{n='CPUs';e={[int]$_.CPU}}
$top | Format-Table | Out-String | Write-Host
$evidence.resources = @{ memFreePct = $freePct; diskFreeGB = [math]::Round($disk.Free / 1GB, 1); top = @($top) }

# Two node/vite servers or two uvicorns is the classic "works, then does not":
# reported here, and only stopped below if one of them holds our port without
# serving Alpha.
$dupes = @(Get-CimInstance Win32_Process -EA SilentlyContinue | Where-Object { $_.CommandLine -match 'vite(\.js)?"?\s+(preview|dev)|uvicorn' })
if ($dupes.Count -gt 2) {
  Note "$($dupes.Count) vite/uvicorn processes running:"
  $dupes | ForEach-Object { Note "  pid $($_.ProcessId): $($_.CommandLine)" }
}

# cloudflared: where its config is, and a fingerprint of it and its credentials.
if (-not $CloudflaredConfig) {
  $img = (Get-CimInstance Win32_Service -Filter "Name='$CloudflaredService'" -EA SilentlyContinue).PathName
  if ($img -match '--config\s+"?([^"]+?\.ya?ml)"?(\s|$)') { $CloudflaredConfig = $Matches[1] }
  elseif (Test-Path (Join-Path $env:USERPROFILE '.cloudflared\config.yml')) { $CloudflaredConfig = Join-Path $env:USERPROFILE '.cloudflared\config.yml' }
}
$cfFiles = @()
if ($CloudflaredConfig -and (Test-Path $CloudflaredConfig)) {
  $cfFiles += $CloudflaredConfig
  $cfText = Get-Content $CloudflaredConfig -Raw
  if ($cfText -match '(?m)^\s*credentials-file:\s*"?([^"\r\n]+?)"?\s*$') { if (Test-Path $Matches[1]) { $cfFiles += $Matches[1] } }
  $ingress = @([regex]::Matches($cfText, '(?m)^\s*-\s*hostname:\s*"?([^"\s]+)"?\s*[\r\n]+\s*service:\s*"?([^"\s]+)"?') |
               ForEach-Object { "$($_.Groups[1].Value) -> $($_.Groups[2].Value)" })
  Note "cloudflared config: $CloudflaredConfig"
  $ingress | ForEach-Object { Note "  ingress $_" }
  $evidence.ingress = $ingress
  $pubRule = $ingress | Where-Object { $_ -like "$PublicHost ->*" } | Select-Object -First 1
  if ($pubRule -and $pubRule -notmatch "127\.0\.0\.1:$FrontendPort|localhost:$FrontendPort") {
    Problem "The ingress for $PublicHost is '$pubRule', not port $FrontendPort. Not edited - confirm which origin is meant."
  }
  if ($pubRule -match "localhost:$FrontendPort") {
    Note "  ingress says 'localhost'; the frontend is pinned to 127.0.0.1 so both resolve to the same socket."
  }
} else { Note "cloudflared config not found - connector checks are limited to the service." }
$hashBefore = @{}; foreach ($f in $cfFiles) { $hashBefore[$f] = (Get-FileHash $f -Algorithm SHA256).Hash }
$evidence.cloudflaredHashBefore = $hashBefore

$std = powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE | Select-String 'Current AC Power Setting Index: (0x[0-9a-f]+)'
$hib = powercfg /q SCHEME_CURRENT SUB_SLEEP HIBERNATEIDLE | Select-String 'Current AC Power Setting Index: (0x[0-9a-f]+)'
$standbyMin = if ($std) { [int]([Convert]::ToInt32($std.Matches[0].Groups[1].Value, 16) / 60) } else { $null }
$hibernateMin = if ($hib) { [int]([Convert]::ToInt32($hib.Matches[0].Groups[1].Value, 16) / 60) } else { $null }
Note "AC sleep after: $standbyMin min   AC hibernate after: $hibernateMin min   (0 = never)"

Note "Recent Alpha logs:"
foreach ($lg in @(Get-ChildItem @("$AlphaRoot\logs", "$AlphaRoot\software\backend\logs", "$env:ProgramData\AlphaBoot") -Filter *.log -EA SilentlyContinue |
                  Sort-Object LastWriteTime -Descending | Select-Object -First 3)) {
  Note "--- $($lg.FullName) (last 8 lines)"
  Get-Content $lg.FullName -Tail 8 -EA SilentlyContinue | ForEach-Object { Note "    $_" }
}

if ($ReportOnly) { Note "`n-ReportOnly: nothing changed."; Finish 0 }

# ================================================================= 2. backend
Section "2. Backend on $BackendPort"
$bootDir = Join-Path $env:ProgramData 'AlphaBoot'
New-Item -ItemType Directory -Force -Path $bootDir | Out-Null
$backendWrapper = Join-Path $bootDir 'run-alpha-backend.cmd'
$backendLog = Join-Path $bootDir 'alpha-backend.log'

function Export-AndDisable($task) {
  $file = Join-Path $rbDir ("task-{0}-{1}.xml" -f ($task.TaskName -replace '[^\w.-]', '_'), $stamp)
  Export-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath | Set-Content -Path $file -Encoding unicode
  $manifest.exportedTasks += @{ name = $task.TaskName; path = $task.TaskPath; file = $file }
  Disable-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath | Out-Null
  $manifest.disabledTasks += @{ name = $task.TaskName; path = $task.TaskPath }
  Changed "disabled conflicting task '$($task.TaskPath)$($task.TaskName)' (exported to $file)"
}

function Split-CommandLine($cl) {
  if ($cl -match '^\s*"([^"]+)"\s*(.*)$') { return @($Matches[1], $Matches[2]) }
  if ($cl -match '^\s*(\S+)\s*(.*)$')    { return @($Matches[1], $Matches[2]) }
  return @($cl, '')
}

$spec = $null
if (BackendOK) {
  OK "$backendUrl answers"
  $lb = Listener $BackendPort
  if ($lb -and $lb.CommandLine) {
    $parts = Split-CommandLine $lb.CommandLine
    $exe = if ($lb.Exe) { $lb.Exe } else { $parts[0] }
    $dir = $BackendDir
    if (-not $dir) {
      # uvicorn main:app needs to start where main.py is.
      if ($parts[1] -match '([\w.]+):\w+') {
        $modFile = ($Matches[1] -replace '\.', '\') + '.py'
        $hit = Get-ChildItem $AlphaRoot -Recurse -Depth 4 -Filter (Split-Path $modFile -Leaf) -EA SilentlyContinue |
               Where-Object { $_.FullName -like "*$modFile" -and $_.FullName -notmatch '\\(node_modules|\.venv|venv|site-packages)\\' } | Select-Object -First 1
        if ($hit) { $dir = $hit.FullName.Substring(0, $hit.FullName.Length - $modFile.Length).TrimEnd('\') }
      }
      if (-not $dir) { $dir = @("$AlphaRoot\software\backend", "$AlphaRoot\backend", $AlphaRoot) | Where-Object { Test-Path $_ } | Select-Object -First 1 }
    }
    $spec = @{ exe = $exe; args = $parts[1]; dir = $dir; pid = $lb.Pid }
    Note "adopted from pid $($lb.Pid): `"$exe`" $($parts[1])   (in $dir)"
  }
} else {
  Problem "$backendUrl does not answer."
}
if (-not $spec -and $BackendExe) { $spec = @{ exe = $BackendExe; args = $BackendArgs; dir = $(if ($BackendDir) { $BackendDir } else { $AlphaRoot }); pid = $null } }
if (-not $spec -and (Get-ScheduledTask -TaskName $BackendTask -EA SilentlyContinue)) {
  Note "no live backend to adopt; starting the existing '$BackendTask' task"
  Start-ScheduledTask -TaskName $BackendTask
  for ($i = 0; $i -lt 30 -and -not (BackendOK); $i++) { Start-Sleep 3 }
  if (BackendOK) { OK "backend back via '$BackendTask'"; [void]$problems.Remove("$backendUrl does not answer.") }
}

if ($spec) {
  # Other tasks that start a backend on this port would fight the new one.
  foreach ($t in $alphaTasks) {
    $a = ($t.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' '
    if ($t.TaskName -ne $BackendTask -and $t.State -ne 'Disabled' -and $a -match "uvicorn|$BackendPort|backend") { Export-AndDisable $t }
  }
  @"
@echo off
rem Written by repair-alpha-host.ps1. Re-run it instead of editing.
cd /d "$($spec.dir)"
:loop
echo [%date% %time%] starting backend >> "$backendLog"
"$($spec.exe)" $($spec.args) >> "$backendLog" 2>&1
echo [%date% %time%] backend exited %errorlevel%, restarting in 10s >> "$backendLog"
ping -n 11 127.0.0.1 > nul
goto loop
"@ | Set-Content -Path $backendWrapper -Encoding ascii

  $existing = Get-ScheduledTask -TaskName $BackendTask -EA SilentlyContinue
  if ($existing) {
    $file = Join-Path $rbDir ("task-{0}-{1}.xml" -f ($BackendTask -replace '[^\w.-]', '_'), $stamp)
    Export-ScheduledTask -TaskName $BackendTask | Set-Content -Path $file -Encoding unicode
    $manifest.exportedTasks += @{ name = $BackendTask; path = $existing.TaskPath; file = $file }
  } else { $manifest.createdTasks += $BackendTask }
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $trigger = New-ScheduledTaskTrigger -AtStartup; $trigger.Delay = 'PT20S'
  Register-ScheduledTask -TaskName $BackendTask -Force `
    -Action (New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$backendWrapper`"") `
    -Trigger $trigger `
    -Principal (New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Highest) `
    -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries `
               -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)) `
    -Description "Alpha backend on 127.0.0.1:$BackendPort (repair-alpha-host.ps1)" | Out-Null
  Changed "boot task '$BackendTask' runs the backend at boot as $user, whether or not anyone logs in"

  if (-not $NoHandover -and $spec.pid) {
    # Prove the task can start it, now, rather than at the next 3 a.m. reboot.
    Note "handing over: stopping pid $($spec.pid) and starting '$BackendTask' (about 10-60s of backend downtime)"
    Post "repair: backend handover to boot task, brief downtime"
    taskkill.exe /T /F /PID $spec.pid 2>&1 | Out-Null
    Start-ScheduledTask -TaskName $BackendTask
    $up = $false
    for ($i = 0; $i -lt 40 -and -not $up; $i++) { Start-Sleep 3; $up = BackendOK }
    if ($up) { Changed "backend now supervised by '$BackendTask' - /health answered after handover" }
    else {
      Problem "Backend did not come back under '$BackendTask' within 120s. Restarting the original command."
      Get-Content $backendLog -Tail 20 -EA SilentlyContinue | ForEach-Object { Note "    $_" }
      Stop-ScheduledTask -TaskName $BackendTask -EA SilentlyContinue
      Disable-ScheduledTask -TaskName $BackendTask | Out-Null
      Start-Process -FilePath $spec.exe -ArgumentList $spec.args -WorkingDirectory $spec.dir -WindowStyle Hidden
      Start-Sleep 15
      Note "original restarted: /health $(if (BackendOK) { 'answers' } else { 'STILL DOWN' }). '$BackendTask' disabled until fixed."
    }
  }
} elseif (-not (BackendOK)) {
  Problem "Cannot start the backend: nothing to adopt and no task. Re-run with -BackendExe <python.exe> -BackendArgs '-m uvicorn main:app --host 127.0.0.1 --port $BackendPort' -BackendDir <folder with main.py>."
}

# ================================================================= 3. frontend
Section "3. Production frontend on $FrontendPort"
$fe = Join-Path $AlphaRoot 'frontend'
$dist = Join-Path $fe 'dist'

$lf = Listener $FrontendPort
if ($lf -and -not (FrontendOK)) {
  # Holding the port without serving Alpha: this is the one process this script
  # will stop, and only if it is a runtime it knows.
  if ($lf.Name -match '^(node|python|pythonw)\.exe$') {
    taskkill.exe /T /F /PID $lf.Pid 2>&1 | Out-Null
    Changed "stopped $($lf.Name) pid $($lf.Pid): held $FrontendPort without serving Alpha ($($lf.CommandLine))"
  } else { Problem "$($lf.Name) pid $($lf.Pid) holds $FrontendPort and is not Alpha. Not stopped - decide what it is." }
}

# Stale build: dist older than the newest source file serves yesterday's app.
if (Test-Path (Join-Path $fe 'package.json')) {
  $srcNewest = Get-ChildItem (Join-Path $fe 'src') -Recurse -File -EA SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $distIndex = Get-Item (Join-Path $dist 'index.html') -EA SilentlyContinue
  $stale = (-not $distIndex) -or ($srcNewest -and $srcNewest.LastWriteTime -gt $distIndex.LastWriteTime)
  Note "dist built: $(if ($distIndex) { $distIndex.LastWriteTime } else { 'never' })   newest source: $($srcNewest.LastWriteTime) ($($srcNewest.Name))"
  if ($stale) {
    $npm = (Get-Command npm.cmd -EA SilentlyContinue).Source
    if ($distIndex) {
      $bak = Join-Path $OpsDir "dist-backup-$stamp"
      robocopy $dist $bak /MIR /NFL /NDL /NJH /NJS | Out-Null
      $manifest.distBackup = $bak
      Note "old dist kept at $bak"
    }
    Push-Location $fe
    & $npm run build 2>&1 | Select-Object -Last 15 | ForEach-Object { Note "    $_" }
    $built = $LASTEXITCODE
    Pop-Location
    if ($built -eq 0 -and (Test-Path (Join-Path $dist 'index.html'))) { Changed "frontend rebuilt from current source" }
    else {
      Problem "npm run build failed (exit $built)."
      if ($manifest.distBackup) { robocopy $manifest.distBackup $dist /MIR /NFL /NDL /NJH /NJS | Out-Null; Note "previous dist restored - serving the last build that existed" }
    }
  } else { OK "dist is current" }
}

# Replace other tasks that serve the frontend, then let the existing boot script
# own the "Alpha" task (it pins --host 127.0.0.1 --strictPort).
foreach ($t in $alphaTasks) {
  $a = ($t.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' '
  if ($t.TaskName -ne $FrontendTask -and $t.State -ne 'Disabled' -and $a -match "vite|preview|$FrontendPort|run-alpha\.cmd") { Export-AndDisable $t }
}
if (Get-ScheduledTask -TaskName $FrontendTask -EA SilentlyContinue) {
  $file = Join-Path $rbDir ("task-{0}-{1}.xml" -f ($FrontendTask -replace '[^\w.-]', '_'), $stamp)
  Export-ScheduledTask -TaskName $FrontendTask | Set-Content -Path $file -Encoding unicode
  $manifest.exportedTasks += @{ name = $FrontendTask; path = '\'; file = $file }
} else { $manifest.createdTasks += $FrontendTask }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start-alpha-at-boot.ps1') -AlphaRoot $AlphaRoot -Port $FrontendPort -TaskName $FrontendTask
if ($LASTEXITCODE -ne 0) { Problem "start-alpha-at-boot.ps1 reported a problem - its verdict is above." }
for ($i = 0; $i -lt 20 -and -not (FrontendOK); $i++) { Start-Sleep 3 }
if (FrontendOK) { OK "$frontendUrl serves Alpha" } else { Problem "$frontendUrl does not serve Alpha yet." }

$viaHost = Body $frontendUrl $PublicHost
if ($viaHost -match 'Blocked request') {
  Problem "Vite answers 403 'Blocked request' when asked for $PublicHost - which is what the tunnel asks. Fix in frontend\vite.config: preview: { allowedHosts: ['$PublicHost'] }, then npm run build."
} elseif ($viaHost -match 'id="root"') { OK "frontend also serves Alpha for Host: $PublicHost (what cloudflared sends)" }

if (Test-Path (Join-Path $dist 'index.html')) {
  if (FrontendOK) {
    robocopy $dist (Join-Path $fe 'dist.last-good') /MIR /NFL /NDL /NJH /NJS | Out-Null
    OK "dist snapshotted as dist.last-good (what self-heal rolls back to)"
  }
}

# ================================================================= 4. connector
Section "4. Cloudflare connector"
$svc = Get-Service $CloudflaredService -EA SilentlyContinue
if (-not $svc) { Problem "No '$CloudflaredService' service. Run fix-cloudflare.ps1 - it installs one without touching the tunnel's credentials." }
else {
  sc.exe config $CloudflaredService start= delayed-auto | Out-Null
  sc.exe failure $CloudflaredService reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
  OK "'$CloudflaredService' starts at boot and restarts on crash"
  if ($svc.Status -ne 'Running') { Start-Service $CloudflaredService -EA SilentlyContinue; Start-Sleep 8; Changed "started stopped '$CloudflaredService' service" }

  $pub = Code "https://$PublicHost/"
  Note "https://$PublicHost/ -> $pub"
  $connectorFault = @('502', '504', '520', '521', '522', '523', '524', '530') -contains $pub
  if ($connectorFault) {
    $proven = 0
    for ($i = 0; $i -lt 3; $i++) { if ((FrontendOK) -and (BackendOK)) { $proven++ }; Start-Sleep 10 }
    $internet = (Code 'https://www.cloudflare.com/cdn-cgi/trace') -like '2*'
    $pub = Code "https://$PublicHost/"
    if ($proven -eq 3 -and $internet -and (@('502', '504', '520', '521', '522', '523', '524', '530') -contains $pub)) {
      Note "origin healthy on 3/3 checks, Internet up, edge still says $pub: the connector is the fault. Restarting it."
      Restart-Service $CloudflaredService -Force
      Start-Sleep 20
      $pub = Code "https://$PublicHost/"
      Changed "restarted '$CloudflaredService' (config and credentials untouched); public now $pub"
    } elseif ($proven -lt 3) {
      Problem "Public $pub, but the origin was healthy on only $proven/3 checks. Connector NOT restarted - fix the origin first."
    } elseif (-not $internet) { Problem "This machine cannot reach Cloudflare at all. Connector NOT restarted - check the network (fix-host.ps1)." }
    else { OK "public recovered on its own ($pub)" }
  } elseif ($pub -eq '000') { Problem "https://$PublicHost/ did not answer (DNS or network from this machine)." }
  else { OK "public answers $pub (302/401/403 here is Cloudflare Access or bot protection in front of a working tunnel)" }
}
$hashAfter = @{}; foreach ($f in $cfFiles) { $hashAfter[$f] = (Get-FileHash $f -Algorithm SHA256).Hash }
$evidence.cloudflaredHashAfter = $hashAfter
$drift = @($cfFiles | Where-Object { $hashBefore[$_] -ne $hashAfter[$_] })
if ($drift.Count) { Problem "cloudflared files changed during the run (not by this script): $($drift -join ', ')" }
elseif ($cfFiles.Count) { OK "cloudflared config and credentials byte-identical before and after (SHA-256)" }

# ================================================================= 5. power
Section "5. Power"
$manifest.power = @{ standbyMin = $standbyMin; hibernateMin = $hibernateMin }
if ($standbyMin -ne 0) { powercfg /change standby-timeout-ac 0 | Out-Null; Changed "AC sleep: $standbyMin min -> never" }
if ($hibernateMin -ne 0) { powercfg /change hibernate-timeout-ac 0 | Out-Null; Changed "AC hibernate: $hibernateMin min -> never" }
$lid = powercfg /q SCHEME_CURRENT SUB_BUTTONS LIDACTION | Select-String 'Current AC Power Setting Index: (0x[0-9a-f]+)'
if ($lid -and $lid.Matches[0].Groups[1].Value -ne '0x00000000') {
  Problem "Closing the lid on AC still sleeps this machine. Not changed automatically. To keep Alpha up with the lid shut:  powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0; powercfg /setactive SCHEME_CURRENT"
}

# ================================================================= 6. self-heal
Section "6. Self-heal"
$node = (Get-Command node.exe -EA SilentlyContinue).Source
$shConfig = Join-Path $OpsDir 'selfheal.json'
[ordered]@{
  stateDir = (Join-Path $OpsDir 'selfheal')
  logFile  = (Join-Path $logDir 'selfheal.jsonl')
  backend  = @{ url = $backendUrl; task = $BackendTask; wrapper = $backendWrapper; port = $BackendPort }
  frontend = @{ url = $frontendUrl; task = $FrontendTask; wrapper = (Join-Path $bootDir 'run-alpha.cmd'); port = $FrontendPort; dir = $fe; hostHeader = $PublicHost }
  public   = @{ url = "https://$PublicHost/"; controlUrl = 'https://www.cloudflare.com/cdn-cgi/trace'; service = $CloudflaredService }
  coordination = @{ root = $AlphaRoot; actor = 'alpha-selfheal' }
  cooldownMs = 300000; budgetPerHour = 3; budgetPerDay = 12
} | ConvertTo-Json -Depth 4 | Set-Content -Path $shConfig -Encoding utf8
$selfheal = Join-Path $tunnel 'scripts\alpha-selfheal.mjs'
$dry = & $node $selfheal --config $shConfig --dry-run 2>&1 | Out-String
Note "dry run: $($dry.Trim())"
if (-not (Get-ScheduledTask -TaskName $SelfHealTask -EA SilentlyContinue)) { $manifest.createdTasks += $SelfHealTask }
$every = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2)
$boot  = New-ScheduledTaskTrigger -AtStartup; $boot.Delay = 'PT3M'
Register-ScheduledTask -TaskName $SelfHealTask -Force `
  -Action (New-ScheduledTaskAction -Execute $node -Argument "`"$selfheal`" --config `"$shConfig`"" -WorkingDirectory $tunnel) `
  -Trigger @($every, $boot) `
  -Principal (New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest) `
  -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable -AllowStartIfOnBatteries `
             -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew) `
  -Description 'Bounded self-repair for Alpha: cooldown, budget, rollback, coordination posts (alpha-selfheal.mjs)' | Out-Null
Changed "'$SelfHealTask' runs every 2 minutes as SYSTEM; log $logDir\selfheal.jsonl; status: node `"$selfheal`" --config `"$shConfig`" --status"

# ================================================================= 7. verify
Section "7. Verification"
$v = [ordered]@{}
$v.backendHealth = Code $backendUrl
$v.frontendLocal = if (FrontendOK) { '200 + app root' } else { Code $frontendUrl }
# vite preview answers every app route with index.html; a 404 here means the
# server is not doing SPA fallback and a deep link or refresh will break.
foreach ($r in @('login', 'chat', 'decks', 'brain', 'agents', 'network', 'crown')) {
  $v["route /$r"] = if ((Body "$frontendUrl$r") -match 'id="root"') { 'served' } else { Code "$frontendUrl$r" }
}
$v.public = Code "https://$PublicHost/"
Push-Location $tunnel
$agents = node src/admin/run.js agents 2>&1 | Out-String
Pop-Location
$v.jackAttached = [bool]($agents -match '(?i)jack')
$v.GetEnumerator() | ForEach-Object { Note ("{0,-18} {1}" -f $_.Key, $_.Value) }
Write-Host $agents
if (-not $v.jackAttached) { Problem "No agent named like 'jack' is attached. On Jack's laptop: node scripts\setup-agent.mjs, then run keep-agent.mjs (docs\MASTER_HOST_REPAIR.md, section Jack)." }
$evidence.verification = $v
$evidence.tasksAfter = @(Get-ScheduledTask -TaskName $BackendTask, $FrontendTask, $SelfHealTask -EA SilentlyContinue |
  ForEach-Object { "$($_.TaskName)=$($_.State)" })
Note "In a browser, signed in through Cloudflare Access, still check by hand: login, Chat sends and answers,"
Note "Decks, Brain, Agents, Network Hub and Crown Panel open without a red error. A script cannot sign in through Access."

Finish $(if ($problems.Count) { 1 } else { 0 })

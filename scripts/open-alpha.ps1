<#
  open-alpha.ps1 - what the Alpha desktop shortcut runs.

  Opens Alpha in the browser, but only after proving it answers. On Laptop41
  the shortcut "did nothing" because the site on 4173 was hung: the port was
  held by a vite preview that accepted connections and never replied, so the
  browser spun and the scheduled task still read "Running". A shortcut that
  only opens a URL cannot tell that apart from a working Alpha.

  So, each time:
    1. Frontend: if nothing answers on $Url within a few seconds, stop the
       '$FrontendTask' task, end whatever still holds the port (the hung
       process and its children), start the task again and wait for it.
    2. Backend: if $BackendUrl does not answer and '$BackendTask' exists, run
       that task's own command once, without its -WithFrontend switch - the
       frontend is step 1's job, and two of them would fight over the port.
       The task is not enabled or edited.
    3. Open $Url.

  Install or repair the shortcut (from an Administrator PowerShell):
      powershell -ExecutionPolicy Bypass -File .\scripts\open-alpha.ps1 -InstallShortcut

  The shortcut runs elevated, because the site's task may run as another
  account and only an administrator can end its process. Everything it does is
  logged to %LOCALAPPDATA%\alpha-open.log.
#>
param(
  [string]$Url = 'http://127.0.0.1:4173/',
  [string]$FrontendTask = 'Alpha',
  [int]$FrontendPort = 4173,
  [string]$BackendUrl = 'http://127.0.0.1:8001/',
  [string]$BackendTask = 'AlphaGalaxy Runtime',
  [int]$WaitSeconds = 120,
  [switch]$InstallShortcut,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Continue'
$log = Join-Path $env:LOCALAPPDATA 'alpha-open.log'
function Log($t) {
  $line = "[{0}] {1}" -f (Get-Date -Format 's'), $t
  Add-Content -Path $log -Value $line -EA SilentlyContinue
  Write-Host $line
}
function Popup($t) {
  try { (New-Object -ComObject WScript.Shell).Popup($t, 0, 'Alpha', 0x30) | Out-Null } catch { Write-Host $t }
}

# Any HTTP answer counts, even an error page: the failure being caught here is
# a server that never replies, not one that replies with something odd.
function Answers($u, [int]$timeoutSec = 5) {
  try {
    Invoke-WebRequest $u -UseBasicParsing -TimeoutSec $timeoutSec | Out-Null
    return $true
  } catch [System.Net.WebException] {
    return ($null -ne $_.Exception.Response)
  } catch {
    return $false
  }
}

function WaitFor($u, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (Answers $u 5) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

# ------------------------------------------------------------- the shortcut
if ($InstallShortcut) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $lnk = Join-Path $desktop 'Alpha.lnk'
  if (Test-Path $lnk) {
    $backup = Join-Path $env:LOCALAPPDATA ("alpha-shortcut-backup-{0}.lnk" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Copy-Item $lnk $backup
    Write-Host "old shortcut kept at $backup"
  }
  $shell = New-Object -ComObject WScript.Shell
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`""
  $s.WorkingDirectory = Split-Path $PSCommandPath
  $s.Description = 'Open Alpha, restarting it first if it is not answering'
  $s.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',13'
  $s.Save()
  # "Run as administrator" is one bit in the .lnk header (byte 0x15, 0x20);
  # the COM object has no property for it.
  $bytes = [IO.File]::ReadAllBytes($lnk)
  $bytes[0x15] = $bytes[0x15] -bor 0x20
  [IO.File]::WriteAllBytes($lnk, $bytes)
  Write-Host "shortcut written: $lnk"
  Write-Host "it runs: $($s.TargetPath) $($s.Arguments)"
  exit 0
}

Log "open-alpha: checking $Url"

# ------------------------------------------------------------- 1. frontend
if (Answers $Url 8) {
  Log "frontend answers"
} else {
  Log "frontend is not answering - restarting task '$FrontendTask'"
  $task = Get-ScheduledTask -TaskName $FrontendTask -EA SilentlyContinue
  if (-not $task) {
    Popup "Alpha is not answering on $Url and there is no '$FrontendTask' task to restart it.`n`nLog: $log"
    exit 1
  }
  Stop-ScheduledTask -TaskName $FrontendTask -EA SilentlyContinue
  # Stopping the task ends npm, not always the node it started; a hung vite
  # left behind keeps the port and the restarted one cannot bind.
  Get-NetTCPConnection -LocalPort $FrontendPort -State Listen -EA SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
      $p = Get-CimInstance Win32_Process -Filter "ProcessId=$_" -EA SilentlyContinue
      Log "ending pid $_ ($($p.Name)) holding port $FrontendPort"
      & taskkill.exe /PID $_ /T /F | Out-Null
    }
  Start-Sleep -Seconds 2
  if ((Get-ScheduledTask -TaskName $FrontendTask).State -eq 'Disabled') {
    Popup "The '$FrontendTask' task is disabled, so Alpha cannot be restarted from here.`n`nLog: $log"
    exit 1
  }
  Start-ScheduledTask -TaskName $FrontendTask
  if (WaitFor $Url $WaitSeconds) {
    Log "frontend answers after restart"
  } else {
    Log "frontend still not answering after $WaitSeconds s"
    Popup "Alpha was restarted but is still not answering on $Url after $WaitSeconds seconds.`n`nLog: $log"
    exit 1
  }
}

# -------------------------------------------------------------- 2. backend
if ($BackendUrl) {
  if (Answers $BackendUrl 5) {
    Log "backend answers"
  } else {
    $bt = Get-ScheduledTask -TaskName $BackendTask -EA SilentlyContinue
    if (-not $bt) {
      Log "backend not answering and no '$BackendTask' task - opening Alpha without it"
    } else {
      $a = $bt.Actions | Select-Object -First 1
      $args2 = ($a.Arguments -replace '(?i)\s-WithFrontend\b', '')
      Log "backend not answering - running '$BackendTask' command once: $($a.Execute) $args2"
      $start = @{ FilePath = $a.Execute; ArgumentList = $args2; WindowStyle = 'Hidden' }
      if ($a.WorkingDirectory) { $start.WorkingDirectory = $a.WorkingDirectory }
      try {
        Start-Process @start
        if (WaitFor $BackendUrl 60) { Log "backend answers" }
        else { Log "backend still not answering after 60 s - opening Alpha anyway" }
      } catch {
        Log "could not start the backend: $($_.Exception.Message)"
      }
    }
  }
}

# ----------------------------------------------------------------- 3. open
if (-not $NoBrowser) { Start-Process $Url }
Log "opened $Url"

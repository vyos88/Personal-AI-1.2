<#
  alpha-frontend-run.ps1 - keep Alpha's production frontend (vite preview) up.

  This is what the "Alpha" scheduled task runs after fix-frontend.ps1 -Repair.
  fix-frontend.ps1 copies it to <Landing>\ops\ so the task does not depend on
  where this repository happens to be checked out; do not point a task at the
  copy inside the tunnel checkout, self-update moves that.

  It runs node directly against vite.js rather than `npm run preview`: npm is a
  wrapper, the server is its grandchild, and Task Scheduler stopping the task
  would leave the grandchild holding 4173 so the next start fails to bind.

  It loops forever. A task whose process exits is "Ready" and nothing restarts
  it until the next trigger, so the restart lives here, with backoff.
#>

param(
  [Parameter(Mandatory=$true)][string]$FrontendDir,
  [Parameter(Mandatory=$true)][string]$Node,
  [int]$Port = 4173,
  [string]$Bind = '127.0.0.1',
  [Parameter(Mandatory=$true)][string]$LogDir
)

$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$runLog = Join-Path $LogDir 'frontend-runner.log'
$outLog = Join-Path $LogDir 'frontend.out.log'
$errLog = Join-Path $LogDir 'frontend.err.log'
$pidFile = Join-Path $LogDir 'frontend.pid'

function Log($t) {
  $line = '{0:yyyy-MM-dd HH:mm:ss} [{1}] {2}' -f (Get-Date), $PID, $t
  Add-Content -Path $runLog -Value $line
}

# An always-on process with unrotated logs eventually fills the disk.
function Rotate($f) {
  if ((Test-Path $f) -and (Get-Item $f).Length -gt 10MB) {
    Move-Item -Force $f "$f.1"
  }
}

$vite = Join-Path $FrontendDir 'node_modules\vite\bin\vite.js'
$delay = 5
while ($true) {
  Rotate $runLog; Rotate $outLog; Rotate $errLog

  if (-not (Test-Path $Node))  { Log "node not found at $Node"; Start-Sleep 60; continue }
  if (-not (Test-Path $vite))  { Log "vite not installed: $vite (run npm ci in $FrontendDir)"; Start-Sleep 60; continue }
  if (-not (Test-Path (Join-Path $FrontendDir 'dist\index.html'))) {
    Log "no production build: $FrontendDir\dist\index.html missing (run npm run build)"; Start-Sleep 60; continue
  }

  # Say who holds the port rather than letting vite's --strictPort error be the
  # only record of it. The one holder this removes is provably ours: the vite
  # a previous runner started (its pid file) serving this same directory, left
  # behind when the task was stopped. Anything else is logged and left alone.
  $holder = Get-NetTCPConnection -LocalPort $Port -State Listen -EA SilentlyContinue | Select-Object -First 1
  if ($holder) {
    $hp  = $holder.OwningProcess
    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$hp" -EA SilentlyContinue).CommandLine
    $old = if (Test-Path $pidFile) { (Get-Content $pidFile -EA SilentlyContinue | Select-Object -First 1) } else { '' }
    if ("$hp" -eq "$old".Trim() -and $cmd -and $cmd.IndexOf($vite, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      Log "port $Port held by our own orphaned vite (pid $hp); stopping it"
      Stop-Process -Id $hp -Force -EA SilentlyContinue
      Start-Sleep 2
    } else {
      Log "port $Port already held by pid ${hp}: $cmd"
      Start-Sleep 30; continue
    }
  }

  $viteArgs = '"{0}" preview --host {1} --port {2} --strictPort' -f $vite, $Bind, $Port
  Log "starting: `"$Node`" $viteArgs  (cwd $FrontendDir)"
  $started = Get-Date
  $p = Start-Process -FilePath $Node -ArgumentList $viteArgs -WorkingDirectory $FrontendDir `
         -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden -PassThru
  # Touch the handle now: without it PowerShell 5.1 reports ExitCode as empty.
  $null = $p.Handle
  Set-Content -Path $pidFile -Value $p.Id
  $p.WaitForExit()
  $ran = (Get-Date) - $started
  Log ("vite exited with code {0} after {1:n0}s" -f $p.ExitCode, $ran.TotalSeconds)

  # Back off on a crash loop, reset once it has stayed up a while.
  if ($ran.TotalMinutes -gt 5) { $delay = 5 } else { $delay = [Math]::Min($delay * 2, 120) }
  Start-Sleep -Seconds $delay
}

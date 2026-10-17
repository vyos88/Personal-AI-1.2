<#
  use-latest-alpha.ps1 - make the Alpha desktop shortcut open the newest Alpha
  on this machine, not whichever copy the 'Alpha' task happened to point at.

  Why: on Laptop41 the 'Alpha' task served
  C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software\frontend with
  `vite preview`, which serves the last *build*, not the source. So the
  shortcut showed an old Alpha while the 2.0 shell (ALPHA_OS_VERSION = "2.0"
  in src\app\shell\AppShell.tsx) sat elsewhere, or sat unbuilt.

  What it does, from an Administrator PowerShell:
      powershell -ExecutionPolicy Bypass -File .\scripts\use-latest-alpha.ps1

    1. Finds every Alpha frontend under -SearchRoots (a folder with
       package.json and src\app\shell\AppShell.tsx, outside node_modules) and
       reads its ALPHA_OS_VERSION and ALPHA_VERSION. Newest /OS version wins;
       ties go to the most recently edited source.
    2. Builds it into dist.next and only then swaps it in for dist, keeping
       the previous build as dist.prev-<stamp>. A failed build changes nothing.
    3. Points the '$Task' task at that folder (its command is kept; the old
       definition is exported to %LOCALAPPDATA% first), restarts it, and waits
       for the site to answer.
    4. Installs the desktop shortcut (open-alpha.ps1 -InstallShortcut) and
       opens Alpha.

  -ReportOnly lists what it found and what it would pick, and changes nothing.
#>
param(
  [string[]]$SearchRoots = @($env:USERPROFILE, 'C:\AlphaData', 'C:\services'),
  [string]$Task = 'Alpha',
  [int]$Port = 4173,
  [string]$Url = 'http://127.0.0.1:4173/',
  [switch]$ReportOnly
)

$ErrorActionPreference = 'Continue'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
function Step($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function OK($t)   { Write-Host "  ok: $t" -ForegroundColor Green }
function Stop-With($t) { Write-Host "  STOPPED: $t" -ForegroundColor Red; exit 1 }

function VersionOf([string]$text) {
  if ($text -match '^\d+$') { $text = "$text.0" }
  try { return [version]$text } catch { return [version]'0.0' }
}

# ------------------------------------------------------------------- 1. find
Step "1. Alpha copies on this machine"
$found = @()
foreach ($root in $SearchRoots) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem $root -Recurse -Depth 8 -Filter AppShell.tsx -EA SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.FullName -match '\\src\\app\\shell\\AppShell\.tsx$' } |
    ForEach-Object {
      $fe = $_.FullName -replace '\\src\\app\\shell\\AppShell\.tsx$', ''
      if (-not (Test-Path (Join-Path $fe 'package.json'))) { return }
      $src = Get-Content $_.FullName -Raw
      $os    = if ($src -match 'ALPHA_OS_VERSION\s*=\s*"([^"]+)"') { $Matches[1] } else { '' }
      $alpha = if ($src -match 'ALPHA_VERSION\s*=\s*"([^"]+)"') { $Matches[1] } else { '' }
      $dist  = Join-Path $fe 'dist\index.html'
      $found += [pscustomobject]@{
        Folder  = $fe
        OS      = $os
        Alpha   = $alpha
        Edited  = $_.LastWriteTime
        Built   = if (Test-Path $dist) { (Get-Item $dist).LastWriteTime } else { $null }
      }
    }
}
if (-not $found) { Stop-With "no Alpha frontend (src\app\shell\AppShell.tsx) under $($SearchRoots -join ', ')" }
$found | Sort-Object Folder -Unique | Format-Table Folder, OS, Alpha, Edited, Built -AutoSize | Out-String -Width 300 | Write-Host

$pick = $found | Sort-Object @{ e = { VersionOf $_.OS }; Descending = $true }, @{ e = { $_.Edited }; Descending = $true } | Select-Object -First 1
if (-not $pick.OS) { Stop-With "none of these declares ALPHA_OS_VERSION, so there is no way to tell which is newest" }
OK "newest: /OS $($pick.OS), Alpha $($pick.Alpha) in $($pick.Folder)"

$pkg = Get-Content (Join-Path $pick.Folder 'package.json') -Raw | ConvertFrom-Json
if (-not $pkg.scripts.build)   { Stop-With "$($pick.Folder)\package.json has no 'build' script" }
if (-not $pkg.scripts.preview) { Stop-With "$($pick.Folder)\package.json has no 'preview' script, and that is what the '$Task' task runs" }

$t = Get-ScheduledTask -TaskName $Task -EA SilentlyContinue
if (-not $t) { Stop-With "there is no '$Task' scheduled task to point at it" }
$action = $t.Actions | Select-Object -First 1
OK "'$Task' task currently runs: $($action.Execute) $($action.Arguments)  (in $($action.WorkingDirectory))"

if ($ReportOnly) { Write-Host "`n-ReportOnly: nothing changed."; exit 0 }

# ------------------------------------------------------------------ 2. build
Step "2. Building $($pick.Folder)"
$npm = (Get-Command npm.cmd -EA SilentlyContinue).Source
if (-not $npm) { Stop-With "npm.cmd is not on PATH" }
Push-Location $pick.Folder
try {
  if (-not (Test-Path 'node_modules')) {
    Write-Host "  installing dependencies (first build of this copy)..."
    & $npm install
    if ($LASTEXITCODE -ne 0) { Stop-With "npm install failed; nothing else was changed" }
  }
  if (Test-Path 'dist.next') { Remove-Item 'dist.next' -Recurse -Force }
  # Build beside the live dist, not over it: vite empties its outDir first, so
  # a build that fails half way would leave nothing to serve.
  & $npm run build -- --outDir dist.next --emptyOutDir
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path 'dist.next\index.html')) {
    Stop-With "the build failed (output above); the current Alpha was not touched"
  }
  if (Test-Path 'dist') { Rename-Item 'dist' "dist.prev-$stamp"; OK "previous build kept as dist.prev-$stamp" }
  Rename-Item 'dist.next' 'dist'
  OK "built: $($pick.Folder)\dist"
} finally {
  Pop-Location
}

# ------------------------------------------------------------ 3. repoint
Step "3. Pointing the '$Task' task at it"
$current = ($action.WorkingDirectory -replace '/', '\').TrimEnd('\')
if ($current -ieq $pick.Folder.TrimEnd('\')) {
  OK "already points there"
} else {
  $backup = Join-Path $env:LOCALAPPDATA "alpha-task-$Task-$stamp.xml"
  Export-ScheduledTask -TaskName $Task | Set-Content -Path $backup -Encoding unicode
  OK "old task definition exported to $backup"
  $new = New-ScheduledTaskAction -Execute $action.Execute -Argument $action.Arguments -WorkingDirectory $pick.Folder
  Set-ScheduledTask -TaskName $Task -Action $new | Out-Null
  OK "now runs in $($pick.Folder)"
}

Stop-ScheduledTask -TaskName $Task -EA SilentlyContinue
Get-NetTCPConnection -LocalPort $Port -State Listen -EA SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
    Write-Host "  ending pid $_ holding port $Port"
    & taskkill.exe /PID $_ /T /F | Out-Null
  }
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName $Task
$deadline = (Get-Date).AddSeconds(120)
$up = $false
while (-not $up -and (Get-Date) -lt $deadline) {
  try { Invoke-WebRequest $Url -UseBasicParsing -TimeoutSec 5 | Out-Null; $up = $true } catch { Start-Sleep -Seconds 2 }
}
if (-not $up) { Stop-With "the '$Task' task restarted but nothing answers on $Url after 120 s" }
OK "Alpha answers on $Url"

# --------------------------------------------------------- 4. shortcut
Step "4. Desktop shortcut"
& (Join-Path $PSScriptRoot 'open-alpha.ps1') -InstallShortcut
& (Join-Path $PSScriptRoot 'open-alpha.ps1')
Write-Host "`nDone: the Alpha shortcut opens /OS $($pick.OS) from $($pick.Folder)." -ForegroundColor Green

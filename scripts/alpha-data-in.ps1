<#
.SYNOPSIS
  Copies Alpha's data from a plugged-in drive into this machine's Alpha copy:
  the step of the Alpha move a person would otherwise do by hand.

.DESCRIPTION
  The owner chose (2026-10-07) to move Alpha from Worker1 to the Host. The
  code is a git clone there (prepare-alpha-here); the data is not in git. On
  Worker1 it was copied to the 1 TB WD drive as alpha-move-YYYYMMDD\ with
  memory\ and artifacts\ inside, and the owner plugged that drive into the
  Host. This finds it and copies it in:

    1. Every drive but C: is searched for a top-level alpha-move-* folder
       that holds memory\ or artifacts\; the newest name wins.
    2. The target is the Host's clone: <profile>\Downloads\VyoS-advance-tech-ai
       \BuildArtifacts\installers\Alpha-Full, beside its software\. It must
       already exist, and nothing may answer on 8001 here (an Alpha that runs
       here owns its data; this never copies under a running backend).
    3. memory\ and artifacts\ are copied in. Nothing is deleted, nothing newer
       here is overwritten, and no .env* file is copied: .env.local carries
       secrets and moves by hand only.
    4. Afterwards every file on the drive must be present here, or the exit
       code is 1. Sizes, counts and .env.local presence are printed, never a
       file's contents.

  Takes nothing from the action ({"do":"alpha-data-in"}). -Drives and -Target
  are for the tests.
#>
param(
  [string[]]$Drives,
  [string]$Target,
  [int]$Port = 8001
)

$ErrorActionPreference = 'Continue'
function Gb([double]$bytes) { '{0:N2} GB' -f ($bytes / 1GB) }
function Tally([string]$path) {
  $files = @(Get-ChildItem -LiteralPath $path -Recurse -File -Force -EA SilentlyContinue | Where-Object { $_.Name -notlike '.env*' })
  [pscustomobject]@{ count = $files.Count; bytes = [double](($files | Measure-Object Length -Sum).Sum); files = $files }
}

if (-not $Drives) {
  $Drives = @(Get-PSDrive -PSProvider FileSystem -EA SilentlyContinue | Where-Object { $_.Root -and $_.Root -notmatch '^[Cc]:' } | ForEach-Object { $_.Root })
}
if (-not $Target) {
  $profileDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
  $Target = Join-Path (Join-Path (Join-Path $profileDir 'Downloads') 'VyoS-advance-tech-ai') 'BuildArtifacts\installers\Alpha-Full'
}

# 1
$found = @()
foreach ($root in $Drives) {
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
  foreach ($d in @(Get-ChildItem -LiteralPath $root -Directory -Filter 'alpha-move-*' -EA SilentlyContinue)) {
    if ((Test-Path -LiteralPath (Join-Path $d.FullName 'memory')) -or (Test-Path -LiteralPath (Join-Path $d.FullName 'artifacts'))) { $found += $d }
  }
}
Write-Host "drives searched: $(if ($Drives) { $Drives -join ' ' } else { 'none but C:' })"
if (-not $found.Count) {
  Write-Host 'PROBLEM: no alpha-move-* folder with memory\ or artifacts\ at the top of any drive but C: (is the drive plugged in, and does Windows show it a letter?)'
  exit 1
}
$source = ($found | Sort-Object Name -Descending | Select-Object -First 1).FullName
foreach ($other in $found) { if ($other.FullName -ne $source) { Write-Host "also found (not used): $($other.FullName)" } }
Write-Host "source: $source"

# 2
if (-not (Test-Path -LiteralPath (Join-Path $Target 'software') -PathType Container)) {
  Write-Host "PROBLEM: $Target\software is not here: run prepare-alpha-here first"
  exit 1
}
$listening = $false
if (Get-Command Get-NetTCPConnection -EA SilentlyContinue) {
  $listening = [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -EA SilentlyContinue)
}
if ($listening) {
  Write-Host "PROBLEM: something answers on $Port here, so an Alpha may be running on this data; nothing was copied"
  exit 1
}
Write-Host "target: $Target"

# 3
$parts = @('memory', 'artifacts') | Where-Object { Test-Path -LiteralPath (Join-Path $source $_) -PathType Container }
$need = 0.0
$before = @{}
foreach ($p in $parts) { $before[$p] = Tally (Join-Path $source $p); $need += $before[$p].bytes }
$drive = try { [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot((Resolve-Path -LiteralPath $Target).Path)) } catch { $null }
if ($drive -and $drive.AvailableFreeSpace -lt ($need + 5GB)) {
  Write-Host ("PROBLEM: {0} free on {1}, the copy needs {2} and 5 GB to spare" -f (Gb $drive.AvailableFreeSpace), $drive.Name, (Gb $need))
  exit 1
}
$robocopy = Get-Command robocopy.exe -EA SilentlyContinue
foreach ($p in $parts) {
  $from = Join-Path $source $p
  $to = Join-Path $Target $p
  Write-Host ("copying {0}: {1} files, {2}" -f $p, $before[$p].count, (Gb $before[$p].bytes))
  $started = Get-Date
  if ($robocopy) {
    # /XO: a file that is newer here stays. No /MIR or /PURGE: nothing here is deleted.
    & $robocopy.Source $from $to /E /XO /XF '.env*' /R:1 /W:1 /MT:8 /NP /NFL /NDL /NJH | Out-Null
    $code = $LASTEXITCODE
    Write-Host ("  robocopy exit {0} ({1}) in {2:N0} s" -f $code, $(if ($code -lt 8) { 'ok' } else { 'some files failed' }), ((Get-Date) - $started).TotalSeconds)
  } else {
    $copied = 0
    foreach ($f in $before[$p].files) {
      $rel = $f.FullName.Substring($from.Length).TrimStart('\', '/')
      $dest = Join-Path $to $rel
      if (Test-Path -LiteralPath $dest -PathType Leaf) {
        if ((Get-Item -LiteralPath $dest).LastWriteTimeUtc -ge $f.LastWriteTimeUtc) { continue }
      }
      New-Item -ItemType Directory -Force -Path (Split-Path $dest -Parent) | Out-Null
      Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
      $copied++
    }
    Write-Host "  copied $copied file(s)"
  }
}

# 4
$missing = 0
foreach ($p in $parts) {
  $from = Join-Path $source $p
  $to = Join-Path $Target $p
  $gone = @($before[$p].files | Where-Object { -not (Test-Path -LiteralPath (Join-Path $to $_.FullName.Substring($from.Length).TrimStart('\', '/')) -PathType Leaf) })
  $after = Tally $to
  Write-Host ("{0} here now: {1} files, {2}; {3} from the drive missing" -f $p, $after.count, (Gb $after.bytes), $gone.Count)
  foreach ($g in ($gone | Select-Object -First 5)) { Write-Host "  missing: $($g.FullName.Substring($from.Length).TrimStart('\', '/'))" }
  $missing += $gone.Count
}
foreach ($envFile in @((Join-Path $Target '.env.local'), (Join-Path $Target 'software\frontend\.env.local'))) {
  Write-Host "$(if (Test-Path -LiteralPath $envFile -PathType Leaf) { 'present' } else { 'MISSING' }): $envFile (contents not read; copied by hand only)"
}
if ($missing) { Write-Host "PROBLEM: $missing file(s) from the drive are not here"; exit 1 }
Write-Host 'done: the data is in place; next songs-check, then the local test start'
exit 0

<#
.SYNOPSIS
  Phase 2 of the Alpha move (docs/HANDOFF_2026-10-07d_alpha-moves-to-host.md):
  take Alpha's data and configuration that Laptop41 sent over Taildrop, check
  every file against the manifest that came with them, and put them into the
  Alpha copy prepare-alpha-here.ps1 made. Starts nothing.

.DESCRIPTION
  Laptop41 sends, with `tailscale file cp`:
    alpha-move-manifest.json  {"files":[{"name","sha256","bytes","kind"}]}
    memory-*.tar              Alpha's memory\ folder (kind "memory")
    env.local / env           the root .env.local / .env (kind "env-local"/"env")

  Taildrop is end-to-end encrypted and peer to peer inside the owner's
  tailnet; nothing passes through git, a chat or a third-party server. That is
  the route HANDOFF_2026-10-05c chose for auth.json too.

  This job:
    1. collects whatever Taildrop holds for this machine into the inbox
       (C:\AlphaData\alpha-move\inbox);
    2. reads the newest manifest and checks every file it names: present,
       the right size, the right SHA-256. One mismatch stops everything and
       changes nothing; the files stay for the next run;
    3. moves the existing memory\ aside (memory.prev-<stamp>, never deleted)
       and extracts the archive in its place, so the first copy and the final
       one at the switch-over are the same step;
    4. puts .env.local and .env beside software\, keeping any earlier one as
       .prev-<stamp>, and removes the received copies from the inbox so a
       secret does not sit in two places.

  It never prints a configuration file's contents, never starts Alpha, and
  refuses outright while something listens on 8001 here: data is never
  swapped under a running Alpha.

  Exit 0 when the data is in place, 3 when nothing complete has arrived yet,
  1 when it refused or a check failed.
#>
param(
  [string]$Target = '',
  [string]$Inbox = 'C:\AlphaData\alpha-move\inbox',
  [switch]$NoFetch
)

$ErrorActionPreference = 'Continue'
if (-not $Target) {
  $profileDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
  $Target = Join-Path (Join-Path $profileDir 'Downloads') 'VyoS-advance-tech-ai'
}
$nested = Join-Path $Target 'BuildArtifacts\installers\Alpha-Full'
$alphaHome = if (Test-Path (Join-Path $nested 'software')) { $nested } else { $Target }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$tar = if (Get-Command tar.exe -EA SilentlyContinue) { 'tar.exe' } else { 'tar' }
function Say([string]$t) { Write-Output $t }

$machine = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { [Environment]::MachineName }
Say ("RECEIVE ALPHA DATA {0} {1}" -f $machine, (Get-Date).ToString('yyyy-MM-dd HH:mm'))

$live = $null
$live = Get-NetTCPConnection -LocalPort 8001 -State Listen -EA SilentlyContinue | Select-Object -First 1
if ($live) { Say "REFUSED: something listens on 8001 (pid $($live.OwningProcess)): data is never swapped under a running Alpha"; exit 1 }
if (-not (Test-Path (Join-Path $alphaHome 'software\backend\main.py'))) { Say "REFUSED: no prepared Alpha copy at $alphaHome (run prepare-alpha-here first)"; exit 1 }

New-Item -ItemType Directory -Force -Path $Inbox | Out-Null
if (-not $NoFetch) {
  $ts = Get-Command tailscale -EA SilentlyContinue
  if (-not $ts) { Say 'NOT YET: tailscale is not on PATH here'; exit 3 }
  $out = & $ts.Source file get --conflict=overwrite $Inbox 2>&1
  Say ("  taildrop: {0}" -f ((@($out) | Select-Object -Last 1) -as [string]))
}

$manifestFile = Join-Path $Inbox 'alpha-move-manifest.json'
if (-not (Test-Path $manifestFile)) { Say "NOT YET: no alpha-move-manifest.json in $Inbox"; exit 3 }
try { $manifest = Get-Content $manifestFile -Raw | ConvertFrom-Json } catch { Say 'REFUSED: the manifest is not valid JSON'; exit 1 }
$entries = @($manifest.files)
if (-not $entries.Count) { Say 'REFUSED: the manifest lists no files'; exit 1 }

# ---------------------------------------------------------------- verify all first
$bad = 0; $waiting = 0
foreach ($e in $entries) {
  $name = [string]$e.name
  if ($name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$' -or @('memory', 'env-local', 'env') -notcontains [string]$e.kind) { Say "  REFUSED entry: $name ($($e.kind))"; $bad++; continue }
  $p = Join-Path $Inbox $name
  if (-not (Test-Path $p)) { Say "  waiting for $name"; $waiting++; continue }
  $len = (Get-Item -Force $p).Length
  $hash = (Get-FileHash -Algorithm SHA256 $p).Hash.ToLower()
  if ($len -ne [int64]$e.bytes -or $hash -ne ([string]$e.sha256).ToLower()) { Say "  MISMATCH: $name ($len bytes)"; $bad++ }
  else { Say ("  ok: {0} ({1:N1} MB, sha256 matches)" -f $name, ($len / 1MB)) }
}
if ($bad) { Say "REFUSED: $bad file(s) failed the check; nothing was changed, the files stay in $Inbox"; exit 1 }
if ($waiting) { Say "NOT YET: $waiting file(s) still to arrive"; exit 3 }

# ---------------------------------------------------------------- memory
foreach ($e in @($entries | Where-Object { $_.kind -eq 'memory' })) {
  $tarFile = Join-Path $Inbox ([string]$e.name)
  $listing = @(& $tar -tf $tarFile 2>$null)
  $unsafe = @($listing | Where-Object { $_ -match '^(/|[A-Za-z]:)|(^|[\\/])\.\.([\\/]|$)' -or $_ -notmatch '^memory([\\/]|$)' })
  if (-not $listing.Count -or $unsafe.Count) { Say "REFUSED: $($e.name) holds paths outside memory\ ($($unsafe.Count)); nothing was changed"; exit 1 }
  $mem = Join-Path $alphaHome 'memory'
  if (Test-Path $mem) {
    Rename-Item -Path $mem -NewName "memory.prev-$stamp"
    Say "  kept the previous memory\ as memory.prev-$stamp"
  }
  $out = & $tar -xf $tarFile -C $alphaHome 2>&1
  if ($LASTEXITCODE -ne 0) {
    Say "FAILED: extracting $($e.name)"; @($out | Select-Object -Last 3) | ForEach-Object { Say "    | $_" }
    if (Test-Path (Join-Path $alphaHome "memory.prev-$stamp")) {
      if (Test-Path $mem) { Rename-Item -Path $mem -NewName "memory.failed-$stamp" }
      Rename-Item -Path (Join-Path $alphaHome "memory.prev-$stamp") -NewName 'memory'
      Say '  the previous memory\ is back in place'
    }
    exit 1
  }
  $count = @(Get-ChildItem $mem -Recurse -File -Force -EA SilentlyContinue).Count
  Say ("  memory\ in place: {0:N0} files" -f $count)
  Remove-Item -Force $tarFile
}

# ---------------------------------------------------------------- configuration
foreach ($pair in @(@('env-local', '.env.local'), @('env', '.env'))) {
  foreach ($e in @($entries | Where-Object { $_.kind -eq $pair[0] })) {
    $src = Join-Path $Inbox ([string]$e.name)
    $dst = Join-Path $alphaHome $pair[1]
    if (Test-Path $dst) { Move-Item -Force $dst "$dst.prev-$stamp"; Say "  kept the previous $($pair[1]) as $($pair[1]).prev-$stamp" }
    Move-Item -Force $src $dst
    Say ("  {0} in place ({1} bytes; contents not shown)" -f $pair[1], (Get-Item -Force $dst).Length)
  }
}
Remove-Item -Force $manifestFile
Say "RESULT: Alpha's data and configuration are in $alphaHome. Nothing was started."
exit 0

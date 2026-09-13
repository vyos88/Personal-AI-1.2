<#
  cleanup-alpha.ps1 — inventory every copy of Alpha on this machine, say which
  one is live, and remove the old ones.

  REPORT ONLY (this is the default — it deletes nothing):
      powershell -ExecutionPolicy Bypass -File .\cleanup-alpha.ps1

  REMOVE the old copies, after reading the report above:
      powershell -ExecutionPolicy Bypass -File .\cleanup-alpha.ps1 -Delete

  -Delete still shows the list and then requires DELETE typed in full. What it
  removes goes to the Recycle Bin, not the void, so a mistake is recoverable.
  Add -Permanent only if disk space is the actual problem and you have read the
  list carefully.

  Each copy is identified by its OWN version, read from the ALPHA_VERSION
  constant in its AppShell.tsx, because timestamps lie: a copy restored from a
  backup has a new date and old code.

  What it will never delete, whatever you pass:
    the live copy            whichever directory the running Alpha is served from
    the newest backup        the one rollback you would actually want
    anything holding a .env  that is a configured install, not a stale copy;
                             it is reported and skipped, and you decide
    the alpha-tunnel repo    this repository, and its alpha-host/alpha-agent
                             services, are a different program from Alpha

  Installed programs and Windows services are REPORTED, never touched. An
  uninstaller can take a working install with it, and the tunnel's own services
  live in the same name space.
#>

param(
  [string]$AlphaRoot = 'C:\AlphaData\Alpha',
  [string]$Landing   = 'C:\AlphaData',
  [switch]$Delete,
  [switch]$Permanent
)

$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'cleanup-alpha-log.txt'
Start-Transcript -Path $log -Force | Out-Null

function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function OK($t)      { Write-Host "  ok: $t" -ForegroundColor Green }
function Warn($t)    { Write-Host "  $t" -ForegroundColor Yellow }
function Bad($t)     { Write-Host "  $t" -ForegroundColor Red }
function Note($t)    { Write-Host "     $t" -ForegroundColor DarkGray }

# Read a copy's own version rather than trusting where it sits.
function Get-AlphaVersion($dir) {
  $shell = Join-Path $dir 'frontend\src\app\shell\AppShell.tsx'
  if (-not (Test-Path $shell)) { return $null }
  $m = Select-String -Path $shell -Pattern 'const\s+ALPHA_VERSION\s*=\s*"([^"]+)"' -EA SilentlyContinue |
       Select-Object -First 1
  if ($m) { return $m.Matches[0].Groups[1].Value }
  return '?'
}

function Get-DirSize($dir) {
  try { (Get-ChildItem $dir -Recurse -File -Force -EA SilentlyContinue | Measure-Object Length -Sum).Sum }
  catch { 0 }
}

# Remove-Item cannot reach the Recycle Bin, and Shell.Application's delete verb
# is asynchronous and can raise a confirmation dialog — either would hang this
# or appear to succeed having done nothing. This API is synchronous and names
# the Recycle Bin explicitly.
Add-Type -AssemblyName Microsoft.VisualBasic -EA SilentlyContinue
function Recycle($path) {
  $bin = [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
  $ui  = [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs
  if (Test-Path $path -PathType Container) {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($path, $ui, $bin)
  } else {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($path, $ui, $bin)
  }
}

# ------------------------------------------------------------- what is live
Section "Which Alpha is running"
# Keep the whole command line and test discovered copies against it as plain
# text. Parsing a root out of the command line with a regex is what looks
# right and is not: an alpha-ish path matched non-greedily yields C:\AlphaData
# rather than C:\AlphaData\Alpha, which would protect every backup under it
# and quietly make this script a no-op that reports success.
$cmdLines = @()
$procs = @(Get-Process -EA SilentlyContinue | Where-Object { $_.ProcessName -match '^(node|python|pythonw|deno|bun)$' })
foreach ($p in $procs) {
  $cmd = try {
    (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)" -EA SilentlyContinue).CommandLine
  } catch { $null }
  if ($cmd) { $cmdLines += $cmd }
}
if ($cmdLines) {
  OK "$($cmdLines.Count) node/python process(es) running; their paths are matched against each copy below"
} else {
  Warn "No node/python process is running at all."
  Warn "Either Alpha is stopped, or it is served by something this does not recognise."
  Note "The copy at -AlphaRoot is treated as live regardless, so nothing there is removed."
}
# -AlphaRoot is protected unconditionally, running or not.
$protected = @($AlphaRoot)

# A copy is live if its full path appears verbatim in some command line.
# Substring, not -like: a path containing [ or ] would break a wildcard match
# and lose its protection, which is the one failure this must not have.
#
# DELIBERATELY not separator-aware. "C:\AlphaData\AlphaOld" starts with
# "C:\AlphaData\Alpha" and is therefore treated as live, so a sibling whose
# name merely begins with a protected path is never deleted. That is a false
# positive, and for a deletion script a false positive costs a leftover folder
# while a false negative costs someone's install. Do not "fix" this by adding a
# trailing-separator check without deciding you want the opposite trade.
function Test-Live($dir) {
  if ($protected | Where-Object {
        $dir.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) -or
        $_.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) }) { return $true }
  foreach ($c in $cmdLines) {
    if ($c.IndexOf($dir, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
  }
  return $false
}

# --------------------------------------------------------- find every copy
Section "Every Alpha copy on this machine"
$searchRoots = @(
  $Landing,
  'C:\', 'C:\Alpha', 'C:\alpha', 'C:\Program Files', 'C:\Program Files (x86)',
  $env:USERPROFILE,
  (Join-Path $env:USERPROFILE 'Downloads'),
  (Join-Path $env:USERPROFILE 'Desktop'),
  (Join-Path $env:USERPROFILE 'Documents'),
  $env:LOCALAPPDATA
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

# A directory is an Alpha copy if it holds the shell file. That is a much
# narrower test than "is named alpha", which matches this repository too.
$copies = @()
foreach ($root in $searchRoots) {
  $depth = if ($root -eq 'C:\' -or $root -eq $env:USERPROFILE) { 3 } else { 5 }
  $hits = @(Get-ChildItem $root -Recurse -Depth $depth -Filter 'AppShell.tsx' -File -Force -EA SilentlyContinue |
            Where-Object { $_.FullName -notmatch '\\node_modules\\' })
  foreach ($h in $hits) {
    # <root>\frontend\src\app\shell\AppShell.tsx  ->  <root>. Strip the
    # known suffix rather than climbing N levels: counting Split-Path calls is
    # off by one the moment the layout differs, and a wrong root here is what
    # would get handed to the delete loop.
    $suffix = '\frontend\src\app\shell'
    $d = $h.Directory.FullName
    if (-not $d.EndsWith($suffix, [StringComparison]::OrdinalIgnoreCase)) {
      Note "ignoring $($h.FullName) — not laid out like an Alpha copy"
      continue
    }
    $dir = $d.Substring(0, $d.Length - $suffix.Length)
    if ($dir -and (Test-Path $dir)) { $copies += $dir }
  }
}
$copies = @($copies | Select-Object -Unique)

$inventory = @()
foreach ($c in $copies) {
  $inventory += [pscustomobject]@{
    Path      = $c
    Version   = (Get-AlphaVersion $c)
    Modified  = (Get-Item $c).LastWriteTime
    SizeMB    = [math]::Round((Get-DirSize $c)/1MB, 1)
    HasEnv    = (Test-Path (Join-Path $c '.env'))
    Live      = (Test-Live $c)
    Kind      = 'install'
  }
}

# sync-alpha.ps1 leaves one of these behind on every Receive, so they pile up.
$backupRoot = Join-Path $Landing 'Backups'
$backups = @()
if (Test-Path $backupRoot) {
  $backups = @(Get-ChildItem $backupRoot -Directory -Filter 'Alpha-*' -EA SilentlyContinue |
               Sort-Object LastWriteTime -Descending)
  $newest = if ($backups) { $backups[0].FullName } else { $null }
  foreach ($b in $backups) {
    $inventory += [pscustomobject]@{
      Path      = $b.FullName
      Version   = (Get-AlphaVersion $b.FullName)
      Modified  = $b.LastWriteTime
      SizeMB    = [math]::Round((Get-DirSize $b.FullName)/1MB, 1)
      HasEnv    = (Test-Path (Join-Path $b.FullName '.env'))
      Live      = (($b.FullName -eq $newest) -or (Test-Live $b.FullName))
      Kind      = if ($b.FullName -eq $newest) { 'backup (newest, kept)' } else { 'backup' }
    }
  }
}

if (-not $inventory) {
  Warn "No Alpha copy found under any of:"
  $searchRoots | ForEach-Object { Note $_ }
  Warn "If Alpha lives somewhere else, pass it: .\cleanup-alpha.ps1 -AlphaRoot <path>"
} else {
  $inventory | Sort-Object Kind, Modified -Descending |
    Format-Table @{L='Ver';E={$_.Version}}, @{L='MB';E={$_.SizeMB}},
                 @{L='Modified';E={$_.Modified.ToString('yyyy-MM-dd HH:mm')}},
                 @{L='env';E={if($_.HasEnv){'yes'}else{''}}},
                 @{L='Keep';E={if($_.Live){'KEEP'}else{''}}},
                 Kind, Path -AutoSize | Out-String -Width 200 | Write-Host
}

# ------------------------------------------------------------------ archives
Section "Stale archives and staging directories"
$junk = @()
foreach ($pat in @('alpha-code.zip', 'alpha-*.zip', 'Alpha-*.zip')) {
  foreach ($root in @($Landing, (Join-Path $env:USERPROFILE 'Downloads'))) {
    if (Test-Path $root) {
      $junk += @(Get-ChildItem $root -Filter $pat -File -EA SilentlyContinue)
    }
  }
}
$stage = Join-Path $Landing '_alpha-stage'
if (Test-Path $stage) { $junk += (Get-Item $stage) }
$junk = @($junk | Select-Object -Unique)
if ($junk) {
  $junk | ForEach-Object {
    $sz = if ($_.PSIsContainer) { Get-DirSize $_.FullName } else { $_.Length }
    Write-Host ("  {0,8:N1} MB  {1}" -f ($sz/1MB), $_.FullName)
  }
  Note "These are transfer leftovers. sync-alpha.ps1 recreates them when needed."
} else {
  OK "none"
}

# ------------------------------------------------------- installed programs
Section "Installed programs matching Alpha (reported only)"
$keys = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$installed = @(Get-ItemProperty $keys -EA SilentlyContinue |
               Where-Object { $_.DisplayName -match 'alpha|vyos' })
if ($installed) {
  foreach ($i in $installed) {
    Write-Host "  $($i.DisplayName)  $($i.DisplayVersion)"
    if ($i.UninstallString) { Note "uninstall: $($i.UninstallString)" }
  }
  Warn "Not uninstalled by this script. An uninstaller can take a working"
  Warn "install with it, and only you know which of these is in use."
  Note "Run the uninstall string yourself once you are sure."
} else {
  OK "nothing in Add/Remove Programs matches Alpha"
}

# ---------------------------------------------------------------- services
Section "Services pointing at paths that no longer exist (reported only)"
$svcs = @(Get-Service -EA SilentlyContinue | Where-Object Name -like '*alpha*')
if (-not $svcs) {
  OK "no alpha-* services on this machine"
} else {
  foreach ($s in $svcs) {
    $bin = try { (Get-CimInstance Win32_Service -Filter "Name='$($s.Name)'" -EA SilentlyContinue).PathName } catch { $null }
    $exe = if ($bin -match '^"([^"]+)"') { $Matches[1] } elseif ($bin -match '^(\S+)') { $Matches[1] } else { $null }
    $dead = $exe -and -not (Test-Path $exe)
    if ($dead) {
      Bad "$($s.Name) [$($s.Status)] -> $exe  (MISSING)"
      Note "A leftover from an older install. Remove with: sc.exe delete $($s.Name)"
    } else {
      OK "$($s.Name) [$($s.Status)]"
    }
  }
  Warn "alpha-host and alpha-agent belong to alpha-tunnel, NOT to Alpha."
  Warn "Do not delete those two while the tunnel is in use."
}

# ------------------------------------------------------------------ removal
$removable = @($inventory | Where-Object { -not $_.Live -and -not $_.HasEnv })
$skippedEnv = @($inventory | Where-Object { -not $_.Live -and $_.HasEnv })
$freeMB = [math]::Round((($removable | Measure-Object SizeMB -Sum).Sum +
                         (($junk | ForEach-Object { if ($_.PSIsContainer) { Get-DirSize $_.FullName } else { $_.Length } } |
                           Measure-Object -Sum).Sum / 1MB)), 1)

Section "What -Delete would remove"
if ($skippedEnv) {
  Warn "Skipped because they hold a .env — a configured install, not a stale copy:"
  $skippedEnv | ForEach-Object { Note "$($_.Path)  (version $($_.Version))" }
  Note "If one of these really is dead, delete it by hand after checking its .env."
}
if (-not $removable -and -not $junk) {
  OK "Nothing to remove. This machine has one Alpha and no leftovers."
  Write-Host "`nFull log written to: $log`n"
  Stop-Transcript | Out-Null
  exit 0
}
foreach ($r in $removable) { Write-Host "  copy    $($r.Path)  (version $($r.Version), $($r.SizeMB) MB)" }
foreach ($j in $junk)      { Write-Host "  archive $($j.FullName)" }
Write-Host ("  total: about {0} MB" -f $freeMB) -ForegroundColor Cyan

if (-not $Delete) {
  Write-Host "`nNothing was deleted. This run only reported." -ForegroundColor Green
  Write-Host "Read the list above. If it is right, run it again with -Delete."
  Write-Host "`nThree lines worth sending back, if you want me to read it:"
  Write-Host "  1. the Ver and Keep columns from the inventory table"
  Write-Host "  2. whether any service printed MISSING"
  Write-Host "  3. the total MB on the line above"
  Write-Host "`nFull log written to: $log`n"
  Stop-Transcript | Out-Null
  exit 0
}

Section "Confirm"
$dest = if ($Permanent) { 'PERMANENTLY, not to the Recycle Bin' } else { 'to the Recycle Bin' }
Write-Host "  This will remove the items listed above $dest." -ForegroundColor Yellow
$answer = Read-Host "  Type DELETE in full to proceed, anything else to stop"
if ($answer -ne 'DELETE') {
  Write-Host "  Stopped. Nothing was removed." -ForegroundColor Green
  Write-Host "`nFull log written to: $log`n"
  Stop-Transcript | Out-Null
  exit 0
}

Section "Removing"
$done = 0
foreach ($target in (@($removable | ForEach-Object { $_.Path }) + @($junk | ForEach-Object { $_.FullName }))) {
  # Re-checked here rather than trusted from the filter above: this is the last
  # point before something is actually removed.
  if (Test-Live $target) {
    Bad "refusing $target — it is live, or is -AlphaRoot"
    continue
  }
  try {
    if ($Permanent) { Remove-Item $target -Recurse -Force -EA Stop }
    else            { Recycle $target }
    OK "removed $target"
    $done++
  } catch {
    Bad "could not remove $target : $($_.Exception.Message)"
    Note "Usually a file still open. Stop Alpha, close editors and terminals in that path, re-run."
  }
}
Write-Host ("`n  {0} item(s) removed, about {1} MB reclaimed." -f $done, $freeMB) -ForegroundColor Green
if (-not $Permanent) { Note "In the Recycle Bin until you empty it, if you need any of it back." }

Write-Host "`nFull log written to: $log`n"
Stop-Transcript | Out-Null

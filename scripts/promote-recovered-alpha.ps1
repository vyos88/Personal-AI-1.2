<#
  promote-recovered-alpha.ps1 - after recover-alpha-from-usb.ps1 has finished,
  prove the recovered copy can replace the live install, then (only when asked)
  swap it in at the SAME path, with an automatic and a manual way back.

  STEP 1, read only (changes nothing, safe while the site is serving):
      powershell -ExecutionPolicy Bypass -File .\promote-recovered-alpha.ps1

  STEP 2, elevated, only when step 1 says READY, and after a person has signed
  in at http://127.0.0.1:4183, sent one Chat message and opened Decks, Brain
  and Agents on the recovered copy:
      powershell -ExecutionPolicy Bypass -File .\promote-recovered-alpha.ps1 -Promote -HumanChecked [-CarryLiveData | -AcceptDataRollback]

  Undo a promotion:
      powershell -ExecutionPolicy Bypass -File .\promote-recovered-alpha.ps1 -Rollback

  Why the same path. Everything already pointing at C:\AlphaData\Alpha keeps
  working untouched: the boot wrappers in C:\ProgramData\AlphaBoot, the
  self-heal config, cloudflared's ingress, and the recovered configuration's
  own references to the live path - which recover-alpha-from-usb.ps1 refused to
  run from E: precisely because they name this path. Rollback is a rename back.

  What -Promote does, in order (about 2-5 minutes of site downtime):
    1. disables 'Alpha Self-Heal' so it cannot restart anything mid-swap
    2. stops the recovered copy on 8011/4183 (recover-alpha-from-usb -StopRecovered)
    3. stops the 'Alpha' and 'Alpha Backend' tasks and every process whose
       executable or command line is inside the live folder - nothing else
    4. RENAMES the live folder to Alpha.pre-promote-<time>. Nothing is deleted
       or overwritten; that folder is the rollback.
    5. copies the recovered checkout into C:\AlphaData\Alpha (without the
       recovery-only vite.recovery.config.mjs, which points at 8011)
    6. with -CarryLiveData, copies the data files that are newer in, or only
       in, the live install over the recovered ones (live data wins)
    7. recreates the backend's Python venv at the same relative path (a venv
       cannot be moved) and installs the recovered requirements into it
    8. starts the backend from the new folder and waits for /health
    9. runs repair-alpha-host.ps1 -AlphaRoot C:\AlphaData\Alpha, which adopts
       that backend into 'Alpha Backend' (and proves the handover), serves the
       frontend through 'Alpha', snapshots dist.last-good and re-enables
       'Alpha Self-Heal'
   10. verifies; if the backend or the frontend is not serving, it rolls back
       on its own

  Never touched: the USB drive, the recovery folder on E: (copied from, not
  moved), cloudflared's config and credentials, DNS, WAF, Access.
#>

param(
  [string]$Recovery = '',
  [string]$TargetRoot = 'E:\AlphaRecovery',
  [string]$LiveRoot = 'C:\AlphaData\Alpha',
  [int]$BackendPort = 8001,
  [int]$FrontendPort = 4173,
  [string]$HealthPath = '/health',
  [string]$PublicHost = 'alpha-ai.uk',
  [switch]$Promote,
  [switch]$HumanChecked,
  [switch]$CarryLiveData,
  [switch]$AcceptDataRollback,
  [switch]$Rollback
)

$ErrorActionPreference = 'Continue'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$LiveRoot = $LiveRoot.TrimEnd('\')
$liveParent = Split-Path $LiveRoot
$liveLeaf = Split-Path $LiveRoot -Leaf
$logDir = Join-Path $liveParent 'alpha-ops\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "promote-$stamp.log"
Start-Transcript -Path $log -Force | Out-Null

$blockers = New-Object System.Collections.ArrayList
function Blocker($t) { [void]$blockers.Add($t); Write-Host "  BLOCKER: $t" -ForegroundColor Red }
function OK($t)      { Write-Host "  ok: $t" -ForegroundColor Green }
function Warn($t)    { Write-Host "  $t" -ForegroundColor Yellow }
function Note($t)    { Write-Host "  $t" }
function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Done($code) { Write-Host "`nLog: $log`n"; Stop-Transcript | Out-Null; exit $code }

function Code($url, [string]$HostHeader = '') {
  $a = @('-s', '-k', '-o', 'NUL', '-w', '%{http_code}', '--max-time', '8')
  if ($HostHeader) { $a += @('-H', "Host: $HostHeader") }
  $c = & curl.exe @a $url 2>$null; if (-not $c) { '000' } else { "$c" }
}
function Body($url, [string]$HostHeader = '') {
  $a = @('-s', '-k', '--max-time', '8'); if ($HostHeader) { $a += @('-H', "Host: $HostHeader") }
  (& curl.exe @a $url 2>$null | Out-String)
}
$backendUrl = "http://127.0.0.1:$BackendPort$HealthPath"
$frontendUrl = "http://127.0.0.1:$FrontendPort/"
function BackendOK { (Code $backendUrl) -like '2*' }
function FrontendOK { (Body $frontendUrl) -match 'id="root"' }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin -and -not $Rollback) {
  # 'Alpha Backend' runs elevated, and Windows hides an elevated process's
  # command line from a non-elevated one - section 3 would then find nothing.
  Write-Host "Not elevated: still read only, but the backend's command line may be hidden. Prefer an Administrator PowerShell." -ForegroundColor Yellow
}

# Every process belonging to an Alpha folder: its executable or its command
# line lies inside that folder, or it is one of the boot wrappers. That is the
# proof; nothing outside it is ever stopped.
function Stop-AlphaTree($root) {
  foreach ($t in 'Alpha Self-Heal', 'Alpha', 'Alpha Backend') { Stop-ScheduledTask -TaskName $t -EA SilentlyContinue }
  $boot = Join-Path $env:ProgramData 'AlphaBoot'
  $mine = @(Get-CimInstance Win32_Process -EA SilentlyContinue | Where-Object {
    $_.ProcessId -ne $PID -and (
      ($_.ExecutablePath -and $_.ExecutablePath.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) -or
      ($_.CommandLine -and ($_.CommandLine.IndexOf("$root\", [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
                            $_.CommandLine.IndexOf("$boot\run-alpha", [StringComparison]::OrdinalIgnoreCase) -ge 0)) ) })
  foreach ($p in $mine) {
    Note "stopping pid $($p.ProcessId) $($p.Name): $($p.CommandLine)"
    taskkill.exe /T /F /PID $p.ProcessId 2>&1 | Out-Null
  }
  Start-Sleep 3
}

function Rename-WithRetry($from, $toLeaf) {
  for ($i = 0; $i -lt 5; $i++) {
    try { Rename-Item -Path $from -NewName $toLeaf -EA Stop; return $true }
    catch { Note "rename attempt $($i + 1) failed: $($_.Exception.Message)"; Start-Sleep 5 }
  }
  return $false
}

# ================================================================ ROLLBACK
if ($Rollback) {
  Section "Rollback of the last promotion"
  if (-not $admin) { Write-Host "Run elevated." -ForegroundColor Red; Done 1 }
  $m = Get-ChildItem $logDir -Filter 'promotion-*.json' -EA SilentlyContinue | Sort-Object Name | Select-Object -Last 1
  if (-not $m) { Write-Host "No promotion manifest in $logDir." -ForegroundColor Red; Done 1 }
  $mf = Get-Content $m.FullName -Raw | ConvertFrom-Json
  if (-not (Test-Path $mf.aside)) { Write-Host "The pre-promotion folder $($mf.aside) is gone; nothing to roll back to." -ForegroundColor Red; Done 1 }
  Disable-ScheduledTask -TaskName 'Alpha Self-Heal' -EA SilentlyContinue | Out-Null
  Stop-AlphaTree $LiveRoot
  if (Test-Path $LiveRoot) {
    if (-not (Rename-WithRetry $LiveRoot "$liveLeaf.rolledback-$stamp")) { Write-Host "Could not move the promoted folder aside; nothing changed." -ForegroundColor Red; Done 1 }
    Note "promoted copy kept at $LiveRoot.rolledback-$stamp (anything written since promotion is in there)"
  }
  if (-not (Rename-WithRetry $mf.aside $liveLeaf)) { Write-Host "Could not rename $($mf.aside) back to $LiveRoot. Do it by hand, then Start-ScheduledTask 'Alpha Backend','Alpha'." -ForegroundColor Red; Done 1 }
  Start-ScheduledTask -TaskName 'Alpha Backend' -EA SilentlyContinue
  Start-ScheduledTask -TaskName 'Alpha' -EA SilentlyContinue
  for ($i = 0; $i -lt 40 -and -not ((BackendOK) -and (FrontendOK)); $i++) { Start-Sleep 3 }
  Enable-ScheduledTask -TaskName 'Alpha Self-Heal' -EA SilentlyContinue | Out-Null
  Note ("backend {0}   frontend {1}   public {2}" -f (Code $backendUrl), $(if (FrontendOK) { 'serves Alpha' } else { Code $frontendUrl }), (Code "https://$PublicHost/"))
  Rename-Item $m.FullName "$($m.Name).undone" -EA SilentlyContinue
  Done 0
}

if ($PSScriptRoot.StartsWith("$LiveRoot\", [StringComparison]::OrdinalIgnoreCase)) {
  Write-Host "This script runs from inside $LiveRoot; moving that folder would take the tunnel with it. Run it from the alpha-tunnel checkout outside Alpha." -ForegroundColor Red
  Done 1
}

# ================================================================ 1. recovery done?
Section "1. Is the USB recovery finished?"
$active = @(Get-CimInstance Win32_Process -EA SilentlyContinue | Where-Object {
  $_.ProcessId -ne $PID -and $_.CommandLine -match 'recover-alpha-from-usb\.ps1' -and $_.CommandLine -notmatch '-StopRecovered' })
if ($active) {
  foreach ($a in $active) { Note "running: pid $($a.ProcessId) since $($a.CreationDate)" }
  Write-Host "  The recovery is still running. Nothing was checked or changed; run this again when it prints its VERDICT." -ForegroundColor Yellow
  Done 2
}
if (-not $Recovery) {
  $Recovery = Get-ChildItem $TargetRoot -Directory -EA SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName 'evidence.json') } |
              Sort-Object Name | Select-Object -Last 1 -ExpandProperty FullName
}
if (-not $Recovery -or -not (Test-Path (Join-Path $Recovery 'evidence.json'))) {
  Write-Host "  No finished recovery under $TargetRoot (evidence.json is written only when the run ends). Pass -Recovery <folder>." -ForegroundColor Yellow
  Done 2
}
$checkout = Join-Path $Recovery 'checkout'
$ev = Get-Content (Join-Path $Recovery 'evidence.json') -Raw | ConvertFrom-Json
OK "recovery folder $Recovery, finished $($ev.finishedAt)"
Note "recovered HEAD: $($ev.checkoutHead)"
if (@($ev.problems).Count) { foreach ($p in @($ev.problems)) { Blocker "recovery reported: $p" } }
$vr = $ev.verification
if ($vr) {
  if ("$($vr.recoveredBackendHealth)" -notlike '2*') { Blocker "recovered backend /health was $($vr.recoveredBackendHealth)" }
  if ("$($vr.recoveredFrontendAsPublicHost)" -ne 'served') { Blocker "recovered frontend with Host: $PublicHost was '$($vr.recoveredFrontendAsPublicHost)' - promoted, the public site would fail" }
} else { Blocker "evidence.json has no verification section - the recovery stopped before step 8" }

# ================================================================ 2. layout
Section "2. Does the recovered copy fit what the boot tasks expect?"
$fe = Join-Path $checkout 'frontend'
$checks = [ordered]@{
  'frontend\src\app\shell\AppShell.tsx (start-alpha-at-boot finds Alpha by it)' = (Join-Path $fe 'src\app\shell\AppShell.tsx')
  'frontend\package.json'          = (Join-Path $fe 'package.json')
  'frontend\dist\index.html'       = (Join-Path $fe 'dist\index.html')
  'frontend\node_modules\vite'     = (Join-Path $fe 'node_modules\vite\bin\vite.js')
}
foreach ($k in $checks.Keys) { if (Test-Path $checks[$k]) { OK $k } else { Blocker "missing $k" } }
# The recovered repository can hold the app below its top level (the alpha-full
# import keeps it at BuildArtifacts\installers\Alpha-Full\software). Say where,
# so the blocker above points at the real layout instead of just "missing".
if (-not (Test-Path (Join-Path $fe 'src\app\shell\AppShell.tsx'))) {
  $nested = @(Get-ChildItem $checkout -Recurse -Depth 8 -Filter 'AppShell.tsx' -File -Force -EA SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.Directory.FullName -like '*\frontend\src\app\shell' } |
    ForEach-Object { $_.Directory.FullName.Substring(0, $_.Directory.FullName.Length - '\frontend\src\app\shell'.Length) })
  if ($nested) {
    Warn "Alpha is nested inside the recovered checkout, not at its top. Candidate app roots:"
    $nested | ForEach-Object { Note "    $_" }
    Warn "This script, start-alpha-at-boot.ps1 and repair-alpha-host.ps1 all expect <AlphaRoot>\frontend."
    Warn "Promoting a nested root changes what C:\AlphaData\Alpha contains; that layout decision is not made here."
  }
}
if (Test-Path (Join-Path $checkout 'scripts\alpha_coordination_tunnel.ps1')) { OK 'scripts\alpha_coordination_tunnel.ps1 (repair and self-heal post through it)' }
else { Warn "no scripts\alpha_coordination_tunnel.ps1 - repair and self-heal will run but post nothing" }
try {
  $scripts = (Get-Content (Join-Path $fe 'package.json') -Raw | ConvertFrom-Json).scripts
  $names = @($scripts.PSObject.Properties.Name)
  $serving = @($names | Where-Object { "$($scripts.$_)" -match "\b$FrontendPort\b" -or "$($scripts.$_)" -match 'vite\s+preview' })
  if ($serving.Count -eq 1 -or ($serving.Count -eq 0 -and $names -contains 'preview')) { OK "npm script start-alpha-at-boot will pick: $(if ($serving) { $serving[0] } else { 'preview' })" }
  else { Blocker "start-alpha-at-boot cannot pick one npm script for $FrontendPort (candidates: $($serving -join ', '))" }
} catch { Blocker "frontend\package.json does not parse" }
if (Test-Path (Join-Path $fe 'vite.recovery.config.mjs')) { Note "vite.recovery.config.mjs (proxy -> 8011) will be left out of the promoted copy" }

# The backend, the way recover-alpha-from-usb found it.
$appFile = Get-ChildItem $checkout -Recurse -Depth 5 -Filter *.py -EA SilentlyContinue |
           Where-Object { $_.FullName -notmatch '\\(node_modules|\.git|venv|\.venv|site-packages)\\' } |
           Select-String -Pattern '^\s*app\s*=\s*FastAPI\(' -List -EA SilentlyContinue | Select-Object -First 1
$req = Get-ChildItem $checkout -Recurse -Depth 4 -Filter requirements*.txt -EA SilentlyContinue |
       Where-Object { $_.FullName -notmatch '\\(node_modules|\.git|venv|\.venv)\\' } | Sort-Object { $_.FullName.Length } | Select-Object -First 1
if ($appFile) { OK "backend app: $($appFile.Path.Substring($checkout.Length + 1))" } else { Blocker "no module defining app = FastAPI(...) in the recovered checkout" }
if ($req) { OK "requirements: $($req.FullName.Substring($checkout.Length + 1))" } else { Blocker "no requirements*.txt in the recovered checkout" }

# ================================================================ 3. live backend
Section "3. How the live backend runs today (what the promoted one must match)"
$spec = $null
$l = Get-NetTCPConnection -LocalPort $BackendPort -State Listen -EA SilentlyContinue | Select-Object -First 1
if ($l) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($l.OwningProcess)" -EA SilentlyContinue
  $argLine = if ($p.CommandLine -match '^\s*"[^"]+"\s*(.*)$') { $Matches[1] } elseif ($p.CommandLine -match '^\s*\S+\s*(.*)$') { $Matches[1] } else { '' }
  $exe = $p.ExecutablePath
  if (-not $exe -and $p.CommandLine -match '^\s*"?([^"]+?\.exe)"?\s') { $exe = $Matches[1] }
  $spec = @{ exe = $exe; args = $argLine; source = "pid $($p.ProcessId)" }
} else {
  $w = Join-Path $env:ProgramData 'AlphaBoot\run-alpha-backend.cmd'
  if (Test-Path $w) {
    $t = Get-Content $w -Raw
    if ($t -match '(?m)^"([^"]+)"\s+(.*?)\s+>>') { $spec = @{ exe = $Matches[1]; args = $Matches[2]; source = $w } }
  }
}
$newExe = $null; $venvRel = $null; $modRel = $null
if (-not $spec) { Blocker "cannot tell how the backend is started: nothing on $BackendPort and no run-alpha-backend.cmd. Start the live backend, then re-run." }
else {
  Note "live backend ($($spec.source)): `"$($spec.exe)`" $($spec.args)"
  if ($spec.exe -and $spec.exe.StartsWith("$LiveRoot\", [StringComparison]::OrdinalIgnoreCase)) {
    $rel = $spec.exe.Substring($LiveRoot.Length + 1)
    $cfgFile = Join-Path (Split-Path (Split-Path $spec.exe)) 'pyvenv.cfg'
    if (Test-Path $cfgFile) {
      $venvRel = (Split-Path (Split-Path $rel))
      OK "venv inside the install at $venvRel - it will be recreated there (a venv cannot be moved)"
    } else { Warn "interpreter is inside the install but is not a venv ($rel); it is copied as-is from the recovered checkout" }
    $newExe = Join-Path $LiveRoot $rel
  } else {
    $newExe = $spec.exe
    Note "interpreter is outside the install - kept: $newExe (its packages are whatever it has today)"
  }
  if ($spec.args -match '([\w.]+):\w+') {
    $modFile = ($Matches[1] -replace '\.', '\') + '.py'
    $hit = Get-ChildItem $LiveRoot -Recurse -Depth 5 -Filter (Split-Path $modFile -Leaf) -EA SilentlyContinue |
           Where-Object { $_.FullName -like "*\$modFile" -and $_.FullName -notmatch '\\(node_modules|\.venv|venv|site-packages)\\' } | Select-Object -First 1
    if ($hit) {
      $modRel = $hit.FullName.Substring($LiveRoot.Length + 1, $hit.FullName.Length - $LiveRoot.Length - 1 - $modFile.Length).TrimEnd('\')
      if (Test-Path (Join-Path (Join-Path $checkout $modRel) $modFile)) { OK "module $modFile is at the same place in the recovered copy ($(if ($modRel) { $modRel } else { '.' }))" }
      else { Blocker "the live backend runs $modFile from '$modRel', and the recovered copy has no file there - the layouts differ" }
    } else { Warn "could not find $modFile under $LiveRoot; repair-alpha-host will infer the directory" }
  }
}

# ================================================================ 4. versions
Section "4. Versions"
function Ver($root) {
  $s = Join-Path $root 'frontend\src\app\shell\AppShell.tsx'
  if ((Get-Content $s -Raw -EA SilentlyContinue) -match 'ALPHA_VERSION\s*=\s*["'']([^"'']+)') { $Matches[1] } else { '?' }
}
$liveVer = Ver $LiveRoot; $recVer = Ver $checkout
Note "ALPHA_VERSION  live $liveVer   recovered $recVer"
$recHead = (git -C $checkout rev-parse HEAD 2>$null)
$liveHead = if (Test-Path (Join-Path $LiveRoot '.git')) { (git -C $LiveRoot rev-parse HEAD 2>$null) } else { $null }
$relation = 'unknown (the live install is not a git checkout)'
if ($liveHead) {
  git -C $checkout cat-file -e "$liveHead^{commit}" 2>$null; $known = ($LASTEXITCODE -eq 0)
  git -C $checkout merge-base --is-ancestor $liveHead $recHead 2>$null; $ancestor = ($LASTEXITCODE -eq 0)
  if ($liveHead -eq $recHead) { $relation = 'same commit' }
  elseif (-not $known) { $relation = 'live has commits the backup does not - the recovered code is OLDER or diverged' }
  elseif ($ancestor) { $relation = 'recovered is newer than live' }
  else { $relation = 'recovered is older than live, or diverged' }
  $dirty = @(git -C $LiveRoot status --porcelain 2>$null | Where-Object { $_ -notmatch 'node_modules|dist' })
  if ($dirty.Count) { Warn "the live install has $($dirty.Count) uncommitted change(s) that exist nowhere else - they stay in the renamed folder, but are not promoted:"; $dirty | Select-Object -First 15 | ForEach-Object { Note "    $_" } }
}
Note "git: live $liveHead   recovered $recHead   -> $relation"
if ($relation -match 'OLDER') { Warn "Promoting would move the code BACK. Only do it if the live code is the broken part." }

# Schema: migration files present on one side only.
foreach ($mdir in @('alembic\versions', 'migrations\versions', 'migrations')) {
  $a = @(Get-ChildItem (Join-Path $LiveRoot "*\$mdir"), (Join-Path $LiveRoot $mdir) -File -Recurse -Depth 1 -EA SilentlyContinue | ForEach-Object Name)
  $b = @(Get-ChildItem (Join-Path $checkout "*\$mdir"), (Join-Path $checkout $mdir) -File -Recurse -Depth 1 -EA SilentlyContinue | ForEach-Object Name)
  if ($a.Count -or $b.Count) {
    $onlyLive = @($a | Where-Object { $b -notcontains $_ })
    if ($onlyLive.Count) { Warn "migrations only in LIVE ($mdir): $($onlyLive -join ', ') - live data may use a schema the recovered code does not know" }
    else { OK "no live-only migrations in $mdir" }
  }
}

# ================================================================ 5. data
Section "5. Data written since the backup"
# The backup's data is exactly what alpha-data.tar held; compare those paths.
$tarFile = Join-Path $Recovery 'source\alpha-data.tar'
$entries = @(tar.exe -tf $tarFile 2>$null | Where-Object { $_ -and $_ -notmatch '/$' } | ForEach-Object { ($_ -replace '/', '\') -replace '^(\.\\)+', '' } |
             Where-Object { $_ -notmatch '\\node_modules\\' })
$tops = @($entries | ForEach-Object { ($_ -split '\\')[0] } | Select-Object -Unique)
Note "backup data: $($entries.Count) files under $($tops -join ', ')"
$set = @{}; foreach ($e in $entries) { $set[$e.ToLowerInvariant()] = $true }
function Get-Divergent($liveDir) {
$liveNewer = @(); $liveOnly = @()
foreach ($e in $entries) {
  $lf = Join-Path $liveDir $e; $rf = Join-Path $checkout $e
  if (-not (Test-Path $lf -PathType Leaf)) { continue }
  if (-not (Test-Path $rf -PathType Leaf)) { $liveNewer += $e; continue }
  $li = Get-Item $lf -Force; $ri = Get-Item $rf -Force
  $same = ($li.Length -eq $ri.Length) -and ((Get-FileHash $lf).Hash -eq (Get-FileHash $rf).Hash)
  if (-not $same -and $li.LastWriteTimeUtc -gt $ri.LastWriteTimeUtc) { $liveNewer += $e }
}
foreach ($t in $tops) {
  $d = Join-Path $liveDir $t
  if (Test-Path $d -PathType Container) {
    foreach ($f in Get-ChildItem $d -Recurse -File -Force -EA SilentlyContinue | Where-Object { $_.FullName -notmatch '\\(node_modules|__pycache__|logs)\\' }) {
      $rel = $f.FullName.Substring($liveDir.Length + 1)
      if (-not $set.ContainsKey($rel.ToLowerInvariant())) { $liveOnly += $rel }
    }
  }
}
return [pscustomobject]@{ Newer = $liveNewer; Only = $liveOnly; All = @($liveNewer + $liveOnly) }
}
$dv = Get-Divergent $LiveRoot
$liveNewer = $dv.Newer; $liveOnly = $dv.Only; $divergent = @($dv.All)
if (-not $divergent.Count) { OK "the live install holds no data newer than the backup" }
else {
  Warn "$($liveNewer.Count) data file(s) changed in LIVE since the backup, $($liveOnly.Count) exist only in live:"
  $divergent | Select-Object -First 25 | ForEach-Object { Note "    $_" }
  if ($divergent.Count -gt 25) { Note "    ... and $($divergent.Count - 25) more (full list in the log's promotion manifest)" }
  if (-not $CarryLiveData -and -not $AcceptDataRollback) {
    Blocker "promotion would serve the backup's older data. Choose: -CarryLiveData (copy these live files into the promoted copy; live wins) or -AcceptDataRollback (serve the backup's data; the live files stay in the renamed folder)."
  }
}

# ================================================================ 6. config, space, tasks
Section "6. Configuration, space, tasks"
$cfgFiles = @(Get-ChildItem $checkout -Recurse -File -Force -Include '.env*', '*.json', '*.yaml', '*.yml', '*.toml', '*.ini' -EA SilentlyContinue |
  Where-Object { $_.FullName -notmatch '\\(node_modules|\.git|dist)\\' -and $_.Length -lt 2MB })
$toE = @($cfgFiles | Select-String -SimpleMatch $TargetRoot -List -EA SilentlyContinue)
if ($toE.Count) { Blocker "recovered configuration names the recovery folder (would point back at E: after promotion): $(@($toE | ForEach-Object { "$($_.Path):$($_.LineNumber)" }) -join ', ')" }
$toLive = @($cfgFiles | Select-String -SimpleMatch $LiveRoot -List -EA SilentlyContinue)
if ($toLive.Count) { OK "$($toLive.Count) config file(s) name $LiveRoot - correct once promoted to that same path" }
$need = (Get-ChildItem $checkout -Recurse -File -Force -EA SilentlyContinue | Measure-Object Length -Sum).Sum
$free = (Get-PSDrive ($LiveRoot.Substring(0, 1))).Free
Note ("copy needs {0:N1} GB, {1}: has {2:N1} GB free" -f ($need / 1GB), $LiveRoot.Substring(0, 1), ($free / 1GB))
if ($free -lt ($need * 1.3 + 3GB)) { Blocker "not enough free space for the copy plus a fresh venv" }
if (Test-Path "$LiveRoot.pre-promote-*") { Warn "an earlier $liveLeaf.pre-promote-* folder exists; it is kept" }
foreach ($t in 'Alpha', 'Alpha Backend', 'Alpha Self-Heal') {
  $x = Get-ScheduledTask -TaskName $t -EA SilentlyContinue
  Note ("task {0,-16} {1}" -f $t, $(if ($x) { "$($x.State)" } else { 'absent - repair-alpha-host will create it' }))
}
if (Test-Path (Join-Path $TargetRoot 'recovered-pids.json')) { Note "the recovered copy is still running on 8011/4183; -Promote stops it first" }
if (-not (BackendOK)) { Warn "the live backend is not answering right now ($backendUrl)" }
if (-not (FrontendOK)) { Warn "the live frontend is not serving right now ($frontendUrl)" }

# ================================================================ verdict / plan
Section "VERDICT"
if ($blockers.Count) {
  Write-Host "NOT READY: $($blockers.Count) blocker(s)." -ForegroundColor Yellow
  $i = 1; foreach ($b in $blockers) { Write-Host "  $i. $b"; $i++ }
  if ($Promote) { Write-Host "`n-Promote refused. Nothing was changed." -ForegroundColor Red }
  Done 1
}
$choice = if ($divergent.Count) { if ($CarryLiveData) { ' -CarryLiveData' } else { ' -AcceptDataRollback' } } else { '' }
Write-Host "READY to promote $checkout -> $LiveRoot" -ForegroundColor Green
if (-not $Promote) {
  Write-Host "`nNext, after signing in at http://127.0.0.1:4183, sending one Chat message and opening Decks, Brain, Agents:"
  Write-Host "  powershell -ExecutionPolicy Bypass -File .\scripts\promote-recovered-alpha.ps1 -Promote -HumanChecked$choice" -ForegroundColor Cyan
  Done 0
}
if (-not $HumanChecked) { Write-Host "-Promote needs -HumanChecked: sign in and send a Chat message on http://127.0.0.1:4183 first. Nothing changed." -ForegroundColor Red; Done 1 }
if (-not $admin) { Write-Host "-Promote must run elevated. Nothing changed." -ForegroundColor Red; Done 1 }

# ================================================================ PROMOTE
$aside = "$LiveRoot.pre-promote-$stamp"
$manifest = [ordered]@{ stamp = $stamp; recovery = $Recovery; aside = $aside; live = $LiveRoot; carried = @(); dataChoice = $choice.Trim(); backend = $spec }
$manifestFile = Join-Path $logDir "promotion-$stamp.json"
function Save { $manifest | ConvertTo-Json -Depth 5 | Set-Content $manifestFile -Encoding utf8 }

function Undo($why) {
  Write-Host "`n  ROLLING BACK: $why" -ForegroundColor Red
  Stop-AlphaTree $LiveRoot
  if (Test-Path $LiveRoot) { [void](Rename-WithRetry $LiveRoot "$liveLeaf.failed-$stamp") }
  if (Rename-WithRetry $aside $liveLeaf) {
    Start-ScheduledTask -TaskName 'Alpha Backend' -EA SilentlyContinue
    Start-ScheduledTask -TaskName 'Alpha' -EA SilentlyContinue
    for ($i = 0; $i -lt 40 -and -not ((BackendOK) -and (FrontendOK)); $i++) { Start-Sleep 3 }
  } else { Write-Host "  Could not rename $aside back. Do it by hand: Rename-Item '$aside' '$liveLeaf'" -ForegroundColor Red }
  Enable-ScheduledTask -TaskName 'Alpha Self-Heal' -EA SilentlyContinue | Out-Null
  Note ("after rollback: backend {0}, frontend {1}" -f (Code $backendUrl), $(if (FrontendOK) { 'serves Alpha' } else { Code $frontendUrl }))
  Note "the failed promotion is kept at $LiveRoot.failed-$stamp"
  Done 1
}

Section "P1. Quiesce (downtime starts)"
Disable-ScheduledTask -TaskName 'Alpha Self-Heal' -EA SilentlyContinue | Out-Null
Note "'Alpha Self-Heal' disabled for the swap"
$rec = Join-Path $PSScriptRoot 'recover-alpha-from-usb.ps1'
if (Test-Path (Join-Path $TargetRoot 'recovered-pids.json')) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $rec -TargetRoot $TargetRoot -StopRecovered | ForEach-Object { Note "$_" }
}
Stop-AlphaTree $LiveRoot
# The backend was writing until a moment ago: compare again now it has stopped.
$divergent = @((Get-Divergent $LiveRoot).All)
Note "data newer in live, re-checked after stopping: $($divergent.Count) file(s)"
if ($divergent.Count -and -not $CarryLiveData -and -not $AcceptDataRollback) {
  Write-Host "  The live install wrote new data while this ran. Restarting it; nothing was changed. Re-run with -CarryLiveData or -AcceptDataRollback." -ForegroundColor Red
  Start-ScheduledTask -TaskName 'Alpha Backend' -EA SilentlyContinue; Start-ScheduledTask -TaskName 'Alpha' -EA SilentlyContinue
  Enable-ScheduledTask -TaskName 'Alpha Self-Heal' -EA SilentlyContinue | Out-Null
  Done 1
}
$manifest.dataFiles = $divergent

Section "P2. Move the live install aside (not deleted)"
if (-not (Rename-WithRetry $LiveRoot (Split-Path $aside -Leaf))) {
  Write-Host "  A process still holds files in $LiveRoot. Restarting the live install; nothing was changed." -ForegroundColor Red
  Start-ScheduledTask -TaskName 'Alpha Backend' -EA SilentlyContinue; Start-ScheduledTask -TaskName 'Alpha' -EA SilentlyContinue
  Enable-ScheduledTask -TaskName 'Alpha Self-Heal' -EA SilentlyContinue | Out-Null
  Done 1
}
Save
OK "live install is now $aside"

Section "P3. Copy the recovered checkout in"
robocopy $checkout $LiveRoot /E /COPY:DAT /R:1 /W:1 /XF vite.recovery.config.mjs /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { Undo "robocopy failed (exit $LASTEXITCODE)" }
OK "copied"

if ($divergent.Count -and $CarryLiveData) {
  Section "P4. Carry live data forward (live wins)"
  foreach ($r in $divergent) {
    $dst = Join-Path $LiveRoot $r
    New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
    Copy-Item -LiteralPath (Join-Path $aside $r) -Destination $dst -Force
    $manifest.carried += $r
  }
  Save
  OK "$($divergent.Count) file(s) carried from the live install"
}

if ($venvRel) {
  Section "P5. Recreate the backend venv at $venvRel"
  $venv = Join-Path $LiveRoot $venvRel
  if (Test-Path $venv) { [void](Rename-WithRetry $venv ((Split-Path $venv -Leaf) + ".from-backup")); Note "the venv that came with the backup is kept as *.from-backup" }
  $pyHome = $null
  $cfg = Join-Path (Join-Path $aside $venvRel) 'pyvenv.cfg'
  if ((Get-Content $cfg -Raw -EA SilentlyContinue) -match '(?m)^home\s*=\s*(.+)$') { $pyHome = $Matches[1].Trim() }
  $basePy = if ($pyHome -and (Test-Path (Join-Path $pyHome 'python.exe'))) { Join-Path $pyHome 'python.exe' } else { (Get-Command py.exe -EA SilentlyContinue).Source }
  Note "base interpreter: $basePy (the one the live venv was made from)"
  & $basePy -m venv $venv
  $venvPy = Join-Path $venv 'Scripts\python.exe'
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $venvPy)) { Undo "could not create the venv with $basePy" }
  & $venvPy -m pip install --disable-pip-version-check -q -r (Join-Path $LiveRoot $req.FullName.Substring($checkout.Length + 1)) 2>&1 | Select-Object -Last 8 | ForEach-Object { Note "$_" }
  if ($LASTEXITCODE -ne 0) { Undo "pip install of the recovered requirements failed" }
  # The live backend may be launched as python -m uvicorn or as uvicorn.exe.
  if ("$($spec.exe) $($spec.args)" -match 'uvicorn') { & $venvPy -m pip show uvicorn *> $null; if ($LASTEXITCODE -ne 0) { & $venvPy -m pip install -q uvicorn | Out-Null } }
  if (-not (Test-Path $newExe)) { Undo "the venv has no $newExe after installing requirements" }
  OK "venv ready"
}

Section "P6. Start the backend from the promoted copy"
$modDir = if ($null -ne $modRel) { Join-Path $LiveRoot $modRel } else { $LiveRoot }
$beLog = Join-Path $logDir "promote-backend-$stamp.log"
$be = Start-Process -FilePath $newExe -ArgumentList $spec.args -WorkingDirectory $modDir -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $beLog -RedirectStandardError "$beLog.err"
for ($i = 0; $i -lt 40 -and -not (BackendOK); $i++) { Start-Sleep 3 }
if (-not (BackendOK)) { Get-Content "$beLog.err" -Tail 20 -EA SilentlyContinue | ForEach-Object { Note "    $_" }; Undo "the promoted backend did not answer $backendUrl within 120s" }
OK "backend answers from $modDir (pid $($be.Id))"

Section "P7. Boot tasks, dist snapshot and self-heal (repair-alpha-host.ps1)"
# It adopts the backend just started (and proves the handover), registers
# 'Alpha' through start-alpha-at-boot.ps1, snapshots dist.last-good and
# re-registers 'Alpha Self-Heal' enabled. Its exit code also counts things this
# promotion does not own (Jack's laptop attached, lid action), so the checks
# below decide, not the exit code.
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'repair-alpha-host.ps1') -AlphaRoot $LiveRoot -BackendDir $modDir -BackendPort $BackendPort -FrontendPort $FrontendPort -PublicHost $PublicHost |
  ForEach-Object { Note "  | $_" }

Section "P8. Verify"
for ($i = 0; $i -lt 30 -and -not ((BackendOK) -and (FrontendOK)); $i++) { Start-Sleep 3 }
$v = [ordered]@{}
$v.backend = Code $backendUrl
$v.frontend = if (FrontendOK) { 'serves Alpha' } else { Code $frontendUrl }
$pb = Body $frontendUrl $PublicHost
$v.frontendAsPublicHost = if ($pb -match 'id="root"') { 'served' } elseif ($pb -match 'Blocked request') { 'BLOCKED' } else { Code $frontendUrl $PublicHost }
foreach ($r in 'login', 'chat', 'decks', 'brain', 'agents', 'network', 'crown') { $v["/$r"] = if ((Body "$frontendUrl$r") -match 'id="root"') { 'served' } else { Code "$frontendUrl$r" } }
$v.public = Code "https://$PublicHost/"
$v.version = Ver $LiveRoot
$sh = Get-ScheduledTask -TaskName 'Alpha Self-Heal' -EA SilentlyContinue
$v.selfHeal = if ($sh) { "$($sh.State)" } else { 'absent' }
$v.GetEnumerator() | ForEach-Object { Note ("{0,-22} {1}" -f $_.Key, $_.Value) }
$manifest.verification = $v; Save
if ($v.backend -notlike '2*' -or $v.frontend -ne 'serves Alpha' -or $v.frontendAsPublicHost -ne 'served') {
  Undo "promoted copy is not serving (backend $($v.backend), frontend $($v.frontend), Host header $($v.frontendAsPublicHost))"
}
if ($sh -and $sh.State -eq 'Disabled') { Enable-ScheduledTask -TaskName 'Alpha Self-Heal' | Out-Null; Note "'Alpha Self-Heal' re-enabled" }
Write-Host "`nPROMOTED. The previous install is at $aside - keep it until the checks below pass." -ForegroundColor Green
Write-Host "By hand: https://$PublicHost -> Access -> Alpha login; Chat answers; Decks, Brain, Agents, Network Hub, Crown open."
Write-Host "Then reboot without logging in; the site must load from a phone within 3 minutes."
Write-Host "Undo: powershell -ExecutionPolicy Bypass -File .\scripts\promote-recovered-alpha.ps1 -Rollback"
Done 0

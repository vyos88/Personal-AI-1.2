<#
  recover-alpha-from-usb.ps1 - restore Alpha from the recovery drive into an
  isolated folder, run it beside the live install, and prove it works -
  without touching the live install or the drive it came from.

  Run as Administrator, on Laptop41:
      powershell -ExecutionPolicy Bypass -File .\recover-alpha-from-usb.ps1
  Stop the recovered copy afterwards:
      powershell -ExecutionPolicy Bypass -File .\recover-alpha-from-usb.ps1 -StopRecovered

  Order, each step logged, posted to the coordination tunnel, and written to
  evidence.json in the recovery folder:
    1. preflight   F:\AlphaBackup has alpha-all-refs.bundle, alpha-data.tar
                   and RESTORE.md (printed, never executed); E: has room.
                   The live install gets a fingerprint to compare at the end.
    2. stale       stops Alpha launch attempts that never bound a port and
                   are older than 5 minutes. Protected, whatever they look
                   like: whatever listens on 8001/4173/8787, its parents and
                   its children.
    3. copy        F: -> E:\AlphaRecovery\<time>\source, read-only on F:,
                   then SHA-256 of every file on both sides.
    4. clone       git bundle verify, then clone into ...\checkout.
    5. data        alpha-data.tar listed first; an absolute path or '..'
                   entry refuses the extraction. Then extracted into checkout.
    6. deps        npm ci (or install) + build for the frontend; a venv of
                   its own for the backend. Nothing global.
    7. run         the recovered copy on 8011 (backend) and 4183 (frontend),
                   so the live 8001/4173 keep serving. The frontend's API
                   proxy is pointed at 8011 by a recovery-only Vite config,
                   so a check of the recovered UI never lands on the live
                   backend. The backend is NOT started if the recovered
                   configuration names the live install's paths - it would
                   write into it.
    8. verify      recovered /health, recovered frontend (plain and with the
                   public Host), /chat /decks /brain /agents served, live
                   8001 /health, public alpha-ai.uk, and the live install's
                   fingerprint unchanged.

  It never overwrites the live install. Promotion is a separate, later step,
  and this prints what has to be true before it.
#>

param(
  [string]$Source = 'F:\AlphaBackup',
  [string]$TargetRoot = 'E:\AlphaRecovery',
  [string]$LiveRoot = 'C:\AlphaData\Alpha',
  [int]$RecoveredBackendPort = 8011,
  [int]$RecoveredFrontendPort = 4183,
  [int]$LiveBackendPort = 8001,
  [int]$LiveFrontendPort = 4173,
  [string]$PublicHost = 'alpha-ai.uk',
  [string]$HealthPath = '/health',
  # Where Alpha sits inside the restored checkout (the folder holding frontend
  # and backend). The alpha-full repository keeps it here; '' means the top.
  [string]$AppSubdir = 'BuildArtifacts\installers\Alpha-Full\software',
  [switch]$NoStopStale,
  [switch]$StopRecovered
)

$ErrorActionPreference = 'Continue'
$problems = New-Object System.Collections.ArrayList
$evidence = [ordered]@{ startedAt = (Get-Date).ToString('o'); host = $env:COMPUTERNAME }
function Problem($t) { [void]$problems.Add($t); Write-Host "  PROBLEM: $t" -ForegroundColor Red }
function OK($t)      { Write-Host "  ok: $t" -ForegroundColor Green }
function Note($t)    { Write-Host "  $t" }
$coordScript = Join-Path $LiveRoot 'scripts\alpha_coordination_tunnel.ps1'
function Post($m) {
  if (-not (Test-Path $coordScript)) { return }
  $m = "[$env:COMPUTERNAME] $m"; if ($m.Length -gt 3900) { $m = $m.Substring(0, 3900) }
  try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $coordScript -Action Post -Actor 'laptop41-recovery' -Message $m 2>&1 | Out-Null } catch {}
}
function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan; Post "recovery: $t" }
function Code($url, [string]$HostHeader = '') {
  $a = @('-s', '-k', '-o', 'NUL', '-w', '%{http_code}', '--max-time', '8')
  if ($HostHeader) { $a += @('-H', "Host: $HostHeader") }
  $c = & curl.exe @a $url 2>$null; if (-not $c) { '000' } else { "$c" }
}
function Body($url, [string]$HostHeader = '') {
  $a = @('-s', '-k', '--max-time', '8'); if ($HostHeader) { $a += @('-H', "Host: $HostHeader") }
  (& curl.exe @a $url 2>$null | Out-String)
}

$pidFile = Join-Path $TargetRoot 'recovered-pids.json'
if ($StopRecovered) {
  if (Test-Path $pidFile) {
    foreach ($p in @((Get-Content $pidFile -Raw | ConvertFrom-Json).pids)) { taskkill.exe /T /F /PID $p 2>&1 | Out-Null; Note "stopped $p" }
    Remove-Item $pidFile
  } else { Note "no recovered copy recorded as running" }
  exit 0
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$work = Join-Path $TargetRoot $stamp
$copy = Join-Path $work 'source'
$checkout = Join-Path $work 'checkout'
$AppSubdir = $AppSubdir.Trim('\')
# Build, run and verify the same folder promote-recovered-alpha.ps1 promotes.
$app = if ($AppSubdir) { Join-Path $checkout $AppSubdir } else { $checkout }
New-Item -ItemType Directory -Force -Path $work | Out-Null
$log = Join-Path $work 'recovery.log'
Start-Transcript -Path $log -Force | Out-Null

function Finish($code) {
  $evidence.finishedAt = (Get-Date).ToString('o'); $evidence.problems = @($problems)
  $evidence | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $work 'evidence.json') -Encoding utf8
  Write-Host "`n=== VERDICT ===" -ForegroundColor Cyan
  if ($problems.Count -eq 0) {
    Write-Host "Recovered copy passed every automated check. The live install was not touched." -ForegroundColor Green
    Write-Host "Before promoting it: open http://127.0.0.1:$RecoveredFrontendPort, sign in, send one Chat message, open Decks, Brain, Agents."
  } else { Write-Host "$($problems.Count) blocker(s):" -ForegroundColor Yellow; $i = 1; foreach ($p in $problems) { Write-Host "  $i. $p"; $i++ } }
  Write-Host "`nRecovery folder: $work`nLog: $log`nEvidence: $(Join-Path $work 'evidence.json')"
  Post ("recovery finished: {0} blocker(s). {1}" -f $problems.Count, (@($problems) -join ' | '))
  Stop-Transcript | Out-Null; exit $code
}

# Fingerprint of the live install: file count, bytes, newest write. Cheap, and
# enough to show at the end that nothing here wrote into it.
function LiveFingerprint {
  $f = Get-ChildItem $LiveRoot -Recurse -File -Force -EA SilentlyContinue | Where-Object { $_.FullName -notmatch '\\(node_modules|logs|__pycache__)\\' }
  $m = $f | Measure-Object Length -Sum
  $newest = ($f | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1)
  "$($m.Count) files, $($m.Sum) bytes, newest $($newest.LastWriteTimeUtc.ToString('o')) $($newest.Name)"
}

# ================================================================ 1. preflight
Section "1. Preflight"
$need = 'alpha-all-refs.bundle', 'alpha-data.tar', 'RESTORE.md'
foreach ($n in $need) { if (-not (Test-Path (Join-Path $Source $n))) { Problem "$Source\$n is missing." } }
if ($problems.Count) { Finish 1 }
$srcBytes = (Get-ChildItem $Source -Recurse -File | Measure-Object Length -Sum).Sum
$drive = Get-PSDrive ($TargetRoot.Substring(0, 1))
Note ("source {0:N1} GB   {1}: free {2:N1} GB" -f ($srcBytes / 1GB), $drive.Name, ($drive.Free / 1GB))
if ($drive.Free -lt 4 * $srcBytes + 10GB) { Problem "Not enough room on $($drive.Name): (copy + checkout + data + dependencies needs about 4x the backup plus 10 GB)."; Finish 1 }
Note "--- RESTORE.md (read, not executed) ---"
Get-Content (Join-Path $Source 'RESTORE.md') | ForEach-Object { Note "  | $_" }
$liveBefore = if (Test-Path $LiveRoot) { LiveFingerprint } else { 'absent' }
Note "live install: $liveBefore"
$evidence.liveBefore = $liveBefore

# ================================================================ 2. stale launches
Section "2. Stale Alpha launch attempts"
$procs = @(Get-CimInstance Win32_Process -EA SilentlyContinue)
$byPid = @{}; foreach ($p in $procs) { $byPid[[int]$p.ProcessId] = $p }
$listening = @(Get-NetTCPConnection -State Listen -EA SilentlyContinue | ForEach-Object { [int]$_.OwningProcess } | Select-Object -Unique)
$protected = @{}
foreach ($port in @($LiveBackendPort, $LiveFrontendPort, 8787)) {
  foreach ($c in @(Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue)) {
    $x = [int]$c.OwningProcess
    while ($x -and $byPid.ContainsKey($x) -and -not $protected.ContainsKey($x)) { $protected[$x] = $true; $x = [int]$byPid[$x].ParentProcessId }
  }
}
# children of protected processes are protected too
do { $grew = $false; foreach ($p in $procs) { if ($protected.ContainsKey([int]$p.ParentProcessId) -and -not $protected.ContainsKey([int]$p.ProcessId)) { $protected[[int]$p.ProcessId] = $true; $grew = $true } } } while ($grew)
$cutoff = (Get-Date).AddMinutes(-5)
$stale = @($procs | Where-Object {
  $_.Name -match '^(node|python|pythonw|cmd|npm)\.exe$' -and
  $_.CommandLine -and $_.CommandLine -match '(?i)alpha|vite|uvicorn' -and
  $_.CommandLine -notmatch '(?i)alpha-tunnel|alpha-selfheal|recover-alpha|repair-alpha|cloudflared' -and
  -not $protected.ContainsKey([int]$_.ProcessId) -and
  $listening -notcontains [int]$_.ProcessId -and
  $_.CreationDate -lt $cutoff
})
$evidence.stale = @($stale | ForEach-Object { "$($_.ProcessId) $($_.Name) $($_.CommandLine)" })
if (-not $stale.Count) { OK "none found" }
foreach ($s in $stale) {
  Note "stale: pid $($s.ProcessId) $($s.Name) since $($s.CreationDate): $($s.CommandLine)"
  if (-not $NoStopStale) { Stop-Process -Id $s.ProcessId -Force -EA SilentlyContinue; Note "  stopped" }
}
Note "protected (serving live ports, or their parents/children): $(@($protected.Keys) -join ', ')"

# ================================================================ 3. copy + verify
Section "3. Copy and verify"
robocopy $Source $copy /E /COPY:DAT /R:2 /W:5 /NFL /NDL /NJH /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Problem "robocopy failed (exit $LASTEXITCODE)."; Finish 1 }
$hashes = @()
foreach ($f in Get-ChildItem $Source -Recurse -File) {
  $rel = $f.FullName.Substring($Source.TrimEnd('\').Length).TrimStart('\')
  $a = (Get-FileHash $f.FullName -Algorithm SHA256).Hash
  $b = (Get-FileHash (Join-Path $copy $rel) -Algorithm SHA256 -EA SilentlyContinue).Hash
  $hashes += [pscustomobject]@{ file = $rel; sha256 = $a; match = ($a -eq $b) }
  if ($a -ne $b) { Problem "copy of $rel does not match the drive." }
}
$hashes | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
$hashes | ConvertTo-Json | Set-Content (Join-Path $work 'sha256.json') -Encoding utf8
$evidence.sha256 = $hashes
if ($problems.Count) { Finish 1 }
OK "$($hashes.Count) file(s) copied, every SHA-256 matches"

# ================================================================ 4. clone
Section "4. Clone the bundle"
$bundle = Join-Path $copy 'alpha-all-refs.bundle'
$verify = git bundle verify $bundle 2>&1 | Out-String
Note $verify.Trim()
if ($LASTEXITCODE -ne 0) { Problem "git bundle verify failed."; Finish 1 }
$heads = git bundle list-heads $bundle 2>&1 | Out-String
$evidence.bundleHeads = $heads.Trim()
git clone $bundle $checkout 2>&1 | ForEach-Object { Note "$_" }
if (-not (Test-Path (Join-Path $checkout '.git'))) { Problem "clone failed."; Finish 1 }
Push-Location $checkout
if (-not (git rev-parse --verify HEAD 2>$null)) {
  $br = @('main', 'master') | Where-Object { git rev-parse --verify "origin/$_" 2>$null } | Select-Object -First 1
  if ($br) { git checkout -q -b $br "origin/$br" }
}
$evidence.checkoutHead = (git log -1 --format='%H %ci %s' 2>$null)
$evidence.branches = @(git branch -a 2>$null)
Pop-Location
OK "checkout at $($evidence.checkoutHead)"

# ================================================================ 5. data
Section "5. Extract alpha-data.tar"
$tarFile = Join-Path $copy 'alpha-data.tar'
$entries = @(tar.exe -tf $tarFile 2>$null)
$bad = @($entries | Where-Object { $_ -match '^(/|\\|[A-Za-z]:)' -or ($_ -replace '\\', '/').Split('/') -contains '..' })
Note "$($entries.Count) entries; top level: $(@($entries | ForEach-Object { ($_ -split '[\\/]')[0] } | Select-Object -Unique -First 12) -join ', ')"
if ($bad.Count) { Problem "alpha-data.tar has entries that would land outside the checkout: $($bad | Select-Object -First 5)"; Finish 1 }
tar.exe -xf $tarFile -C $checkout
if ($LASTEXITCODE -ne 0) { Problem "tar extraction failed (exit $LASTEXITCODE)."; Finish 1 }
OK "extracted into $checkout"

# The recovered copy must not write into the live one.
$liveRefs = @(Get-ChildItem $checkout -Recurse -File -Force -Include '.env*', '*.json', '*.yaml', '*.yml', '*.toml', '*.ini' -EA SilentlyContinue |
  Where-Object { $_.FullName -notmatch '\\(node_modules|\.git)\\' -and $_.Length -lt 2MB } |
  Select-String -SimpleMatch $LiveRoot -List -EA SilentlyContinue)
$evidence.liveRefs = @($liveRefs | ForEach-Object { "$($_.Path):$($_.LineNumber)" })

# ================================================================ 6. deps
Section "6. Dependencies"
$fe = @("$app\frontend", $app) | Where-Object { Test-Path "$_\package.json" } | Select-Object -First 1
$npm = (Get-Command npm.cmd -EA SilentlyContinue).Source
if (-not (Test-Path $app -PathType Container)) { Problem "the restored checkout has no $AppSubdir - re-run with -AppSubdir <the folder holding frontend>, or -AppSubdir '' for the top." }
elseif (-not $fe) { Problem "no package.json in $app or its frontend folder." }
else {
  Push-Location $fe
  if (Test-Path 'package-lock.json') { & $npm ci 2>&1 | Select-Object -Last 5 | ForEach-Object { Note "$_" } }
  else { & $npm install 2>&1 | Select-Object -Last 5 | ForEach-Object { Note "$_" } }
  if ($LASTEXITCODE -ne 0) { Problem "npm install failed in $fe." }
  & $npm run build 2>&1 | Select-Object -Last 8 | ForEach-Object { Note "$_" }
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path 'dist\index.html')) { Problem "frontend build failed." } else { OK "frontend built" }
  Pop-Location
}
$req = Get-ChildItem $app -Recurse -Depth 4 -Filter requirements*.txt -EA SilentlyContinue |
       Where-Object { $_.FullName -notmatch '\\(node_modules|\.git|venv|\.venv)\\' } | Sort-Object { $_.FullName.Length } | Select-Object -First 1
$appFile = Get-ChildItem $app -Recurse -Depth 5 -Filter *.py -EA SilentlyContinue |
           Where-Object { $_.FullName -notmatch '\\(node_modules|\.git|venv|\.venv|site-packages)\\' } |
           Select-String -Pattern '^\s*app\s*=\s*FastAPI\(' -List -EA SilentlyContinue | Select-Object -First 1
$venvPy = $null
if ($req -and $appFile) {
  $py = (Get-Command py.exe -EA SilentlyContinue).Source; if (-not $py) { $py = (Get-Command python.exe -EA SilentlyContinue).Source }
  $venv = Join-Path $work 'venv'
  & $py -m venv $venv; $venvPy = Join-Path $venv 'Scripts\python.exe'
  & $venvPy -m pip install --disable-pip-version-check -q -r $req.FullName 2>&1 | Select-Object -Last 5 | ForEach-Object { Note "$_" }
  if ($LASTEXITCODE -ne 0) { Problem "pip install -r $($req.FullName) failed." } else { OK "backend dependencies in $venv" }
  & $venvPy -m pip show uvicorn *> $null; if ($LASTEXITCODE -ne 0) { & $venvPy -m pip install -q uvicorn | Out-Null }
} else { Problem "could not find the backend (requirements*.txt and a module defining app = FastAPI(...))." }

# ================================================================ 7. run
Section "7. Run the recovered copy on $RecoveredBackendPort / $RecoveredFrontendPort"
$pids = @()
foreach ($port in @($RecoveredBackendPort, $RecoveredFrontendPort)) {
  if (Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue) { Problem "port $port is already in use - pick others with -RecoveredBackendPort/-RecoveredFrontendPort." }
}
if ($liveRefs.Count) {
  Problem "the recovered configuration names the live install ($LiveRoot) in: $($evidence.liveRefs -join ', '). Backend NOT started - it would write into the live copy. Point those at $checkout, then re-run."
} elseif ($venvPy -and $appFile -and -not $problems.Count) {
  $modDir = Split-Path $appFile.Path
  $mod = [IO.Path]::GetFileNameWithoutExtension($appFile.Path)
  $be = Start-Process -FilePath $venvPy -ArgumentList '-m', 'uvicorn', "${mod}:app", '--host', '127.0.0.1', '--port', "$RecoveredBackendPort" `
         -WorkingDirectory $modDir -RedirectStandardOutput (Join-Path $work 'backend.out.log') -RedirectStandardError (Join-Path $work 'backend.err.log') -PassThru -WindowStyle Hidden
  $pids += $be.Id; Note "backend pid $($be.Id): uvicorn ${mod}:app in $modDir"
}
if ($fe -and (Test-Path "$fe\dist\index.html") -and (Test-Path "$fe\node_modules\vite\bin\vite.js")) {
  $base = Get-ChildItem $fe -Filter 'vite.config.*' | Select-Object -First 1
  $rc = Join-Path $fe 'vite.recovery.config.mjs'
  $imp = if ($base) { "import base from './$($base.Name)';" } else { 'const base = {};' }
  @"
// Written by recover-alpha-from-usb.ps1: the recovered frontend must call the
// recovered backend, never the live one on $LiveBackendPort.
$imp
const cfg = typeof base === 'function' ? await base({ command: 'serve', mode: 'production' }) : base;
const retarget = (proxy) => JSON.parse(JSON.stringify(proxy ?? {}).replaceAll(':$LiveBackendPort', ':$RecoveredBackendPort'));
export default { ...cfg,
  server: { ...cfg.server, proxy: retarget(cfg.server?.proxy) },
  preview: { ...cfg.preview, proxy: retarget(cfg.preview?.proxy ?? cfg.server?.proxy),
             host: '127.0.0.1', port: $RecoveredFrontendPort, strictPort: true } };
"@ | Set-Content $rc -Encoding utf8
  $node = (Get-Command node.exe).Source
  $fp = Start-Process -FilePath $node -ArgumentList "`"$fe\node_modules\vite\bin\vite.js`"", 'preview', '--config', "`"$rc`"" `
         -WorkingDirectory $fe -RedirectStandardOutput (Join-Path $work 'frontend.out.log') -RedirectStandardError (Join-Path $work 'frontend.err.log') -PassThru -WindowStyle Hidden
  $pids += $fp.Id; Note "frontend pid $($fp.Id): vite preview on $RecoveredFrontendPort (proxy -> $RecoveredBackendPort)"
}
@{ pids = $pids } | ConvertTo-Json | Set-Content $pidFile -Encoding utf8
$rb = "http://127.0.0.1:$RecoveredBackendPort$HealthPath"; $rf = "http://127.0.0.1:$RecoveredFrontendPort/"
for ($i = 0; $i -lt 40; $i++) { if ((Code $rb) -like '2*' -and (Body $rf) -match 'id="root"') { break }; Start-Sleep 3 }

# ================================================================ 8. verify
Section "8. Verify"
$v = [ordered]@{}
$v.recoveredBackendHealth = Code $rb
$v.recoveredFrontend = if ((Body $rf) -match 'id="root"') { '200 + app root' } else { Code $rf }
$pubBody = Body $rf $PublicHost
$v.recoveredFrontendAsPublicHost = if ($pubBody -match 'id="root"') { 'served' } elseif ($pubBody -match 'Blocked request') { 'BLOCKED by vite allowedHosts' } else { Code $rf $PublicHost }
foreach ($r in 'chat', 'decks', 'brain', 'agents') { $v["route /$r"] = if ((Body "$rf$r") -match 'id="root"') { 'served' } else { Code "$rf$r" } }
$v.liveBackendHealth = Code "http://127.0.0.1:$LiveBackendPort$HealthPath"
$v.liveFrontend = Code "http://127.0.0.1:$LiveFrontendPort/"
$v.public = Code "https://$PublicHost/"
$liveAfter = if (Test-Path $LiveRoot) { LiveFingerprint } else { 'absent' }
$v.liveInstallUnchanged = ($liveAfter -eq $liveBefore)
$v.GetEnumerator() | ForEach-Object { Note ("{0,-30} {1}" -f $_.Key, $_.Value) }
$evidence.verification = $v; $evidence.liveAfter = $liveAfter

if ($v.recoveredBackendHealth -notlike '2*') { Problem "recovered backend /health on $RecoveredBackendPort -> $($v.recoveredBackendHealth). See $work\backend.err.log" ; Get-Content (Join-Path $work 'backend.err.log') -Tail 15 -EA SilentlyContinue | ForEach-Object { Note "    $_" } }
if ($v.recoveredFrontend -ne '200 + app root') { Problem "recovered frontend on $RecoveredFrontendPort -> $($v.recoveredFrontend). See $work\frontend.err.log" }
if ($v.recoveredFrontendAsPublicHost -like 'BLOCKED*') { Problem "recovered frontend refuses Host: $PublicHost - add it to preview.allowedHosts before promoting, or the public site will 403." }
foreach ($r in 'chat', 'decks', 'brain', 'agents') { if ($v["route /$r"] -ne 'served') { Problem "recovered /$r -> $($v["route /$r"])" } }
if (-not $v.liveInstallUnchanged) {
  # The live backend writes its own files while it serves, so a change is a
  # prompt to look, not proof this script wrote there (it never targets it).
  Note "NOTE: the live install's fingerprint moved during the run (before: $liveBefore; after: $liveAfter). Expected if the live backend wrote data; check the newest file named above before promoting."
}
Note "Chat is checked by page, not by sending: a message may trigger real actions. Send one by hand at $rf."
Note "The public route serves the LIVE install; the recovered copy is local-only until promoted."
Note "Leave it running to check by hand; stop it with:  .\recover-alpha-from-usb.ps1 -StopRecovered"

Finish $(if ($problems.Count) { 1 } else { 0 })

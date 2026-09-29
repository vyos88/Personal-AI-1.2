<#
  recover-alpha-from-usb.ps1 - restore Alpha from the recovery drive into an
  isolated folder, run it beside the live install, and prove it works -
  without touching the live install or the drive it came from.

  Run as Administrator, on Laptop41:
      powershell -ExecutionPolicy Bypass -File .\recover-alpha-from-usb.ps1
  Stop the recovered copy afterwards:
      powershell -ExecutionPolicy Bypass -File .\recover-alpha-from-usb.ps1 -StopRecovered
  Continue a run that stopped, in the same folder, without copying again:
      powershell -ExecutionPolicy Bypass -File .\recover-alpha-from-usb.ps1 -Resume E:\AlphaRecovery\<time>

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
    9. panel       the Crown panel (CrowPanel): its USB-serial bridge is
                   present and working, which COM port it is on now, and -
                   unless -NoPanelProbe - its own answer to {"cmd":"status"}:
                   on WiFi, provisioned with a coordinator and a key, and
                   that coordinator answering /healthz from here.

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
  [string]$PanelPort = '',
  [switch]$NoPanelProbe,
  [string]$Resume = '',
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

# Clicking in a console window puts it in QuickEdit selection, and Windows then
# suspends the next write to it - the script freezes on a section header with
# no disk activity until someone presses Esc. A multi-hour copy is exactly
# when someone clicks the window, so this run turns QuickEdit off for itself.
try {
  Add-Type -Namespace Recovery -Name Console -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int h);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint m);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint m);
'@
  $in = [Recovery.Console]::GetStdHandle(-10); $mode = 0
  # ENABLE_EXTENDED_FLAGS (0x80) set, ENABLE_QUICK_EDIT_MODE (0x40) cleared.
  if ([Recovery.Console]::GetConsoleMode($in, [ref]$mode)) { [void][Recovery.Console]::SetConsoleMode($in, ($mode -bor 0x80) -band -bnot 0x40) }
} catch {}

if ($Resume) {
  # Continue a run that stopped, in its own folder. robocopy skips every file
  # already there with the same size and time, so only what is missing or
  # partial is read off the drive again; the SHA-256 pass still checks it all.
  $work = (Resolve-Path $Resume -EA SilentlyContinue).Path
  if (-not $work -or -not (Test-Path (Join-Path $work 'source'))) { Write-Host "-Resume $Resume : no source folder there to continue." -ForegroundColor Red; exit 1 }
  if (-not $work.StartsWith($TargetRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { Write-Host "-Resume $Resume is not under $TargetRoot." -ForegroundColor Red; exit 1 }
  if (Test-Path (Join-Path $work 'checkout')) { Write-Host "$work\checkout already exists - this run got past the copy. Rename that folder aside, then resume." -ForegroundColor Red; exit 1 }
  $running = @(Get-CimInstance Win32_Process -EA SilentlyContinue | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and (
    ($_.Name -eq 'robocopy.exe' -and $_.CommandLine -like "*$work*") -or
    ($_.CommandLine -match '(?i)recover-alpha-from-usb' -and $_.CommandLine -notmatch '(?i)-Resume|-StopRecovered') ) })
  if ($running.Count) { Write-Host "Another recovery is still running (pid $(@($running.ProcessId) -join ', ')). Stop it first (Ctrl+C in its window), then resume." -ForegroundColor Red; exit 1 }
} else {
  $work = Join-Path $TargetRoot (Get-Date -Format 'yyyyMMdd-HHmmss')
}
$copy = Join-Path $work 'source'
$checkout = Join-Path $work 'checkout'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$log = Join-Path $work 'recovery.log'
if ($Resume) { Start-Transcript -Path $log -Append | Out-Null; Write-Host "`n##### resumed $(Get-Date -Format o)" } else { Start-Transcript -Path $log -Force | Out-Null }
$evidence.resumed = [bool]$Resume

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
# A resumed run already holds part of the copy on the target.
$already = if (Test-Path $copy) { [int64](Get-ChildItem $copy -Recurse -File -Force -EA SilentlyContinue | Measure-Object Length -Sum).Sum } else { 0 }
if ($already) { Note ("already copied: {0:N1} GB" -f ($already / 1GB)) }
if ($drive.Free + $already -lt 4 * $srcBytes + 10GB) { Problem "Not enough room on $($drive.Name): (copy + checkout + data + dependencies needs about 4x the backup plus 10 GB)."; Finish 1 }
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
# robocopy writes every file it copies to robocopy.log, so a long copy can be
# watched from another window; the console and recovery.log only get the end.
$rcLog = Join-Path $work 'robocopy.log'
Note "copying - progress: Get-Content '$rcLog' -Tail 5 -Wait"
robocopy $Source $copy /E /COPY:DAT /R:2 /W:5 /NDL /NP /BYTES "/LOG+:$rcLog" | Out-Null
$rc = $LASTEXITCODE
Get-Content $rcLog -Tail 14 -EA SilentlyContinue | ForEach-Object { Note "  | $_" }
if ($rc -ge 8) { Problem "robocopy failed (exit $rc). See $rcLog."; Finish 1 }
$hashes = @()
$files = @(Get-ChildItem $Source -Recurse -File); $n = 0
foreach ($f in $files) {
  $rel = $f.FullName.Substring($Source.TrimEnd('\').Length).TrimStart('\')
  $n++; Note ("hashing {0}/{1}: {2} ({3:N1} GB, both sides)" -f $n, $files.Count, $rel, ($f.Length / 1GB))
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
$fe = @("$checkout\frontend", $checkout) | Where-Object { Test-Path "$_\package.json" } | Select-Object -First 1
$npm = (Get-Command npm.cmd -EA SilentlyContinue).Source
if (-not $fe) { Problem "no package.json in the checkout or its frontend folder." }
else {
  Push-Location $fe
  if (Test-Path 'package-lock.json') { & $npm ci 2>&1 | Select-Object -Last 5 | ForEach-Object { Note "$_" } }
  else { & $npm install 2>&1 | Select-Object -Last 5 | ForEach-Object { Note "$_" } }
  if ($LASTEXITCODE -ne 0) { Problem "npm install failed in $fe." }
  & $npm run build 2>&1 | Select-Object -Last 8 | ForEach-Object { Note "$_" }
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path 'dist\index.html')) { Problem "frontend build failed." } else { OK "frontend built" }
  Pop-Location
}
$req = Get-ChildItem $checkout -Recurse -Depth 4 -Filter requirements*.txt -EA SilentlyContinue |
       Where-Object { $_.FullName -notmatch '\\(node_modules|\.git|venv|\.venv)\\' } | Sort-Object { $_.FullName.Length } | Select-Object -First 1
$appFile = Get-ChildItem $checkout -Recurse -Depth 5 -Filter *.py -EA SilentlyContinue |
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

# ================================================================ 9. Crown panel
# The panel polls the coordinator, not Alpha, so nothing above can have broken
# it. It is checked because "is it still there, on which port, and is it still
# reporting" is asked right after a recovery, and Windows renumbers COM ports
# on re-enumeration - whatever saved the old number stops finding the board.
Section "9. Crown panel"
$pv = [ordered]@{}
# The USB-serial bridges a CrowPanel enumerates through: CH340/CH341, CH343/
# CH9102, CP210x and the ESP32-S3's native USB. Matched by VID/PID, because a
# FriendlyName changes with the driver.
$panelIds = 'VID_1A86&PID_7523', 'VID_1A86&PID_5523', 'VID_1A86&PID_55D3', 'VID_1A86&PID_55D4', 'VID_10C4&PID_EA60', 'VID_303A&PID_1001'
$bridges = @(Get-PnpDevice -PresentOnly -EA SilentlyContinue | Where-Object {
  $id = $_.InstanceId; @($panelIds | Where-Object { $id -like "*$_*" }).Count -gt 0 } | ForEach-Object {
  [pscustomobject]@{ port = if ($_.FriendlyName -match '\((COM\d+)\)') { $Matches[1] } else { $null }
                     name = $_.FriendlyName; status = $_.Status; instanceId = $_.InstanceId } })
$pv.bridges = @($bridges | ForEach-Object { "$(if ($_.port) { $_.port } else { 'no COM' }) $($_.name) [$($_.status)]" })
$working = @($bridges | Where-Object { $_.status -eq 'OK' -and $_.port })
if (-not $bridges.Count) {
  Problem "Crown panel: no CrowPanel USB-serial bridge is attached (looked for CH340/CH343/CP210x/ESP32-S3 USB). Check the cable and the port, then run scripts\usb-inventory.ps1."
  $other = @(Get-CimInstance Win32_SerialPort -EA SilentlyContinue | ForEach-Object { "$($_.DeviceID) $($_.Name)" })
  Note "  serial ports present: $(if ($other.Count) { $other -join '; ' } else { 'none' })"
} else {
  foreach ($b in $pv.bridges) { Note "  bridge: $b" }
  foreach ($b in @($bridges | Where-Object { $_.status -ne 'OK' })) { Problem "Crown panel: $($b.name) is attached but not working ($($b.status)) - it needs a driver or a replug." }
}
if ($PanelPort -and $working.Count -and @($working | Where-Object { $_.port -eq $PanelPort }).Count -eq 0) {
  Problem "Crown panel: expected on $PanelPort, but its bridge is on $(@($working.port) -join ', '). Windows renumbered it - update ALPHA_PANEL_PORT and anything else that saved $PanelPort."
}

# Asks the sketch for its status over serial. Read-only: 'status' changes
# nothing on the board and its reply never carries the WiFi password or the
# key. DTR/RTS stay low, but some adapters tie them to EN, so opening the port
# may still restart the board once - -NoPanelProbe skips this.
function PanelStatus($port) {
  $sp = New-Object System.IO.Ports.SerialPort $port, 115200, 'None', 8, 'One'
  $sp.DtrEnable = $false; $sp.RtsEnable = $false; $sp.ReadTimeout = 500; $sp.WriteTimeout = 2000; $sp.NewLine = "`n"
  try { $sp.Open() } catch { return [pscustomobject]@{ error = "cannot open ${port}: $($_.Exception.Message) - is a serial monitor or an alpha.panel task holding it?" } }
  try {
    # A board that just restarted prints its boot log first, so ask again
    # every two seconds and take the first line that is a reply.
    $deadline = (Get-Date).AddSeconds(12); $nextSend = Get-Date
    while ((Get-Date) -lt $deadline) {
      if ((Get-Date) -ge $nextSend) { $sp.DiscardInBuffer(); $sp.WriteLine('{"cmd":"status"}'); $nextSend = (Get-Date).AddSeconds(2) }
      $line = $null
      try { $line = $sp.ReadLine().Trim() }
      catch { if (-not ($_.Exception -is [TimeoutException] -or $_.Exception.InnerException -is [TimeoutException])) { throw } }
      if ($line -and $line.StartsWith('{')) {
        try { $j = $line | ConvertFrom-Json } catch { $j = $null }
        if ($j -and ($null -ne $j.ok -or $j.error)) { return $j }
      }
    }
    [pscustomobject]@{ error = "no reply to {""cmd"":""status""} on $port within 12 s - wrong port, or the sketch is not running (flash it with alpha.panel Flash)" }
  } catch { [pscustomobject]@{ error = "serial error on ${port}: $($_.Exception.Message)" } }
  finally { if ($sp.IsOpen) { $sp.Close() }; $sp.Dispose() }
}

if ($NoPanelProbe) {
  Note "  -NoPanelProbe: presence only, the board was not asked for its status."
} elseif ($working.Count) {
  # Expected port first; with several bridges, the one that answers is the panel.
  $order = @($working | Sort-Object { if ($_.port -eq $PanelPort) { 0 } else { 1 } })
  $reply = $null
  foreach ($b in $order) {
    $r = PanelStatus $b.port
    $pv["status $($b.port)"] = ($r | ConvertTo-Json -Compress)
    Note "  $($b.port) -> $($pv["status $($b.port)"])"
    if ($null -ne $r.ok) { $reply = $r; $pv.port = $b.port; break }
  }
  if (-not $reply) {
    Problem "Crown panel: no board answered {""cmd"":""status""} on $(@($order.port) -join ', '). $(@($order | ForEach-Object { $pv["status $($_.port)"] }) -join ' | ')"
  } else {
    OK "Crown panel answers on $($pv.port)"
    if (-not $reply.connected) { Problem "Crown panel: not on WiFi (ssid '$($reply.ssid)'). Provision it with alpha.panel Provision." }
    if (-not $reply.host) { Problem "Crown panel: no coordinator host set - it has nothing to poll. Provision it with alpha.panel Provision." }
    elseif (-not $reply.keyed) { Problem "Crown panel: no key set - the coordinator's /stats needs one, so the panel will show 'unauthorized'." }
    if ($reply.host) {
      $pv.coordinatorHealth = Code "$($reply.host.TrimEnd('/'))/healthz"
      Note "  panel's coordinator $($reply.host)/healthz -> $($pv.coordinatorHealth)"
      if ($pv.coordinatorHealth -notlike '2*') { Problem "Crown panel: its coordinator $($reply.host) answers /healthz with $($pv.coordinatorHealth) - the panel will show an error until the coordinator is back." }
    }
  }
}
$evidence.panel = $pv

Finish $(if ($problems.Count) { 1 } else { 0 })

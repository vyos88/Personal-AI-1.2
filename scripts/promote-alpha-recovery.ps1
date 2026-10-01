<#
  promote-alpha-recovery.ps1 - make a verified recovered copy of Alpha the one
  Laptop41 serves: backend on 8001, production frontend on 4173, boot tasks,
  self-heal, the host agent's coordination root, and a health check of all of
  it. The live folder is never moved, overwritten or deleted - it stays where
  it is as the rollback.

  Check the gates only (changes nothing):
      powershell -ExecutionPolicy Bypass -File .\promote-alpha-recovery.ps1 -Check
  Promote, after signing in to the recovered copy by hand:
      powershell -ExecutionPolicy Bypass -File .\promote-alpha-recovery.ps1 -Confirmed
  Go back to the previous copy:
      powershell -ExecutionPolicy Bypass -File .\promote-alpha-recovery.ps1 -Rollback

  Gates - every one must pass, and -Check reports each:
    1. no recovery is running   (recover-alpha-from-usb.ps1 still executing)
    2. the recovered copy is stopped (its 8011/4183 servers use the same data
                                 folder a promoted backend would; stopping them
                                 is yours: recover-alpha-from-usb.ps1 -StopRecovered)
    3. the latest recovery evidence has no problems, no live-path references,
                                 and every copied file's SHA-256 matched
    4. the recovered data is not older than the live data, unless
                                 -AcceptOlderData (promoting older data loses
                                 whatever the live copy wrote since the backup)
    5. -Confirmed: a person signed in at http://127.0.0.1:4183 and used Chat,
                                 Decks, Brain, Agents and Crown Panel

  Then, in order: record a manifest; point the host agent's ALPHA_REPO_ROOT at
  the recovered copy (backups kept); stop the frontend serving the old copy;
  set self-heal's state aside; run repair-alpha-host.ps1 against the recovered
  root with its backend given explicitly; verify.
#>

param(
  [string]$RecoveryRoot = 'E:\AlphaRecovery',
  [string]$LiveRoot = 'C:\AlphaData\Alpha',
  [string]$OpsDir = 'C:\AlphaData\alpha-ops',
  [string]$AgentService = 'alpha-agent',
  [string]$PublicHost = 'alpha-ai.uk',
  [int]$BackendPort = 8001,
  [int]$FrontendPort = 4173,
  [switch]$Check,
  [switch]$Confirmed,
  [switch]$AcceptOlderData,
  [switch]$Rollback
)

$ErrorActionPreference = 'Continue'
$tunnel = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$promoDir = Join-Path $OpsDir 'promotion'
New-Item -ItemType Directory -Force -Path $promoDir | Out-Null
$log = Join-Path $promoDir "promote-$stamp.log"
Start-Transcript -Path $log -Force | Out-Null
$blockers = New-Object System.Collections.ArrayList
function Blocker($t) { [void]$blockers.Add($t); Write-Host "  BLOCKER: $t" -ForegroundColor Red }
function OK($t)      { Write-Host "  ok: $t" -ForegroundColor Green }
function Note($t)    { Write-Host "  $t" }
function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Code($url, [string]$HostHeader = '') {
  $a = @('-s', '-k', '-o', 'NUL', '-w', '%{http_code}', '--max-time', '8')
  if ($HostHeader) { $a += @('-H', "Host: $HostHeader") }
  $c = & curl.exe @a $url 2>$null; if (-not $c) { '000' } else { "$c" }
}
function Body($url, [string]$HostHeader = '') {
  $a = @('-s', '-k', '--max-time', '8'); if ($HostHeader) { $a += @('-H', "Host: $HostHeader") }
  (& curl.exe @a $url 2>$null | Out-String)
}
function Done($code) {
  Write-Host "`n=== VERDICT ===" -ForegroundColor Cyan
  if ($blockers.Count) { Write-Host "$($blockers.Count) blocker(s):" -ForegroundColor Yellow; $i = 1; foreach ($b in $blockers) { Write-Host "  $i. $b"; $i++ } }
  else { Write-Host "No blockers." -ForegroundColor Green }
  Write-Host "`nLog: $log"; Stop-Transcript | Out-Null; exit $code
}

# The backend is whichever module defines the FastAPI app - the same rule the
# recovery used to start it, so promotion runs what was verified.
function Find-Backend($root) {
  $hit = Get-ChildItem $root -Recurse -Depth 5 -Filter *.py -EA SilentlyContinue |
         Where-Object { $_.FullName -notmatch '\\(node_modules|\.git|venv|\.venv|site-packages)\\' } |
         Select-String -Pattern '^\s*app\s*=\s*FastAPI\(' -List -EA SilentlyContinue | Select-Object -First 1
  if ($hit) { @{ dir = (Split-Path $hit.Path); module = [IO.Path]::GetFileNameWithoutExtension($hit.Path) } }
}
function Newest($root, $tops) {
  $n = $null
  foreach ($t in $tops) {
    $p = Join-Path $root $t
    if (-not (Test-Path $p)) { continue }
    $f = Get-ChildItem $p -Recurse -File -Force -EA SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if ($f -and (-not $n -or $f.LastWriteTimeUtc -gt $n.LastWriteTimeUtc)) { $n = $f }
  }
  $n
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Blocker "Not elevated. Run from an Administrator PowerShell."; Done 1 }

# ================================================================ rollback
if ($Rollback) {
  Section "Rollback of the last promotion"
  $m = Get-ChildItem $promoDir -Filter 'manifest-*.json' -EA SilentlyContinue | Sort-Object Name | Select-Object -Last 1
  if (-not $m) { Blocker "No promotion manifest in $promoDir."; Done 1 }
  $mf = Get-Content $m.FullName -Raw | ConvertFrom-Json
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'repair-alpha-host.ps1') -OpsDir $OpsDir -Rollback
  if ($mf.agentEnvBackup -and (Test-Path $mf.agentEnvBackup)) { Copy-Item $mf.agentEnvBackup $mf.agentEnvFile -Force; OK "restored $($mf.agentEnvFile)" }
  if ($mf.nssmEnvBefore -ne $null -and (Get-Command nssm -EA SilentlyContinue)) {
    nssm set $AgentService AppEnvironmentExtra $mf.nssmEnvBefore | Out-Null; OK "restored $AgentService environment"
  }
  if ($mf.selfhealStateAside -and (Test-Path $mf.selfhealStateAside)) {
    $st = Join-Path $OpsDir 'selfheal'
    if (Test-Path $st) { Rename-Item $st "selfheal.promoted-$stamp" }
    Rename-Item $mf.selfhealStateAside 'selfheal'; OK "self-heal state restored"
  }
  Note "Restart the agent so it reads its old root:  nssm restart $AgentService"
  Note "The recovered copy is untouched at $($mf.recoveredRoot)."
  Rename-Item $m.FullName "$($m.Name).undone"
  Done 0
}

# ================================================================ gates
Section "Gates"
# 1. an active recovery
$running = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -EA SilentlyContinue |
             Where-Object { $_.CommandLine -match 'recover-alpha-from-usb\.ps1' -and $_.CommandLine -notmatch '-StopRecovered' })
if ($running.Count) { Blocker "A recovery is still running (pid $($running.ProcessId -join ', ')). Wait for its verdict; this script does not stop it." }
else { OK "no recovery running" }

# 2. the recovered copy's own servers
$pidFile = Join-Path $RecoveryRoot 'recovered-pids.json'
$alive = @()
if (Test-Path $pidFile) {
  foreach ($p in @((Get-Content $pidFile -Raw | ConvertFrom-Json).pids)) { if (Get-Process -Id $p -EA SilentlyContinue) { $alive += $p } }
}
if ($alive.Count) { Blocker "The recovered copy is still running for testing (pid $($alive -join ', '), ports 8011/4183) and shares the data a promoted backend would use. When you have finished testing it:  .\scripts\recover-alpha-from-usb.ps1 -StopRecovered" }
else { OK "recovered copy not running" }

# 3. evidence
$ev = Get-ChildItem $RecoveryRoot -Directory -EA SilentlyContinue | Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName 'evidence.json' } | Where-Object { Test-Path $_ } | Select-Object -First 1
$recovered = $null
if (-not $ev) { Blocker "No evidence.json under $RecoveryRoot - the recovery has not finished." }
else {
  $e = Get-Content $ev -Raw | ConvertFrom-Json
  $work = Split-Path $ev
  $recovered = Join-Path $work 'checkout'
  Note "evidence: $ev"
  Note "checkout: $($e.checkoutHead)"
  if (@($e.problems).Count) { foreach ($p in $e.problems) { Blocker "recovery reported: $p" } }
  if (@($e.liveRefs).Count) { Blocker "recovered configuration still names the live install: $($e.liveRefs -join ', ')" }
  if (@($e.sha256 | Where-Object { -not $_.match }).Count) { Blocker "a copied file did not match the drive's SHA-256." }
  if (-not $e.verification) { Blocker "the recovery never reached verification." }
  if (-not @($e.problems).Count -and $e.verification) { OK "recovery verdict clean" }
  if (-not (Test-Path (Join-Path $recovered 'scripts\alpha_coordination_tunnel.ps1'))) {
    Blocker "$recovered has no scripts\alpha_coordination_tunnel.ps1 - pointing the host agent at it would break every coordination receipt."
  }
  if (-not (Test-Path (Join-Path $recovered 'frontend\src\app\shell\AppShell.tsx'))) { Blocker "$recovered does not look like Alpha (no frontend\src\app\shell\AppShell.tsx)." }
}

# 4. data freshness
if ($recovered) {
  $tar = Join-Path $work 'source\alpha-data.tar'
  $tops = @(tar.exe -tf $tar 2>$null | ForEach-Object { ($_ -replace '^\./', '' -split '[\\/]')[0] } | Where-Object { $_ } | Select-Object -Unique)
  $nl = Newest $LiveRoot $tops; $nr = Newest $recovered $tops
  Note "data folders from the backup: $($tops -join ', ')"
  Note "newest live data:      $(if ($nl) { "$($nl.LastWriteTimeUtc.ToString('u')) $($nl.FullName)" } else { 'none' })"
  Note "newest recovered data: $(if ($nr) { "$($nr.LastWriteTimeUtc.ToString('u')) $($nr.FullName)" } else { 'none' })"
  if ($nl -and $nr -and $nl.LastWriteTimeUtc -gt $nr.LastWriteTimeUtc.AddMinutes(1) -and -not $AcceptOlderData) {
    Blocker "The live copy has data newer than the backup ($($nl.LastWriteTimeUtc.ToString('u')) vs $($nr.LastWriteTimeUtc.ToString('u'))). Promoting would serve older data. Copy what matters across, or re-run with -AcceptOlderData."
  } else { OK "recovered data is not older than live data$(if ($AcceptOlderData) { ' (or accepted)' })" }
}

# the backend the recovery verified
$venvPy = if ($recovered) { Join-Path $work 'venv\Scripts\python.exe' }
$be = if ($recovered) { Find-Backend $recovered }
if ($recovered -and -not (Test-Path $venvPy)) { Blocker "No recovery venv at $venvPy." }
if ($recovered -and -not $be) { Blocker "Cannot find the recovered backend (a module defining app = FastAPI(...))." }
if ($recovered -and -not (Test-Path (Join-Path $recovered 'frontend\dist\index.html'))) { Blocker "The recovered frontend has no build (frontend\dist\index.html)." }

# 5. a person
if (-not $Confirmed) {
  if ($Check) { Note "(-Confirmed not given: sign in at http://127.0.0.1:4183 first, then re-run with -Confirmed)" }
  else { Blocker "Pass -Confirmed once a person has signed in at http://127.0.0.1:4183 and used Chat, Decks, Brain, Agents and Crown Panel." }
}

if ($blockers.Count -or $Check) { Done $(if ($blockers.Count) { 1 } else { 0 }) }

# ================================================================ promote
Section "Promote $recovered"
$manifest = [ordered]@{ stamp = $stamp; recoveredRoot = $recovered; previousRoot = $LiveRoot; evidence = $ev }

# Host agent: its coordination handler reads ALPHA_REPO_ROOT. Left pointing at
# the old copy, every receipt from here on lands in the wrong tunnel log.
$envFile = Join-Path $tunnel '.env.agent'
if ((Test-Path $envFile) -and (Select-String -Path $envFile -Pattern '^\s*ALPHA_REPO_ROOT=' -Quiet)) {
  $bak = Join-Path $promoDir ".env.agent.$stamp"
  Copy-Item $envFile $bak
  (Get-Content $envFile) -replace '^\s*ALPHA_REPO_ROOT=.*$', "ALPHA_REPO_ROOT=$recovered" | Set-Content $envFile -Encoding ascii
  $manifest.agentEnvFile = $envFile; $manifest.agentEnvBackup = $bak
  OK ".env.agent ALPHA_REPO_ROOT -> $recovered (backup $bak)"
}
$nssm = (Get-Command nssm -EA SilentlyContinue).Source
if ($nssm -and (Get-Service $AgentService -EA SilentlyContinue)) {
  $before = (& $nssm get $AgentService AppEnvironmentExtra 2>$null | Out-String).Trim()
  if ($before -match 'ALPHA_REPO_ROOT=') {
    $manifest.nssmEnvBefore = $before
    $parts = @($before -split "\r?\n" | Where-Object { $_ } | ForEach-Object { if ($_ -match '^ALPHA_REPO_ROOT=') { "ALPHA_REPO_ROOT=$recovered" } else { $_ } })
    & $nssm set $AgentService AppEnvironmentExtra @parts | Out-Null
    OK "$AgentService environment ALPHA_REPO_ROOT -> $recovered"
  }
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $promoDir "manifest-$stamp.json") -Encoding utf8

# The frontend serving the old copy. start-alpha-at-boot.ps1 stops its own
# wrapper, but leaves a server started any other way answering - which would
# keep the old copy on 4173 behind a task that looks promoted.
foreach ($c in @(Get-NetTCPConnection -LocalPort $FrontendPort -State Listen -EA SilentlyContinue)) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -EA SilentlyContinue
  if ($p -and $p.Name -eq 'node.exe' -and $p.CommandLine -notlike "*$recovered*") {
    taskkill.exe /T /F /PID $p.ProcessId 2>&1 | Out-Null
    OK "stopped the old frontend on $FrontendPort (pid $($p.ProcessId))"
  } elseif ($p -and $p.Name -ne 'node.exe') { Blocker "$($p.Name) pid $($p.ProcessId) holds $FrontendPort - not stopped; decide what it is."; Done 1 }
}

# Self-heal's streaks and last-good fingerprint describe the old copy.
$st = Join-Path $OpsDir 'selfheal'
if (Test-Path $st) {
  $aside = Join-Path $OpsDir "selfheal.before-promotion-$stamp"
  Rename-Item $st $aside
  $manifest.selfhealStateAside = $aside
  $manifest | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $promoDir "manifest-$stamp.json") -Encoding utf8
  OK "self-heal state set aside"
}

$oldBe = Find-Backend $LiveRoot
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'repair-alpha-host.ps1') `
  -AlphaRoot $recovered -OpsDir $OpsDir -BackendPort $BackendPort -FrontendPort $FrontendPort -PublicHost $PublicHost `
  -BackendExe $venvPy -BackendArgs "-m uvicorn $($be.module):app --host 127.0.0.1 --port $BackendPort" -BackendDir $be.dir `
  -RestoreBackendDir $(if ($oldBe) { $oldBe.dir } else { '' })
if ($LASTEXITCODE -ne 0) { Blocker "repair-alpha-host.ps1 reported problems - its verdict is above. Undo with -Rollback if Alpha is down." }

if ($nssm -and (Get-Service $AgentService -EA SilentlyContinue)) { & $nssm restart $AgentService | Out-Null; OK "$AgentService restarted onto the new root" }
elseif (Get-Service alpha-keeper -EA SilentlyContinue) { Restart-Service alpha-keeper; OK "alpha-keeper restarted onto the new root" }

# ================================================================ verify
Section "Verify the promoted host"
Start-Sleep 10
$v = [ordered]@{}
$v.backendHealth = Code "http://127.0.0.1:$BackendPort/health"
$v.backendFromRecovered = [bool](Get-CimInstance Win32_Process -EA SilentlyContinue | Where-Object { $_.CommandLine -like "*$($be.module):app*" -and $_.CommandLine -like "*--port $BackendPort*" -and $_.ExecutablePath -eq $venvPy })
$fb = Get-NetTCPConnection -LocalPort $FrontendPort -State Listen -EA SilentlyContinue | Select-Object -First 1
$fp = if ($fb) { Get-CimInstance Win32_Process -Filter "ProcessId=$($fb.OwningProcess)" }
$v.frontend = if ((Body "http://127.0.0.1:$FrontendPort/") -match 'id="root"') { '200 + app root' } else { Code "http://127.0.0.1:$FrontendPort/" }
$v.frontendFromRecovered = [bool]($fp -and "$($fp.CommandLine)" -like "*$recovered*")
$v.frontendAsPublicHost = if ((Body "http://127.0.0.1:$FrontendPort/" $PublicHost) -match 'id="root"') { 'served' } else { Code "http://127.0.0.1:$FrontendPort/" $PublicHost }
foreach ($r in 'chat', 'decks', 'brain', 'agents', 'crown', 'network') { $v["route /$r"] = if ((Body "http://127.0.0.1:$FrontendPort/$r") -match 'id="root"') { 'served' } else { Code "http://127.0.0.1:$FrontendPort/$r" } }
$v.public = Code "https://$PublicHost/"
foreach ($t in 'Alpha Backend', 'Alpha', 'Alpha Self-Heal') { $task = Get-ScheduledTask -TaskName $t -EA SilentlyContinue; $v["task $t"] = if ($task) { "$($task.State) as $($task.Principal.UserId)/$($task.Principal.LogonType)" } else { 'MISSING' } }
Push-Location $tunnel
$agents = node src/admin/run.js agents 2>&1 | Out-String
Pop-Location
$v.agents = ($agents -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 8) -join ' | '
$v.GetEnumerator() | ForEach-Object { Note ("{0,-24} {1}" -f $_.Key, $_.Value) }
if ($v.backendHealth -notlike '2*') { Blocker "backend /health -> $($v.backendHealth)" }
if (-not $v.backendFromRecovered) { Blocker "the process on $BackendPort is not the recovered backend." }
if ($v.frontend -ne '200 + app root') { Blocker "frontend -> $($v.frontend)" }
if (-not $v.frontendFromRecovered) { Blocker "the process on $FrontendPort is not serving $recovered." }
foreach ($t in 'Alpha Backend', 'Alpha', 'Alpha Self-Heal') { if ($v["task $t"] -eq 'MISSING') { Blocker "scheduled task '$t' is missing." } }
if (@('502', '504', '530', '000') -contains $v.public) { Blocker "public $PublicHost -> $($v.public)" }
$v | ConvertTo-Json | Set-Content (Join-Path $promoDir "verify-$stamp.json") -Encoding utf8
Note "Crown Panel, Chat, Decks, Brain and Agents: open https://$PublicHost/ through Access and use each once."
Note "Rollback:  .\scripts\promote-alpha-recovery.ps1 -Rollback   (the old copy at $LiveRoot was never touched)"
Done $(if ($blockers.Count) { 1 } else { 0 })

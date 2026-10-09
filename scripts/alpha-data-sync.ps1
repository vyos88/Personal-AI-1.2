<#
.SYNOPSIS
  Phase 3's data half (docs/HANDOFF_2026-10-07d_alpha-moves-to-host.md): keep
  the other machine's copy of Alpha's memory\ in step, so whichever one serves
  next serves recent data, and nothing written during a cover is lost.

.DESCRIPTION
  One rule, the same on both machines: **the machine that serves Alpha sends
  what changed; the other applies it while it does not serve.**

  Sending (with -Peer):
    - Only a machine whose backend answers here sends. It also sends once more
      after it stops serving (a stand-down, a hand-back), so the last minutes
      it served go out too. A machine that never served here sends nothing, so
      a stale copy is never pushed over a live one.
    - The first pass sets a baseline and sends nothing: both copies are the
      same at a switch-over. -Since sets the baseline instead, for a copy known
      to be older (the Host's is from 2026-10-07).
    - What it sends is every file under memory\ written since the last send,
      less what it received itself and has not changed since. That keeps two
      machines from sending the same file back and forth. It also leaves out
      what send-alpha-data.ps1 leaves out (test leftovers, a recovery image,
      the Android SDK, the books junction, __pycache__), and never follows a
      junction.
    - The files are packed with tar beside a manifest naming its SHA-256, and
      handed to `tailscale file cp`. That is Taildrop: end-to-end encrypted,
      inside the owner's tailnet, never git or chat.

  Receiving (always, unless -NoReceive):
    - `tailscale file get` collects into -Inbox, the inbox receive-alpha-data
      uses. Only alpha-data-*.json manifests and their archives are this
      script's; anything else there is left alone.
    - Every archive is checked before anything is applied: present, the right
      size, the right SHA-256, and nothing in it outside memory\.
    - **Nothing is applied under a running Alpha.** While the backend answers
      here, a package is held, and the data-apply job (-ApplyHeld) applies it:
      it stops the backend, applies, and starts it again.
    - Applying never deletes. A file is written only when the incoming one is
      newer, and the one it replaces is kept under data-sync\replaced\<time>\.
      A file newer here is kept and counted as a conflict. Times are carried
      across, so a copy never looks newer than its original.

  Exit codes: 0 done (including "nothing to do"); 1 a send or an apply failed
  or was refused; 3 a package is held, or still arriving.
#>
param(
  [string]$OpsDir = 'C:\AlphaData\alpha-ops',
  [string]$AlphaRoot = 'C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software',
  [string]$Peer = '',
  [string]$Inbox = 'C:\AlphaData\alpha-move\inbox',
  [string]$HealthUrl = 'http://127.0.0.1:8001/health',
  [string]$Since = '',
  [switch]$NoSend,
  [switch]$NoReceive,
  [switch]$ApplyHeld,
  [switch]$NoFetch
)

$ErrorActionPreference = 'Continue'
function Say([string]$t) { Write-Output $t }
$machine = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { [Environment]::MachineName }
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$dir = Join-Path $OpsDir 'data-sync'
$stateFile = Join-Path $dir 'state.json'
$indexFile = Join-Path $dir 'received.json'
$sentFile = Join-Path $dir 'sent.json'
$tar = if (Get-Command tar.exe -EA SilentlyContinue) { 'tar.exe' } else { 'tar' }
$skip = '^memory/local/(pytest-[^/]*|test-temp|uno-q-recovery|android-sdk|books)(/|$)|(^|/)__pycache__(/|$)'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# Where Alpha's memory\ is: beside -AlphaRoot when that is a real Alpha, else
# where prepare-alpha-here put it (the Host's nested Alpha-Full), the same rule
# receive-alpha-data.ps1 follows.
$alphaHome = $AlphaRoot -replace '[\\/][^\\/]+[\\/]?$', ''
if (-not (Test-Path -LiteralPath (Join-Path $alphaHome 'software'))) {
  $profileDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
  $target = Join-Path (Join-Path $profileDir 'Downloads') 'VyoS-advance-tech-ai'
  $nested = Join-Path $target 'BuildArtifacts\installers\Alpha-Full'
  $alphaHome = if (Test-Path -LiteralPath (Join-Path $nested 'software')) { $nested } else { $target }
}
$mem = Join-Path $alphaHome 'memory'

function Load-Json([string]$f) { if (Test-Path -LiteralPath $f) { try { return Get-Content -LiteralPath $f -Raw | ConvertFrom-Json } catch { } }; return $null }
function Save-Json([string]$f, $v) {
  [IO.File]::WriteAllText("$f.tmp", ($v | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding $false))
  Move-Item -LiteralPath "$f.tmp" -Destination $f -Force
}
function Iso([int64]$ticks) { if ($ticks) { return ([datetime]::new($ticks, [DateTimeKind]::Utc)).ToString('yyyy-MM-ddTHH:mm:ssZ') }; return 'never' }
function Serving {
  try { return [int](Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 5 -EA Stop).StatusCode -eq 200 } catch { return $false }
}
# Every file under memory\, relative with forward slashes, never through a
# junction (memory\local\books points at another drive).
function Walk([string]$root) {
  $out = New-Object System.Collections.ArrayList
  if (-not (Test-Path -LiteralPath $root)) { return $out }
  $stack = New-Object System.Collections.Stack
  $stack.Push($root)
  while ($stack.Count) {
    $d = $stack.Pop()
    foreach ($f in @(try { [IO.Directory]::GetFiles($d) } catch { @() })) { [void]$out.Add($f) }
    foreach ($s in @(try { [IO.Directory]::GetDirectories($d) } catch { @() })) {
      if (([IO.File]::GetAttributes($s) -band [IO.FileAttributes]::ReparsePoint) -eq 0) { $stack.Push($s) }
    }
  }
  return $out
}
function Rel([string]$base, [string]$full) { return ('memory/' + $full.Substring($base.Length).TrimStart('\', '/')) -replace '\\', '/' }
function Copy-Keeping([string]$src, [string]$dst) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
  Copy-Item -LiteralPath $src -Destination $dst -Force
  (Get-Item -LiteralPath $dst).LastWriteTimeUtc = (Get-Item -LiteralPath $src).LastWriteTimeUtc
}

$state = Load-Json $stateFile
if (-not $state) { $state = [pscustomobject]@{} }
foreach ($k in 'baselineTicks', 'lastSentTicks', 'servingSeenTicks') { if (-not ($state.PSObject.Properties.Name -contains $k)) { $state | Add-Member -NotePropertyName $k -NotePropertyValue ([int64]0) } }
$received = @{}
$idx = Load-Json $indexFile
if ($idx) { foreach ($p in $idx.PSObject.Properties) { $received[$p.Name] = [int64]$p.Value } }
# What went out, by its time: a file stamped ahead of this clock (another
# machine's, or a skewed one) is not sent again until it changes.
$sentIdx = @{}
$sidx = Load-Json $sentFile
if ($sidx) { foreach ($p in $sidx.PSObject.Properties) { $sentIdx[$p.Name] = [int64]$p.Value } }

Say ("DATA SYNC {0} {1} (memory\ at {2})" -f $machine, (Get-Date).ToString('yyyy-MM-dd HH:mm'), $mem)
$exit = 0
$serving = Serving

# ---------------------------------------------------------------- receive
function Stop-Backend {
  Stop-ScheduledTask -TaskName 'Alpha Backend' -EA SilentlyContinue
  foreach ($c in @(Get-NetTCPConnection -LocalPort 8001 -State Listen -EA SilentlyContinue)) {
    $p = Get-Process -Id $c.OwningProcess -EA SilentlyContinue
    if ($p -and @('python', 'pythonw', 'uvicorn', 'node') -contains $p.ProcessName.ToLower()) { taskkill.exe /T /F /PID $p.Id 2>&1 | Out-Null }
  }
}
if (-not $NoReceive) {
  New-Item -ItemType Directory -Force -Path $Inbox | Out-Null
  if (-not $NoFetch) {
    try { $got = & tailscale file get --conflict=rename $Inbox 2>&1; if ($LASTEXITCODE -ne 0) { Say "  taildrop: $((@($got) | Select-Object -Last 1))" } }
    catch { Say "  taildrop: $($_.Exception.Message)" }
  }
  $packages = @(Get-ChildItem -LiteralPath $Inbox -Filter 'alpha-data-*.json' -File -EA SilentlyContinue | Sort-Object Name)
  $held = 0
  $stopped = $false
  foreach ($m in $packages) {
    $man = Load-Json $m.FullName
    $tarName = if ($man) { [string]$man.archive.name } else { '' }
    if (-not $man -or $tarName -notmatch '^alpha-data-[A-Za-z0-9._-]+\.tar$') { Say "  REFUSED: $($m.Name) is not a manifest this script wrote"; $exit = 1; continue }
    $tarFile = Join-Path $Inbox $tarName
    if (-not (Test-Path -LiteralPath $tarFile)) { Say "  waiting for $tarName"; if (-not $exit) { $exit = 3 }; continue }
    $len = (Get-Item -LiteralPath $tarFile).Length
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $tarFile).Hash.ToLower()
    if ($len -ne [int64]$man.archive.bytes -or $hash -ne ([string]$man.archive.sha256).ToLower()) { Say "  REFUSED: $tarName does not match its manifest ($len bytes); kept for a person"; $exit = 1; continue }
    $listing = @(& $tar -tf $tarFile 2>$null | ForEach-Object { $_ -replace '\\', '/' })
    $unsafe = @($listing | Where-Object { $_ -match '^(/|[A-Za-z]:)|(^|/)\.\.(/|$)' -or $_ -notmatch '^memory(/|$)' })
    if (-not $listing.Count -or $unsafe.Count) { Say "  REFUSED: $tarName holds paths outside memory\ ($($unsafe.Count)); nothing applied"; $exit = 1; continue }
    if ($serving -and -not $ApplyHeld) { $held++; Say "  HELD: $tarName from $($man.from) ($($man.files) file(s)): Alpha serves here, so it waits for the data-apply job"; continue }
    if ($serving -and $ApplyHeld -and -not $stopped) { Stop-Backend; $stopped = $true; Say '  stopped the backend to apply' }

    $staging = Join-Path $dir "staging-$stamp"
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    $out = & $tar -xf $tarFile -C $staging 2>&1
    if ($LASTEXITCODE -ne 0) { Say "  FAILED: extracting $tarName"; Remove-Item -LiteralPath $staging -Recurse -Force -EA SilentlyContinue; $exit = 1; continue }
    $base = Join-Path $staging 'memory'
    $applied = 0; $same = 0; $conflicts = 0; $replaced = 0
    foreach ($src in (Walk $base)) {
      $rel = Rel $base $src
      $dst = Join-Path $alphaHome ($rel -replace '/', '\')
      $srcTicks = (Get-Item -LiteralPath $src).LastWriteTimeUtc.Ticks
      if (Test-Path -LiteralPath $dst) {
        $d = Get-Item -LiteralPath $dst
        if ($d.LastWriteTimeUtc.Ticks -eq $srcTicks -and $d.Length -eq (Get-Item -LiteralPath $src).Length) { $same++; $received[$rel] = $srcTicks; continue }
        if ($d.LastWriteTimeUtc.Ticks -gt $srcTicks) { $conflicts++; continue }
        Copy-Keeping $dst (Join-Path (Join-Path $dir "replaced\$stamp") ($rel -replace '/', '\'))
        $replaced++
      }
      Copy-Keeping $src $dst
      $received[$rel] = $srcTicks
      $applied++
    }
    Remove-Item -LiteralPath $staging -Recurse -Force -EA SilentlyContinue
    Remove-Item -LiteralPath $tarFile, $m.FullName -Force -EA SilentlyContinue
    $state | Add-Member -Force -NotePropertyName lastApply -NotePropertyValue ([ordered]@{ at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); from = [string]$man.from; files = $applied; unchanged = $same; replaced = $replaced; keptNewerHere = $conflicts })
    Say ("  APPLIED {0} from {1}: {2} file(s) written ({3} replaced, kept under data-sync\replaced\{4}), {5} already the same, {6} newer here and kept" -f $tarName, $man.from, $applied, $replaced, $stamp, $same, $conflicts)
  }
  if ($stopped) { Start-ScheduledTask -TaskName 'Alpha Backend' -EA SilentlyContinue; Say "  started the backend again ('Alpha Backend')" }
  $state | Add-Member -Force -NotePropertyName held -NotePropertyValue $held
  if ($held -and -not $exit) { $exit = 3 }
  if (-not $packages.Count) { Say '  nothing received' }
  Save-Json $indexFile $received
}

# ---------------------------------------------------------------- send
if ($Peer -and -not $NoSend) {
  if ($Peer -notmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,62}$') { Say 'REFUSED: -Peer must be a machine name'; exit 1 }
  $passStart = (Get-Date).ToUniversalTime().Ticks
  if ($serving) { $state.servingSeenTicks = $passStart }
  if ($Since) {
    $s = [datetime]::Parse($Since, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal)
    $state.baselineTicks = $s.Ticks; $state.lastSentTicks = $s.Ticks
    Say "  baseline set to $(Iso $s.Ticks) (-Since): everything written here after it goes to $Peer"
  }
  if (-not $state.baselineTicks) {
    $state.baselineTicks = $passStart; $state.lastSentTicks = $passStart
    Say "  baseline set to $(Iso $passStart): from now on, what changes here goes to $Peer"
  # Served at the last pass is "may have served until just now": the minutes
  # between that pass and the stop go out once more. Only a pass that saw no
  # serving since the last send has nothing of its own to send.
  } elseif (-not $serving -and $state.servingSeenTicks -lt $state.lastSentTicks) {
    Say '  not serving here, and nothing unsent from when it did: nothing to send'
  } else {
    $since = [int64]$state.lastSentTicks
    $changed = @(Walk $mem | Where-Object {
        $t = [IO.File]::GetLastWriteTimeUtc($_).Ticks
        $r = Rel $mem $_
        $t -gt $since -and $r -notmatch $skip -and -not ($received.ContainsKey($r) -and $received[$r] -eq $t) -and -not ($sentIdx.ContainsKey($r) -and $sentIdx[$r] -eq $t)
      })
    if (-not $changed.Count) {
      Say "  nothing written here since $(Iso $since)"
      $state.lastSentTicks = $passStart
    } else {
      $out = Join-Path $dir "outbox-$stamp"
      $staging = Join-Path $out 'staging'
      foreach ($f in $changed) { Copy-Keeping $f (Join-Path $staging ((Rel $mem $f) -replace '/', '\')) }
      $tarName = "alpha-data-$($machine.ToLower())-$stamp.tar"
      $tarFile = Join-Path $out $tarName
      & $tar -cf $tarFile -C $staging memory 2>&1 | Out-Null
      $bytes = ($changed | ForEach-Object { (Get-Item -LiteralPath $_).Length } | Measure-Object -Sum).Sum
      $manifest = Join-Path $out "alpha-data-$($machine.ToLower())-$stamp.json"
      Save-Json $manifest ([ordered]@{ kind = 'memory-changes'; from = $machine; at = (Iso $passStart); since = (Iso $since); files = $changed.Count; bytes = $bytes
          archive = [ordered]@{ name = $tarName; bytes = (Get-Item -LiteralPath $tarFile).Length; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $tarFile).Hash.ToLower() } })
      $sent = $false
      try { $r = & tailscale file cp $tarFile $manifest "$($Peer):" 2>&1; $sent = ($LASTEXITCODE -eq 0); if (-not $sent) { Say "  taildrop: $((@($r) | Select-Object -Last 1))" } }
      catch { Say "  taildrop: $($_.Exception.Message)" }
      Remove-Item -LiteralPath $out -Recurse -Force -EA SilentlyContinue
      if ($sent) {
        foreach ($f in $changed) { $sentIdx[(Rel $mem $f)] = [IO.File]::GetLastWriteTimeUtc($f).Ticks }
        Save-Json $sentFile $sentIdx
        $state.lastSentTicks = $passStart
        $state | Add-Member -Force -NotePropertyName lastSend -NotePropertyValue ([ordered]@{ at = (Iso $passStart); to = $Peer; files = $changed.Count; bytes = $bytes })
        Say ("  SENT {0} file(s), {1:N1} MB written since {2}, to {3}" -f $changed.Count, ($bytes / 1MB), (Iso $since), $Peer)
      } else {
        Say "  NOT SENT: $($changed.Count) file(s) wait for the next pass (nothing is lost: the next send starts from $(Iso $since))"
        $exit = 1
      }
    }
  }
}

Save-Json $stateFile $state
exit $exit

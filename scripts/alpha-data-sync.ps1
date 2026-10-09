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
    - Format 2: the tar holds numbered files (f/0000000, ...), and the
      manifest names each one: its memory\ path and its time, to the tick.
      Names never pass through tar, so a name outside the ANSI code page (the
      Chinese-named PDFs that made Windows' tar.exe fail a part on 2026-10-09)
      or a long path cannot break a part. A package from before format 2
      (memory\ itself in the tar) is still applied.

  Receiving (always, unless -NoReceive):
    - `tailscale file get` collects into -Inbox, the inbox receive-alpha-data
      uses. Only alpha-data-*.json manifests and their archives are this
      script's; anything else there is left alone.
    - Every archive is checked before anything is applied: present, the right
      size, the right SHA-256, and nothing in it outside memory\ (in format 2,
      every name in the manifest: no drive, no "..", no backslash).
    - **Nothing is applied under a running Alpha.** While the backend answers
      here, a package is held, and the data-apply job (-ApplyHeld) applies it:
      it stops the backend, applies, and starts it again.
    - Applying never deletes. A file is written only when the incoming one is
      newer, and the one it replaces is kept under data-sync\replaced\<time>\.
      A file newer here is kept and counted as a conflict. Times are carried
      across, so a copy never looks newer than its original.

  Two things keep a send from holding up whoever runs it:
    - The peer is asked of `tailscale status` first. A peer that is offline or
      not on this tailnet is reported at once, and nothing is packed: on
      2026-10-09 a send to a machine that had gone dark held Worker1's
      autopilot pass, and its live page, until the job's time ran out.
    - -MaxBytes caps one pass, and a backlog over it goes in parts: the oldest
      files first, up to the cap, and the next pass carries on from the last
      one sent. A full copy (an old -Since) is gigabytes, and Taildrop between
      these machines ran at a few hundred KB/s on 2026-10-09: sent whole, it
      would hold the autopilot pass, and its 5-minute live page, for hours.
      In parts, each pass stays a few minutes and the copy streams across.

  A file is copied for packing under a short folder (-StageRoot, by default
  `ds` beside -OpsDir: C:\AlphaData\ds). On 2026-10-09 the copy went under
  alpha-ops\data-sync\outbox-<time>\staging\, 20 characters longer than
  Worker1's own Alpha folder. A 254-character path in memory\ came out at 274,
  over Windows' 260, so Copy-Item failed. The script then counted the file as
  sent anyway, and it would never have gone. Now:
    - a file that cannot be packed is reported, never counted as sent, and goes
      again with the next pass;
    - a folder that cannot be read is reported, not walked past in silence;
    - a file that cannot be written on the receiving side is reported, and its
      package is kept and applied again next pass.
  -Resend forgets what was sent, so everything after -Since goes again. That
  is how files the old script counted as sent, but never packed, get sent.

  Exit codes: 0 done (including "nothing to do", and one part of a backlog
  sent); 1 a send or an apply failed or was refused, or a file could not be
  packed or written; 3 a package is held, or still arriving.

  -TestCopyFails is a test seam: a copy to a path matching it fails, as a
  path over 260 characters does on Windows.
#>
param(
  [string]$OpsDir = 'C:\AlphaData\alpha-ops',
  [string]$AlphaRoot = 'C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software',
  [string]$Peer = '',
  [string]$Inbox = 'C:\AlphaData\alpha-move\inbox',
  [string]$HealthUrl = 'http://127.0.0.1:8001/health',
  [string]$Since = '',
  [int64]$MaxBytes = 0,
  [string]$StageRoot = '',
  [switch]$Resend,
  [switch]$NoSend,
  [switch]$NoReceive,
  [switch]$ApplyHeld,
  [switch]$NoFetch,
  [string]$TestCopyFails = ''
)

$ErrorActionPreference = 'Continue'
function Say([string]$t) { Write-Output $t }
$machine = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { [Environment]::MachineName }
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$dir = Join-Path $OpsDir 'data-sync'
$stateFile = Join-Path $dir 'state.json'
$indexFile = Join-Path $dir 'received.json'
$sentFile = Join-Path $dir 'sent.json'
$pendingFile = Join-Path $dir 'pending.json'
if (-not $StageRoot) { $StageRoot = Join-Path (Split-Path -Parent $OpsDir) 'ds' }
$tar =if (Get-Command tar.exe -EA SilentlyContinue) { 'tar.exe' } else { 'tar' }
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

# UTF-8 both ways: Windows PowerShell reads a file with no BOM as ANSI, and a
# memory\ path with a character outside it would come back as another name.
function Load-Json([string]$f) { if (Test-Path -LiteralPath $f) { try { return Get-Content -LiteralPath $f -Raw -Encoding UTF8 | ConvertFrom-Json } catch { } }; return $null }
function Save-Json([string]$f, $v) {
  [IO.File]::WriteAllText("$f.tmp", ($v | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding $false))
  Move-Item -LiteralPath "$f.tmp" -Destination $f -Force
}
function Iso([int64]$ticks) { if ($ticks) { return ([datetime]::new($ticks, [DateTimeKind]::Utc)).ToString('yyyy-MM-ddTHH:mm:ssZ') }; return 'never' }
function Serving {
  try { return [int](Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 5 -EA Stop).StatusCode -eq 200 } catch { return $false }
}
# Every file under memory\, relative with forward slashes, never through a
# junction (memory\local\books points at another drive). A folder it cannot
# read (on Windows, one whose path is too long) goes in $script:unreadable,
# so the caller can say so instead of leaving out its files in silence.
function Walk([string]$root) {
  $script:unreadable = New-Object System.Collections.ArrayList
  $out = New-Object System.Collections.ArrayList
  if (-not (Test-Path -LiteralPath $root)) { return $out }
  $stack = New-Object System.Collections.Stack
  $stack.Push($root)
  while ($stack.Count) {
    $d = $stack.Pop()
    $files = @(); $dirs = @()
    try { $files = [IO.Directory]::GetFiles($d); $dirs = [IO.Directory]::GetDirectories($d) } catch { [void]$script:unreadable.Add($d) }
    foreach ($f in $files) { [void]$out.Add($f) }
    foreach ($s in $dirs) {
      try { if (([IO.File]::GetAttributes($s) -band [IO.FileAttributes]::ReparsePoint) -eq 0) { $stack.Push($s) } }
      catch { [void]$script:unreadable.Add($s) }
    }
  }
  return $out
}
function Size-Of($list) { $n = [int64]0; foreach ($f in @($list)) { if ($f) { try { $n += (New-Object IO.FileInfo $f).Length } catch { } } }; return $n }
function Short([string]$t) { if ($t.Length -gt 120) { return $t.Substring(0, 117) + '...' }; return $t }
# online, offline, absent (not on this tailnet) or unknown (no answer from tailscale)
function Peer-State([string]$name) {
  $st = $null
  try { $st = ((& tailscale status --json 2>$null) -join "`n") | ConvertFrom-Json } catch { return 'unknown' }
  if (-not $st -or -not $st.Peer) { return 'unknown' }
  $hit = @($st.Peer.PSObject.Properties | ForEach-Object { $_.Value } | Where-Object {
      ([string]$_.HostName -ieq $name) -or ((([string]$_.DNSName) -split '\.')[0] -ieq $name) }) | Select-Object -First 1
  if (-not $hit) { return 'absent' }
  if ($hit.Online) { return 'online' }
  return 'offline'
}
function Rel([string]$base, [string]$full) { return ('memory/' + $full.Substring($base.Length).TrimStart('\', '/')) -replace '\\', '/' }
# Throws when it cannot copy, so no caller counts a file that did not arrive.
# -Force everywhere: without it Get-Item does not see a hidden file (a .git
# file in memory\local\autonomy-sandboxes). $ticks, when given, is the time
# the file had where it was written.
function Copy-Keeping([string]$src, [string]$dst, [int64]$ticks = 0) {
  if ($TestCopyFails -and ($dst -replace '\\', '/') -match $TestCopyFails) { throw "could not copy to $dst (-TestCopyFails)" }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) -EA Stop | Out-Null
  Copy-Item -LiteralPath $src -Destination $dst -Force -EA Stop
  $when = if ($ticks) { [datetime]::new($ticks, [DateTimeKind]::Utc) } else { (Get-Item -LiteralPath $src -Force -EA Stop).LastWriteTimeUtc }
  (Get-Item -LiteralPath $dst -Force -EA Stop).LastWriteTimeUtc = $when
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
    # Format 2 packs numbered files (f/0000000) and names them in the manifest;
    # an older package holds memory\ itself. Either way nothing may land
    # outside memory\: no absolute path, no drive, no "..", no backslash.
    $entries = @()
    if ([int]$man.format -eq 2) {
      $entries = @($man.entries)
      $names = @($listing | Where-Object { $_ -notmatch '^f/?$' })
      $unsafe = @($names | Where-Object { $_ -notmatch '^f/\d+$' }) + @($entries | Where-Object { [string]$_.p -notmatch '^memory/[^/]' -or [string]$_.p -match '\\|:|(^|/)\.\.?(/|$)' })
      if ($names.Count -ne $entries.Count -and -not $unsafe.Count) { Say "  REFUSED: $tarName holds $($names.Count) file(s) and its manifest names $($entries.Count); nothing applied"; $exit = 1; continue }
    } else {
      $unsafe = @($listing | Where-Object { $_ -match '^(/|[A-Za-z]:)|(^|/)\.\.(/|$)' -or $_ -notmatch '^memory(/|$)' })
    }
    if (-not $listing.Count -or $unsafe.Count) { Say "  REFUSED: $tarName holds paths outside memory\ ($($unsafe.Count)); nothing applied"; $exit = 1; continue }
    if ($serving -and -not $ApplyHeld) { $held++; Say "  HELD: $tarName from $($man.from) ($($man.files) file(s)): Alpha serves here, so it waits for the data-apply job"; continue }
    if ($serving -and $ApplyHeld -and -not $stopped) { Stop-Backend; $stopped = $true; Say '  stopped the backend to apply' }

    # Unpacked under the short root, not beside the inbox: see -StageRoot.
    $staging = Join-Path $StageRoot 'i'
    Remove-Item -LiteralPath $staging -Recurse -Force -EA SilentlyContinue
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    $out = & $tar -xf $tarFile -C $staging 2>&1
    if ($LASTEXITCODE -ne 0) { Say "  FAILED: extracting $tarName"; Remove-Item -LiteralPath $staging -Recurse -Force -EA SilentlyContinue; $exit = 1; continue }
    $base = Join-Path $staging 'memory'
    if ([int]$man.format -eq 2) {
      $script:unreadable = New-Object System.Collections.ArrayList
      $items = @(for ($i = 0; $i -lt $entries.Count; $i++) {
          [pscustomobject]@{ src = (Join-Path (Join-Path $staging 'f') $i.ToString('D7')); rel = [string]$entries[$i].p; ticks = [int64]$entries[$i].t } })
    } else {
      $items = @(Walk $base | ForEach-Object { [pscustomobject]@{ src = $_; rel = (Rel $base $_); ticks = [int64]0 } })
    }
    $applied = 0; $same = 0; $conflicts = 0; $replaced = 0; $notWritten = 0; $why = ''
    foreach ($it in $items) {
      $src = $it.src; $rel = $it.rel
      $dst = Join-Path $alphaHome ($rel -replace '/', '\')
      try {
        $srcTicks = if ($it.ticks) { $it.ticks } else { (Get-Item -LiteralPath $src -Force -EA Stop).LastWriteTimeUtc.Ticks }
        if (Test-Path -LiteralPath $dst) {
          $d = Get-Item -LiteralPath $dst -Force -EA Stop
          if ($d.LastWriteTimeUtc.Ticks -eq $srcTicks -and $d.Length -eq (Get-Item -LiteralPath $src -Force -EA Stop).Length) { $same++; $received[$rel] = $srcTicks; continue }
          if ($d.LastWriteTimeUtc.Ticks -gt $srcTicks) { $conflicts++; continue }
          # The file it replaces is kept first, or it is not replaced at all.
          Copy-Keeping $dst (Join-Path (Join-Path $dir "replaced\$stamp") ($rel -replace '/', '\'))
          $replaced++
        }
        Copy-Keeping $src $dst $srcTicks
        $received[$rel] = $srcTicks
        $applied++
      } catch { $notWritten++; if (-not $why) { $why = Short "${rel}: $($_.Exception.Message)" } }
    }
    $unread = $script:unreadable.Count
    Remove-Item -LiteralPath $staging -Recurse -Force -EA SilentlyContinue
    $state | Add-Member -Force -NotePropertyName lastApply -NotePropertyValue ([ordered]@{ at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); from = [string]$man.from; files = $applied; unchanged = $same; replaced = $replaced; keptNewerHere = $conflicts; notWritten = $notWritten })
    Say ("  APPLIED {0} from {1}: {2} file(s) written ({3} replaced, kept under data-sync\replaced\{4}), {5} already the same, {6} newer here and kept" -f $tarName, $man.from, $applied, $replaced, $stamp, $same, $conflicts)
    # A package with a file that did not land stays, and is applied again next
    # pass: what did land then reads as already the same.
    if ($notWritten -or $unread) {
      if ($unread) { $why = Short ("a folder in it could not be read: " + (Rel $base $script:unreadable[0])) }
      Say ("  FAILED: {0} file(s) and {1} folder(s) from {2} could not be written here (first: {3}); the package is kept and applied again next pass" -f $notWritten, $unread, $tarName, $why)
      $exit = 1
    } else {
      Remove-Item -LiteralPath $tarFile, $m.FullName -Force -EA SilentlyContinue
    }
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
    if ($Resend) {
      $sentIdx = @{}; Save-Json $sentFile $sentIdx; Save-Json $pendingFile @{}
      Say "  -Resend: what was sent before is forgotten, so everything written here after $(Iso $since) goes again"
    }
    # What an earlier pass could not pack, by its time then.
    $pend = @{}
    $pidx = Load-Json $pendingFile
    if ($pidx) { foreach ($p in $pidx.PSObject.Properties) { $pend[$p.Name] = [int64]$p.Value } }
    $files = @(Walk $mem)
    $unread = @($script:unreadable)
    $changed = @($files | Where-Object {
        $t = [IO.File]::GetLastWriteTimeUtc($_).Ticks
        $r = Rel $mem $_
        $t -gt $since -and $r -notmatch $skip -and -not ($received.ContainsKey($r) -and $received[$r] -eq $t) -and -not ($sentIdx.ContainsKey($r) -and $sentIdx[$r] -eq $t)
      })
    # It rides with this pass whatever its time: the last send moved past it.
    $riders = @(if ($pend.Count) {
        $files | Where-Object {
          $t = [IO.File]::GetLastWriteTimeUtc($_).Ticks
          $r = Rel $mem $_
          $pend.ContainsKey($r) -and $t -le $since -and -not ($sentIdx.ContainsKey($r) -and $sentIdx[$r] -eq $t)
        }
      })
    if ($unread.Count) {
      Say ("  SKIPPED: {0} folder(s) under memory\ could not be read (a path too long?), so nothing in them is sent (first: {1})" -f $unread.Count, (Short (Rel $mem $unread[0])))
    }
    $any = $changed.Count + $riders.Count
    if (-not $any) {
      Say "  nothing written here since $(Iso $since)"
      $state.lastSentTicks = $passStart
    } else {
      $bytes = Size-Of ($changed + $riders)
      $peerState = Peer-State $Peer
    }
    if ($any -and $peerState -in @('offline', 'absent')) {
      Say ("  NOT SENT: {0} is {1} ({2}); {3} file(s), {4:N1} MB wait for it (nothing is lost: the next send starts from {5})" -f $Peer,
        $(if ($peerState -eq 'absent') { 'not on this tailnet' } else { 'offline' }), 'tailscale status', $any, ($bytes / 1MB), (Iso $since))
      $exit = 1
    } elseif ($any) {
      # Over the cap: the oldest first, up to it (at least one file), and every
      # file stamped the same as the last one taken, so the next pass can carry
      # on from that time without skipping any.
      $cutoff = $passStart
      $left = New-Object System.Collections.ArrayList
      $leftBytes = [int64]0
      if ($MaxBytes -gt 0 -and (Size-Of $changed) -gt $MaxBytes) {
        $sorted = @($changed | Sort-Object { [IO.File]::GetLastWriteTimeUtc($_).Ticks })
        $take = New-Object System.Collections.ArrayList
        $sum = [int64]0
        foreach ($f in $sorted) {
          $len = Size-Of @($f)
          if ($take.Count -and ($sum + $len) -gt $MaxBytes) { break }
          [void]$take.Add($f); $sum += $len
        }
        $cutoff = [IO.File]::GetLastWriteTimeUtc($take[$take.Count - 1]).Ticks
        # (A range in PowerShell counts down when it can: 1..0 is two items.)
        if ($take.Count -lt $sorted.Count) {
          foreach ($f in $sorted[$take.Count..($sorted.Count - 1)]) {
            if ([IO.File]::GetLastWriteTimeUtc($f).Ticks -eq $cutoff) { [void]$take.Add($f) } else { [void]$left.Add($f); $leftBytes += Size-Of @($f) }
          }
        }
        $changed = @($take)
      }
      # Riders are capped the same way, so a pile of them cannot make a pass
      # of hours either; the rest stay pending for the passes after.
      if ($MaxBytes -gt 0 -and (Size-Of $riders) -gt $MaxBytes) {
        $rs = New-Object System.Collections.ArrayList
        $sum = [int64]0
        foreach ($f in @($riders | Sort-Object { [IO.File]::GetLastWriteTimeUtc($_).Ticks })) {
          $len = Size-Of @($f)
          if ($rs.Count -and ($sum + $len) -gt $MaxBytes) { break }
          [void]$rs.Add($f); $sum += $len
        }
        $riders = @($rs)
      }
      $send = @($changed) + @($riders)
      # Format 2: each file is packed as f/0000000, f/0000001, ... and the
      # manifest names it (its memory\ path and its time, to the tick). The
      # archive then holds nothing tar can stumble on: on 2026-10-09 Windows'
      # tar.exe failed on a part holding PDFs named in Chinese, and a 254-
      # character path came out at 274 when copied under alpha-ops. The copy is
      # .NET's, which sees hidden files (a .git file) like any other. A file
      # that cannot be copied is left out of the package, by name.
      $stage = Join-Path $StageRoot 'o'
      Remove-Item -LiteralPath $stage -Recurse -Force -EA SilentlyContinue
      $fdir = [IO.Directory]::CreateDirectory((Join-Path $stage 'f')).FullName
      $packed = New-Object System.Collections.ArrayList
      $failed = New-Object System.Collections.ArrayList
      $entries = New-Object System.Collections.ArrayList
      $why = ''
      foreach ($f in $send) {
        try {
          if ($TestCopyFails -and ($f -replace '\\', '/') -match $TestCopyFails) { throw "could not copy $f (-TestCopyFails)" }
          $t = [IO.File]::GetLastWriteTimeUtc($f).Ticks
          [IO.File]::Copy($f, [IO.Path]::Combine($fdir, $packed.Count.ToString('D7')), $true)
          [void]$entries.Add([ordered]@{ p = (Rel $mem $f); t = $t })
          [void]$packed.Add($f)
        } catch { [void]$failed.Add($f); if (-not $why) { $why = Short "$(Rel $mem $f): $($_.Exception.Message)" } }
      }
      $bytes = Size-Of $packed
      $sent = $false
      if ($packed.Count) {
        $out = Join-Path $dir "outbox-$stamp"
        New-Item -ItemType Directory -Force -Path $out | Out-Null
        $tarName = "alpha-data-$($machine.ToLower())-$stamp.tar"
        $tarFile = Join-Path $out $tarName
        $tarOut = & $tar -cf $tarFile -C $stage f 2>&1
        $tarCode = $LASTEXITCODE
        if ($tarCode -ne 0) {
          # Every line it said, not the last: on 2026-10-09 the last was empty.
          $said = @(@($tarOut) | ForEach-Object { "$_".Trim() } | Where-Object { $_ }) -join ' / '
          Say ("  FAILED: packing (tar exit {0}): {1}" -f $tarCode, $(if ($said) { Short $said } else { 'it said nothing' }))
        } else {
          $manifest = Join-Path $out "alpha-data-$($machine.ToLower())-$stamp.json"
          Save-Json $manifest ([ordered]@{ kind = 'memory-changes'; format = 2; from = $machine; at = (Iso $passStart); since = (Iso $since); files = $packed.Count; bytes = $bytes
              archive = [ordered]@{ name = $tarName; bytes = (Get-Item -LiteralPath $tarFile).Length; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $tarFile).Hash.ToLower() }
              entries = @($entries) })
          try { $r = & tailscale file cp $tarFile $manifest "$($Peer):" 2>&1; $sent = ($LASTEXITCODE -eq 0); if (-not $sent) { Say "  taildrop: $((@($r) | Select-Object -Last 1))" } }
          catch { Say "  taildrop: $($_.Exception.Message)" }
        }
        Remove-Item -LiteralPath $out -Recurse -Force -EA SilentlyContinue
      }
      Remove-Item -LiteralPath $stage -Recurse -Force -EA SilentlyContinue
      # Only what went is counted as sent. What could not be packed is pending
      # and rides with the next pass, so the send moves on without losing it.
      # A send Taildrop did not take changes nothing: all of it goes again.
      if ($sent -or -not $packed.Count) {
        if ($sent) { foreach ($f in $packed) { $r = Rel $mem $f; $sentIdx[$r] = [IO.File]::GetLastWriteTimeUtc($f).Ticks; $pend.Remove($r) } }
        foreach ($f in $failed) { $pend[(Rel $mem $f)] = [IO.File]::GetLastWriteTimeUtc($f).Ticks }
        foreach ($k in @($pend.Keys)) { if (-not (Test-Path -LiteralPath (Join-Path $alphaHome ($k -replace '/', '\')))) { $pend.Remove($k) } }
        Save-Json $sentFile $sentIdx
        Save-Json $pendingFile $pend
        $state.lastSentTicks = $cutoff
      }
      if ($sent) {
        $state | Add-Member -Force -NotePropertyName lastSend -NotePropertyValue ([ordered]@{ at = (Iso $passStart); to = $Peer; files = $packed.Count; bytes = $bytes; leftFiles = $left.Count; leftBytes = $leftBytes; notPacked = $pend.Count })
        Say ("  SENT {0} file(s), {1:N1} MB written since {2}, to {3}" -f $packed.Count, ($bytes / 1MB), (Iso $since), $Peer)
        $ridden = @($riders | Where-Object { $packed -contains $_ }).Count
        if ($ridden) { Say ("  with {0} file(s) an earlier pass could not pack" -f $ridden) }
        if ($left.Count) { Say ("  PART of a backlog: {0} file(s), {1:N1} MB still to send, from {2}; the next pass carries on" -f $left.Count, ($leftBytes / 1MB), (Iso $cutoff)) }
        if ($failed.Count) { Say ("  NOT IN THIS PART: {0} file(s) could not be packed, and go with the next pass (first: {1})" -f $failed.Count, $why); $exit = 1 }
      } elseif ($packed.Count) {
        Say "  NOT SENT: $($send.Count) file(s) wait for the next pass (nothing is lost: the next send starts from $(Iso $since))"
        $exit = 1
      } else {
        Say ("  NOT SENT: none of {0} file(s) could be packed, and they go with the next pass (first: {1})" -f $send.Count, $why)
        $exit = 1
      }
    }
  }
}

Save-Json $stateFile $state
exit $exit

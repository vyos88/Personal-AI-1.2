<#
.SYNOPSIS
  Stops a leftover `vite preview` tree that does not serve Alpha's site, and
  never the one that does.

.DESCRIPTION
  fleet-inventory on Worker1 has reported `DUPLICATES: Alpha site x2` since
  2026-10-07 02:54 UTC: the `Alpha` task's restart at 02:31 started a new
  preview tree, which holds 4173, and left the one from before running (pid
  6508). Nothing serves from it; it holds memory on a laptop that was down to
  1 GB free. HANDOFF_2026-10-07b section 5 asked a session at the laptop to
  stop it, and none came. This does exactly that step, by rule:

    1. Whatever listens on the site's port (4173) is the live site. If nothing
       does, or it is not a vite process, nothing is stopped: there is no way
       to tell the live tree from a leftover.
    2. A tree is a `vite` process with every vite process under it (`cmd /c
       vite preview` runs node under cmd, and both match). The live tree is
       the one whose root is the listener or one of its ancestors.
    3. Every other tree whose command says `preview` is stopped with its
       children (taskkill /T). A `vite` dev server is reported and left alone:
       a person may be working with it.
    4. Afterwards the site must still answer on 4173 from the same listener,
       or the exit code is 1.

  Takes no arguments from the autopilot ({"do":"stop-stray-site"}).
  -ProcessesJson and -Holders give it a process list and the listener instead
  of reading the machine; with them it prints its plan as JSON and stops
  nothing. The tests use that.
#>
param(
  [int]$Port = 4173,
  [string]$ProcessesJson,
  [int[]]$Holders
)

$ErrorActionPreference = 'SilentlyContinue'
$siteRe = 'vite(\.js)?["'' ]+preview|vite[\\/]bin'
$npmRe = '(?i)npm(-cli\.js|\.cmd)?["'' ]+run["'' ]+preview\b'

function Get-StrayPlan($procs, $holders) {
  $byPid = @{}
  foreach ($p in $procs) { $byPid[[int]$p.pid] = $p }
  $isSite = @{}
  foreach ($p in $procs) { if ("$($p.cmd)" -match $siteRe) { $isSite[[int]$p.pid] = $true } }
  $plan = [ordered]@{ ok = $false; reason = $null; live = @(); stop = @(); leave = @() }
  $holders = @($holders | Where-Object { $_ })
  if (-not $holders.Count) { $plan.reason = "nothing listens on ${Port}: cannot tell the live site from a leftover, so nothing is stopped"; return $plan }

  # The listener and everything above it belong to the live site.
  $liveSet = @{}
  foreach ($h in $holders) {
    $cur = [int]$h; $guard = 0
    while ($byPid.ContainsKey($cur) -and -not $liveSet.ContainsKey($cur) -and $guard -lt 64) {
      $liveSet[$cur] = $true
      $cur = [int]$byPid[$cur].parent; $guard++
    }
  }
  $siteHolders = @($holders | Where-Object { $isSite.ContainsKey([int]$_) })
  if (-not $siteHolders.Count) {
    $names = ($holders | ForEach-Object { if ($byPid.ContainsKey([int]$_)) { "$($byPid[[int]$_].name) $_" } else { "pid $_" } }) -join ', '
    $plan.reason = "$Port is held by $names, not a vite process: nothing is stopped"
    return $plan
  }

  # Roots: vite processes whose parent is not a vite process.
  $roots = @($procs | Where-Object { $isSite.ContainsKey([int]$_.pid) -and -not $isSite.ContainsKey([int]$_.parent) })
  foreach ($r in $roots) {
    # The whole tree, so a `preview` anywhere in it counts and its size is known.
    $tree = New-Object System.Collections.ArrayList
    $todo = New-Object System.Collections.Queue
    $todo.Enqueue([int]$r.pid)
    while ($todo.Count -and $tree.Count -lt 256) {
      $id = $todo.Dequeue()
      if ($tree -contains $id) { continue }
      [void]$tree.Add($id)
      foreach ($c in $procs) { if ([int]$c.parent -eq $id -and [int]$c.pid -ne $id) { $todo.Enqueue([int]$c.pid) } }
    }
    $mb = 0; foreach ($id in $tree) { if ($byPid.ContainsKey($id)) { $mb += [int]$byPid[$id].mb } }
    $entry = [ordered]@{ pid = [int]$r.pid; processes = $tree.Count; mb = $mb; cmd = "$($r.cmd)"; pids = @($tree) }
    $isLive = $liveSet.ContainsKey([int]$r.pid) -or @($tree | Where-Object { $liveSet.ContainsKey($_) }).Count
    if ($isLive) { $plan.live += $entry; continue }
    $preview = @($tree | Where-Object { $byPid.ContainsKey($_) -and "$($byPid[$_].cmd)" -match '(?i)\bpreview\b' }).Count
    if (-not $preview) { $plan.leave += $entry; continue }
    # `npm run preview` above it would only wait on a dead child: take it too.
    $top = [int]$r.pid; $guard = 0
    while ($byPid.ContainsKey([int]$byPid[$top].parent) -and $guard -lt 8) {
      $up = $byPid[[int]$byPid[$top].parent]
      if ($liveSet.ContainsKey([int]$up.pid) -or "$($up.cmd)" -notmatch $npmRe) { break }
      $top = [int]$up.pid; $guard++
    }
    $entry.pid = $top
    $plan.stop += $entry
  }
  if (-not $plan.live.Count) { $plan.reason = "no vite tree contains the listener on ${Port}: nothing is stopped"; $plan.stop = @(); return $plan }
  $plan.ok = $true
  $plan
}

function Cut([string]$text, [int]$max = 90) {
  $t = ($text -replace '\s+', ' ').Trim()
  if ($t.Length -gt $max) { $t = $t.Substring(0, $max) + '...' }
  $t
}

# The end of a command line is the part that says what it is: the start is a
# long node_modules path, and cutting there hid what pid 6508 was running
# (Worker1, 2026-10-07: "node ...\node_modules\.bin\\..." and nothing more).
function Tail([string]$text, [int]$max = 160) {
  $t = ($text -replace '(?i)(--?(token|key|password|secret|api-?key)[= ]+)\S+', '$1...' -replace '\s+', ' ').Trim()
  if ($t.Length -gt $max) { $t = '...' + $t.Substring($t.Length - $max) }
  $t
}

if ($ProcessesJson) {
  $procs = @(Get-Content -LiteralPath $ProcessesJson -Raw | ConvertFrom-Json)
  ConvertTo-Json -InputObject (Get-StrayPlan $procs @($Holders)) -Depth 5 -Compress
  exit 0
}

$machine = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { [Environment]::MachineName }
Write-Output ("STOP STRAY SITE {0} {1}" -f $machine, (Get-Date).ToString('yyyy-MM-dd HH:mm'))
$procs = @(Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; name = $_.Name; cmd = "$($_.CommandLine)"; mb = [math]::Round($_.WorkingSetSize / 1MB); started = $_.CreationDate } })
$listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen | ForEach-Object { [int]$_.OwningProcess } | Select-Object -Unique)
$plan = Get-StrayPlan $procs $listeners
foreach ($t in $plan.live) { Write-Output ("live : tree {0} ({1} processes, {2} MB) holds {3}: {4}" -f $t.pid, $t.processes, $t.mb, $Port, (Cut $t.cmd)) }
foreach ($t in $plan.leave) {
  Write-Output ("leave: tree {0} ({1} MB) is not a preview server, left alone. What it is:" -f $t.pid, $t.mb)
  foreach ($id in @($t.pids | Select-Object -First 6)) {
    $p = $procs | Where-Object { $_.pid -eq $id } | Select-Object -First 1
    if (-not $p) { continue }
    $held = @(Get-NetTCPConnection -OwningProcess $id -State Listen | ForEach-Object { $_.LocalPort } | Select-Object -Unique)
    $since = if ($p.started) { ([datetime]$p.started).ToString('MM-dd HH:mm') } else { '?' }
    Write-Output ("       pid {0} {1}, started {2}, listening on {3}: {4}" -f $id, $p.name, $since, $(if ($held.Count) { $held -join ', ' } else { 'nothing' }), (Tail $p.cmd))
  }
}
if (-not $plan.ok) { Write-Output "STOPPED NOTHING: $($plan.reason)"; exit 1 }
if (-not $plan.stop.Count) { Write-Output "nothing to stop: one preview tree, and it is the live one"; exit 0 }

foreach ($t in $plan.stop) {
  $held = @(Get-NetTCPConnection -OwningProcess $t.pid -State Listen | ForEach-Object { $_.LocalPort } | Select-Object -Unique)
  $ports = if ($held.Count) { "listening on $($held -join ', ')" } else { 'listening on nothing' }
  taskkill.exe /T /F /PID $t.pid 2>&1 | Out-Null
  $gone = -not (Get-Process -Id $t.pid)
  Write-Output ("stop : tree {0} ({1} processes, {2} MB, {3}) {4}: {5}" -f $t.pid, $t.processes, $t.mb, $ports, $(if ($gone) { 'stopped' } else { 'STILL RUNNING' }), (Cut $t.cmd))
}

# The live site must be untouched: same listener, and it answers.
Start-Sleep -Seconds 2
$after = @(Get-NetTCPConnection -LocalPort $Port -State Listen | ForEach-Object { [int]$_.OwningProcess } | Select-Object -Unique)
$same = $after.Count -and -not @($after | Where-Object { $listeners -notcontains $_ }).Count
$code = ''
foreach ($scheme in 'https', 'http') { if (-not $code -or $code -eq '000') { $code = (& curl.exe -s -k -o NUL -w '%{http_code}' --max-time 10 "${scheme}://127.0.0.1:$Port/" 2>$null | Out-String).Trim() } }
Write-Output ("site : {0} on {1}, held by pid {2}{3}" -f $(if ($code -match '^[23]') { "answers $code" } else { "NOT answering ($code)" }), $Port, ($after -join ', '), $(if ($same) { ' (unchanged)' } else { ' (CHANGED)' }))
if ($code -match '^[23]' -and $same) { exit 0 }
exit 1

<#
.SYNOPSIS
  One read-only inventory of everything Alpha runs on this machine: scheduled
  tasks, services, background processes by role, listening ports, and Alpha's
  Agent Manager snapshot. Duplicates are flagged.

.DESCRIPTION
  The owner asked (2026-10-07) for "one recipe from all" agents and workers,
  then to stop the ones not needed. Nothing listed the whole of it in one
  place: the doctor cannot read the coordinator's agents without a login, and
  scheduled tasks, stewards and bridges were each in a different log. This is
  that list, short enough for the autopilot report (its last 60 lines), so a
  session or Alpha can decide what to stop from evidence.

  It changes nothing. It starts, stops and writes nothing; command lines are
  cut to 100 characters and anything after a flag that names a key, token,
  password or secret is masked (the autopilot redacts again before pushing).

  Run by the autopilot ({"do":"fleet-inventory"}), or by hand.
#>
param(
  [string]$AlphaRoot = 'C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software'
)

$ErrorActionPreference = 'SilentlyContinue'
$lines = New-Object System.Collections.ArrayList
function Say([string]$text) { [void]$lines.Add($text) }
function Cut([string]$text, [int]$max = 100) {
  if (-not $text) { return '' }
  $t = $text -replace '(?i)(--?(token|key|password|secret|api-?key)[= ]+)\S+', '$1...'
  $t = $t -replace '\s+', ' '
  if ($t.Length -gt $max) { $t = $t.Substring(0, $max) + '...' }
  $t
}

$machine = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { [Environment]::MachineName }
Say ("FLEET INVENTORY {0} {1}" -f $machine, (Get-Date).ToString('yyyy-MM-dd HH:mm'))

# ---------------------------------------------------------------- tasks
$interesting = '(?i)alpha|comfy|cloudflare|ollama|claude|codex|steward|agent|music|image|peer|doctor|autopilot|self-?heal|standby|watchdog|coordinator|tunnel|vyos|panel|deck'
if (Get-Command Get-ScheduledTask -EA SilentlyContinue) {
  $all = @(Get-ScheduledTask | Where-Object { $_.TaskPath -notlike '\Microsoft*' -and $_.TaskName -match $interesting } | Sort-Object TaskName)
  $tasks = @($all | Where-Object { "$($_.State)" -ne 'Disabled' })
  $off = @($all | Where-Object { "$($_.State)" -eq 'Disabled' })
  Say ("TASKS ({0} enabled, {1} disabled): name | state | last run | result | next | runs" -f $tasks.Count, $off.Count)
  $shown = 0
  foreach ($t in $tasks) {
    if ($shown -ge 22) { Say ("  ... {0} more task(s)" -f ($tasks.Count - $shown)); break }
    $info = $t | Get-ScheduledTaskInfo
    $act = @($t.Actions)[0]
    $runs = if ($act) { Cut ("{0} {1}" -f (Split-Path -Leaf $act.Execute), $act.Arguments) 70 } else { '' }
    $last = if ($info.LastRunTime -and $info.LastRunTime.Year -gt 2000) { $info.LastRunTime.ToString('MM-dd HH:mm') } else { 'never' }
    $next = if ($info.NextRunTime -and $info.NextRunTime.Year -gt 2000) { $info.NextRunTime.ToString('MM-dd HH:mm') } else { '-' }
    Say ("  {0} | {1} | {2} | 0x{3:X} | {4} | {5}" -f $t.TaskName, $t.State, $last, [int64]$info.LastTaskResult, $next, $runs)
    $shown++
  }
  if ($off.Count) { Say (Cut ('  disabled: ' + (($off | ForEach-Object { $_.TaskName -replace '^Alpha ', '' }) -join ', ')) 400) }
} else { Say 'TASKS: Get-ScheduledTask is not available here' }

# ---------------------------------------------------------------- services
$services = @(Get-Service -EA SilentlyContinue | Where-Object { $_.Name -match '(?i)alpha|cloudflare|ollama|comfy|tunnel' })
if ($services.Count) {
  Say ('SERVICES: ' + (($services | ForEach-Object { "{0}={1}/{2}" -f $_.Name, $_.Status, $_.StartType }) -join '; '))
} else { Say 'SERVICES: none named like Alpha, cloudflared, Ollama or ComfyUI' }

# ---------------------------------------------------------------- processes
$roles = @(
  @{ role = 'coordinator';        match = 'src[\\/]host[\\/]index\.js';         single = $true },
  @{ role = 'standby';            match = 'standby-alpha\.mjs';                 single = $false },
  @{ role = 'tunnel agent';       match = 'src[\\/]agent[\\/]index\.js';        single = $true },
  @{ role = 'agent keeper';       match = 'keep-agent\.mjs';                    single = $true },
  @{ role = 'music bridge';       match = 'music-bridge\.mjs';                  single = $true },
  @{ role = 'image bridge';       match = 'image-bridge\.mjs';                  single = $true },
  @{ role = 'watchdog';           match = 'watchdog\.mjs';                      single = $true },
  @{ role = 'self-heal';          match = 'alpha-selfheal\.mjs';                single = $true },
  @{ role = 'Alpha backend';      match = 'backend[\\/]main\.py|uvicorn.*main:app'; single = $true },
  @{ role = 'Alpha site';         match = 'vite(\.js)?["'' ]+preview|vite[\\/]bin';  single = $true },
  @{ role = 'ComfyUI';            match = 'ComfyUI[\\/]main\.py';               single = $true },
  @{ role = 'cloudflared';        match = 'cloudflared';                        single = $true },
  @{ role = 'llama-server';       match = 'llama-server';                       single = $false },
  @{ role = 'ollama';             match = '(?i)ollama';                         single = $false },
  @{ role = 'claude';             match = '(?i)[\\/]claude(\.exe)?["'' ]|^claude';  single = $false },
  @{ role = 'codex';              match = '(?i)codex';                          single = $false }
)
$procs = @()
if (Get-Command Get-CimInstance -EA SilentlyContinue) {
  $procs = @(Get-CimInstance Win32_Process -EA SilentlyContinue | ForEach-Object {
    [pscustomobject]@{ pid = $_.ProcessId; parent = $_.ParentProcessId; name = $_.Name; cmd = "$($_.CommandLine)"; mb = [math]::Round($_.WorkingSetSize / 1MB) } })
} else {
  $procs = @(Get-Process | ForEach-Object {
    [pscustomobject]@{ pid = $_.Id; parent = $null; name = $_.ProcessName; cmd = "$($_.CommandLine)"; mb = [math]::Round($_.WorkingSet64 / 1MB) } })
}
$groups = [ordered]@{}
foreach ($p in $procs) {
  if ($p.pid -eq $PID) { continue }
  # The script a node or python process runs decides its role; its other
  # arguments can name another script (the records standby is started with
  # the agent's entry point as an argument, and read as a second agent).
  $script = if ($p.cmd -match '(?i)([^\s"]+\.(m?js|cjs|py))\b') { $Matches[1] } else { '' }
  $role = $null
  if ($script) { foreach ($r in $roles) { if ($script -match $r.match) { $role = $r.role; break } } }
  if (-not $role) { $hay = "$($p.name) $($p.cmd)"; foreach ($r in $roles) { if ($hay -match $r.match) { $role = $r.role; break } } }
  if (-not $role -and $p.name -match '(?i)^(powershell|pwsh)(\.exe)?$' -and $p.cmd -match '(?i)-File\s+"?([^" ]+\.ps1)') { $role = 'ps: ' + (Split-Path -Leaf $Matches[1]) }
  if (-not $role -and $p.name -match '(?i)^pythonw?(\.exe)?$' -and $p.cmd -match '(?i)([A-Za-z0-9_.-]+\.py)') { $role = 'py: ' + $Matches[1] }
  if (-not $role -and $p.name -match '(?i)^node(\.exe)?$' -and $p.cmd -match '(?i)([A-Za-z0-9_.-]+\.(m?js|cjs))') { $role = 'node: ' + $Matches[1] }
  if (-not $role) { continue }
  if (-not $groups.Contains($role)) { $groups[$role] = New-Object System.Collections.ArrayList }
  [void]$groups[$role].Add($p)
}
Say ("PROCESSES ({0} roles): role xN | MB | pids | command" -f $groups.Count)
$shown = 0
$dupes = New-Object System.Collections.ArrayList
foreach ($role in $groups.Keys) {
  # One copy is one process tree: a venv's python.exe starts the real one as
  # its child, and `cmd /c vite preview` runs node under cmd. Counting every
  # process reported each of those as a duplicate on Worker1 (2026-10-07).
  $ids = @($groups[$role] | ForEach-Object { $_.pid })
  $list = @($groups[$role] | Where-Object { -not ($ids -contains $_.parent) })
  if (-not $list.Count) { $list = @($groups[$role]) }
  $single = ($roles | Where-Object { $_.role -eq $role } | Select-Object -First 1).single
  if ($null -eq $single) { $single = $role -match '^(ps|py): ' }
  if ($single -and $list.Count -gt 1) { [void]$dupes.Add("$role x$($list.Count)") }
  if ($shown -ge 20) { continue }
  $pids = (($list | Select-Object -First 4 | ForEach-Object { $_.pid }) -join ',')
  $mb = ($groups[$role] | Measure-Object -Property mb -Sum).Sum
  Say ("  {0} x{1} | {2} MB | {3} | {4}" -f $role, $list.Count, $mb, $pids, (Cut $list[0].cmd 80))
  $shown++
}
if ($groups.Count -gt $shown) { Say ("  ... {0} more role(s)" -f ($groups.Count - $shown)) }
Say ('DUPLICATES: ' + $(if ($dupes.Count) { ($dupes -join '; ') + ' (each of these should run once)' } else { 'none' }))

# ---------------------------------------------------------------- ports
$ports = 8001, 4173, 8787, 8790, 7861, 7860, 8188, 11434, 8080
if (Get-Command Get-NetTCPConnection -EA SilentlyContinue) {
  $seen = foreach ($port in $ports) {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue | Select-Object -First 1
    if ($c) { $n = (Get-Process -Id $c.OwningProcess -EA SilentlyContinue).ProcessName; "$port=$n($($c.OwningProcess))" } else { "$port=-" }
  }
  Say ('PORTS: ' + ($seen -join ' '))
} else { Say 'PORTS: Get-NetTCPConnection is not available here' }

# ---------------------------------------------------------------- Alpha's Agent Manager
$snapshot = Join-Path (Split-Path -Parent $AlphaRoot) 'memory\local\agent-manager\manager-status.json'
if (Test-Path -LiteralPath $snapshot) {
  $age = [int]((Get-Date) - (Get-Item -LiteralPath $snapshot).LastWriteTime).TotalMinutes
  try {
    $j = Get-Content -LiteralPath $snapshot -Raw | ConvertFrom-Json
    $agents = @()
    foreach ($key in 'agents', 'workers', 'processes') { if ($j.$key) { $agents = @($j.$key); break } }
    $states = $agents | ForEach-Object {
      $n = @($_.name, $_.id, $_.agent, $_.agent_id, $_.agentId, $_.key, $_.label, $_.title, $_.display_name, $_.displayName, $_.slug) | Where-Object { $_ } | Select-Object -First 1
      if (-not $n) { $n = @($_.PSObject.Properties | Where-Object { $_.Value -is [string] -and $_.Value -and $_.Name -notmatch '(?i)state|status' } | ForEach-Object { $_.Value }) | Select-Object -First 1 }
      $s = @($_.state, $_.status) | Where-Object { $_ } | Select-Object -First 1
      "$n=$s"
    }
    Say ("AGENT MANAGER: {0} agent(s), snapshot {1} min old{2}" -f $agents.Count, $age, $(if ($age -gt 2) { ' (STALE)' } else { '' }))
    $text = ($states -join ', ')
    while ($text.Length -gt 0) { $take = [math]::Min(150, $text.Length); Say ('  ' + $text.Substring(0, $take)); $text = $text.Substring($take); if ($lines.Count -gt 58) { break } }
  } catch { Say "AGENT MANAGER: snapshot does not parse: $($_.Exception.Message)" }
} else { Say "AGENT MANAGER: no snapshot at $snapshot (the manager does not run here)" }

$lines | Select-Object -First 60 | ForEach-Object { Write-Output $_ }
exit 0

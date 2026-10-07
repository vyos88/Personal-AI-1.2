<#
.SYNOPSIS
  Read-only: can this machine run Alpha, and what would moving Alpha here (or
  away from here) have to carry? One list, short enough for the autopilot
  report.

.DESCRIPTION
  The owner decided (2026-10-07) that laptop-gj8dfmlk, the Host, runs Alpha as
  well as the coordinator, and Laptop41 stops being where Alpha lives. Nothing
  said what the Host lacks for that, or how much Laptop41 would have to hand
  over: the Alpha copy, its runtime data, its configuration, Ollama's models,
  the cloudflared connector for alpha-ai.uk. Run on the Host it lists what is
  missing; run on Laptop41 it lists what has to move.

  It changes nothing. It starts, stops and writes nothing. It reads no file's
  contents: .env.local and cloudflared's files are reported as present or
  absent, with sizes, never opened. Folder sizes stop counting at 200,000
  files rather than walking a huge tree for the whole timeout.

  Run by the autopilot ({"do":"alpha-move-check"}), or by hand.
#>
param(
  [string]$AlphaRoot = 'C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software'
)

$ErrorActionPreference = 'SilentlyContinue'
$lines = New-Object System.Collections.ArrayList
$missing = New-Object System.Collections.ArrayList
function Say([string]$text) { [void]$lines.Add($text) }
function Need([string]$text) { [void]$missing.Add($text) }
function Gb([double]$bytes) { '{0:N1} GB' -f ($bytes / 1GB) }
function FolderSize([string]$path) {
  $n = 0; $sum = 0.0
  foreach ($f in [System.IO.Directory]::EnumerateFiles($path, '*', [System.IO.SearchOption]::AllDirectories)) {
    try { $sum += (New-Object System.IO.FileInfo $f).Length } catch { }
    $n++
    if ($n -ge 200000) { return ('{0}+ files, {1}+' -f $n, (Gb $sum)) }
  }
  '{0} files, {1}' -f $n, (Gb $sum)
}
function Version([string]$exe, [string[]]$arg) {
  $cmd = Get-Command $exe -EA SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { return $null }
  $v = (& $cmd.Source @arg 2>&1 | Select-Object -First 1) -as [string]
  if (-not $v) { $v = 'present' }
  $v.Trim()
}

$machine = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { [Environment]::MachineName }
Say ("ALPHA MOVE CHECK {0} {1}" -f $machine, (Get-Date).ToString('yyyy-MM-dd HH:mm'))

# ---------------------------------------------------------------- machine
$os = Get-CimInstance Win32_OperatingSystem
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
$gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }) -join '; '
$battery = Get-CimInstance Win32_Battery | Select-Object -First 1
$power = if (-not $battery) { 'no battery' } elseif ($battery.BatteryStatus -eq 2) { 'on AC' } else { 'ON BATTERY' }
if ($os) {
  Say ("MACHINE: RAM {0} free of {1}; C: {2} free; {3}" -f (Gb ($os.FreePhysicalMemory * 1KB)), (Gb ($os.TotalVisibleMemorySize * 1KB)), (Gb $disk.FreeSpace), $power)
  if ($disk -and $disk.FreeSpace -lt 20GB) { Need 'under 20 GB free on C: (Alpha, its venv, node_modules and models need room)' }
} else { Say 'MACHINE: not readable here' }
Say ("  GPU: {0}" -f $(if ($gpus) { $gpus } else { 'none found' }))
$ts = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '100.*' } | Select-Object -First 1
$lan = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -match '^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))\.' } | ForEach-Object { "$($_.IPAddress) ($($_.InterfaceAlias))" }) -join ', '
Say ("  addresses: tailnet {0}; LAN {1}" -f $(if ($ts) { $ts.IPAddress } else { 'none' }), $(if ($lan) { $lan } else { 'none' }))

# ---------------------------------------------------------------- the Alpha copy
$candidates = New-Object System.Collections.ArrayList
[void]$candidates.Add($AlphaRoot)
foreach ($u in @(Get-ChildItem 'C:\Users' -Directory)) {
  foreach ($rel in @('Downloads\VyoS-advance-tech-ai\software', 'Downloads\VyoS-advance-tech-ai\BuildArtifacts\installers\Alpha-Full\software', 'Alpha\software', 'Alpha-1.8\software', 'VyoS-advance-tech-ai\software')) {
    $p = Join-Path $u.FullName $rel
    if ((Test-Path $p) -and -not ($candidates -contains $p)) { [void]$candidates.Add($p) }
  }
}
$root = $null
Say 'ALPHA COPY:'
foreach ($c in $candidates) {
  if (-not (Test-Path $c)) { Say ("  {0}: not here" -f $c); continue }
  $top = Split-Path -Parent $c
  $branch = (git -C $top rev-parse --abbrev-ref HEAD 2>$null)
  $commit = (git -C $top log -1 --format='%h %cd' --date=format:'%m-%d %H:%M' 2>$null)
  $parts = @()
  $parts += $(if (Test-Path (Join-Path $c 'backend\main.py')) { 'backend' } else { 'NO backend' })
  $parts += $(if (Test-Path (Join-Path $c 'frontend\package.json')) { 'frontend' } else { 'NO frontend' })
  $parts += $(if (Test-Path (Join-Path $c 'frontend\node_modules')) { 'node_modules' } else { 'no node_modules' })
  $parts += $(if (Test-Path (Join-Path $c 'frontend\dist\index.html')) { 'dist' } else { 'no dist' })
  $git = if ($branch) { "git $branch @ $commit" } else { 'not a git checkout' }
  Say ("  {0}: {1}; {2}" -f $c, ($parts -join ', '), $git)
  if (-not $root -and (Test-Path (Join-Path $c 'backend\main.py'))) { $root = $c }
}
if (-not $root) { Need "no Alpha copy with backend\main.py (clone vyos88/Alpha, branch claude/friendly-wright-jw4ep6-route-b, the one Laptop41 runs)" }

# ---------------------------------------------------------------- runtime data and configuration
if ($root) {
  $top = Split-Path -Parent $root
  Say 'DATA (runtime state; never in git, moves by USB or LAN):'
  foreach ($d in @((Join-Path $top 'memory'), (Join-Path $root 'backend\data'), (Join-Path $root 'memory'))) {
    if (Test-Path $d) { Say ("  {0}: {1}" -f $d, (FolderSize $d)) }
  }
  # The backend's configuration has lived beside software\ as well as inside
  # it; Laptop41's first check looked only inside and called it missing.
  $backendEnv = @((Join-Path $top '.env.local'), (Join-Path $root '.env.local'), (Join-Path $root 'backend\.env.local'), (Join-Path $top '.env'), (Join-Path $root 'backend\.env'))
  foreach ($f in ($backendEnv + @(Join-Path $root 'frontend\.env.local'))) {
    if (Test-Path $f) { Say ("  {0}: present, {1} bytes (contents not read)" -f $f, (Get-Item -Force $f).Length) }
  }
  if (-not ($backendEnv | Where-Object { Test-Path $_ })) { Need "the backend's .env.local (Alpha configuration with its secrets; by USB from Laptop41, never through git or chat)" }
  $venv = @((Join-Path $top '.venv\Scripts\python.exe'), (Join-Path $root '.venv\Scripts\python.exe'), (Join-Path $root 'backend\.venv\Scripts\python.exe')) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($venv) { Say ("  venv: {0} ({1})" -f $venv, ((& $venv --version 2>&1) -as [string]).Trim()) } else { Need "Alpha's Python venv (.venv beside software\) with the backend's requirements" }
}

# ---------------------------------------------------------------- tools
Say 'TOOLS:'
foreach ($t in @(@('git', @('--version')), @('node', @('--version')), @('python', @('--version')), @('py', @('-3', '--version')), @('ollama', @('--version')), @('cloudflared', @('--version')), @('tailscale', @('version')))) {
  $v = Version $t[0] $t[1]
  Say ("  {0}: {1}" -f $t[0], $(if ($v) { $v } else { 'MISSING' }))
}
if (-not (Get-Command node -EA SilentlyContinue)) { Need 'Node.js (the site and the bridges)' }
if (-not ((Get-Command python -EA SilentlyContinue) -or (Get-Command py -EA SilentlyContinue))) { Need 'Python 3 (the backend)' }
if (Get-Command ollama -EA SilentlyContinue) {
  $models = @(ollama list 2>$null | Select-Object -Skip 1 | ForEach-Object { ($_ -split '\s+')[0] } | Where-Object { $_ })
  Say ("  ollama models: {0}" -f $(if ($models.Count) { $models -join ', ' } else { 'none' }))
  if (-not ($models -match '^llama3\.2:3b')) { Need "Ollama model llama3.2:3b (Alpha's chat model on Laptop41)" }
} else { Need "Ollama and llama3.2:3b (Alpha's chat)" }
$cfDir = Join-Path $env:USERPROFILE '.cloudflared'
$cfFiles = @()
foreach ($d in @($cfDir, 'C:\Windows\System32\config\systemprofile\.cloudflared', 'C:\ProgramData\cloudflared')) {
  if (Test-Path $d) { $cfFiles += @(Get-ChildItem $d -File | ForEach-Object { $_.Extension }) }
}
$cfSvc = Get-Service cloudflared -EA SilentlyContinue
$cfProc = @(Get-Process cloudflared -EA SilentlyContinue).Count
Say ("  cloudflared: service {0}; {1} process(es); config folders hold {2} .yml and {3} .json file(s) (not opened)" -f $(if ($cfSvc) { "$($cfSvc.Status)" } else { 'none' }), $cfProc, @($cfFiles | Where-Object { $_ -match '\.ya?ml$' }).Count, @($cfFiles | Where-Object { $_ -eq '.json' }).Count)
if (-not (Get-Command cloudflared -EA SilentlyContinue) -and -not $cfSvc) { Need 'cloudflared, and the alpha-ai.uk tunnel connector (only one machine may run it at a time)' }

# ---------------------------------------------------------------- ports and tasks
$names = [ordered]@{ '8001' = 'backend'; '4173' = 'site'; '8787' = 'coordinator'; '8790' = 'music bridge'; '7861' = 'image bridge'; '11434' = 'ollama'; '8188' = 'comfyui' }
$ports = foreach ($p in $names.Keys) {
  $listen = $null
  $listen = Get-NetTCPConnection -LocalPort ([int]$p) -State Listen -EA SilentlyContinue | Select-Object -First 1
  if ($listen) { '{0} {1}=up' -f $p, $names[$p] } else { '{0} {1}=-' -f $p, $names[$p] }
}
Say ('PORTS: ' + ($ports -join ', '))
if (Get-Command Get-ScheduledTask -EA SilentlyContinue) {
  $want = @('Alpha', 'Alpha Backend', 'Alpha Self-Heal', 'Alpha Doctor', 'alpha-music bridge', 'alpha-image bridge', 'alpha-coordinator', 'alpha-tunnel agent', 'Alpha Autopilot')
  $have = foreach ($n in $want) { $t = Get-ScheduledTask -TaskName $n -EA SilentlyContinue; if ($t) { '{0}={1}' -f $n, $t.State } else { '{0}=-' -f $n } }
  Say ('TASKS: ' + ($have -join ', '))
}
$mgr = if ($root) { Join-Path (Split-Path -Parent $root) 'memory\local\agent-manager\manager-status.json' } else { $null }
Say ("AGENT MANAGER: {0}" -f $(if ($mgr -and (Test-Path $mgr)) { 'snapshot here, written ' + (Get-Item $mgr).LastWriteTime.ToString('MM-dd HH:mm') } else { 'not running here' }))

# ---------------------------------------------------------------- verdict
if ($missing.Count) {
  Say ("MISSING TO RUN ALPHA HERE ({0}):" -f $missing.Count)
  foreach ($m in $missing) { Say "  - $m" }
} else {
  Say 'MISSING TO RUN ALPHA HERE: nothing found (the move still needs the data copied and the cutover)'
}

$lines | Select-Object -First 60 | ForEach-Object { Write-Output $_ }
exit 0

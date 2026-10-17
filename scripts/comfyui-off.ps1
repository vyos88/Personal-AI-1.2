<#
.SYNOPSIS
  Stops ComfyUI on this machine and takes it off the fleet's image work, so
  the memory it holds goes back to Alpha.

.DESCRIPTION
  Worker1 runs Alpha's backend, its site, the chat model and, since
  2026-10-06, its own ComfyUI (C:\Users\Vyo\ComfyUI, about 3.4 GB). On
  2026-10-07 it sat at 1.1-1.2 of 15.8 GB free all evening: the CrowPanel feed
  kept going stale and the backend stalled once. The Host makes the pictures
  (ComfyUI on its RTX 3050), so the owner said yes to stopping Worker1's:

    1. Every ComfyUI process (a python whose command runs main.py from a
       ComfyUI folder) is stopped with its tree, from the highest ancestor
       that is itself a ComfyUI launcher (a cmd or powershell whose command
       names ComfyUI, such as start-comfyui.ps1's restart loop), so nothing
       starts it again. A parent that does not name ComfyUI is never touched.
    2. Every scheduled task whose action names ComfyUI is stopped and
       disabled (not deleted). Startup-folder entries that name it are
       reported, not changed.
    3. alpha-image and alpha-image-file come out of ALPHA_EXTRA_HANDLERS in
       the agent's .env.agent (and its service environment), and the agent is
       restarted, so the image bridge sends every picture to the machines
       that still offer alpha.image. The image bridge itself keeps running.
    4. Afterwards nothing may answer on 8188 and no ComfyUI process may be
       left, or the exit code is 1. Free memory before and after is printed.

  Takes no arguments from the autopilot ({"do":"comfyui-off"}).
  -ProcessesJson gives it a process list instead of reading the machine; with
  it, it prints its plan as JSON and stops nothing. -Repo with -NoRestart
  edits only that checkout's .env.agent and touches no process or task. The
  tests use both.
#>
param(
  [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [int]$Port = 8188,
  [int]$ImageBridgePort = 7861,
  [string]$ProcessesJson,
  [switch]$NoRestart
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'agent-setup.ps1')
$comfyRe = '(?i)comfyui'
$mainRe = '(?i)(^|[\\/" ])main\.py\b'

function Get-ComfyPlan($procs) {
  $byPid = @{}
  foreach ($p in $procs) { $byPid[[int]$p.pid] = $p }
  $plan = [ordered]@{ stop = @(); mb = 0 }
  $seen = @{}
  foreach ($p in $procs) {
    $cmd = "$($p.cmd)"
    if ("$($p.name)" -notmatch '(?i)^python' -or $cmd -notmatch $mainRe -or $cmd -notmatch $comfyRe) { continue }
    # Climb while the parent is itself a ComfyUI launcher.
    $top = [int]$p.pid; $guard = 0
    while ($guard -lt 16) {
      $parent = [int]$byPid[$top].parent
      if (-not $byPid.ContainsKey($parent) -or $parent -eq $top) { break }
      $pp = $byPid[$parent]
      if ("$($pp.name)" -notmatch '(?i)^(cmd|powershell|pwsh)(\.exe)?$' -or "$($pp.cmd)" -notmatch $comfyRe) { break }
      $top = $parent; $guard++
    }
    if ($seen.ContainsKey($top)) { continue }
    $seen[$top] = $true
    # The whole tree under the top, for its size.
    $tree = New-Object System.Collections.ArrayList
    $todo = New-Object System.Collections.Queue
    $todo.Enqueue($top)
    while ($todo.Count -and $tree.Count -lt 256) {
      $id = $todo.Dequeue()
      if ($tree -contains $id) { continue }
      [void]$tree.Add($id)
      foreach ($c in $procs) { if ([int]$c.parent -eq $id -and [int]$c.pid -ne $id) { $todo.Enqueue([int]$c.pid) } }
    }
    $mb = 0; foreach ($id in $tree) { if ($byPid.ContainsKey($id)) { $mb += [int]$byPid[$id].mb } }
    $plan.stop += ,([ordered]@{ pid = $top; comfy = [int]$p.pid; processes = $tree.Count; mb = $mb; cmd = "$($byPid[$top].cmd)" })
    $plan.mb += $mb
  }
  return $plan
}

function Read-Processes {
  @(Get-CimInstance Win32_Process -EA SilentlyContinue | ForEach-Object {
    [pscustomobject]@{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; name = "$($_.Name)"; cmd = "$($_.CommandLine)"; mb = [int]([double]$_.WorkingSetSize / 1MB) }
  })
}
function Free-GB { try { [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB, 1) } catch { $null } }
function Answers([string]$url) { try { Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5 | Out-Null; $true } catch { $false } }

if ($ProcessesJson) {
  $procs = @(Get-Content -LiteralPath $ProcessesJson -Raw | ConvertFrom-Json)
  Get-ComfyPlan $procs | ConvertTo-Json -Depth 5 -Compress
  exit 0
}

$failed = New-Object System.Collections.ArrayList
function Fail([string]$t) { [void]$failed.Add($t); Write-Host "PROBLEM: $t" }

if (-not $NoRestart) {
  $before = Free-GB
  Write-Host "free memory before: $before GB"

  # 2 first, so a task cannot start ComfyUI again while 1 stops it.
  foreach ($t in @(Get-ScheduledTask -EA SilentlyContinue)) {
    $what = (@($t.Actions) | ForEach-Object { "$($_.Execute) $($_.Arguments) $($_.WorkingDirectory)" }) -join ' '
    if ("$($t.TaskName) $what" -notmatch $comfyRe) { continue }
    Stop-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -EA SilentlyContinue
    if (Disable-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -EA SilentlyContinue) { Write-Host "disabled scheduled task '$($t.TaskName)' (was $($t.State))" }
    else { Fail "scheduled task '$($t.TaskName)' names ComfyUI and could not be disabled" }
  }
  foreach ($dir in @([Environment]::GetFolderPath('Startup'), [Environment]::GetFolderPath('CommonStartup'))) {
    if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
    Get-ChildItem -LiteralPath $dir -File -EA SilentlyContinue | Where-Object {
      $_.Name -match $comfyRe -or ($_.Extension -match '(?i)^\.(bat|cmd|ps1)$' -and (Select-String -LiteralPath $_.FullName -Pattern $comfyRe -Quiet))
    } | ForEach-Object { Write-Host "note: startup entry $($_.FullName) names ComfyUI; left as it is, so it may start ComfyUI at the next logon" }
  }

  # 1
  $plan = Get-ComfyPlan (Read-Processes)
  if (-not $plan.stop.Count) { Write-Host 'no ComfyUI process is running' }
  foreach ($s in $plan.stop) {
    Write-Host "stopping ComfyUI tree at pid $($s.pid): $($s.processes) process(es), $($s.mb) MB: $($s.cmd)"
    & taskkill.exe /PID $s.pid /T /F 2>&1 | Out-Null
  }
}

# 3
$agent = if ($NoRestart) { @{ kind = $null; repo = $Repo } } else { Find-Agent -Fallback $Repo }
if (-not $PSBoundParameters.ContainsKey('Repo') -and $agent.repo) { $Repo = $agent.repo }
$handlers = Set-AgentHandlers -Repo $Repo -Handlers @() -Settings @{} -Drop @('alpha-image', 'alpha-image-file') -Agent $agent
Write-Host "ok: .env.agent handlers: $($handlers -join ', ')"
if ($NoRestart) { exit 0 }
if (Restart-Agent $agent) { Write-Host 'the agent no longer offers alpha.image' } else { Fail 'the agent was not restarted, so it still offers alpha.image' }

# 4
Start-Sleep -Seconds 15
$left = Get-ComfyPlan (Read-Processes)
if ($left.stop.Count) { Fail "ComfyUI is still running: pid(s) $(($left.stop | ForEach-Object { $_.comfy }) -join ', ')" }
if (Answers "http://127.0.0.1:$Port/system_stats") { Fail "something still answers on $Port" } else { Write-Host "ok: nothing answers on $Port" }
$after = Free-GB
Write-Host "free memory after: $after GB$(if ($null -ne $before -and $null -ne $after) { " ($([math]::Round($after - $before, 1)) GB back)" })"
$models = try { (Invoke-WebRequest -Uri "http://127.0.0.1:$ImageBridgePort/sdapi/v1/sd-models" -UseBasicParsing -TimeoutSec 10).Content } catch { "$($_.ErrorDetails.Message)" }
if ($models -match '"title"\s*:\s*"[^"]*\(([^)"]+)\)"') { Write-Host "machines that make images now (the image bridge's view): $($Matches[1])" }
elseif ($models -match 'no_image_machine') { Write-Host 'note: the image bridge sees no machine that offers alpha.image yet' }

if ($failed.Count) { exit 1 }
Write-Host 'done: ComfyUI is stopped here and pictures go to the other machines'
exit 0

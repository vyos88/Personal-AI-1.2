<#
.SYNOPSIS
  Shared steps for the scripts that turn on an opt-in handler on this
  machine's tunnel agent (enable-music.ps1, enable-image.ps1). Dot-source it.

.DESCRIPTION
  Learned on Worker1, 2026-10-06:
   - Its agent is not the 'alpha-tunnel agent' scheduled task but the Windows
     service 'alpha-agent' (nssm). A service can carry ALPHA_EXTRA_HANDLERS in
     its own environment, which wins over .env.agent, so a handler added only
     to the file is never offered. Both are updated here.
   - pip installing MusicGen into the user's Python upgraded anyio past what
     Alpha's own FastAPI pins (anyio<4). Creator packages now go into their
     own venv, C:\AlphaData\creators-venv, and Repair-PipConflicts puts back
     any pin `pip check` says was broken.
  Nothing here prints a value from .env.agent or the service environment:
  both hold the agent's key.
#>

# The checkout the agent runs from, and how it runs: 'service', 'task' or $null.
function Find-Agent([string]$TaskName = 'alpha-tunnel agent', [string]$ServiceName = 'alpha-agent', [string]$Fallback) {
  $svc = Get-Service -Name $ServiceName -EA SilentlyContinue
  if ($svc) {
    $p = Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName\Parameters" -EA SilentlyContinue
    $dir = if ($p -and $p.AppDirectory -and (Test-Path -LiteralPath $p.AppDirectory)) { $p.AppDirectory } else { $Fallback }
    return @{ kind = 'service'; name = $ServiceName; repo = $dir }
  }
  if (Get-Command Get-ScheduledTask -EA SilentlyContinue) {
    $t = Get-ScheduledTask -TaskName $TaskName -EA SilentlyContinue
    if ($t) {
      $m = [regex]::Match("$($t.Actions[0].Arguments)", '"?([^"]+?)[\\/]scripts[\\/]keep-agent\.mjs')
      $dir = if ($m.Success -and (Test-Path -LiteralPath $m.Groups[1].Value)) { $m.Groups[1].Value } else { $Fallback }
      return @{ kind = 'task'; name = $TaskName; repo = $dir }
    }
  }
  return @{ kind = $null; name = $null; repo = $Fallback }
}

# Adds $Handlers to ALPHA_EXTRA_HANDLERS and sets $Settings in .env.agent
# (backed up), and in the service environment when the agent is a service.
# Returns the merged handler list.
function Set-AgentHandlers([string]$Repo, [string[]]$Handlers, [hashtable]$Settings, [string[]]$Remove = @(), $Agent = $null) {
  $envFile = Join-Path $Repo '.env.agent'
  $lines = New-Object System.Collections.ArrayList
  if (Test-Path -LiteralPath $envFile) {
    foreach ($l in (Get-Content -LiteralPath $envFile)) { [void]$lines.Add($l) }
    Copy-Item -LiteralPath $envFile -Destination "$envFile.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force
  }
  $merged = Merge-HandlerLines $lines $Handlers $Settings $Remove
  [IO.File]::WriteAllLines($envFile, [string[]]$lines, (New-Object Text.UTF8Encoding($false)))

  if ($Agent -and $Agent.kind -eq 'service') {
    $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$($Agent.name)\Parameters"
    $extra = (Get-ItemProperty -Path $key -Name AppEnvironmentExtra -EA SilentlyContinue).AppEnvironmentExtra
    if ($extra) {
      $list = New-Object System.Collections.ArrayList
      foreach ($e in @($extra)) { [void]$list.Add([string]$e) }
      # The same full list in both places: the service's value replaces the
      # file's, so a list of only the new handlers would drop the others.
      $merged = Merge-HandlerLines $list $merged $Settings $Remove
      Set-ItemProperty -Path $key -Name AppEnvironmentExtra -Value ([string[]]$list) -Type MultiString
      # And the file gets anything only the service had.
      [void](Merge-HandlerLines $lines $merged @{} @())
      [IO.File]::WriteAllLines($envFile, [string[]]$lines, (New-Object Text.UTF8Encoding($false)))
      Write-Host "ok: the $($Agent.name) service's own environment carries the same handlers (it wins over .env.agent)"
    }
  }
  return $merged
}

# Edits NAME=value lines in place (an ArrayList). Exported for tests.
function Merge-HandlerLines($lines, [string[]]$Handlers, [hashtable]$Settings, [string[]]$Remove = @()) {
  function Index-Of([string]$name) {
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match "^\s*$([regex]::Escape($name))\s*=") { return $i } }
    return -1
  }
  $i = Index-Of 'ALPHA_EXTRA_HANDLERS'
  $have = if ($i -ge 0) { ((($lines[$i] -split '=', 2)[1]).Trim().Trim('"', "'") -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ } } else { @() }
  $merged = @($have)
  foreach ($h in $Handlers) { if ($merged -notcontains $h) { $merged += $h } }
  if ($i -ge 0) { $lines[$i] = "ALPHA_EXTRA_HANDLERS=$($merged -join ',')" } else { [void]$lines.Add("ALPHA_EXTRA_HANDLERS=$($merged -join ',')") }
  foreach ($name in $Settings.Keys) {
    $j = Index-Of $name
    if ($j -ge 0) { $lines[$j] = "$name=$($Settings[$name])" } else { [void]$lines.Add("$name=$($Settings[$name])") }
  }
  foreach ($name in $Remove) { $j = Index-Of $name; if ($j -ge 0) { $lines.RemoveAt($j) } }
  return $merged
}

# Restarts the agent so it reads the new handlers. True when it is back.
function Restart-Agent($Agent) {
  if ($Agent.kind -eq 'service') {
    Restart-Service -Name $Agent.name -Force -EA SilentlyContinue
    Start-Sleep -Seconds 5
    $ok = (Get-Service -Name $Agent.name -EA SilentlyContinue).Status -eq 'Running'
    Write-Host $(if ($ok) { "ok: restarted the $($Agent.name) service" } else { "PROBLEM: the $($Agent.name) service is not running after a restart" })
    return $ok
  }
  if ($Agent.kind -eq 'task') {
    $repo = $Agent.repo
    $mine = { param($pattern) @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
      Where-Object { "$($_.CommandLine)" -match $pattern -and "$($_.CommandLine)".IndexOf($repo, [StringComparison]::OrdinalIgnoreCase) -ge 0 }) }
    & $mine 'keep-agent\.mjs|src[\\/]agent[\\/]index\.js' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
    Start-Sleep -Seconds 2
    Start-ScheduledTask -TaskName $Agent.name
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline -and -not (& $mine 'src[\\/]agent[\\/]index\.js')) { Start-Sleep -Seconds 3 }
    $ok = [bool](& $mine 'src[\\/]agent[\\/]index\.js')
    Write-Host $(if ($ok) { "ok: restarted the agent through task '$($Agent.name)'" } else { "PROBLEM: the agent did not come back within 60s after starting '$($Agent.name)'" })
    return $ok
  }
  Write-Host "PROBLEM: no agent service ('alpha-agent') or task ('alpha-tunnel agent') on this machine to restart"
  return $false
}

# A Python 3.10-3.12 that is not the Store stub.
function Find-BasePython {
  foreach ($try in @(@('py', '-3.12'), @('py', '-3.11'), @('py', '-3'), @('python'), @('python3'))) {
    $cmd = Get-Command $try[0] -EA SilentlyContinue
    if (-not $cmd) { continue }
    $exe = (& $cmd.Source @($try | Select-Object -Skip 1) -c 'import sys; print(sys.executable)' 2>$null | Out-String).Trim()
    if ($exe -and (Test-Path -LiteralPath $exe) -and $exe -notmatch '\\WindowsApps\\') { return $exe }
  }
  return $null
}

# The creators' own venv, made once from the base Python. Its python.exe.
function Get-CreatorsPython([string]$Base, [string]$Dir = 'C:\AlphaData\creators-venv') {
  $py = Join-Path $Dir 'Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $py)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $Dir -Parent) | Out-Null
    & $Base -m venv $Dir 2>&1 | Out-Null
  }
  if (Test-Path -LiteralPath $py) { return $py }
  return $null
}

# `pip check` names every requirement an install broke; put each pin back.
function Repair-PipConflicts([string]$Python) {
  $report = (& $Python -m pip check 2>&1 | Out-String)
  $fixes = @([regex]::Matches($report, '(?m)^\S+ \S+ (?:has requirement|requires) ([A-Za-z0-9_.\-]+)([<>=!~][^,\s]*(?:,[<>=!~][^,\s]*)*), but you have') | ForEach-Object { "$($_.Groups[1].Value)$($_.Groups[2].Value)" } | Select-Object -Unique)
  if (-not $fixes.Count) { Write-Host "ok: $Python has no broken requirements"; return $true }
  Write-Host "putting back $($fixes.Count) requirement(s) an earlier install broke in ${Python}: $($fixes -join ', ')"
  & $Python -m pip install --disable-pip-version-check --quiet @fixes 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Host "  $_" }
  $after = (& $Python -m pip check 2>&1 | Out-String)
  $clean = $after -notmatch 'but you have'
  Write-Host $(if ($clean) { "ok: $Python requirements are consistent again" } else { "PROBLEM: $Python still has broken requirements: $(($after -split "`n" | Select-Object -First 2) -join ' / ')" })
  return $clean
}

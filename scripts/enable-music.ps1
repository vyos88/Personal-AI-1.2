<#
.SYNOPSIS
  Makes this machine generate music for Alpha's Music Creator, and with
  -Bridge also serves the Generate button, so nobody has to follow a punch
  list by hand.

.DESCRIPTION
  On 2026-10-06 no machine offered alpha.music: the 2026-09-30 punch list
  (HANDOFF_LAPTOP41_2026-09-30.md section 3) was never finished. This does the
  steps that need no person:

    1. installs scripts\requirements-music.txt (MusicGen) into one pinned
       Python, and checks torch and transformers import;
    2. adds alpha-music and alpha-music-audio to ALPHA_EXTRA_HANDLERS in this
       checkout's .env.agent, keeping every other handler, and sets
       ALPHA_MUSIC_ROOT and ALPHA_MUSIC_PYTHON. The file is backed up first.
       It also holds this agent's key: only the music lines are touched, and
       no value from it is ever printed;
    3. restarts the agent ('alpha-tunnel agent'), so it offers alpha.music;
    4. with -Bridge (the machine that serves Alpha): runs the music bridge as
       the scheduled task 'alpha-music bridge', at logon, through
       start-music-bridge.ps1.

  -DryRun sets ALPHA_MUSIC_DRY_RUN=1: tracks are a click track at the chosen
  BPM, with no model, to prove the whole path before the first real track.

  Run by the autopilot ({"do":"enable-music","bridge":true}), or by hand.
  Exit 0 when every step worked; 1 with the reason otherwise.
#>

param(
  [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  # A full path to python.exe. Default: the one `py -3` or `python` runs.
  [string]$Python,
  [switch]$Bridge,
  [switch]$DryRun,
  [string]$AgentTask = 'alpha-tunnel agent',
  [string]$BridgeTask = 'alpha-music bridge',
  # For tests: skip pip and leave processes and scheduled tasks alone.
  [switch]$SkipInstall,
  [switch]$NoRestart
)

$ErrorActionPreference = 'Continue'
$failed = New-Object System.Collections.ArrayList
function Fail([string]$t) { [void]$failed.Add($t); Write-Host "PROBLEM: $t" }

# The agent reads .env.agent in the checkout it runs from, which need not be
# the one this script sits in: ask its scheduled task.
if (-not $PSBoundParameters.ContainsKey('Repo') -and (Get-Command Get-ScheduledTask -EA SilentlyContinue)) {
  $t = Get-ScheduledTask -TaskName $AgentTask -EA SilentlyContinue
  $m = if ($t) { [regex]::Match("$($t.Actions[0].Arguments)", '"?([^"]+?)[\\/]scripts[\\/]keep-agent\.mjs') }
  if ($m -and $m.Success -and (Test-Path -LiteralPath $m.Groups[1].Value)) {
    if ($m.Groups[1].Value -ne $Repo) { Write-Host "the agent runs from $($m.Groups[1].Value): configuring that checkout" }
    $Repo = $m.Groups[1].Value
  }
}

# ------------------------------------------------------------ 1. Python
function Resolve-Python {
  if ($Python) { return $Python }
  foreach ($try in @(@('py', '-3'), @('python'), @('python3'))) {
    $cmd = Get-Command $try[0] -EA SilentlyContinue
    if (-not $cmd) { continue }
    $exe = (& $cmd.Source @($try | Select-Object -Skip 1) -c 'import sys; print(sys.executable)' 2>$null | Out-String).Trim()
    # The Microsoft Store alias answers with nothing, or a WindowsApps stub.
    if ($exe -and (Test-Path -LiteralPath $exe) -and $exe -notmatch '\\WindowsApps\\') { return $exe }
  }
  return $null
}
$py = Resolve-Python
if (-not $py) { Fail 'no Python 3 found (py -3, python): install Python 3.10+ for this user first' }
else {
  Write-Host "python: $py"
  if (-not $SkipInstall) {
    Write-Host 'installing scripts\requirements-music.txt (the first time downloads torch, several hundred MB)...'
    & $py -m pip install --disable-pip-version-check --quiet -r (Join-Path $Repo 'scripts\requirements-music.txt') 2>&1 |
      Select-Object -Last 5 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) { Fail "pip install failed (exit $LASTEXITCODE)" }
    $v = (& $py -c 'import torch, transformers; print(torch.__version__, transformers.__version__)' 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -eq 0) {
      Write-Host "ok: torch and transformers import ($v)"
      # The first track would otherwise download the model inside its own
      # 10-minute limit, on a CPU that already needs most of it.
      if (-not $DryRun) {
        $model = if ($env:ALPHA_MUSICGEN_MODEL) { $env:ALPHA_MUSICGEN_MODEL } else { 'facebook/musicgen-small' }
        Write-Host "downloading $model once, so the first track does not wait for it..."
        $dl = (& $py -c "from transformers import AutoProcessor, MusicgenForConditionalGeneration as M; AutoProcessor.from_pretrained('$model'); M.from_pretrained('$model'); print('cached')" 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -eq 0) { Write-Host "ok: $model is cached" }
        else { Fail "could not download ${model}: $(($dl -split "`n" | Select-Object -Last 1))" }
      }
    }
    elseif ($DryRun) { Write-Host 'torch does not import yet; a dry run needs no model, so going on' }
    else { Fail "torch/transformers do not import: $(($v -split "`n" | Select-Object -Last 1))" }
  }
}

# ------------------------------------------------------------ 2. .env.agent
$envFile = Join-Path $Repo '.env.agent'
$lines = New-Object System.Collections.ArrayList
if (Test-Path -LiteralPath $envFile) {
  foreach ($l in (Get-Content -LiteralPath $envFile)) { [void]$lines.Add($l) }
  $bak = "$envFile.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item -LiteralPath $envFile -Destination $bak -Force
  Write-Host "backed up .env.agent to $(Split-Path $bak -Leaf)"
} else {
  Write-Host 'no .env.agent yet: creating one with the music settings only'
}
function Index-Of([string]$name) {
  for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match "^\s*$([regex]::Escape($name))\s*=") { return $i } }
  return -1
}
function Set-Line([string]$name, [string]$value) {
  $i = Index-Of $name
  if ($i -ge 0) { $lines[$i] = "$name=$value" } else { [void]$lines.Add("$name=$value") }
}
function Remove-Line([string]$name) { $i = Index-Of $name; if ($i -ge 0) { $lines.RemoveAt($i) } }

$i = Index-Of 'ALPHA_EXTRA_HANDLERS'
$have = if ($i -ge 0) { ((($lines[$i] -split '=', 2)[1]).Trim().Trim('"', "'") -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ } } else { @() }
$handlers = @($have)
foreach ($h in 'alpha-music', 'alpha-music-audio') { if ($handlers -notcontains $h) { $handlers += $h } }
Set-Line 'ALPHA_EXTRA_HANDLERS' ($handlers -join ',')
Set-Line 'ALPHA_MUSIC_ROOT' $Repo
if ($py) { Set-Line 'ALPHA_MUSIC_PYTHON' $py }
if ($DryRun) { Set-Line 'ALPHA_MUSIC_DRY_RUN' '1' } else { Remove-Line 'ALPHA_MUSIC_DRY_RUN' }
[IO.File]::WriteAllLines($envFile, [string[]]$lines, (New-Object Text.UTF8Encoding($false)))
Write-Host "ok: .env.agent handlers: $($handlers -join ', ')$(if ($DryRun) { ' (dry run: click tracks, no model)' })"

# ------------------------------------------------------------ 3. restart the agent
function Repo-Processes([string]$pattern) {
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
    Where-Object { "$($_.CommandLine)" -match $pattern -and "$($_.CommandLine)".IndexOf($Repo, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
}
if (-not $NoRestart) {
  if (-not (Get-ScheduledTask -TaskName $AgentTask -EA SilentlyContinue)) {
    Fail "no scheduled task '$AgentTask' to restart the agent with (scripts\install-always-on.ps1 installs it)"
  } else {
    $old = Repo-Processes 'keep-agent\.mjs|src[\\/]agent[\\/]index\.js'
    $old | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
    Write-Host "stopped $($old.Count) agent process(es)"
    Start-Sleep -Seconds 2
    Start-ScheduledTask -TaskName $AgentTask
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline -and -not (Repo-Processes 'src[\\/]agent[\\/]index\.js')) { Start-Sleep -Seconds 3 }
    if (Repo-Processes 'src[\\/]agent[\\/]index\.js') { Write-Host "ok: agent restarted by '$AgentTask'; it now offers alpha.music" }
    else { Fail "the agent did not come back within 60s after starting '$AgentTask'" }
  }
}

# ------------------------------------------------------------ 4. the bridge
if ($Bridge -and -not $NoRestart) {
  $launcher = Join-Path $Repo 'scripts\start-music-bridge.ps1'
  $argLine = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine -WorkingDirectory $Repo
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $BridgeTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Repo-Processes 'music-bridge\.mjs' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
  Start-ScheduledTask -TaskName $BridgeTask
  $up = $false
  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $deadline -and -not $up) {
    try { $up = [bool](Invoke-RestMethod -Uri 'http://127.0.0.1:8790/music/healthz' -TimeoutSec 3).ok } catch { Start-Sleep -Seconds 3 }
  }
  if ($up) { Write-Host "ok: music bridge answers on 127.0.0.1:8790 (task '$BridgeTask', starts at logon)" }
  else { Fail "music bridge did not answer on 127.0.0.1:8790 within 45s; its log: $(Join-Path $env:TEMP 'alpha-music-bridge.log')" }
}

if ($failed.Count) { exit 1 }
Write-Host 'done: this machine makes music for the Music Creator'
exit 0

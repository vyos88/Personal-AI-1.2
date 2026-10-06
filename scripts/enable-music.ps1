<#
.SYNOPSIS
  Makes this machine generate music for Alpha's Music Creator, and with
  -Bridge also serves the Generate button, so nobody has to follow a punch
  list by hand.

.DESCRIPTION
  On 2026-10-06 no machine offered alpha.music: the 2026-09-30 punch list
  (HANDOFF_LAPTOP41_2026-09-30.md section 3) was never finished. This does the
  steps that need no person:

    1. installs scripts\requirements-music.txt (MusicGen) into the creators'
       own venv (C:\AlphaData\creators-venv), never into the Python Alpha's
       backend uses, puts back any of that Python's pins an earlier version
       of this script broke, and checks torch and transformers import;
    2. adds alpha-music and alpha-music-audio to ALPHA_EXTRA_HANDLERS in this
       checkout's .env.agent, keeping every other handler, and sets
       ALPHA_MUSIC_ROOT and ALPHA_MUSIC_PYTHON. The file is backed up first.
       It also holds this agent's key: only the music lines are touched, and
       no value from it is ever printed;
    3. restarts the agent (the 'alpha-agent' service, or the 'alpha-tunnel
       agent' task), so it offers alpha.music; a service's own environment
       gets the same handlers, since it wins over .env.agent;
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
  # A full path to the python.exe that runs the generator. Default: the
  # creators' venv, made from `py -3.12` / `python`.
  [string]$Python,
  [string]$VenvDir = 'C:\AlphaData\creators-venv',
  [switch]$Bridge,
  # Machines the bridge gives tracks to, in order of preference on equal load
  # ("host,worker1": the Host's RTX 3050 first), or "auto".
  [string]$Machines = 'auto',
  [switch]$DryRun,
  [string]$AgentTask = 'alpha-tunnel agent',
  [string]$BridgeTask = 'alpha-music bridge',
  # For tests: skip pip and leave processes and scheduled tasks alone.
  [switch]$SkipInstall,
  [switch]$NoRestart
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'agent-setup.ps1')
$failed = New-Object System.Collections.ArrayList
function Fail([string]$t) { [void]$failed.Add($t); Write-Host "PROBLEM: $t" }

$agent = if ($NoRestart) { @{ kind = $null; repo = $Repo } } else { Find-Agent -Fallback $Repo }
if (-not $PSBoundParameters.ContainsKey('Repo') -and $agent.repo) {
  if ($agent.repo -ne $Repo) { Write-Host "the agent runs from $($agent.repo): configuring that checkout" }
  $Repo = $agent.repo
}

# ------------------------------------------------------------ 1. Python
$py = $Python
if (-not $py -and -not $SkipInstall) {
  $base = Find-BasePython
  if (-not $base) { Fail 'no Python 3.10+ found (py -3, python): install Python 3.12 for this user first' }
  else {
    # Version 1 of this script installed into $base, which on Worker1 is also
    # where Alpha's FastAPI lives, and lifted anyio past its pin.
    [void](Repair-PipConflicts $base)
    $py = Get-CreatorsPython $base $VenvDir
    if (-not $py) { Fail "could not make the creators' venv in $VenvDir" }
  }
}
if ($py) {
  Write-Host "python: $py"
  if (-not $SkipInstall) {
    # An NVIDIA GPU (the Host's RTX 3050) makes MusicGen many times faster,
    # but plain pip picks the CPU build of torch on Windows.
    $gpu = [bool](Get-Command nvidia-smi -EA SilentlyContinue) -and ((& nvidia-smi -L 2>$null | Out-String) -match 'GPU')
    if ($gpu) {
      Write-Host 'NVIDIA GPU found: installing CUDA torch first'
      & $py -m pip install --disable-pip-version-check --quiet torch --index-url https://download.pytorch.org/whl/cu124 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Host "  $_" }
    }
    Write-Host 'installing scripts\requirements-music.txt (the first time downloads torch, several hundred MB)...'
    & $py -m pip install --disable-pip-version-check --quiet -r (Join-Path $Repo 'scripts\requirements-music.txt') 2>&1 |
      Select-Object -Last 5 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) { Fail "pip install failed (exit $LASTEXITCODE)" }
    $v = (& $py -c 'import torch, transformers; print(torch.__version__, transformers.__version__, "cuda" if torch.cuda.is_available() else "cpu")' 2>&1 | Out-String).Trim()
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

# ------------------------------------------------------------ 2. .env.agent (+ service)
if (-not (Test-Path -LiteralPath (Join-Path $Repo '.env.agent'))) { Write-Host 'no .env.agent yet: creating one with the music settings only' }
$settings = @{ ALPHA_MUSIC_ROOT = $Repo }
if ($py) { $settings.ALPHA_MUSIC_PYTHON = $py }
if ($DryRun) { $settings.ALPHA_MUSIC_DRY_RUN = '1' }
$handlers = Set-AgentHandlers -Repo $Repo -Handlers @('alpha-music', 'alpha-music-audio') -Settings $settings -Remove $(if ($DryRun) { @() } else { @('ALPHA_MUSIC_DRY_RUN') }) -Agent $agent
Write-Host "ok: .env.agent handlers: $($handlers -join ', ')$(if ($DryRun) { ' (dry run: click tracks, no model)' })"

# ------------------------------------------------------------ 3. restart the agent
if (-not $NoRestart) {
  if (Restart-Agent $agent) { Write-Host 'the agent now offers alpha.music' } else { Fail 'the agent was not restarted, so it does not offer alpha.music yet' }
}

# ------------------------------------------------------------ 4. the bridge
function Repo-Processes([string]$pattern) {
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
    Where-Object { "$($_.CommandLine)" -match $pattern -and "$($_.CommandLine)".IndexOf($Repo, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
}
if ($Bridge -and -not $NoRestart) {
  if ($Machines -notmatch '^(auto|[A-Za-z0-9][A-Za-z0-9._-]{0,63}(,[A-Za-z0-9][A-Za-z0-9._-]{0,63})*)$') { Fail "machines must be auto or a comma list of agent names, not '$Machines'" }
  else { [Environment]::SetEnvironmentVariable('ALPHA_MUSIC_AGENT', $Machines, 'User'); Write-Host "music bridge machines: $Machines" }
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

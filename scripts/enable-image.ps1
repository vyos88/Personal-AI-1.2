<#
.SYNOPSIS
  Makes this machine render images for Alpha through the tunnel, so each image
  goes to the least busy laptop; with -Bridge, this machine also serves
  Alpha's image requests to the fleet.

.DESCRIPTION
  Until 2026-10-06 every image Alpha made came from Worker1's own generator
  (IMAGE_GEN_URL, 127.0.0.1:7860), however busy Worker1 was. This:

    1. with -InstallComfy, and nothing answering on 127.0.0.1:8188: installs
       ComfyUI in -ComfyDir with its own Python venv (CUDA torch when an
       NVIDIA GPU is present, CPU otherwise), downloads Stable Diffusion 1.5,
       and runs it at logon as the scheduled task 'ComfyUI';
    2. adds alpha-image and alpha-image-file to ALPHA_EXTRA_HANDLERS in the
       .env.agent of the checkout the agent runs from, and in the agent
       service's own environment when it is a service (backed up; every other
       line kept, nothing printed), with the backend this machine has: a1111
       (Worker1's 7860 adapter) or comfyui (8188); restarts the agent
       (agent-setup.ps1);
    3. with -Bridge (the machine that serves Alpha): runs the image bridge
       (127.0.0.1:7861) as the scheduled task 'alpha-image bridge', points
       Alpha's IMAGE_GEN_URL at it and keeps the direct generator as a
       fallback in IMAGE_GEN_URLS, then restarts 'Alpha Backend'.

  Exit 0 when every step worked; 1 with the reason otherwise.
#>

param(
  [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [ValidateSet('', 'a1111', 'comfyui')] [string]$Backend = '',
  [switch]$InstallComfy,
  [string]$ComfyDir = 'C:\services\ComfyUI',
  [string]$ComfyLog = 'C:\AlphaData\comfyui.log',
  [int]$ComfyWaitSeconds = 420,
  [string]$Checkpoint = 'v1-5-pruned-emaonly.safetensors',
  [string]$CheckpointUrl = 'https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5/resolve/main/v1-5-pruned-emaonly.safetensors',
  [string]$Python,
  [switch]$Bridge,
  # Machines the image bridge uses, in order of preference on equal load, or "auto".
  [string]$Machines = 'auto',
  [string]$AlphaRoot = 'C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software',
  [string]$AgentTask = 'alpha-tunnel agent',
  # For tests: no installs, processes or scheduled tasks.
  [switch]$SkipInstall,
  [switch]$NoRestart
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'agent-setup.ps1')
$failed = New-Object System.Collections.ArrayList
function Fail([string]$t) { [void]$failed.Add($t); Write-Host "PROBLEM: $t" }
function Answers([string]$url) { try { Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5 | Out-Null; $true } catch { $false } }

# The agent (the 'alpha-agent' service, or the 'alpha-tunnel agent' task) and its checkout.
$agent = if ($NoRestart) { @{ kind = $null; repo = $Repo } } else { Find-Agent -Fallback $Repo }
if (-not $PSBoundParameters.ContainsKey('Repo') -and $agent.repo) { $Repo = $agent.repo }

# ------------------------------------------------------------ 1. ComfyUI
if ($InstallComfy -and -not $SkipInstall -and -not (Answers 'http://127.0.0.1:8188/system_stats')) {
  if (-not $Python) {
    foreach ($try in @(@('py', '-3.12'), @('py', '-3.11'), @('py', '-3'), @('python'))) {
      $cmd = Get-Command $try[0] -EA SilentlyContinue
      if (-not $cmd) { continue }
      $exe = (& $cmd.Source @($try | Select-Object -Skip 1) -c 'import sys; print(sys.executable)' 2>$null | Out-String).Trim()
      if ($exe -and (Test-Path -LiteralPath $exe) -and $exe -notmatch '\\WindowsApps\\') { $Python = $exe; break }
    }
  }
  if (-not $Python) { Fail 'no Python 3.10-3.12 found for ComfyUI: install Python 3.12 for this user first' }
  elseif (-not (Get-Command git -EA SilentlyContinue)) { Fail 'git is not on PATH, so ComfyUI cannot be fetched' }
  else {
    if (-not (Test-Path -LiteralPath (Join-Path $ComfyDir 'main.py'))) {
      Write-Host "cloning ComfyUI into $ComfyDir..."
      git clone --depth 1 https://github.com/comfyanonymous/ComfyUI $ComfyDir 2>&1 | Select-Object -Last 2 | ForEach-Object { Write-Host "  $_" }
    }
    $venvPy = Join-Path $ComfyDir 'venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $venvPy)) { & $Python -m venv (Join-Path $ComfyDir 'venv') }
    $gpu = [bool](Get-Command nvidia-smi -EA SilentlyContinue) -and ((& nvidia-smi -L 2>$null | Out-String) -match 'GPU')
    Write-Host $(if ($gpu) { 'NVIDIA GPU found: installing CUDA torch' } else { 'no NVIDIA GPU: installing CPU torch (an image takes minutes, not seconds)' })
    $torchArgs = @('-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', 'torch', 'torchvision', 'torchaudio')
    if ($gpu) { $torchArgs += @('--index-url', 'https://download.pytorch.org/whl/cu124') }
    & $venvPy @torchArgs 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Host "  $_" }
    & $venvPy -m pip install --disable-pip-version-check --quiet -r (Join-Path $ComfyDir 'requirements.txt') 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) { Fail "ComfyUI requirements did not install (exit $LASTEXITCODE)" }
    # No double quotes inside: Windows PowerShell 5.1 drops them on the way to
    # python, and "cuda" arrived as the name cuda (job h02, 2026-10-06).
    $tv = (& $venvPy -c 'import torch; print(torch.__version__, (''cuda'' if torch.cuda.is_available() else ''cpu''))' 2>&1 | Out-String).Trim()
    Write-Host "ComfyUI's torch: $(($tv -split "`n" | Select-Object -Last 1))"
    if ($gpu -and $tv -notmatch 'cuda\s*$') { Write-Host 'note: an NVIDIA GPU is here but this torch cannot use it; ComfyUI runs on the CPU' }

    $ckpt = Join-Path $ComfyDir "models\checkpoints\$Checkpoint"
    if (-not (Test-Path -LiteralPath $ckpt) -or (Get-Item -LiteralPath $ckpt).Length -lt 1GB) {
      Write-Host "downloading $Checkpoint (about 4 GB, resumable)..."
      & curl.exe -L --fail --retry 3 -C - -o $ckpt $CheckpointUrl 2>&1 | Select-Object -Last 1 | ForEach-Object { Write-Host "  $_" }
      if (-not (Test-Path -LiteralPath $ckpt) -or (Get-Item -LiteralPath $ckpt).Length -lt 1GB) { Fail "the checkpoint did not download to $ckpt" }
    }

    # Through start-comfyui.ps1, so what ComfyUI prints lands in a log.
    $launcher = Join-Path $Repo 'scripts\start-comfyui.ps1'
    $argLine = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`" -ComfyDir `"$ComfyDir`" -Log `"$ComfyLog`"" + $(if ($gpu) { '' } else { ' -Cpu' })
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine -WorkingDirectory $ComfyDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
    # A ComfyUI from an earlier attempt that never answered is stopped first.
    Stop-ScheduledTask -TaskName 'ComfyUI' -EA SilentlyContinue
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" -EA SilentlyContinue |
      Where-Object { "$($_.CommandLine)".IndexOf((Join-Path $ComfyDir 'main.py'), [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
    Register-ScheduledTask -TaskName 'ComfyUI' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName 'ComfyUI'
    # Its first start on a GPU builds caches and can take minutes.
    $deadline = (Get-Date).AddSeconds($ComfyWaitSeconds)
    while ((Get-Date) -lt $deadline -and -not (Answers 'http://127.0.0.1:8188/system_stats')) { Start-Sleep -Seconds 5 }
    if (Answers 'http://127.0.0.1:8188/system_stats') { Write-Host "ok: ComfyUI answers on 127.0.0.1:8188 (task ComfyUI, starts at logon; log $ComfyLog)" }
    else {
      Fail "ComfyUI did not answer on 127.0.0.1:8188 within $ComfyWaitSeconds s after starting the task; the end of $ComfyLog follows"
      if (Test-Path -LiteralPath $ComfyLog) { Get-Content -LiteralPath $ComfyLog -Tail 25 | ForEach-Object { Write-Host "  | $_" } }
      else { Write-Host "  (no log at ${ComfyLog}: the task did not start start-comfyui.ps1)" }
    }
  }
}

# Which generator this machine renders with.
if (-not $Backend) {
  $Backend = if ($InstallComfy -or ((Answers 'http://127.0.0.1:8188/system_stats') -and -not (Answers 'http://127.0.0.1:7860/sdapi/v1/sd-models'))) { 'comfyui' } else { 'a1111' }
}
Write-Host "image backend: $Backend"

# ------------------------------------------------------------ 2. .env.agent (+ service)
$settings = @{ ALPHA_IMAGE_BACKEND = $Backend }
if ($Backend -eq 'a1111') { $settings.ALPHA_IMAGE_URL = 'http://127.0.0.1:7860/sdapi/v1/txt2img' }
else { $settings.ALPHA_COMFYUI_URL = 'http://127.0.0.1:8188'; $settings.ALPHA_COMFYUI_CHECKPOINT = $Checkpoint }
$handlers = Set-AgentHandlers -Repo $Repo -Handlers @('alpha-image', 'alpha-image-file') -Settings $settings -Agent $agent
Write-Host "ok: .env.agent handlers: $($handlers -join ', ')"

if (-not $NoRestart) {
  if (Restart-Agent $agent) { Write-Host 'the agent now offers alpha.image' } else { Fail 'the agent was not restarted, so it does not offer alpha.image yet' }
}
function Repo-Processes([string]$pattern) {
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
    Where-Object { "$($_.CommandLine)" -match $pattern -and "$($_.CommandLine)".IndexOf($Repo, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
}

# ------------------------------------------------------------ 3. bridge + Alpha
if ($Bridge -and -not $NoRestart) {
  if ($Machines -notmatch '^(auto|[A-Za-z0-9][A-Za-z0-9._-]{0,63}(,[A-Za-z0-9][A-Za-z0-9._-]{0,63})*)$') { Fail "machines must be auto or a comma list of agent names, not '$Machines'" }
  else { [Environment]::SetEnvironmentVariable('ALPHA_IMAGE_AGENT', $Machines, 'User'); Write-Host "image bridge machines: $Machines" }
  $launcher = Join-Path $Repo 'scripts\start-image-bridge.ps1'
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`"" -WorkingDirectory $Repo
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName 'alpha-image bridge' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Repo-Processes 'image-bridge\.mjs' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
  Start-ScheduledTask -TaskName 'alpha-image bridge'
  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $deadline -and -not (Answers 'http://127.0.0.1:7861/healthz')) { Start-Sleep -Seconds 3 }
  if (-not (Answers 'http://127.0.0.1:7861/healthz')) { Fail "image bridge did not answer on 127.0.0.1:7861 within 45s; its log: $(Join-Path $env:TEMP 'alpha-image-bridge.log')" }
  else {
    Write-Host "ok: image bridge answers on 127.0.0.1:7861 (task 'alpha-image bridge', starts at logon)"
    # Alpha reads IMAGE_GEN_URL from its environment first, then backend\.env.local.
    $bridgeUrl = 'http://127.0.0.1:7861/sdapi/v1/txt2img'
    $direct = 'http://127.0.0.1:7860/sdapi/v1/txt2img'
    # The same files, in the same order, the doctor reads it from.
    $envLocal = @((Join-Path $AlphaRoot 'backend\.env.local'), (Join-Path $AlphaRoot '.env.local'), (Join-Path (Split-Path $AlphaRoot -Parent) '.env.local')) |
      Where-Object { (Test-Path -LiteralPath $_ -PathType Leaf) -and (Select-String -LiteralPath $_ -Pattern '^\s*IMAGE_GEN_URL\s*=' -Quiet) } | Select-Object -First 1
    if (-not $envLocal) { $envLocal = Join-Path $AlphaRoot 'backend\.env.local' }
    $userVar = [Environment]::GetEnvironmentVariable('IMAGE_GEN_URL', 'User')
    if ($userVar) {
      if ($userVar -ne $bridgeUrl) { $direct = $userVar }
      [Environment]::SetEnvironmentVariable('IMAGE_GEN_URL', $bridgeUrl, 'User')
      $extra = [Environment]::GetEnvironmentVariable('IMAGE_GEN_URLS', 'User')
      if ("$extra" -notmatch [regex]::Escape($direct)) { [Environment]::SetEnvironmentVariable('IMAGE_GEN_URLS', ((@($direct) + @("$extra" -split ',' | Where-Object { $_ })) -join ','), 'User') }
      Write-Host 'ok: IMAGE_GEN_URL (user environment) now goes through the image bridge; the direct generator stays as a fallback'
    } elseif (Test-Path -LiteralPath $envLocal) {
      Copy-Item -LiteralPath $envLocal -Destination "$envLocal.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force
      $al = New-Object System.Collections.ArrayList
      foreach ($l in (Get-Content -LiteralPath $envLocal)) { [void]$al.Add($l) }
      $iu = -1; $ius = -1
      for ($k = 0; $k -lt $al.Count; $k++) {
        if ($al[$k] -match '^\s*IMAGE_GEN_URL\s*=') { $iu = $k }
        if ($al[$k] -match '^\s*IMAGE_GEN_URLS\s*=') { $ius = $k }
      }
      if ($iu -ge 0) { $old = (($al[$iu] -split '=', 2)[1]).Trim().Trim('"', "'"); if ($old -and $old -ne $bridgeUrl) { $direct = $old }; $al[$iu] = "IMAGE_GEN_URL=$bridgeUrl" } else { [void]$al.Add("IMAGE_GEN_URL=$bridgeUrl") }
      if ($ius -ge 0) {
        $cur = (($al[$ius] -split '=', 2)[1]).Trim().Trim('"', "'")
        if ($cur -notmatch [regex]::Escape($direct)) { $al[$ius] = "IMAGE_GEN_URLS=" + ((@($direct) + @($cur -split ',' | Where-Object { $_ })) -join ',') }
      } else { [void]$al.Add("IMAGE_GEN_URLS=$direct") }
      [IO.File]::WriteAllLines($envLocal, [string[]]$al, (New-Object Text.UTF8Encoding($false)))
      Write-Host "ok: ${envLocal}: IMAGE_GEN_URL goes through the image bridge; the direct generator stays as a fallback (backed up)"
    } else { Fail "no IMAGE_GEN_URL to repoint: neither the user environment nor $envLocal has one" }
    if (Get-ScheduledTask -TaskName 'Alpha Backend' -EA SilentlyContinue) {
      & schtasks.exe /End /TN 'Alpha Backend' 2>&1 | Out-Null
      Start-Sleep -Seconds 3
      & schtasks.exe /Run /TN 'Alpha Backend' 2>&1 | Out-Null
      Write-Host "restarted task 'Alpha Backend' so it reads the new image route"
    }
  }
}

if ($failed.Count) { exit 1 }
Write-Host 'done: this machine renders images for Alpha through the tunnel'
exit 0

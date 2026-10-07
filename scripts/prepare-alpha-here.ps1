<#
.SYNOPSIS
  Phase 1 of the Alpha move (docs/HANDOFF_2026-10-07d_alpha-moves-to-host.md):
  prepare a copy of Alpha on a machine that does not run Alpha yet, without
  starting it or connecting it to alpha-ai.uk.

.DESCRIPTION
  The owner decided (2026-10-07) that the Host runs Alpha as well as the
  coordinator. The Claude session meant to prepare it ran out of its usage
  allowance after one step, so this is the same work as an autopilot job:

    1. code      clone vyos88/Alpha at the branch Laptop41 runs into
                 <profile>\Downloads\VyoS-advance-tech-ai, or fast-forward a
                 clone already there (never over local changes)
    2. backend   a .venv beside software\ with the backend's requirements
    3. site      npm ci (npm install without a lockfile), then the build
    4. chat      start Ollama if it is not answering, pull llama3.2:3b
    5. connector install cloudflared if it is missing. Nothing is started:
                 no tunnel, no service. Only one machine may run the
                 alpha-ai.uk connector, and until the switch-over that is
                 Laptop41.

  What it never does: start the backend or the site, copy or create
  .env.local, touch Alpha's data, change a scheduled task, or run anything
  named by the payload (the autopilot passes it nothing).

  It refuses outright on a machine where something already listens on
  Alpha's backend port (8001): that machine runs Alpha, and preparing a
  second copy beside a live one is how the wrong one gets edited.

  Each step is independent where it can be: a failed site build does not stop
  the chat model being pulled. Exit 0 when every step is ready, 2 when any is
  not, 1 when it refused to start.

  -DryRun prints what it would do and changes nothing.
#>
param(
  [string]$Target = '',
  [string]$Branch = 'claude/friendly-wright-jw4ep6-route-b',
  [string]$Repo = 'https://github.com/vyos88/Alpha.git',
  [string]$Model = 'llama3.2:3b',
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
if (-not $Target) {
  $profileDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
  $Target = Join-Path (Join-Path $profileDir 'Downloads') 'VyoS-advance-tech-ai'
}
# The live branch keeps what Laptop41 has in VyoS-advance-tech-ai under
# BuildArtifacts\installers\Alpha-Full (live-sync.mjs, apply-alpha-update.mjs).
# The first run looked for software\ at the top of the clone and called a good
# clone empty.
$AppSubdir = 'BuildArtifacts\installers\Alpha-Full'
function Resolve-AlphaHome {
  $nested = Join-Path $Target $AppSubdir
  if (Test-Path (Join-Path $nested 'software')) { return $nested }
  $Target
}
$alphaHome = Resolve-AlphaHome
$software = Join-Path $alphaHome 'software'
$failed = New-Object System.Collections.ArrayList
function Say([string]$t) { Write-Output $t }
function Fail([string]$step, [string]$why) { [void]$failed.Add($step); Say "  NOT READY: $why" }
function Tail($lines, [int]$n = 3) { @($lines | ForEach-Object { "$_" } | Where-Object { $_.Trim() } | Select-Object -Last $n) | ForEach-Object { Say "    | $_" } }

$machine = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { [Environment]::MachineName }
Say ("PREPARE ALPHA HERE {0} {1}{2}" -f $machine, (Get-Date).ToString('yyyy-MM-dd HH:mm'), $(if ($DryRun) { ' (dry run: nothing changes)' } else { '' }))
Say "  target $Target, branch $Branch"

# ---------------------------------------------------------------- guard
$live = $null
$live = Get-NetTCPConnection -LocalPort 8001 -State Listen -EA SilentlyContinue | Select-Object -First 1
if ($live) {
  Say "REFUSED: something already listens on 8001 (pid $($live.OwningProcess)): this machine runs Alpha. Prepare only a machine that does not."
  exit 1
}
if ((Test-Path $Target) -and -not (Test-Path (Join-Path $Target '.git'))) {
  Say "REFUSED: $Target exists and is not a git checkout. Move it aside or prepare elsewhere; nothing was changed."
  exit 1
}

# ---------------------------------------------------------------- 1. code
Say '1. code'
if ($DryRun) {
  if (Test-Path $Target) { Say "  would fast-forward $Target to origin/$Branch" } else { Say "  would clone $Repo ($Branch) into $Target" }
} elseif (-not (Test-Path $Target)) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Target) | Out-Null
  $out = git clone --quiet --branch $Branch --single-branch $Repo $Target 2>&1
  if ($LASTEXITCODE -ne 0) { Fail 'code' 'git clone failed (is vyos88/Alpha reachable with this account''s git credentials?)'; Tail $out }
  else { Say ("  cloned: {0}" -f (git -C $Target log -1 --format='%h %cd %s' --date=format:'%m-%d %H:%M' 2>$null)) }
} else {
  $dirty = git -C $Target status --porcelain 2>$null
  $have = git -C $Target rev-parse --abbrev-ref HEAD 2>$null
  if ($have -ne $Branch) { Fail 'code' "the checkout is on '$have', not $Branch; left as it is" }
  elseif ($dirty) { Fail 'code' 'the checkout has local changes; left as it is (never pulled over local work)' }
  else {
    $out = git -C $Target pull --quiet --ff-only origin $Branch 2>&1
    if ($LASTEXITCODE -ne 0) { Fail 'code' 'fast-forward failed'; Tail $out }
    else { Say ("  up to date: {0}" -f (git -C $Target log -1 --format='%h %cd %s' --date=format:'%m-%d %H:%M' 2>$null)) }
  }
}
$alphaHome = Resolve-AlphaHome
$software = Join-Path $alphaHome 'software'
$haveCode = Test-Path (Join-Path $software 'backend\main.py')
if (-not $DryRun -and -not $haveCode -and -not ($failed -contains 'code')) { Fail 'code' "no software\backend\main.py in $Target or $(Join-Path $Target $AppSubdir)" }
elseif ($haveCode) { Say "  Alpha's software\ is $software" }

# ---------------------------------------------------------------- 2. backend
Say '2. backend'
$venvPy = Join-Path $alphaHome '.venv\Scripts\python.exe'
$reqs = @('backend\requirements.txt', 'requirements.txt', 'backend\requirements-windows.txt') | ForEach-Object { Join-Path $software $_ } | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($DryRun) { Say "  would create $venvPy and install the backend's requirements" }
elseif (-not $haveCode) { Fail 'backend' 'no code yet' }
elseif (-not $reqs) { Fail 'backend' "no requirements file under $software" }
else {
  if (-not (Test-Path $venvPy)) {
    $py = Get-Command py -EA SilentlyContinue
    $out = if ($py) { & py -3 -m venv (Join-Path $alphaHome '.venv') 2>&1 } else { & python -m venv (Join-Path $alphaHome '.venv') 2>&1 }
    if (-not (Test-Path $venvPy)) { Fail 'backend' 'could not create the venv'; Tail $out }
  }
  if (Test-Path $venvPy) {
    $out = & $venvPy -m pip install --disable-pip-version-check --quiet -r $reqs 2>&1
    if ($LASTEXITCODE -ne 0) { Fail 'backend' "pip install -r $(Split-Path -Leaf $reqs) failed"; Tail $out 4 }
    else { Say ("  venv ready ({0}), requirements from {1}" -f ((& $venvPy --version 2>&1) -as [string]).Trim(), $reqs.Substring($software.Length + 1)) }
  }
}

# ---------------------------------------------------------------- 3. site
Say '3. site'
$front = Join-Path $software 'frontend'
if ($DryRun) { Say "  would run npm ci and the build in $front" }
elseif (-not (Test-Path (Join-Path $front 'package.json'))) { Fail 'site' 'no frontend\package.json yet' }
else {
  Push-Location $front
  try {
    $cmd = if (Test-Path 'package-lock.json') { 'ci' } else { 'install' }
    $npm = if (Get-Command npm.cmd -EA SilentlyContinue) { 'npm.cmd' } else { 'npm' }
    $out = & $npm $cmd --no-audit --no-fund 2>&1
    if ($LASTEXITCODE -ne 0) { Fail 'site' "npm $cmd failed"; Tail $out 4 }
    else {
      $out = & $npm run build 2>&1
      if ($LASTEXITCODE -ne 0) {
        Fail 'site' 'the build failed (a file the branch lacks is BACKLOG L3: report it, never copy it in by hand)'
        Tail ($out | Where-Object { $_ -match '(?i)error|could not resolve|not found|failed' }) 4
      } elseif (Test-Path 'dist\index.html') { Say '  built: dist\index.html' }
      else { Fail 'site' 'the build exited 0 but wrote no dist\index.html' }
    }
  } finally { Pop-Location }
}

# ---------------------------------------------------------------- 4. chat
Say '4. chat'
$ollama = Get-Command ollama -EA SilentlyContinue
if ($DryRun) { Say "  would make sure Ollama answers and pull $Model" }
elseif (-not $ollama) { Fail 'chat' 'Ollama is not installed' }
else {
  $null = & ollama list 2>&1
  if ($LASTEXITCODE -ne 0) {
    $app = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama app.exe'
    if (Test-Path $app) { Start-Process -FilePath $app -WindowStyle Hidden } else { Start-Process -FilePath $ollama.Source -ArgumentList 'serve' -WindowStyle Hidden }
    foreach ($i in 1..30) { Start-Sleep -Seconds 2; $null = & ollama list 2>&1; if ($LASTEXITCODE -eq 0) { break } }
  }
  $null = & ollama list 2>&1
  if ($LASTEXITCODE -ne 0) { Fail 'chat' 'Ollama did not start answering within a minute' }
  else {
    $out = & ollama pull $Model 2>&1
    if ($LASTEXITCODE -ne 0) { Fail 'chat' "ollama pull $Model failed"; Tail $out }
    else { Say "  $Model is here" }
  }
}

# ---------------------------------------------------------------- 5. connector
Say '5. connector (installed only; never started here)'
if (Get-Command cloudflared -EA SilentlyContinue) { Say ("  {0}" -f ((cloudflared --version 2>&1 | Select-Object -First 1) -as [string]).Trim()) }
elseif ($DryRun) { Say '  would install cloudflared with winget' }
elseif (-not (Get-Command winget -EA SilentlyContinue)) { Fail 'connector' 'cloudflared is missing and winget is not available' }
else {
  $out = winget install --id Cloudflare.cloudflared -e --silent --accept-package-agreements --accept-source-agreements --disable-interactivity 2>&1
  $exe = @('C:\Program Files (x86)\cloudflared\cloudflared.exe', 'C:\Program Files\cloudflared\cloudflared.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($exe) { Say "  installed: $exe (not started)" } else { Fail 'connector' 'winget did not install cloudflared'; Tail $out }
}

# ---------------------------------------------------------------- summary
$os = Get-CimInstance Win32_OperatingSystem -EA SilentlyContinue
if ($os) { Say ('RAM: {0:N1} GB free of {1:N1} GB' -f ($os.FreePhysicalMemory / 1MB), ($os.TotalVisibleMemorySize / 1MB)) }
Say 'STILL NEEDED FROM A PERSON: .env.local and Alpha''s memory\ from Laptop41 (by USB or LAN, never git), then the switch-over (Phase 2)'
if ($DryRun) { Say 'RESULT: dry run'; exit 0 }
if ($failed.Count) { Say ("RESULT: not ready: {0}" -f (($failed | Select-Object -Unique) -join ', ')); exit 2 }
Say 'RESULT: ready for the data copy'
exit 0

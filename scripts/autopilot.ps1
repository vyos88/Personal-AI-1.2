<#
.SYNOPSIS
  Runs the repairs a Claude session queues in this repository, so nobody has
  to paste commands into PowerShell.

.DESCRIPTION
  A cloud session cannot reach the tailnet, so until now every repair on
  Laptop41 was a block of commands for a person to paste: on the right
  laptop, in the right folder, without a stray character. This closes that
  loop. Every few minutes, on this machine only, it:

    1. fast-forwards this checkout (scripts\self-update.mjs: never over local
       work, never a merge);
    2. reads actions.json from the branch control/<channel>;
    3. runs each action it has not run before, and only from the fixed menu
       below. Anything else is refused and reported, never run;
    4. pushes what happened (exit code, the last lines of output, with
       anything secret-looking cut) to status/<channel>-autopilot.

  The menu (actions.json: {"actions":[{"id":"...","do":"...", ...}]}):
    doctor           laptop41-doctor.ps1 -Watch -Push
    repair-host      repair-alpha-host.ps1 (keeps its own rollback)
    restart-backend  stop whatever listens on Alpha's backend port, start it again
    restart-site     stop whatever listens on the site's port (4173) and its tree, start task 'Alpha' again
    apply-update     apply-alpha-update.mjs --apply --restart   ("skipScripts": true)
    snapshot         snapshot-alpha-live.mjs --push             ("allow": "file:line,...", "includeNew": true)
    ollama-pull      ollama pull <"model">
    enable-music     enable-music.ps1: MusicGen, alpha-music handlers, agent restart  ("bridge": true, "dryRun": true)
    enable-image     enable-image.ps1: alpha-image handlers, agent restart  ("bridge": true, "installComfy": true, "backend": "a1111"|"comfyui")
    live-test        live-test-creators.mjs: real tracks, images and a reel  ("count": 1-6, "only": "music"|"image"|"video")
    ollama-keepalive ollama-keepalive.ps1: keep the chat model loaded   ("keepAlive": "24h", "model")
    brain-topology   brain-topology-check.mjs: the brain deck's links, source to served build  ("fix": true, "branch": "<alpha branch>")
    panel-endpoint   panel-endpoint.ps1: point the USB-attached deck at this machine's home-network backend
    start-task       Start-ScheduledTask <"task">: Alpha, Alpha Backend, Alpha Self-Heal, Alpha Doctor

  Each id runs once. To run something again, queue it under a new id.

  Standing check, every pass, no id needed: when actions.json carries
  {"autofix": {"brainTopology": {"branch": "<alpha branch>"}}}, the brain
  deck's links are checked on each pass and, when this machine serves the old
  deck, the fixed one is brought in from that branch (apply-alpha-update.mjs,
  with its backups and rollback). It reports only when the result changes, and
  tries a fix once per version of the deck's source.

  It refuses to run on any machine but -ExpectHost, so a copy on the wrong
  laptop does nothing.

  Install once, from an Administrator PowerShell on Laptop41:
    cd C:\services\alpha-tunnel; git pull
    powershell -ExecutionPolicy Bypass -File scripts\autopilot.ps1 -Install
  Remove:  ... scripts\autopilot.ps1 -Uninstall

  The task runs as you, elevated, while you are logged on: repairs need
  Administrator, and pushing needs your git credentials.
#>

param(
  [string]$AlphaRoot = 'C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software',
  [string]$OpsDir = 'C:\AlphaData\alpha-ops',
  [string]$ExpectHost = 'DESKTOP-41HPLCN',
  [string]$Channel = 'laptop41',
  [int]$EveryMinutes = 5,
  # How long one pass may take; the task's own time limit, read below, wins.
  [int]$PassMinutes = 100,
  [switch]$Install,
  [switch]$Uninstall,
  # Print what an actions file would run, as JSON, and run nothing.
  [string]$Plan,
  # Set by a pass that has just updated this checkout and hands the rest of
  # the pass to the new code; such a run does not update again.
  [switch]$AfterUpdate
)

$ErrorActionPreference = 'Continue'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$taskName = 'Alpha Autopilot'
$tasksAllowed = @('Alpha', 'Alpha Backend', 'Alpha Self-Heal', 'Alpha Doctor')

function Ps1([string]$file, [string[]]$rest) {
  @{ exe = 'powershell.exe'; args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot $file)) + $rest }
}

# One queued action -> what to run, or why not. Never runs anything itself.
function Resolve-Action($a) {
  $id = [string]$a.id
  $do = [string]$a.do
  $out = [ordered]@{ id = $id; do = $do; ok = $false; reason = $null; exe = $null; args = @(); internal = $null; timeoutMin = 10 }
  if ($id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { $out.reason = 'id must be 1-64 letters, digits, dot, dash or underscore'; return $out }
  $spec = $null
  switch ($do) {
    'doctor'          { $spec = Ps1 'laptop41-doctor.ps1' @('-Watch', '-Push', '-AlphaRoot', $AlphaRoot); $out.timeoutMin = 12 }
    'repair-host'     { $spec = Ps1 'repair-alpha-host.ps1' @('-AlphaRoot', $AlphaRoot); $out.timeoutMin = 45 }
    'restart-backend' { $out.internal = 'restart-backend'; $out.timeoutMin = 3 }
    'restart-site'    { $out.internal = 'restart-site'; $out.timeoutMin = 4 }
    'restart-coordinator' { $out.internal = 'restart-coordinator'; $out.timeoutMin = 4 }
    'apply-update' {
      $rest = @((Join-Path $PSScriptRoot 'apply-alpha-update.mjs'), '--alpha-root', $AlphaRoot, '--apply', '--restart')
      if ($a.skipScripts -eq $true) { $rest += '--skip-scripts' }
      # A host branch (this machine's live code plus fixes, alpha-from-host-*
      # based) keeps its own applied record; its first run names the commit
      # this machine matches.
      if ($a.branch) {
        if ([string]$a.branch -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$' -or [string]$a.branch -match '\.\.') { $out.reason = 'branch must be a plain branch name'; return $out }
        $rest += @('--branch', [string]$a.branch)
      }
      if ($a.from) {
        if ([string]$a.from -notmatch '^[0-9a-f]{40}$') { $out.reason = 'from must be a full 40-character commit id'; return $out }
        $rest += @('--from', [string]$a.from)
      }
      $spec = @{ exe = 'node'; args = $rest }; $out.timeoutMin = 45
    }
    'snapshot' {
      $rest = @((Join-Path $PSScriptRoot 'snapshot-alpha-live.mjs'), '--alpha-root', $AlphaRoot, '--push')
      if ($a.includeNew -eq $true) { $rest += '--include-new' }
      if ($a.allow) {
        $items = ([string]$a.allow).Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
        $bad = @($items | Where-Object { $_ -notmatch '^[A-Za-z0-9_./-]+:\d+$' })
        if ($bad.Count) { $out.reason = "allow entries must be path:line ($($bad.Count) are not)"; return $out }
        $rest += @('--allow', ($items -join ','))
      }
      $spec = @{ exe = 'node'; args = $rest }; $out.timeoutMin = 30
    }
    'enable-music' {
      $rest = @()
      if ($a.bridge -eq $true) { $rest += '-Bridge' }
      if ($a.dryRun -eq $true) { $rest += '-DryRun' }
      if ($a.machines) {
        if ([string]$a.machines -notmatch '^(auto|[A-Za-z0-9][A-Za-z0-9._-]{0,63}(,[A-Za-z0-9][A-Za-z0-9._-]{0,63})*)$') { $out.reason = 'machines must be auto or a comma list of agent names'; return $out }
        $rest += @('-Machines', [string]$a.machines)
      }
      # The first run downloads torch.
      $spec = Ps1 'enable-music.ps1' $rest; $out.timeoutMin = 60
    }
    'enable-image' {
      $rest = @()
      if ($a.bridge -eq $true) { $rest += '-Bridge' }
      if ($a.installComfy -eq $true) { $rest += '-InstallComfy' }
      if ($a.machines) {
        if ([string]$a.machines -notmatch '^(auto|[A-Za-z0-9][A-Za-z0-9._-]{0,63}(,[A-Za-z0-9][A-Za-z0-9._-]{0,63})*)$') { $out.reason = 'machines must be auto or a comma list of agent names'; return $out }
        $rest += @('-Machines', [string]$a.machines)
      }
      if ($a.backend) {
        if ([string]$a.backend -notin @('a1111', 'comfyui')) { $out.reason = 'backend must be a1111 or comfyui'; return $out }
        $rest += @('-Backend', [string]$a.backend)
      }
      if ($AlphaRoot) { $rest += @('-AlphaRoot', $AlphaRoot) }
      # ComfyUI, torch and a 4 GB checkpoint on the first run.
      $spec = Ps1 'enable-image.ps1' $rest; $out.timeoutMin = 120
    }
    'live-test' {
      $rest = @((Join-Path $PSScriptRoot 'live-test-creators.mjs'))
      if ($null -ne $a.count) {
        $n = 0
        if (-not [int]::TryParse([string]$a.count, [ref]$n) -or $n -lt 1 -or $n -gt 6) { $out.reason = 'count must be 1 to 6'; return $out }
        $rest += @('--count', "$n")
      }
      if ($a.only) {
        if ([string]$a.only -notin @('music', 'image', 'video')) { $out.reason = 'only must be music, image or video'; return $out }
        $rest += @('--only', [string]$a.only)
      }
      # The reel is made the way Alpha makes one: its renderer, with the
      # Python the backend runs (whatever listens on 8001).
      # String work, not Join-Path: -Plan runs where that drive may not exist.
      $rest += @('--video-script', (($AlphaRoot -replace '[\\/][^\\/]+[\\/]?$', '') + '\scripts\alpha_video_creator.py'))
      $held = if (Get-Command Get-NetTCPConnection -EA SilentlyContinue) { Get-NetTCPConnection -LocalPort 8001 -State Listen -EA SilentlyContinue | Select-Object -First 1 }
      $py = if ($held) { (Get-Process -Id $held.OwningProcess -EA SilentlyContinue).Path }
      if ($py) { $rest += @('--video-python', $py) }
      $spec = @{ exe = 'node'; args = $rest }; $out.timeoutMin = 45
    }
    'ollama-pull' {
      $model = [string]$a.model
      if ($model -notmatch '^[a-z0-9][a-z0-9._-]{0,63}(:[a-z0-9._-]{1,63})?$') { $out.reason = 'model must look like name:tag'; return $out }
      $spec = @{ exe = 'ollama'; args = @('pull', $model) }; $out.timeoutMin = 60
    }
    'ollama-keepalive' {
      $rest = @()
      if ($a.keepAlive) {
        if ([string]$a.keepAlive -notmatch '^(-1|[1-9][0-9]{0,4}[smh]?)$') { $out.reason = 'keepAlive must be -1 or a duration like 30m or 24h'; return $out }
        $rest += @('-KeepAlive', [string]$a.keepAlive)
      }
      if ($a.model) {
        if ([string]$a.model -notmatch '^[a-z0-9][a-z0-9._-]{0,63}(:[a-z0-9._-]{1,63})?$') { $out.reason = 'model must look like name:tag'; return $out }
        $rest += @('-Model', [string]$a.model)
      }
      $spec = Ps1 'ollama-keepalive.ps1' $rest; $out.timeoutMin = 10
    }
    'brain-topology' {
      $rest = @((Join-Path $PSScriptRoot 'brain-topology-check.mjs'), '--alpha-root', $AlphaRoot, '--ops', $OpsDir)
      if ($a.fix -eq $true) {
        if (-not $a.branch -or [string]$a.branch -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$' -or [string]$a.branch -match '\.\.') { $out.reason = 'fix needs branch, a plain branch name'; return $out }
        $rest += @('--fix', '--branch', [string]$a.branch, '--retry-hours', '0')
      }
      $spec = @{ exe = 'node'; args = $rest }; $out.timeoutMin = 45
    }
    # Points the CrowPanel deck plugged into this machine at this machine's
    # own home-network address. Takes nothing from the action: the URL is
    # worked out on the machine, and a Wi-Fi passphrase never travels here.
    'panel-endpoint'  { $spec = Ps1 'panel-endpoint.ps1' @(); $out.timeoutMin = 3 }
    'fleet-inventory' { $spec = Ps1 'fleet-inventory.ps1' @('-AlphaRoot', $AlphaRoot); $out.timeoutMin = 3 }
    'start-task' {
      $t = [string]$a.task
      if ($tasksAllowed -notcontains $t) { $out.reason = "task must be one of: $($tasksAllowed -join ', ')"; return $out }
      $out.internal = 'start-task'; $out.args = @($t); $out.timeoutMin = 2
    }
    default { $out.reason = "not on the menu: '$do'"; return $out }
  }
  if ($spec) { $out.exe = $spec.exe; $out.args = $spec.args }
  $out.ok = $true
  $out
}

# Cut anything that looks like a credential before a line leaves the machine.
function Redact([string]$t) {
  # Progress bars (ollama, npm) redraw with escape codes and carriage returns:
  # keep only what the line finally said.
  $t = $t -replace '\x1b\[[0-9;?]*[A-Za-z]', ''
  if ($t.Contains("`r")) { $t = ($t -split "`r" | Where-Object { $_.Trim() } | Select-Object -Last 1) }
  $t = $t -replace 'alpha_key_[A-Za-z0-9_\-]+', 'alpha_key_...'
  $t = $t -replace '(?i)((password|passwd|token|secret|api[_-]?key|authorization)["'']?\s*[:=]\s*["'']?)[^\s"'',;]+', '$1...'
  $t = $t -replace '(?i)(bearer\s+)[A-Za-z0-9._\-]+', '$1...'
  # Long runs of letters and digits, but not a git hash or a snapshot branch name.
  [regex]::Replace($t, '[A-Za-z0-9_\-+=]{24,}', {
    param($m)
    $v = $m.Value
    if ($v -match '^[0-9a-f]{7,40}$' -or $v -match '^alpha-from-host-[0-9-]+$' -or $v -notmatch '\d' -or $v -notmatch '[A-Za-z]') { return $v }
    $v.Substring(0, 4) + "...($($v.Length))"
  })
}

if ($Plan) {
  $doc = Get-Content -LiteralPath $Plan -Raw | ConvertFrom-Json
  $plans = @(@($doc.actions) | Where-Object { $_ } | ForEach-Object { Resolve-Action $_ })
  ConvertTo-Json -InputObject $plans -Depth 5 -Compress
  exit 0
}

if ($env:COMPUTERNAME -and $ExpectHost -and $env:COMPUTERNAME -ne $ExpectHost) {
  Write-Host "This is $env:COMPUTERNAME, not ${ExpectHost}: the autopilot does nothing here." -ForegroundColor Yellow
  exit 3
}

# ------------------------------------------------------------ install
if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -EA SilentlyContinue
  Write-Host "removed '$taskName'"
  exit 0
}
if ($Install) {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $admin) { Write-Host 'Run this from an Administrator PowerShell (repairs need it).' -ForegroundColor Red; exit 1 }
  # A machine without Alpha (the Host runs the coordinator and an agent) still
  # gets the actions that need none: enable-music, ollama-*.
  if (-not (Test-Path -LiteralPath $AlphaRoot)) { Write-Host "No Alpha at ${AlphaRoot}: actions that need Alpha (doctor, apply-update, snapshot, restart-backend) will fail here; the rest work." -ForegroundColor Yellow }
  $argLine = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -AlphaRoot `"$AlphaRoot`" -OpsDir `"$OpsDir`" -ExpectHost `"$ExpectHost`" -Channel `"$Channel`""
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine -WorkingDirectory $repo
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
                -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 6)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  Write-Host "installed '$taskName': every $EveryMinutes minutes, runs what control/$Channel queues, reports to status/$Channel-autopilot." -ForegroundColor Green
  Write-Host "remove: powershell -ExecutionPolicy Bypass -File scripts\autopilot.ps1 -Uninstall"
  exit 0
}

# ------------------------------------------------------------ one pass
$dir = Join-Path $OpsDir 'autopilot'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$statePath = Join-Path $dir 'state.json'
$state = $null
if (Test-Path -LiteralPath $statePath) { try { $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { } }
$done = [ordered]@{}
if ($state -and $state.done) { foreach ($p in $state.done.PSObject.Properties) { $done[$p.Name] = $p.Value } }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$passStart = Get-Date
# Entries that ran in a pass that never got to report (the task's time limit
# stopped it): they are reported by this one.
$pending = @()
if ($state -and $state.pending) { $pending = @($state.pending) }

# Task Scheduler stops a pass at the task's time limit, and on 2026-10-06
# Worker1's queue (music, the route update, images, a live test) needed more
# than the 2 hours it was installed with. A pass that is stopped loses nothing
# now (progress is saved after every action), but it should not be stopped:
# raise the limit to 6 hours once, and plan this pass inside whatever it is.
if (Get-Command Get-ScheduledTask -EA SilentlyContinue) {
  try {
    $self = Get-ScheduledTask -TaskName $taskName -EA Stop
    $limit = [string]$self.Settings.ExecutionTimeLimit
    $span = if ($limit -and $limit -ne 'PT0S') { [Xml.XmlConvert]::ToTimeSpan($limit) } else { [TimeSpan]::FromHours(10) }
    if ($span.TotalHours -lt 6) {
      $self.Settings.ExecutionTimeLimit = 'PT6H'
      Set-ScheduledTask -InputObject $self -EA Stop | Out-Null
      Write-Host "raised '$taskName' time limit from $limit to 6 hours"
      # This pass still runs under the old limit.
    }
    $PassMinutes = [math]::Max(20, [int]$span.TotalMinutes - 10)
  } catch { }
}

# 1. Current code first: a new action on the menu arrives with the code that runs it.
if ($AfterUpdate) { $update = ''; $updateExit = 0 }
else {
  $update = & node (Join-Path $PSScriptRoot 'self-update.mjs') --repo $repo 2>&1 | Out-String
  $updateExit = $LASTEXITCODE
}
if ($updateExit -eq 10) {
  # The checkout moved under this pass. Stopping here left the pass silent:
  # on 2026-10-07 main moved every few minutes from 02:15 to 02:30 UTC, and
  # four passes in a row updated and stopped with no action run and no report
  # (not even the live report, which exists to say the reporter is alive).
  # The rest of the pass runs with the new code instead, in a new process,
  # once: that run does not update again.
  Write-Host 'updated this checkout; running the rest of this pass with the new code'
  $forward = @()
  foreach ($k in $PSBoundParameters.Keys) {
    $v = $PSBoundParameters[$k]
    if ($v -is [System.Management.Automation.SwitchParameter]) { if ($v.IsPresent) { $forward += "-$k" } }
    else { $forward += @("-$k", [string]$v) }
  }
  & (Get-Process -Id $PID).Path -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath @forward -AfterUpdate
  exit $LASTEXITCODE
}
# A checkout that cannot update is silent otherwise, and every fix sent through
# this repository then stops reaching the machine. Say why, in every report.
$head = (git -C $repo rev-parse --short HEAD 2>$null | Out-String).Trim()
$checkoutNote = "checkout $head is current"
if ($updateExit -ne 0) {
  $why = ($update -split "`r?`n" | Where-Object { $_ -match 'reason|refus|uncommitted|diverg|fail|error' } | Select-Object -First 3) -join ' / '
  $paths = @(git -C $repo status --porcelain 2>$null | Select-Object -First 15)
  $checkoutNote = "checkout $head did NOT update (self-update exit $updateExit): $why" +
    $(if ($paths.Count) { "; local changes: " + ($paths -join ', ') } else { '' })
}

# 2. What is queued.
# Nothing queued is not a reason to stop here: a checkout that cannot update
# is still reported below.
$queued = @()
$control = $null
git -C $repo fetch -q origin "control/$Channel" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "nothing queued (no control/$Channel branch)" }
else {
  $raw = git -C $repo show 'FETCH_HEAD:actions.json' 2>$null | Out-String
  if (-not $raw.Trim()) { Write-Host 'nothing queued' }
  else {
    try { $control = ConvertFrom-Json $raw; $queued = @(@($control.actions) | Where-Object { $_ }) } catch { Write-Host "actions.json does not parse: $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
  }
}

# 2b. The bridges come back by themselves. Both are logon tasks on this
# machine; on 2026-10-06 the music (8790) and image (7861) bridges were found
# down together, and Alpha's IMAGE_GEN_URL points through 7861, so chat images
# failed until someone noticed. A registered bridge task with nothing on its
# port is started again here, before any queued action (a live test needs them).
$ran = New-Object System.Collections.ArrayList
$bridgeLines = New-Object System.Collections.ArrayList
if ((Get-Command Get-ScheduledTask -EA SilentlyContinue) -and (Get-Command Get-NetTCPConnection -EA SilentlyContinue)) {
  foreach ($b in @(@{ task = 'alpha-music bridge'; port = 8790; log = 'alpha-music-bridge.log' }, @{ task = 'alpha-image bridge'; port = 7861; log = 'alpha-image-bridge.log' })) {
    $registered = Get-ScheduledTask -TaskName $b.task -EA SilentlyContinue
    if (-not $registered) { continue }
    if (Get-NetTCPConnection -LocalPort $b.port -State Listen -EA SilentlyContinue) { continue }
    # Why it went down, before it is restarted: whether the launcher loop was
    # still running (only node died) or the whole task was ended, and the end
    # of its log. Keys are masked; the bridges never log them, but be sure.
    $info = Get-ScheduledTaskInfo -TaskName $b.task -EA SilentlyContinue
    [void]$bridgeLines.Add("'$($b.task)' task was $($registered.State); last run $($info.LastRunTime), last result 0x$('{0:X}' -f [int64]$info.LastTaskResult)")
    $logFile = Join-Path $env:TEMP $b.log
    if (Test-Path -LiteralPath $logFile) {
      Get-Content -LiteralPath $logFile -Tail 6 -EA SilentlyContinue | ForEach-Object {
        $line = ("$_" -replace '(alpha_key_|sk-|ghp_|github_pat_)\S+', '$1***' -replace '[A-Za-z0-9+/_=-]{32,}', '***')
        [void]$bridgeLines.Add("  log: $($line.Substring(0, [math]::Min(200, $line.Length)))")
      }
    } else { [void]$bridgeLines.Add("  no log at $logFile") }
    # A launcher loop that is still running but whose node died cannot be
    # told apart from outside: end the task's instance, then start it fresh.
    Stop-ScheduledTask -TaskName $b.task -EA SilentlyContinue
    Start-ScheduledTask -TaskName $b.task -EA SilentlyContinue
    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline -and -not (Get-NetTCPConnection -LocalPort $b.port -State Listen -EA SilentlyContinue)) { Start-Sleep -Seconds 3 }
    $up = [bool](Get-NetTCPConnection -LocalPort $b.port -State Listen -EA SilentlyContinue)
    [void]$bridgeLines.Add("'$($b.task)' was not listening on $($b.port): restarted, " + $(if ($up) { 'it answers now' } else { "still nothing on $($b.port) after 45s (its log is in %TEMP%)" }))
  }
}
if ($bridgeLines.Count) {
  [void]$ran.Add([ordered]@{ id = "auto-bridges-$stamp"; do = 'bridges (standing)'; result = $(if (($bridgeLines -join ' ') -match 'still nothing') { '1 (still down)' } else { '0 (restarted)' }); at = (Get-Date).ToString('s'); seconds = 0; tail = ($bridgeLines -join "`n") })
  $bridgeLines | ForEach-Object { Write-Host $_ }
}

# 3. Run what has not run.
$queuedRan = 0
foreach ($a in $queued) {
  $p = Resolve-Action $a
  if (-not $p.id -or $done.Contains($p.id)) { continue }
  # One long action may run past the plan, but none starts that would not fit:
  # it waits for the next pass, and so does everything queued after it.
  $elapsed = ((Get-Date) - $passStart).TotalMinutes
  if ($queuedRan -and $p.ok -and ($elapsed + [int]$p.timeoutMin) -gt $PassMinutes) {
    Write-Host ("{0} {1}: deferred to the next pass ({2:N0} of {3} minutes used, it may take {4})" -f $p.id, $p.do, $elapsed, $PassMinutes, $p.timeoutMin)
    break
  }
  $started = Get-Date
  $log = Join-Path $dir "$stamp-$($p.id).log"
  $code = $null
  $text = ''
  if (-not $p.ok) {
    $code = 'refused'; $text = $p.reason
  } elseif ($p.internal -eq 'start-task') {
    try { Start-ScheduledTask -TaskName $p.args[0] -EA Stop; $code = 0; $text = "started '$($p.args[0])'" } catch { $code = 1; $text = $_.Exception.Message }
  } elseif ($p.internal -eq 'restart-site') {
    # Stop-ScheduledTask ends the task's cmd.exe and can leave the preview
    # server on the port: then the task cannot start a new one, and the old
    # one keeps serving its old vite.config (Worker1, 2026-10-06: /music 404).
    $port = 4173
    $lines = New-Object System.Collections.ArrayList
    Stop-ScheduledTask -TaskName 'Alpha' -EA SilentlyContinue
    $held = @(Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue | ForEach-Object OwningProcess | Select-Object -Unique)
    foreach ($procId in $held) { taskkill.exe /T /F /PID $procId 2>&1 | Out-Null; [void]$lines.Add("stopped pid $procId (and its children) on $port") }
    if (-not $held.Count) { [void]$lines.Add("nothing listened on $port") }
    Start-Sleep -Seconds 3
    if (Get-ScheduledTask -TaskName 'Alpha' -EA SilentlyContinue) { Start-ScheduledTask -TaskName 'Alpha'; [void]$lines.Add("started task 'Alpha'") }
    else { [void]$lines.Add("no task 'Alpha' to start the site with") }
    $deadline = (Get-Date).AddSeconds(180)
    while ((Get-Date) -lt $deadline -and -not (Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue)) { Start-Sleep -Seconds 5 }
    $now = @(Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue | ForEach-Object OwningProcess | Select-Object -Unique)
    $up = [bool]$now.Count
    [void]$lines.Add($(if ($up) { "site listening on $port (pid $($now -join ', '))" } else { "site NOT listening on $port after 180s" }))
    if ($up) {
      $music = ''
      foreach ($scheme in 'https', 'http') { if (-not $music) { $music = (& curl.exe -s -k --max-time 10 "${scheme}://127.0.0.1:$port/music/healthz" 2>$null | Out-String).Trim() } }
      [void]$lines.Add("/music/healthz through the site: $(if ($music -match '"ok"\s*:\s*true') { 'the music bridge answers' } elseif ($music) { $music.Substring(0, [math]::Min(120, $music.Length)) } else { 'no answer' })")
    }
    $code = $(if ($up) { 0 } else { 1 }); $text = $lines -join "`n"
  } elseif ($p.internal -eq 'restart-coordinator') {
    # The coordinator runs as the scheduled task 'alpha-coordinator' on the
    # Host. A git pull does not reach it: the 2026-10-07 pull of #159 left it
    # on the old code (LastRunTime 2026-10-06) until something restarted it.
    # The queue survives (data/tasks.json); agents re-register by themselves.
    $port = 8787
    $n = 0; if ($env:ALPHA_HOST_PORT -and [int]::TryParse($env:ALPHA_HOST_PORT, [ref]$n)) { $port = $n }
    $lines = New-Object System.Collections.ArrayList
    if (-not (Get-ScheduledTask -TaskName 'alpha-coordinator' -EA SilentlyContinue)) {
      $code = 1; $text = "no scheduled task 'alpha-coordinator' on $env:COMPUTERNAME: the coordinator does not run here"
    } else {
      Stop-ScheduledTask -TaskName 'alpha-coordinator' -EA SilentlyContinue
      $held = @(Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue | ForEach-Object OwningProcess | Select-Object -Unique)
      foreach ($procId in $held) { taskkill.exe /T /F /PID $procId 2>&1 | Out-Null; [void]$lines.Add("stopped pid $procId (and its children) on $port") }
      if (-not $held.Count) { [void]$lines.Add("nothing listened on $port") }
      Start-Sleep -Seconds 3
      Start-ScheduledTask -TaskName 'alpha-coordinator'
      [void]$lines.Add("started task 'alpha-coordinator' from checkout $((git -C $repo rev-parse --short HEAD 2>$null | Out-String).Trim())")
      $deadline = (Get-Date).AddSeconds(150)
      while ((Get-Date) -lt $deadline -and -not (Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue)) { Start-Sleep -Seconds 5 }
      $listen = Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue | Select-Object -First 1
      if ($listen) {
        $addr = if ($listen.LocalAddress -in @('0.0.0.0', '::')) { '127.0.0.1' } else { $listen.LocalAddress }
        $health = (& curl.exe -s --max-time 10 "http://${addr}:$port/healthz" 2>$null | Out-String).Trim()
        [void]$lines.Add("coordinator listening on ${addr}:$port; healthz: $(if ($health) { $health.Substring(0, [math]::Min(120, $health.Length)) } else { 'no answer' })")
        $code = $(if ($health -match '"ok"\s*:\s*true') { 0 } else { 1 })
      } else {
        [void]$lines.Add("coordinator NOT listening on $port after 150s")
        $code = 1
      }
      $text = $lines -join "`n"
    }
  } elseif ($p.internal -eq 'restart-backend') {
    $port = 8001
    $portFile = Join-Path (Split-Path -Parent $AlphaRoot) 'memory\local\backend.port'
    if (Test-Path -LiteralPath $portFile) { $n = 0; if ([int]::TryParse((Get-Content -LiteralPath $portFile -Raw).Trim(), [ref]$n)) { $port = $n } }
    $lines = New-Object System.Collections.ArrayList
    $held = Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue | Select-Object -First 1
    if ($held) { Stop-Process -Id $held.OwningProcess -Force -EA SilentlyContinue; [void]$lines.Add("stopped pid $($held.OwningProcess) on $port") }
    else { [void]$lines.Add("nothing listened on $port") }
    Start-Sleep -Seconds 5
    if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue)) {
      if (Get-ScheduledTask -TaskName 'Alpha Backend' -EA SilentlyContinue) { Start-ScheduledTask -TaskName 'Alpha Backend'; [void]$lines.Add("started task 'Alpha Backend'") }
      else {
        $startLocal = Join-Path (Split-Path -Parent $AlphaRoot) 'scripts\start-local.ps1'
        if (Test-Path -LiteralPath $startLocal) {
          Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$startLocal`"") -WindowStyle Minimized -WorkingDirectory (Split-Path -Parent $AlphaRoot)
          [void]$lines.Add('started scripts\start-local.ps1')
        } else { [void]$lines.Add('no Alpha Backend task and no start-local.ps1: nothing to start it with') }
      }
    } else { [void]$lines.Add('something already restarted it') }
    $deadline = (Get-Date).AddSeconds(150)
    while ((Get-Date) -lt $deadline -and -not (Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue)) { Start-Sleep -Seconds 5 }
    $up = [bool](Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue)
    [void]$lines.Add($(if ($up) { "backend listening on $port" } else { "backend NOT listening on $port after 150s" }))
    $code = $(if ($up) { 0 } else { 1 }); $text = $lines -join "`n"
  } else {
    $errLog = "$log.err"
    try {
      $quoted = $p.args | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }
      $proc = Start-Process -FilePath $p.exe -ArgumentList $quoted -WorkingDirectory $repo -NoNewWindow -PassThru `
                -RedirectStandardOutput $log -RedirectStandardError $errLog
      # Without a handle taken now, .NET drops the exit code once the process
      # ends, and ExitCode reads back empty: the first report showed "->" with
      # no result for every action.
      $null = $proc.Handle
      if ($proc.WaitForExit([int]$p.timeoutMin * 60000)) { $code = $proc.ExitCode }
      else { Stop-Process -Id $proc.Id -Force -EA SilentlyContinue; $code = "timeout after $($p.timeoutMin) min" }
    } catch { $code = 'could not start'; Set-Content -LiteralPath $errLog -Value $_.Exception.Message }
    # -Raw: line by line, Get-Content also splits at a bare carriage return,
    # and a progress bar's redraws would come back as separate lines.
    $text = (@(Get-Content -LiteralPath $log -Raw -EA SilentlyContinue) + @(Get-Content -LiteralPath $errLog -Raw -EA SilentlyContinue) | Where-Object { $_ }) -join "`n"
  }
  if ($p.internal -or -not $p.ok) { Set-Content -LiteralPath $log -Value $text }
  $prev = $null
  $tail = (($text -split "`n") | ForEach-Object { Redact $_ } | Where-Object { $_.Trim() } |
           Where-Object { $same = ($_ -eq $prev); $prev = $_; -not $same } | Select-Object -Last 60) -join "`n"
  $entry = [ordered]@{ id = $p.id; do = $p.do; result = "$code"; at = $started.ToString('s'); seconds = [int]((Get-Date) - $started).TotalSeconds; tail = $tail }
  $done[$p.id] = [ordered]@{ result = "$code"; at = $entry.at }
  [void]$ran.Add($entry)
  $queuedRan++
  Write-Host ("{0} {1}: {2}" -f $p.id, $p.do, $code)
  # Saved now, not at the end: a pass stopped by the task's time limit would
  # otherwise run every action of it again on the next pass.
  $mid = [ordered]@{ done = $done; history = @($state.history | Where-Object { $_ }); lastRun = (Get-Date).ToString('s'); checkoutNote = $(if ($state) { [string]$state.checkoutNote } else { '' }); brainKey = $(if ($state) { [string]$state.brainKey } else { '' }); syncKey = $(if ($state) { [string]$state.syncKey } else { '' }); deckKey = $(if ($state) { [string]$state.deckKey } else { '' }); deckAt = $(if ($state) { [string]$state.deckAt } else { '' }); pending = @(@($ran) + $pending) }
  $mid | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding UTF8
}

# 3b. Standing checks: run every pass, report only a change.
$brainKey = if ($state -and $state.brainKey) { [string]$state.brainKey } else { '' }
$brainBranch = $null
if ($control -and $control.autofix -and $control.autofix.brainTopology -and $control.autofix.brainTopology.branch) { $brainBranch = [string]$control.autofix.brainTopology.branch }
if ($brainBranch -and (Test-Path -LiteralPath $AlphaRoot)) {
  if ($brainBranch -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$' -or $brainBranch -match '\.\.') { Write-Host 'autofix.brainTopology.branch is not a plain branch name: skipped' }
  else {
    $started = Get-Date
    $text = (& node (Join-Path $PSScriptRoot 'brain-topology-check.mjs') --alpha-root $AlphaRoot --ops $OpsDir --fix --branch $brainBranch 2>&1 | Out-String)
    $code = $LASTEXITCODE
    # What the deck's state is, without the run-to-run detail (times, paths).
    $key = "$code " + (($text -split "`r?`n" | Where-Object { $_ -match '^(OK|PROBLEM|AFTER FIX)' }) -join ' | ')
    if ($key -ne $brainKey) {
      $tail = (($text -split "`r?`n") | ForEach-Object { Redact $_ } | Where-Object { $_.Trim() } | Select-Object -Last 40) -join "`n"
      $result = switch ($code) { 0 { '0 (deck ok)' } 2 { '0 (fixed)' } default { "$code (open)" } }
      [void]$ran.Add([ordered]@{ id = "auto-brain-topology-$stamp"; do = 'brain-topology (standing)'; result = $result; at = $started.ToString('s'); seconds = [int]((Get-Date) - $started).TotalSeconds; tail = $tail })
      Write-Host "brain topology: $result"
    }
    $brainKey = $key
  }
}

# Live sync (docs/LIVE_SYNC.md): delivers the live branch to this machine and,
# with "capture": true, pushes what this machine runs back to it. Turned on by
# autofix.liveSync in actions.json; reported only when its state changes.
$syncKey = if ($state -and $state.syncKey) { [string]$state.syncKey } else { '' }
$sync = if ($control -and $control.autofix -and $control.autofix.liveSync -and $control.autofix.liveSync.branch) { $control.autofix.liveSync } else { $null }
if ($sync -and (Test-Path -LiteralPath $AlphaRoot)) {
  $syncBranch = [string]$sync.branch
  if ($syncBranch -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$' -or $syncBranch -match '\.\.') { Write-Host 'autofix.liveSync.branch is not a plain branch name: skipped' }
  else {
    $started = Get-Date
    $syncArgs = @((Join-Path $PSScriptRoot 'live-sync.mjs'), '--alpha-root', $AlphaRoot, '--ops', $OpsDir, '--branch', $syncBranch)
    if ($env:COMPUTERNAME) { $syncArgs += @('--machine', $env:COMPUTERNAME) }
    if ($sync.capture -eq $true) { $syncArgs += '--capture' }
    if ($sync.skipScripts -eq $true) { $syncArgs += '--skip-scripts' }
    # The owner's approved credential-scan lines, exactly as the snapshot action takes them.
    $syncAllow = @()
    if ($sync.allow) { $syncAllow = @((@($sync.allow) -join ',').Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
    $badAllow = @($syncAllow | Where-Object { $_ -notmatch '^[A-Za-z0-9_./-]+:\d+$' })
    if ($badAllow.Count) { Write-Host "autofix.liveSync.allow entries must be path:line ($($badAllow.Count) are not): none used" }
    elseif ($syncAllow.Count) { $syncArgs += @('--allow', ($syncAllow -join ',')) }
    $text = (& node @syncArgs 2>&1 | Out-String)
    $code = $LASTEXITCODE
    $key = "$code " + (($text -split "`r?`n" | Where-Object { $_ -match '^(IN SYNC|DELIVERED|REFUSED|FAILED|WAITING|CAPTURED|HELD BACK|SKIPPED|KNOWLEDGE|STOP)' }) -join ' | ')
    if ($key -ne $syncKey) {
      # Long enough for every held-back line and the ALLOW WITH line after them.
      # That line is file paths and line numbers only, and a long file name
      # masked by Redact could not be copied into autofix.liveSync.allow.
      $tail = (($text -split "`r?`n") | ForEach-Object { if ($_ -match '^ALLOW WITH: ([A-Za-z0-9_./-]+:\d+)?(,[A-Za-z0-9_./-]+:\d+)*$') { $_ } else { Redact $_ } } | Where-Object { $_.Trim() } | Select-Object -Last 200) -join "`n"
      $result = switch ($code) { 0 { '0 (in sync)' } 2 { '2 (needs a person)' } default { "$code (could not run)" } }
      [void]$ran.Add([ordered]@{ id = "auto-live-sync-$stamp"; do = 'live-sync (standing)'; result = $result; at = $started.ToString('s'); seconds = [int]((Get-Date) - $started).TotalSeconds; tail = $tail })
      Write-Host "live sync: $result"
    }
    $syncKey = $key
  }
}

# Deck liveness (Alpha's scripts\alpha_deck_liveness.py, which live sync
# delivers): every deck source judged by its own freshness field. Turned on by
# autofix.deckLiveness in actions.json; runs at most every everyMin minutes
# (default 15: reading the CrowPanel state costs the backend ~30 s) and is
# reported only when a deck's verdict changes. It runs with the Python the
# backend runs, because it signs in with the backend's own token signer.
$deckKey = if ($state -and $state.deckKey) { [string]$state.deckKey } else { '' }
$deckAt = if ($state -and $state.deckAt) { [string]$state.deckAt } else { '' }
$deck = if ($control -and $control.autofix -and $control.autofix.deckLiveness) { $control.autofix.deckLiveness } else { $null }
if ($deck -and (Test-Path -LiteralPath $AlphaRoot)) {
  $every = 15
  if ($deck -isnot [bool] -and $deck.everyMin) {
    $n = 0
    if ([int]::TryParse([string]$deck.everyMin, [ref]$n) -and $n -ge 5 -and $n -le 1440) { $every = $n } else { Write-Host 'autofix.deckLiveness.everyMin must be 5 to 1440: 15 used' }
  }
  $last = [datetime]::MinValue
  $due = -not $deckAt -or -not [datetime]::TryParse($deckAt, [ref]$last) -or ((Get-Date) - $last).TotalMinutes -ge $every
  if ($due) {
    $started = Get-Date
    $deckAt = $started.ToString('s')
    $deckScript = Join-Path (Join-Path (Split-Path -Parent $AlphaRoot) 'scripts') 'alpha_deck_liveness.py'
    $held = if (Get-Command Get-NetTCPConnection -EA SilentlyContinue) { Get-NetTCPConnection -LocalPort 8001 -State Listen -EA SilentlyContinue | Select-Object -First 1 }
    $py = if ($held) { (Get-Process -Id $held.OwningProcess -EA SilentlyContinue).Path }
    if (-not (Test-Path -LiteralPath $deckScript)) { $text = "STOP: $deckScript is not on this machine yet (live sync delivers it from the live branch)"; $code = 1 }
    elseif (-not $py) { $text = 'DECK DOWN: backend (/health) -> nothing listens on 8001  [decks: all decks]'; $code = 2 }
    else {
      $text = (& $py $deckScript --root (Split-Path -Parent $AlphaRoot) 2>&1 | Out-String)
      $code = $LASTEXITCODE
    }
    # The DECK lines carry verdicts, never ages, so a change is a real change.
    $key = "$code " + (($text -split "`r?`n" | Where-Object { $_ -match '^(DECK|STOP)' }) -join ' | ')
    if ($key -ne $deckKey) {
      $tail = (($text -split "`r?`n") | ForEach-Object { Redact $_ } | Where-Object { $_.Trim() } | Select-Object -Last 60) -join "`n"
      $result = switch ($code) { 0 { '0 (every deck live)' } 2 { '2 (not every deck is live)' } default { "$code (could not run)" } }
      [void]$ran.Add([ordered]@{ id = "auto-deck-liveness-$stamp"; do = 'deck-liveness (standing)'; result = $result; at = $started.ToString('s'); seconds = [int]((Get-Date) - $started).TotalSeconds; tail = $tail })
      Write-Host "deck liveness: $result"
    }
    $deckKey = $key
  }
}

$history = @()
if ($state -and $state.history) { $history = @($state.history) }
$history = @(@($ran) + $pending + $history | Select-Object -First 20)
$ran = @(@($ran) + $pending)
$noteChanged = -not $state -or [string]$state.checkoutNote -ne $checkoutNote
@{ done = $done; history = $history; lastRun = (Get-Date).ToString('s'); checkoutNote = $checkoutNote; brainKey = $brainKey; syncKey = $syncKey; deckKey = $deckKey; deckAt = $deckAt; pending = @() } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding UTF8
# 3c. The live report (autofix.heartbeat): every pass, whatever else did or
# did not happen, one short page on status/<channel>-live says whether Alpha is
# live. The owner asked for a report every 5 minutes, and a report written only
# on change cannot tell "nothing changed" from "the reporter died".
# - Alpha: self-heal's own last probes (backend, site, alpha-ai.uk), which run
#   every 2 minutes; nothing is probed twice.
# - The repair agent: if self-heal has not written its log for 6 minutes, its
#   task is started again, at most once every 30 minutes. It is never
#   duplicated here: two repairers would fight over the same processes.
# - Decks: the deck check's last receipt. Live sync: its last state.
function Read-SelfHeal {
  $log = Join-Path $OpsDir 'logs\selfheal.jsonl'
  if (-not (Test-Path -LiteralPath $log)) { return $null }
  $age = [int]((Get-Date) - (Get-Item -LiteralPath $log).LastWriteTime).TotalMinutes
  $last = $null
  try { $last = (Get-Content -LiteralPath $log -Tail 1 -EA Stop) | ConvertFrom-Json } catch { }
  return [pscustomobject]@{ age = $age; last = $last }
}
function Publish-Live([string]$md, [string]$json, [string]$headline) {
  $liveBranch = "status/$Channel-live"
  $tmpRoot = Join-Path $OpsDir 'tmp'
  New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null
  $lwt = Join-Path $tmpRoot "live-$stamp"
  git -C $repo fetch -q origin $liveBranch 2>&1 | Out-Null
  $lbase = if ($LASTEXITCODE -eq 0) { 'FETCH_HEAD' } else { 'HEAD' }
  git -C $repo worktree add --detach $lwt $lbase 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Host 'live report: could not create a worktree'; return }
  New-Item -ItemType Directory -Force -Path (Join-Path $lwt 'reports') | Out-Null
  Set-Content -LiteralPath (Join-Path $lwt 'reports\live.md') -Value $md -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $lwt 'reports\live.json') -Value $json -Encoding UTF8
  git -C $lwt add reports 2>&1 | Out-Null
  git -C $lwt -c "user.name=$Channel-autopilot" -c "user.email=autopilot@$($Channel).invalid" commit -q -m "$Channel live ${stamp}: $headline" 2>&1 | Out-Null
  git -C $lwt push -q origin "HEAD:refs/heads/$liveBranch" 2>&1 | Out-Null
  $ok = ($LASTEXITCODE -eq 0)
  git -C $repo worktree remove --force $lwt 2>&1 | Out-Null
  Write-Host $(if ($ok) { "live report: $headline" } else { 'live report: push failed' })
}
if ($control -and $control.autofix -and $control.autofix.heartbeat) {
  $now = Get-Date
  $sh = Read-SelfHeal
  $alpha = [ordered]@{ verdict = 'UNKNOWN'; detail = ''; checked_by = '' }
  $heal = [ordered]@{ state = 'NOT INSTALLED'; age_min = $null; repairs = 0; restarted = ''; snapshot = '' }
  if ($sh) {
    $heal.age_min = $sh.age
    # A snapshot is self-heal saving the site's last good build for rollback,
    # not a repair; a failed one is worth saying, as its own note.
    $heal.repairs = @($sh.last.actions | Where-Object { $_ -and $_.action -ne 'snapshot' }).Count
    $badSnap = @($sh.last.actions | Where-Object { $_ -and $_.action -eq 'snapshot' -and $_.code -ne 0 }) | Select-Object -First 1
    if ($badSnap) { $heal.snapshot = 'the rollback copy of the site was not saved' + $(if ($badSnap.error) { ": $(Redact ([string]$badSnap.error))" } else { ' (no reason logged)' }) }
    $heal.state = if ($sh.age -le 6) { 'RUNNING' } else { 'STOPPED' }
  }
  if ($heal.state -eq 'RUNNING' -and $sh.last -and $sh.last.probes) {
    $parts = [ordered]@{ backend = $sh.last.probes.backend; site = $sh.last.probes.frontend; 'alpha-ai.uk' = $sh.last.probes.public }
    $down = @($parts.Keys | Where-Object { -not ($parts[$_] -and $parts[$_].ok -eq $true) })
    $alpha.verdict = if ($down.Count) { 'DOWN' } else { 'LIVE' }
    $alpha.detail = (($parts.Keys | ForEach-Object { "$_ $(if ($parts[$_]) { $parts[$_].status } else { '?' })" }) -join ', ') + $(if ($down.Count) { "; not answering: $($down -join ', ')" } else { '' })
    $alpha.checked_by = "self-heal, $($sh.age) min ago"
  } else {
    # Self-heal is not watching, so look at the backend directly (only that).
    $code = $null
    try { $code = [int](Invoke-WebRequest -Uri 'http://127.0.0.1:8001/health' -UseBasicParsing -TimeoutSec 8).StatusCode } catch { $code = $null }
    $alpha.verdict = if ($code -eq 200) { 'BACKEND UP' } else { 'DOWN' }
    $alpha.detail = "backend $(if ($code) { $code } else { 'no answer' }); site and alpha-ai.uk unchecked while self-heal is not running"
    $alpha.checked_by = 'this pass'
  }
  if ($heal.state -eq 'STOPPED') {
    $kickFile = Join-Path $dir 'selfheal-restart.txt'
    $lastKick = [datetime]::MinValue
    if (Test-Path -LiteralPath $kickFile) { [void][datetime]::TryParse((Get-Content -LiteralPath $kickFile -Raw).Trim(), [ref]$lastKick) }
    if (($now - $lastKick).TotalMinutes -ge 30) {
      Set-Content -LiteralPath $kickFile -Value $now.ToString('s')
      try { Start-ScheduledTask -TaskName 'Alpha Self-Heal' -EA Stop; $heal.restarted = 'started its task again' }
      catch {
        & schtasks.exe /Run /TN 'Alpha Self-Heal' 2>&1 | Out-Null
        $heal.restarted = $(if ($LASTEXITCODE -eq 0) { 'started its task again (schtasks)' } else { 'could not start its task: run scripts\repair-alpha-host.ps1 as Administrator' })
      }
    } else { $heal.restarted = "restart already tried at $($lastKick.ToString('HH:mm'))" }
  }
  $decks = [ordered]@{ summary = 'not checked yet'; not_live = @(); checked_at = $null }
  $receipt = Join-Path (Join-Path (Split-Path -Parent $AlphaRoot) 'memory\local\deck-liveness') 'latest.json'
  if (Test-Path -LiteralPath $receipt) {
    try {
      $r = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
      $counts = @($r.sources | Group-Object verdict | ForEach-Object { "$($_.Count) $($_.Name.ToLower())" })
      $decks.summary = $counts -join ', '
      $decks.not_live = @($r.not_live)
      $decks.checked_at = [string]$r.checked_at
    } catch { $decks.summary = 'receipt unreadable' }
  }
  $syncState = (($syncKey -replace '^\d+ ', '') -split ' \| ' | Where-Object { $_ -match '^(IN SYNC|DELIVERED|REFUSED|FAILED|WAITING|STOP)' } | Select-Object -First 1)
  if (-not $syncState) { $syncState = $(if ($sync) { 'no state yet' } else { 'off' }) }
  $syncState = Redact $syncState
  $headline = "Alpha $($alpha.verdict); self-heal $($heal.state)"
  $md = @(
    "# Alpha is $($alpha.verdict) - $env:COMPUTERNAME, $($now.ToString('yyyy-MM-dd HH:mm zzz'))", '',
    'Written every autopilot pass (5 minutes), whether or not anything changed.', '',
    '| Check | State | Detail |', '|---|---|---|',
    "| Alpha (backend, site, alpha-ai.uk) | $($alpha.verdict) | $($alpha.detail) (checked by $($alpha.checked_by)) |",
    "| Repair agent (self-heal) | $($heal.state) | $(if ($null -ne $heal.age_min) { "last pass $($heal.age_min) min ago, $($heal.repairs) repair(s) in it" } else { 'no log: run scripts\repair-alpha-host.ps1' })$(if ($heal.snapshot) { "; $($heal.snapshot)" })$(if ($heal.restarted) { "; $($heal.restarted)" }) |",
    "| Decks | $($decks.summary) | $(if ($decks.not_live.Count) { 'not live: ' + ($decks.not_live -join '; ') } else { 'all data decks live' })$(if ($decks.checked_at) { " (checked $($decks.checked_at))" }) |",
    "| Live sync | $(($syncState -split ':')[0]) | $syncState |", ''
  ) -join "`n"
  $json = [ordered]@{ at = $now.ToString('o'); machine = $env:COMPUTERNAME; alpha = $alpha; selfheal = $heal; decks = $decks; sync = $syncState } | ConvertTo-Json -Depth 5
  Publish-Live $md $json $headline
}

if (-not $ran.Count -and -not ($noteChanged -and $updateExit -ne 0)) { Write-Host 'nothing new to run'; exit 0 }

# 4. Report, from a temporary worktree so this checkout is never switched or dirtied.
$branch = "status/$Channel-autopilot"
$body = @("# $Channel autopilot $stamp", '', "Host: $env:COMPUTERNAME   Alpha: $AlphaRoot", '', (Redact $checkoutNote), '')
foreach ($h in $history) {
  $body += "## $($h.id)  $($h.do)  ->  $($h.result)   ($($h.at), $($h.seconds)s)"
  $body += '```'; $body += $h.tail; $body += '```'; $body += ''
}
$tmp = Join-Path $OpsDir 'tmp'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$wt = Join-Path $tmp "autopilot-$stamp"
git -C $repo fetch -q origin $branch 2>&1 | Out-Null
$base = if ($LASTEXITCODE -eq 0) { 'FETCH_HEAD' } else { 'HEAD' }
git -C $repo worktree add --detach $wt $base 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host 'could not create a worktree; report kept in state.json' -ForegroundColor Yellow; exit 1 }
New-Item -ItemType Directory -Force -Path (Join-Path $wt 'reports') | Out-Null
Set-Content -LiteralPath (Join-Path $wt 'reports\autopilot.md') -Value ($body -join "`n") -Encoding UTF8
git -C $wt add reports 2>&1 | Out-Null
$summary = $(if ($ran.Count) { ($ran | ForEach-Object { "$($_.id)=$($_.result)" }) -join ' ' } else { 'checkout cannot update' })
git -C $wt -c "user.name=$Channel-autopilot" -c "user.email=autopilot@$($Channel).invalid" commit -q -m "$Channel autopilot ${stamp}: $summary" 2>&1 | Out-Null
git -C $wt push -q origin "HEAD:refs/heads/$branch" 2>&1 | Out-Null
$pushed = ($LASTEXITCODE -eq 0)
git -C $repo worktree remove --force $wt 2>&1 | Out-Null
Write-Host $(if ($pushed) { "reported to $branch" } else { 'push failed; report kept in state.json' })
exit 0

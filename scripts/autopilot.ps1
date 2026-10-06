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
    apply-update     apply-alpha-update.mjs --apply --restart   ("skipScripts": true)
    snapshot         snapshot-alpha-live.mjs --push             ("allow": "file:line,...")
    ollama-pull      ollama pull <"model">
    ollama-keepalive ollama-keepalive.ps1: keep the chat model loaded   ("keepAlive": "24h", "model")
    start-task       Start-ScheduledTask <"task">: Alpha, Alpha Backend, Alpha Self-Heal, Alpha Doctor

  Each id runs once. To run something again, queue it under a new id.

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
  [switch]$Install,
  [switch]$Uninstall,
  # Print what an actions file would run, as JSON, and run nothing.
  [string]$Plan
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
      if ($a.allow) {
        $items = ([string]$a.allow).Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
        $bad = @($items | Where-Object { $_ -notmatch '^[A-Za-z0-9_./-]+:\d+$' })
        if ($bad.Count) { $out.reason = "allow entries must be path:line ($($bad.Count) are not)"; return $out }
        $rest += @('--allow', ($items -join ','))
      }
      $spec = @{ exe = 'node'; args = $rest }; $out.timeoutMin = 30
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
  if (-not (Test-Path -LiteralPath $AlphaRoot)) { Write-Host "No Alpha at ${AlphaRoot}: pass -AlphaRoot <software folder>." -ForegroundColor Red; exit 1 }
  $argLine = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -AlphaRoot `"$AlphaRoot`" -OpsDir `"$OpsDir`" -ExpectHost `"$ExpectHost`" -Channel `"$Channel`""
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine -WorkingDirectory $repo
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
                -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
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

# 1. Current code first: a new action on the menu arrives with the code that runs it.
$update = & node (Join-Path $PSScriptRoot 'self-update.mjs') --repo $repo 2>&1 | Out-String
$updateExit = $LASTEXITCODE
if ($updateExit -eq 10) { Write-Host 'updated this checkout; queued actions run on the next pass, with the new code'; exit 0 }
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
git -C $repo fetch -q origin "control/$Channel" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "nothing queued (no control/$Channel branch)" }
else {
  $raw = git -C $repo show 'FETCH_HEAD:actions.json' 2>$null | Out-String
  if (-not $raw.Trim()) { Write-Host 'nothing queued' }
  else {
    try { $queued = @(@((ConvertFrom-Json $raw).actions) | Where-Object { $_ }) } catch { Write-Host "actions.json does not parse: $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
  }
}

# 3. Run what has not run.
$ran = New-Object System.Collections.ArrayList
foreach ($a in $queued) {
  $p = Resolve-Action $a
  if (-not $p.id -or $done.Contains($p.id)) { continue }
  $started = Get-Date
  $log = Join-Path $dir "$stamp-$($p.id).log"
  $code = $null
  $text = ''
  if (-not $p.ok) {
    $code = 'refused'; $text = $p.reason
  } elseif ($p.internal -eq 'start-task') {
    try { Start-ScheduledTask -TaskName $p.args[0] -EA Stop; $code = 0; $text = "started '$($p.args[0])'" } catch { $code = 1; $text = $_.Exception.Message }
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
  Write-Host ("{0} {1}: {2}" -f $p.id, $p.do, $code)
}

$history = @()
if ($state -and $state.history) { $history = @($state.history) }
$history = @(@($ran) + $history | Select-Object -First 20)
$noteChanged = -not $state -or [string]$state.checkoutNote -ne $checkoutNote
@{ done = $done; history = $history; lastRun = (Get-Date).ToString('s'); checkoutNote = $checkoutNote } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding UTF8
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

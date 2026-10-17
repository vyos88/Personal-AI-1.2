<#
  apply-chat-fix.ps1 - put Alpha PR #17 (the /chat dictionary 500) into a
  running install, without replacing anything else.

  REPORT ONLY (the default - changes nothing):
      powershell -ExecutionPolicy Bypass -File .\apply-chat-fix.ps1

  APPLY, then restart the backend so it takes effect:
      powershell -ExecutionPolicy Bypass -File .\apply-chat-fix.ps1 -Apply -Restart

  UNDO (the path is printed by -Apply):
      powershell -ExecutionPolicy Bypass -File .\apply-chat-fix.ps1 -Rollback <backup> [-Restart]

  The bug: in chat() the dictionary lane appended to response_sources long
  before the function assigned it, so every dictionary question ("what does X
  mean") raised UnboundLocalError and answered 500. The fix moves that
  citation into early_sources and merges it where response_sources is built -
  the same three edits as vyos88/Alpha#17, made only inside chat().

  It refuses rather than guesses: unless all three original lines are found
  exactly where #17 found them, nothing is written. The original file is
  copied to <OpsDir>\backups first, the edited file must parse as Python, and
  a file that does not parse is put back on the spot. Encoding (BOM) and line
  endings are kept as they were.

  -Restart stops only the process listening on the backend port, and only when
  something will start it again (the 'Alpha Backend' task or its wrapper loop).
  It then waits for /health.
#>

param(
  [string]$AlphaRoot = 'C:\AlphaData\Alpha',
  [string]$MainPy = '',
  [string]$OpsDir = 'C:\AlphaData\alpha-ops',
  [string]$Python = '',
  [int]$BackendPort = 8001,
  [string]$HealthPath = '/health',
  [string]$BackendTask = 'Alpha Backend',
  [switch]$Apply,
  [switch]$Restart,
  [string]$Rollback = ''
)

$ErrorActionPreference = 'Continue'
function OK($t)   { Write-Host "  ok: $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  $t" -ForegroundColor Yellow }
function Note($t) { Write-Host "  $t" }
function Stop1($t) { Write-Host "  STOP: $t" -ForegroundColor Red; exit 1 }

# ------------------------------------------------------------ which main.py
if (-not $MainPy) {
  $cands = @(
    (Join-Path (Join-Path $AlphaRoot 'backend') 'main.py'),
    (Join-Path (Join-Path (Join-Path $AlphaRoot 'software') 'backend') 'main.py'),
    (Join-Path $AlphaRoot 'main.py')
  )
  $MainPy = $cands | Where-Object { Test-Path $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $MainPy -or -not (Test-Path $MainPy -PathType Leaf)) { Stop1 "no backend main.py under $AlphaRoot - pass -MainPy <path>" }
$MainPy = (Resolve-Path $MainPy).Path
Note "backend file: $MainPy"

function Find-Python {
  if ($Python) { return $Python }
  # The backend's own interpreter, so the parse check uses its Python version.
  $w = Join-Path $env:ProgramData 'AlphaBoot\run-alpha-backend.cmd'
  if ($env:ProgramData -and (Test-Path $w)) {
    $m = [regex]::Match((Get-Content $w -Raw), '(?m)^"([^"]+python[^"]*\.exe)"')
    if ($m.Success -and (Test-Path $m.Groups[1].Value)) { return $m.Groups[1].Value }
  }
  foreach ($n in 'py.exe', 'python.exe', 'python3', 'python') {
    $c = Get-Command $n -EA SilentlyContinue | Select-Object -First 1
    if ($c) { return $c.Source }
  }
  return $null
}

function Test-Parses($path) {
  $py = Find-Python
  if (-not $py) { Warn "no Python found to check the edit; pass -Python <python.exe>"; return $false }
  $code = "import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8-sig').read())"
  & $py -c $code $path 2>&1 | ForEach-Object { Note "    $_" }
  return ($LASTEXITCODE -eq 0)
}

function Read-Source($path) {
  $bytes = [IO.File]::ReadAllBytes($path)
  $bom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $start = 0; if ($bom) { $start = 3 }
  $text = (New-Object Text.UTF8Encoding($false)).GetString($bytes, $start, $bytes.Length - $start)
  $nl = "`n"; if ($text.Contains("`r`n")) { $nl = "`r`n" }
  return @{ Text = $text; Bom = $bom; Nl = $nl }
}

function Write-Source($path, $text, $bom) {
  [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($bom)))
}

function Restart-Backend {
  $task = Get-ScheduledTask -TaskName $BackendTask -EA SilentlyContinue
  $wrapper = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -EA SilentlyContinue |
               Where-Object { $_.CommandLine -match 'run-alpha-backend\.cmd' })
  if (-not $task -and -not $wrapper) {
    Warn "nothing would start the backend again (no '$BackendTask' task, no wrapper running)."
    Warn "Not stopping it. Restart the backend by hand to load the change."
    return
  }
  $l = Get-NetTCPConnection -LocalPort $BackendPort -State Listen -EA SilentlyContinue | Select-Object -First 1
  if ($l) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($l.OwningProcess)" -EA SilentlyContinue
    if ($p.Name -notmatch '^(python|pythonw|py)\.exe$') { Warn "port $BackendPort is held by $($p.Name), not Python - not stopping it"; return }
    Note "stopping the backend (pid $($p.ProcessId)) so it restarts on the fixed file"
    taskkill.exe /T /F /PID $p.ProcessId 2>&1 | Out-Null
  }
  if (-not $wrapper -and $task) { Start-Sleep 2; Start-ScheduledTask -TaskName $BackendTask }
  $url = "http://127.0.0.1:$BackendPort$HealthPath"
  for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep 2
    $c = & curl.exe -s -o NUL -w '%{http_code}' --max-time 5 $url 2>$null
    if ("$c" -like '2*') { OK "backend answers $url ($c)"; return }
  }
  Warn "backend did not answer $url within 90s - check the 'Alpha Backend' log (C:\ProgramData\AlphaBoot\alpha-backend.log)"
}

# ------------------------------------------------------------ rollback
if ($Rollback) {
  if (-not (Test-Path $Rollback -PathType Leaf)) { Stop1 "$Rollback does not exist" }
  Copy-Item -LiteralPath $Rollback -Destination $MainPy -Force
  OK "restored $MainPy from $Rollback"
  if ($Restart) { Restart-Backend } else { Note "restart the backend to load it (re-run with -Restart)" }
  exit 0
}

# ------------------------------------------------------------ find chat()
$src = Read-Source $MainPy
$text = $src.Text; $nl = $src.Nl
$sig = 'async def chat(request: ChatRequest'
$start = $text.IndexOf($sig)
if ($start -lt 0) { Stop1 "no '$sig' in $MainPy - this is not the backend #17 fixed" }
# chat() ends at the next line that starts in column 0 with code.
$m = [regex]::Match($text.Substring($start + $sig.Length), '\r?\n(?=[^\s#])')
$end = if ($m.Success) { $start + $sig.Length + $m.Index } else { $text.Length }
$body = $text.Substring($start, $end - $start)
Note ("chat() found: {0} lines" -f ($body.Split("`n").Count))

if ($body.Contains('early_sources: list[dict] = []')) { OK "already fixed - nothing to do"; exit 0 }

$anchor = ('    early_communication_result = await asyncio.to_thread(', '        _communication_intent_response, text, thread_before', '    )', '') -join $nl
$insert = ('    # Sources the early, deterministic answers cite. response_sources is only',
           '    # built near the end of this function, and appending to it here made every',
           '    # dictionary hit an UnboundLocalError -- a 500 instead of the definition.',
           '    early_sources: list[dict] = []', '') -join $nl
$dictOld = ('            response_sources.append({', "                'title': f`"Dictionary: {dictionary_result['word']}`",") -join $nl
$dictNew = ('            early_sources.append({', "                'title': f`"Dictionary: {dictionary_result['word']}`",") -join $nl
$buildOld = 'response_sources = [*_requested_discovery_sources(text), *online_sources]'
$buildNew = 'response_sources = [*_requested_discovery_sources(text), *early_sources, *online_sources]'

function Count($hay, $needle) { ($hay.Length - $hay.Replace($needle, '').Length) / [Math]::Max(1, $needle.Length) }
$checks = [ordered]@{ 'early answers start' = $anchor; 'dictionary citation' = $dictOld; 'response_sources built' = $buildOld }
$bad = $false
foreach ($k in $checks.Keys) {
  $n = Count $body $checks[$k]
  if ($n -eq 1) { OK "found: $k" } else { Warn "expected exactly one '$k' in chat(), found $n"; $bad = $true }
}
if ($bad) { Stop1 "this chat() is not the code #17 fixed. Nothing was changed." }

if (-not $Apply) {
  Write-Host "`nREADY: the bug is present and the fix applies cleanly. Nothing changed." -ForegroundColor Green
  Note "Apply it:  powershell -ExecutionPolicy Bypass -File .\scripts\apply-chat-fix.ps1 -Apply -Restart"
  exit 0
}

# ------------------------------------------------------------ apply
$newBody = $body.Replace($anchor, $anchor + $insert).Replace($dictOld, $dictNew).Replace($buildOld, $buildNew)
$newText = $text.Substring(0, $start) + $newBody + $text.Substring($end)

New-Item -ItemType Directory -Force -Path (Join-Path $OpsDir 'backups') | Out-Null
$backup = Join-Path (Join-Path $OpsDir 'backups') ("main.py.before-chat-fix-{0}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
Copy-Item -LiteralPath $MainPy -Destination $backup -Force
OK "original saved to $backup"

Write-Source $MainPy $newText $src.Bom
if (-not (Test-Parses $MainPy)) {
  Copy-Item -LiteralPath $backup -Destination $MainPy -Force
  Stop1 "the edited file did not parse (or could not be checked); the original was put back"
}
OK "fix applied; main.py parses"
Note "Undo:  powershell -ExecutionPolicy Bypass -File .\scripts\apply-chat-fix.ps1 -Rollback `"$backup`" -Restart"

if ($Restart) { Restart-Backend } else { Warn "the running backend still has the old code until it restarts (re-run with -Restart)" }
Note "Then ask Alpha: 'what does ephemeral mean' - it should answer with a definition, not an error."
exit 0

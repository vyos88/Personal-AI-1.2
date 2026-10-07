<#
  laptop41-doctor.ps1 - one pass over everything on the Alpha host (Laptop41):
  where Alpha actually lives, backend, chat, whether the site is stale and at
  which layer, the public hostname, the alpha-tunnel coordinator, the
  CrowPanel and memory/disk.

  LOOK (changes nothing):
      powershell -ExecutionPolicy Bypass -File .\scripts\laptop41-doctor.ps1

  LOOK, THEN FIX what has a proven fixer (run as Administrator):
      powershell -ExecutionPolicy Bypass -File .\scripts\laptop41-doctor.ps1 -Fix

  SEND the report where a Claude session can read it (no copy-paste needed):
      add -Push

  It does not assume the layout. It finds the backend (the main.py that
  defines chat()) and the frontend (the package.json that uses vite) under
  -AlphaRoot, and reports which process holds each port and what the 'Alpha'
  task runs, because a guessed path is how the first run of this script
  reported "no main.py" on a machine whose backend was answering.

  -Fix adds no repair logic of its own. It runs the two fixers that already
  exist, each with its own backup and rollback:
    apply-chat-fix.ps1 -Apply -Restart   when the dictionary 500 is present
    repair-alpha-host.ps1                when the frontend is down or stale
  repair-alpha-host registers a self-heal task that runs scripts from the
  checkout it was started from, so it is only run from the real checkout,
  never from a temporary git worktree.

  -Push commits the report from a temporary git worktree to a new branch
  status/laptop41-<time>, so the checkout the agent runs from is never switched
  or dirtied. Tokens are redacted from the report before it is written; the
  chat password and the admin key are never written at all.
#>

param(
  [string]$AlphaRoot = 'C:\AlphaData\Alpha',
  [string]$OpsDir = 'C:\AlphaData\alpha-ops',
  [int]$BackendPort = 8001,
  [int]$FrontendPort = 4173,
  [int]$MusicBridgePort = 8790,
  [int]$ImageBridgePort = 7861,
  [int]$CoordinatorPort = 8787,
  [string]$PublicHost = 'alpha-ai.uk',
  [string]$ChatUser = '',
  # Where Alpha's chat model runs, and which model it asks for (Alpha's own
  # defaults: config.py OLLAMA_BASE_URL / OLLAMA_MODEL).
  [string]$OllamaUrl = $(if ($env:OLLAMA_BASE_URL) { $env:OLLAMA_BASE_URL } else { 'http://127.0.0.1:11434' }),
  [string]$ChatModel = $(if ($env:OLLAMA_MODEL) { $env:OLLAMA_MODEL } else { 'llama3.2:3b' }),
  [switch]$Fix,
  [switch]$Push,
  # Scheduled mode: no prompts, never fixes, tracks problems across runs,
  # posts to Alpha on change, and writes nine ranked recommendations.
  [switch]$Watch,
  [switch]$InstallSchedule,
  [switch]$UninstallSchedule,
  [int]$EveryMinutes = 15,
  # A problem open this many consecutive runs is marked NEEDS A PERSON.
  [int]$EscalateAfterRuns = 4
)

$ErrorActionPreference = 'Continue'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$reportDir = Join-Path $OpsDir 'reports'
# Not $env:TEMP: on Laptop41 it pointed at the removed USB drive (F:).
$tmpDir = Join-Path $OpsDir 'tmp'
New-Item -ItemType Directory -Force -Path $reportDir, $tmpDir | Out-Null
$report = Join-Path $reportDir "laptop41-doctor-$stamp.txt"
$lines = New-Object System.Collections.ArrayList
$problems = New-Object System.Collections.ArrayList

function Out1($t, $color = '') {
  [void]$lines.Add("$t")
  if ($color) { Write-Host $t -ForegroundColor $color } else { Write-Host $t }
}
function Section($t) { Out1 ''; Out1 "=== $t ===" 'Cyan' }
function OK($t)      { Out1 "  ok: $t" 'Green' }
function Note($t)    { Out1 "  $t" }
function Problem($t) { [void]$problems.Add($t); Out1 "  PROBLEM: $t" 'Red' }
function Indent($text) { foreach ($l in ("$text" -split "`r?`n")) { if ($l.Trim()) { Note "  $l" } } }
# Native stderr through 2>&1 arrives as ErrorRecords that PowerShell 5.1 prints
# with a whole "NativeCommandError" block each; keep only the text.
function Plain { process { "$_" } }

function Http($url, [string]$hostHeader = '') {
  $a = @('-s', '-o', 'NUL', '-w', '%{http_code}', '--max-time', '10')
  if ($hostHeader) { $a += @('-H', "Host: $hostHeader") }
  $c = & curl.exe @a $url 2>$null
  if (-not $c) { return '000' }
  return "$c"
}
function Body($url, [string]$hostHeader = '') {
  $a = @('-s', '--max-time', '10')
  # Vite preview on this machine may serve HTTPS with its own certificate.
  if ($url -like 'https://127.0.0.1*') { $a += '-k' }
  if ($hostHeader) { $a += @('-H', "Host: $hostHeader") }
  return ((& curl.exe @a $url 2>$null) -join "`n")
}
# The script tag vite writes into index.html names the hashed bundle, so it
# says exactly which build a layer is serving.
function BundleOf($html) {
  $m = [regex]::Match("$html", 'src="(/assets/[^"]+\.js)"')
  if ($m.Success) { return $m.Groups[1].Value }
  return ''
}
function Owner($port) {
  $l = Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue | Select-Object -First 1
  if (-not $l) { return $null }
  return Get-CimInstance Win32_Process -Filter "ProcessId=$($l.OwningProcess)" -EA SilentlyContinue
}
function Describe($p) {
  if (-not $p) { return 'nothing listening' }
  return "pid $($p.ProcessId) $($p.Name): $($p.CommandLine)"
}
# Self-heal writes one line to its log every pass (2 minutes). A log written
# in the last 10 minutes proves it runs, whether or not this account can see
# its scheduled task.
function SelfHealAge {
  $log = Join-Path $OpsDir 'logs\selfheal.jsonl'
  if (-not (Test-Path $log)) { return $null }
  return [int]((Get-Date) - (Get-Item $log).LastWriteTime).TotalMinutes
}
function SelfHealFresh { $age = SelfHealAge; return ($null -ne $age -and $age -le 10) }
function TaskResult($code) {
  $hex = '0x{0:X8}' -f ([int64]$code -band 0xFFFFFFFF)
  switch ($hex) {
    '0x00000000' { return "$hex (success)" }
    '0x00041301' { return "$hex (still running)" }
    '0xC000013A' { return "$hex (killed: Ctrl+C or its console closed - the process did not survive)" }
    '0x800710E0' { return "$hex (refused: the operator or a condition stopped it)" }
    default      { return $hex }
  }
}

# The CLI reads ALPHA_ADMIN_TOKEN from the environment or a .env in the folder
# it runs from; move-coordinator-here prints the admin key once and stores it
# nowhere, so a worktree copy of .env cannot have it. Ask, keep it in this
# process only.
$script:adminAsked = $false
function Admin([string]$cmd) {
  if (-not $env:ALPHA_ADMIN_TOKEN -and -not $script:adminAsked -and -not $Watch) {
    $script:adminAsked = $true
    $envFile = Join-Path $repo '.env'
    $inFile = (Test-Path $envFile) -and (Select-String -Path $envFile -Pattern '^ALPHA_(ADMIN|BOOTSTRAP)_TOKEN=.+' -Quiet)
    if (-not $inFile) {
      $s = Read-Host 'Admin key for the coordinator (the one move-coordinator-here printed; Enter to skip)' -AsSecureString
      $k = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
      if ($k) { $env:ALPHA_ADMIN_TOKEN = $k }
    }
  }
  Push-Location $repo
  try { return ((& node src\admin\run.js $cmd 2>&1 | Plain | Out-String)) } finally { Pop-Location }
}

# A backend setting: the environment first, then the .env files, .env.local
# before .env (the .bak copies beside them carry old values). Within a file
# the first line wins, as run_server.py loads it. Returns @{ value; from }.
function EnvSetting([string]$name) {
  foreach ($scope in 'Process', 'User', 'Machine') {
    $v = [Environment]::GetEnvironmentVariable($name, $scope)
    if ($v) { return @{ value = $v.Trim(); from = "environment ($scope)" } }
  }
  $files = @((Join-Path $AlphaRoot 'backend\.env.local'), (Join-Path $AlphaRoot '.env.local'), (Join-Path (Split-Path $AlphaRoot -Parent) '.env.local'),
             (Join-Path $AlphaRoot 'backend\.env'), (Join-Path $AlphaRoot '.env'), (Join-Path (Split-Path $AlphaRoot -Parent) '.env'))
  foreach ($f in $files) {
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { continue }
    $hit = Select-String -LiteralPath $f -Pattern "^\s*$([regex]::Escape($name))\s*=" -EA SilentlyContinue | Select-Object -First 1
    if ($hit) { return @{ value = ($hit.Line -split '=', 2)[1].Trim().Trim('"', "'"); from = $f } }
  }
  return $null
}

# Alpha's own deck firmware (hardware/examples/crowpanel_alpha_* in Alpha)
# holds no credential: it polls /panel/crowpanel/public-state every 3 s.
# Alpha's notes on getting it live (memory/knowledge/
# alpha_crowpanel_live_deployment.json) check, in order: the route is on, the
# backend listens on an address the panel can reach, that address is a
# trusted host, a device actually calls in, and the feed is fresh. Each of
# those has kept the panel dark once.
# Every board and home-network device this machine can see, by the identifier
# that outlives a replug or a new DHCP lease: a USB board by its VID:PID and
# instance id (COM numbers move on re-enumeration), a Wi-Fi device by its MAC
# (its IP moves with the lease). Alpha's topology names devices from these
# lines (frontend/src/config/fleetNames.js). Read-only: the neighbour table is
# what Windows already holds; nothing is probed or sent.
function Devices-ByAddress {
  Note '--- devices by address (USB: port, VID:PID, instance; LAN: IP, MAC)'
  $script:devicesFound = [ordered]@{ at = (Get-Date).ToString('o'); host = $env:COMPUTERNAME; usb = @(); self = @(); lan = @() }
  foreach ($d in @(Get-CimInstance Win32_PnPEntity -Filter "Name LIKE '%(COM%'" -EA SilentlyContinue)) {
    $com = [regex]::Match([string]$d.Name, '\((COM\d+)\)').Groups[1].Value
    $vp = [regex]::Match([string]$d.DeviceID, 'VID_([0-9A-F]{4})&PID_([0-9A-F]{4})', 'IgnoreCase')
    $vidpid = if ($vp.Success) { "$($vp.Groups[1].Value):$($vp.Groups[2].Value)".ToLower() } else { '-' }
    $inst = ([string]$d.DeviceID).Split('\')[-1]
    Note ("usb  {0,-6} {1,-10} {2,-28} {3}" -f $com, $vidpid, $inst, $d.Name)
    $script:devicesFound.usb += [ordered]@{ port = $com; vidPid = $vidpid; instance = $inst; deviceId = [string]$d.DeviceID; name = [string]$d.Name }
  }
  foreach ($a in @(Get-NetAdapter -Physical -EA SilentlyContinue | Where-Object Status -eq 'Up')) {
    $ip = (Get-NetIPAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -EA SilentlyContinue | Select-Object -First 1).IPAddress
    Note ("self {0,-15} {1}  {2}" -f $ip, ($a.MacAddress -replace '-', ':').ToLower(), $a.Name)
    $script:devicesFound.self += [ordered]@{ ip = $ip; mac = ($a.MacAddress -replace '-', ':').ToLower(); adapter = [string]$a.Name }
  }
  $seen = @(Get-NetNeighbor -AddressFamily IPv4 -EA SilentlyContinue | Where-Object {
      $_.IPAddress -match '^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)' -and
      $_.State -in 'Reachable', 'Stale', 'Delay', 'Probe', 'Permanent' -and
      $_.LinkLayerAddress -and $_.LinkLayerAddress -notmatch '^(00-00-00-00-00-00|FF-FF-FF-FF-FF-FF)$' -and
      $_.IPAddress -notmatch '\.255$' } | Sort-Object { [version]$_.IPAddress })
  foreach ($n in $seen) {
    Note ("lan  {0,-15} {1}  {2}" -f $n.IPAddress, ($n.LinkLayerAddress -replace '-', ':').ToLower(), $n.State)
    $script:devicesFound.lan += [ordered]@{ ip = [string]$n.IPAddress; mac = ($n.LinkLayerAddress -replace '-', ':').ToLower(); state = [string]$n.State }
  }
  if (-not $seen.Count) { Note 'lan  (no home-network neighbours in the table yet)' }
  # The same list as data, for Alpha and the cloud sessions to read without
  # parsing the report: alpha-ops\devices.json here, reports/devices.json on
  # status/laptop41.
  try { $script:devicesFound | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $OpsDir 'devices.json') -Encoding ASCII } catch {}
}

function Check-DeckFeed {
  Note "--- Alpha's deck feed (/panel/crowpanel/public-state)"
  $lan = EnvSetting 'ALPHA_PANEL_LAN_READ'
  $lanOn = [bool]($lan -and $lan.value -eq 'true')
  $feedUrl = "http://127.0.0.1:$BackendPort/panel/crowpanel/public-state"
  $code = Http $feedUrl
  if ($code -eq '404') {
    if ($lanOn) { Problem "Alpha's deck feed answers 404 though ALPHA_PANEL_LAN_READ=true ($($lan.from)): the backend started before that was set" }
    else {
      $was = if ($lan) { "'$($lan.value)' in $($lan.from)" } else { 'not set' }
      Problem "Alpha's deck feed is off: ALPHA_PANEL_LAN_READ is $was, so the deck panel has nothing to read"
    }
  } elseif ($code -like '2*') {
    $feed = $null
    try { $feed = (Body $feedUrl) | ConvertFrom-Json } catch {}
    if (-not $feed) { Problem "Alpha's deck feed answered $code without JSON" }
    elseif ($feed.status -eq 'live') {
      $age = if ($feed.freshness -and $null -ne $feed.freshness.heartbeat_age_s) { " (assistant heartbeat $($feed.freshness.heartbeat_age_s)s old)" } else { '' }
      OK "Alpha's deck feed is live$age"
    } elseif ($feed.freshness -and $feed.freshness.reason) {
      Problem "Alpha's deck feed is $($feed.status): $($feed.freshness.reason). $($feed.freshness.advice)"
      # The numbers that tell a stalled loop from an old snapshot: how old the
      # heartbeat was when the panel state was built, and how old that state is.
      $f = $feed.freshness
      $ages = @()
      if ($null -ne $f.heartbeat_age_s) { $ages += "assistant heartbeat $($f.heartbeat_age_s)s old (live under $($f.threshold_s)s)" }
      if ($f.stale_since) { $ages += "stale since $(if ($f.stale_since -is [datetime]) { $f.stale_since.ToString('s') } else { $f.stale_since })" }
      if ($null -ne $feed.snapshot_age_s) { $ages += "panel snapshot $($feed.snapshot_age_s)s old" }
      if ($ages.Count) { Note "  $($ages -join '; ')" }
    } else {
      Problem "Alpha's deck feed is $($feed.status), and this backend does not say why: it predates Alpha#26, which keeps the assistant heartbeat fresh between cycles"
    }
  } else {
    Problem "Alpha's deck feed answered $code"
  }

  # The panel is on WiFi; it reaches this machine on a home-network address
  # only. HOST in .env.local names the addresses the backend binds, and a
  # lease that moved leaves the panel pointed at nothing.
  if (-not (Get-Command Get-NetTCPConnection -EA SilentlyContinue)) {
    Note 'cannot list listening addresses or callers here (no Get-NetTCPConnection)'
    return
  }
  $homeNet = '^(::ffff:)?(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)'
  $addrs = @(Get-NetIPAddress -AddressFamily IPv4 -EA SilentlyContinue)
  $own = @($addrs |
    Where-Object { $_.IPAddress -match $homeNet -and $_.InterfaceAlias -notmatch 'vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback' } |
    ForEach-Object { @{ ip = "$($_.IPAddress)"; nic = "$($_.InterfaceAlias)" } })
  $listen = @(Get-NetTCPConnection -LocalPort $BackendPort -State Listen -EA SilentlyContinue | ForEach-Object { "$($_.LocalAddress)" } | Sort-Object -Unique)
  if (-not $listen) { Note "nothing listens on port $BackendPort (section 1)"; return }
  Note "backend listens on: $($listen -join ', ')"
  $anyAddress = [bool]($listen | Where-Object { $_ -eq '0.0.0.0' -or $_ -eq '::' })
  $reach = @($own | Where-Object { $anyAddress -or $listen -contains $_.ip })
  foreach ($a in $own) { if ($reach -notcontains $a) { Note "not listening on $($a.ip) ($($a.nic))" } }
  if ($own -and -not $reach) {
    Problem "the backend listens on no home-network address (this machine has $(($own | ForEach-Object { "$($_.ip) on $($_.nic)" }) -join ', ')): the deck panel cannot reach it"
  }
  foreach ($a in $reach) {
    $c = Http "http://$($a.ip):$BackendPort/health"
    if ($c -like '2*') { OK "the panel's way in answers: http://$($a.ip):$BackendPort/health $c ($($a.nic))" }
    elseif ($c -eq '400') { Problem "http://$($a.ip):$BackendPort answers 400: $($a.ip) is not a trusted host (ALPHA_TRUSTED_HOSTS is taken at startup)" }
    else { Problem "http://$($a.ip):$BackendPort/health answered $c from this machine" }
  }

  # A 3-second poll leaves Established or TimeWait connections from the
  # panel's address for a couple of minutes. None of this machine's own
  # addresses (the probe above, the WSL switch) is a caller.
  $ownIps = @($addrs | ForEach-Object { "$($_.IPAddress)" })
  $callers = @(Get-NetTCPConnection -LocalPort $BackendPort -EA SilentlyContinue |
    Where-Object { "$($_.RemoteAddress)" -match $homeNet -and ("$($_.State)" -eq 'Established' -or "$($_.State)" -eq 'TimeWait') -and $ownIps -notcontains ("$($_.RemoteAddress)" -replace '^::ffff:', '') } |
    Group-Object { "$($_.RemoteAddress)" -replace '^::ffff:', '' } | ForEach-Object { "$($_.Name) ($($_.Count) connections)" })
  if ($callers) { OK "home-network devices that called the backend in the last couple of minutes: $($callers -join ', ')" }
  elseif ($lanOn) { Problem 'no device on the home network has called the backend in the last couple of minutes: the deck panel is not reaching this machine' }
  else { Note 'no device on the home network has called the backend in the last couple of minutes' }
}

# ------------------------------------------------------------ layout
# Get-ChildItem -Recurse walks into node_modules (tens of thousands of files,
# each one scanned by Defender) before any filter sees it; on Laptop41 that
# ran the scheduled pass past its 10-minute limit before it wrote anything.
# This walker never descends into a skipped folder.
$skipNames = @('node_modules', '.venv', 'venv', 'env', 'site-packages', '.git', '__pycache__', 'BuildArtifacts', '.next', 'build')
function Find-Files([string[]]$roots, [string[]]$patterns, [int]$maxDepth) {
  $out = New-Object System.Collections.ArrayList
  $stack = New-Object System.Collections.Stack
  foreach ($r in $roots) { if ($r -and (Test-Path $r -PathType Container)) { $stack.Push(@($r, 0)) } }
  while ($stack.Count -gt 0) {
    $item = $stack.Pop(); $dir = $item[0]; $depth = $item[1]
    foreach ($pat in $patterns) {
      $found = @(); try { $found = [IO.Directory]::GetFiles($dir, $pat) } catch { }
      foreach ($f in $found) { [void]$out.Add((Get-Item -LiteralPath $f)) }
    }
    if ($depth -ge $maxDepth) { continue }
    $subs = @()
    try { $subs = [IO.Directory]::GetDirectories($dir) } catch { }
    foreach ($d in $subs) {
      $leaf = [IO.Path]::GetFileName($d)
      if ($skipNames -contains $leaf -or $leaf -like 'dist*') { continue }
      $stack.Push(@($d, ($depth + 1)))
    }
  }
  return $out
}
function Find-Layout {
  Section "0. Where Alpha lives under $AlphaRoot"
  if (-not (Test-Path $AlphaRoot)) { Problem "$AlphaRoot does not exist"; return }
  Note ('top level: ' + ((Get-ChildItem $AlphaRoot -EA SilentlyContinue | ForEach-Object { $_.Name }) -join ', '))

  $mains = @(Find-Files @($AlphaRoot) @('main.py') 4 |
             Where-Object { Select-String -Path $_.FullName -SimpleMatch 'async def chat(request: ChatRequest' -Quiet })
  $be = Owner $BackendPort
  Note "port $BackendPort : $(Describe $be)"
  $script:mainPy = $null
  if ($mains.Count -eq 1) { $script:mainPy = $mains[0].FullName; OK "backend: $($script:mainPy)" }
  elseif ($mains.Count -gt 1) {
    foreach ($m in $mains) { Note "backend candidate: $($m.FullName)" }
    $hit = @($mains | Where-Object { $be -and $be.CommandLine -and $be.CommandLine.IndexOf($_.DirectoryName, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
    if ($hit.Count -eq 1) { $script:mainPy = $hit[0].FullName; OK "backend (named by the running process): $($script:mainPy)" }
    else { Problem 'more than one backend main.py; cannot tell which one is running' }
  } else {
    Problem "no main.py defining chat() under $AlphaRoot - the backend on $BackendPort runs from somewhere else (see its command line above)"
  }

  $task = Get-ScheduledTask -TaskName 'Alpha' -EA SilentlyContinue
  $taskText = ''
  if ($task) {
    foreach ($a in $task.Actions) {
      $taskText += " $($a.Execute) $($a.Arguments) $($a.WorkingDirectory)"
      Note "task Alpha runs: $($a.Execute) $($a.Arguments)"
      Note "            in: $($a.WorkingDirectory)"
    }
    # start-alpha-at-boot.ps1 registers `cmd.exe /c "...\run-alpha.cmd"`, and
    # the wrapper is what names the folder (`cd /d "<frontend>"`). Read it too,
    # or every boot-task install reads as "serves some other folder".
    foreach ($m in [regex]::Matches($taskText, '[A-Za-z]:\\[^"]+?\.(cmd|bat|ps1)')) {
      if (Test-Path -LiteralPath $m.Value) {
        $taskText += ' ' + (Get-Content -LiteralPath $m.Value -Raw -EA SilentlyContinue)
        Note "            wrapper: $($m.Value)"
      }
    }
  }
  $fes = @(Find-Files @($AlphaRoot) @('package.json') 4 |
           Where-Object { (Get-Content $_.FullName -Raw -EA SilentlyContinue) -match '"vite"' })
  $fo = Owner $FrontendPort
  Note "port $FrontendPort : $(Describe $fo)"
  $script:frontend = $null
  foreach ($f in $fes) {
    $d = $f.DirectoryName
    $hasDist = Test-Path (Join-Path $d 'dist\index.html')
    $byTask = $taskText -and $taskText.IndexOf($d, [StringComparison]::OrdinalIgnoreCase) -ge 0
    Note ("frontend candidate: {0}  dist:{1}  named-by-task:{2}" -f $d, $hasDist, $byTask)
    if ($byTask) { $script:frontend = $d }
  }
  if (-not $script:frontend -and $fes.Count -gt 0) { $script:frontend = $fes[0].DirectoryName }
  if ($script:frontend) { OK "frontend: $($script:frontend)" } else { Problem "no vite frontend under $AlphaRoot" }
  if ($taskText -and $script:frontend -and $taskText.IndexOf($script:frontend, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    Problem "the 'Alpha' task does not mention $($script:frontend): it serves some other folder"
  }
}

function Run-Checks {
  Find-Layout

  # ------------------------------------------------------------ backend
  Section "1. Backend (port $BackendPort)"
  $h = Http "http://127.0.0.1:$BackendPort/health"
  if ($h -like '2*') { OK "/health answers $h" } else { Problem "backend /health answered $h" }

  $script:chatBug = $false
  if ($script:mainPy) {
    $fixOut = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'apply-chat-fix.ps1') -MainPy $script:mainPy -OpsDir $OpsDir 2>&1 | Plain | Out-String
    if ($fixOut -match 'already fixed') { OK 'chat fix (dictionary 500) is in the live main.py' }
    elseif ($fixOut -match 'READY:') { $script:chatBug = $true; Problem 'live main.py still has the dictionary bug (fix: -Fix)' }
    else { Note 'apply-chat-fix.ps1 does not recognise this chat() (a different version of the backend):'; Indent $fixOut }
    $mt = (Get-Item $script:mainPy).LastWriteTime
    $bp = Owner $BackendPort
    if ($bp) {
      $started = (Get-Process -Id $bp.ProcessId -EA SilentlyContinue).StartTime
      Note ("main.py edited {0:yyyy-MM-dd HH:mm}; backend started {1:yyyy-MM-dd HH:mm}" -f $mt, $started)
      if ($started -and $mt -gt $started) { Problem 'main.py changed after the backend started: it is running old code until restarted' }
    }
  }

  # ------------------------------------------------------------ chat
  Section '2. Chat'
  # Without a login: is the backend ready, is /chat mounted and guarded, and
  # does the chat model answer at all? Runs every pass, so scheduled reports
  # say whether chat can work, not only whether the backend is up.
  try {
    $ready = Invoke-RestMethod -Uri "http://127.0.0.1:$BackendPort/ready" -TimeoutSec 15
    OK "backend ready (phase $($ready.phase))"
  } catch {
    $code = $null; try { $code = [int]$_.Exception.Response.StatusCode } catch {}
    if ($code -eq 503) { Problem "backend is still warming up (/ready answers 503)" }
    else { Problem "backend /ready does not answer (HTTP $code)" }
  }
  $chatCode = $null
  try {
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$BackendPort/chat" -ContentType 'application/json' -Body '{"message":"ping"}' -TimeoutSec 30 | Out-Null
    $chatCode = 200
  } catch { try { $chatCode = [int]$_.Exception.Response.StatusCode } catch {} }
  if ($chatCode -in 401, 403) { OK "/chat is mounted and asks for a login (HTTP $chatCode)" }
  elseif ($chatCode -eq 200) { Problem '/chat answered without a login' }
  else { Problem "/chat without a login answers HTTP $chatCode, expected 401 (route missing or failing)" }
  $tags = $null
  try { $tags = Invoke-RestMethod -Uri "$($OllamaUrl.TrimEnd('/'))/api/tags" -TimeoutSec 15 } catch { Problem "Ollama does not answer at $OllamaUrl" }
  if ($tags) {
    $names = @($tags.models | ForEach-Object { $_.name })
    Note ("Ollama models: " + $(if ($names) { $names -join ', ' } else { 'none' }))
    $want = if ($ChatModel -match ':') { $ChatModel } else { "${ChatModel}:latest" }
    if ($names -notcontains $want) { Problem "chat model '$ChatModel' is not pulled in Ollama" }
    else {
      try {
        $t0 = Get-Date
        $gen = Invoke-RestMethod -Method Post -Uri "$($OllamaUrl.TrimEnd('/'))/api/generate" -ContentType 'application/json' -TimeoutSec 180 `
                 -Body (@{ model = $ChatModel; prompt = 'Reply with the single word OK.'; stream = $false; options = @{ num_predict = 8 } } | ConvertTo-Json)
        $secs = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
        $load = [math]::Round(([double]$gen.load_duration) / 1e9, 1)
        $tps = if ([double]$gen.eval_duration -gt 0) { [math]::Round([double]$gen.eval_count / ([double]$gen.eval_duration / 1e9), 1) } else { 0 }
        $txt = ("$($gen.response)" -replace '\s+', ' ').Trim()
        if ($txt.Length -gt 60) { $txt = $txt.Substring(0, 60) + '...' }
        OK "chat model '$ChatModel' answered in ${secs}s (load ${load}s, $tps tokens/s): $txt"
        # Loading and answering are different problems with different fixes:
        # on 2026-10-06 a 77.9s reply was 75.6s of loading and a normal 9.4
        # tokens/s, and "close apps or move chat" sent people the wrong way.
        $answer = [math]::Round([math]::Max(0, $secs - $load), 1)
        if ($answer -gt 60) { Problem "chat model '$ChatModel' took ${answer}s to answer once loaded: chat will time out" }
        elseif ($load -gt 30) { Problem "chat model '$ChatModel' took ${load}s to load: the first chat after an idle spell waits that long" }
        # How long Ollama keeps it loaded decides how often anyone pays that load.
        try {
          $want2 = if ($ChatModel -match ':') { $ChatModel } else { "${ChatModel}:latest" }
          $ps = @((Invoke-RestMethod -Uri "$($OllamaUrl.TrimEnd('/'))/api/ps" -TimeoutSec 10).models) | Where-Object { $_.name -eq $want2 -or $_.model -eq $want2 } | Select-Object -First 1
          if ($ps -and $ps.expires_at) {
            # Ollama writes nanoseconds (trimmed to 7 digits for .NET Framework); PowerShell 7 may hand over a date.
            $at = $ps.expires_at
            $when = if ($at -is [datetime]) { [DateTimeOffset]$at } else { [DateTimeOffset]::Parse(([string]$at -replace '(\.\d{7})\d+', '$1'), [Globalization.CultureInfo]::InvariantCulture) }
            $mins = [math]::Round(($when - [DateTimeOffset]::UtcNow).TotalMinutes)
            if ($mins -gt 525600) { OK "Ollama keeps '$ChatModel' loaded until it stops" }
            elseif ($mins -ge 60) { OK "Ollama keeps '$ChatModel' loaded for $([math]::Round($mins / 60)) h after each use" }
            else { Note "Ollama unloads '$ChatModel' $mins min after each use (OLLAMA_KEEP_ALIVE not set); the next chat then waits for a reload" }
          }
        } catch { }
      } catch {
        Problem "chat model '$ChatModel' did not answer: $($_.Exception.Message)"
      }
    }
  }
  if ($ChatUser -and -not $Watch) {
    if (-not $script:chatPass) { $script:chatPass = Read-Host "Alpha password for $ChatUser" -AsSecureString }
    $plainPw = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($script:chatPass))
    $login = $null
    try {
      $login = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$BackendPort/auth/login" -ContentType 'application/json' `
                 -Body (@{ username = $ChatUser; password = $plainPw } | ConvertTo-Json) -TimeoutSec 30
    } catch {
      $code = $null; try { $code = [int]$_.Exception.Response.StatusCode } catch {}
      Problem "login as $ChatUser failed: HTTP $code $($_.ErrorDetails.Message)"
    }
    $plainPw = $null
    if ($login -and -not $login.access_token) {
      Problem "login as $ChatUser gave no token (2FA: $($login.requires_2fa), agreement: $($login.requires_agreement))"
    } elseif ($login) {
      OK "login as $ChatUser"
      $since = Get-Date
      $failed = $false
      foreach ($q in 'hello', 'what is 2 plus 2', 'what does ephemeral mean') {
        try {
          $r = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$BackendPort/chat" -ContentType 'application/json' `
                 -Headers @{ Authorization = "Bearer $($login.access_token)" } -Body (@{ message = $q } | ConvertTo-Json) -TimeoutSec 120
          $txt = ("$($r.response)" -replace '\s+', ' ')
          if ($txt.Length -gt 160) { $txt = $txt.Substring(0, 160) + '...' }
          OK "chat '$q' -> routed_to=$($r.routed_to): $txt"
        } catch {
          $failed = $true
          $code = $null; try { $code = [int]$_.Exception.Response.StatusCode } catch {}
          Problem "chat '$q' failed: HTTP $code"
          if ($_.ErrorDetails.Message) { Indent ("response body: " + $_.ErrorDetails.Message) }
        }
      }
      if ($failed) {
        # The traceback is in whatever log the backend writes; show the newest
        # ones touched since the first message went out.
        $roots = @($AlphaRoot, (Join-Path $env:ProgramData 'AlphaBoot'), (Join-Path $OpsDir 'logs')) | Where-Object { Test-Path $_ }
        $logs = @(Find-Files $roots @('*.log', '*.txt', '*.jsonl') 5 |
                  Where-Object { $_.LastWriteTime -ge $since.AddSeconds(-5) } |
                  Sort-Object LastWriteTime -Descending | Select-Object -First 2)
        if (-not $logs) { Note 'no log file changed while chat failed: the backend logs to its console only' }
        foreach ($lg in $logs) { Note "--- tail of $($lg.FullName)"; Get-Content $lg.FullName -Tail 40 -EA SilentlyContinue | ForEach-Object { Note "  $_" } }
      }
    }
  } else {
    Note 'not logged in, so chat itself was not tried. Add -ChatUser <your Alpha login> to send real messages.'
  }

  # ------------------------------------------------------------ stale?
  Section '3. Is Alpha stale, and at which layer?'
  $script:frontendStale = $false
  $fileBundle = ''
  if ($script:frontend) {
    $distIndex = Join-Path $script:frontend 'dist\index.html'
    if (-not (Test-Path $distIndex)) {
      $script:frontendStale = $true; Problem "no dist\index.html in $($script:frontend): no production build to serve"
    } else {
      $fileBundle = BundleOf (Get-Content $distIndex -Raw)
      $built = (Get-Item $distIndex).LastWriteTime
      $newest = Get-ChildItem (Join-Path $script:frontend 'src') -Recurse -File -EA SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
      Note ("dist built     {0:yyyy-MM-dd HH:mm}" -f $built)
      if ($newest) {
        Note ("newest source  {0:yyyy-MM-dd HH:mm}  {1}" -f $newest.LastWriteTime, $newest.FullName.Substring($script:frontend.Length + 1))
        if ($newest.LastWriteTime -gt $built.AddMinutes(1)) {
          $script:frontendStale = $true
          Problem 'the build is older than the source: the site shows the old Alpha until dist is rebuilt'
        } else { OK 'build is newer than every source file' }
      }
    }
  }
  # The cloudflared ingress on Laptop41 is https://127.0.0.1:4173: Vite preview
  # serves TLS there, and an http:// probe of it reads as nothing listening.
  $feUrl = "http://127.0.0.1:$FrontendPort/"
  if (-not (BundleOf (Body $feUrl)) -and (BundleOf (Body "https://127.0.0.1:$FrontendPort/"))) { $feUrl = "https://127.0.0.1:$FrontendPort/" }
  Note "frontend probed at $feUrl"
  $localBundle = BundleOf (Body $feUrl $PublicHost)
  $pubBundle   = BundleOf (Body "https://$PublicHost/")
  Note "bundle in dist     $fileBundle"
  Note "bundle on :$FrontendPort   $localBundle"
  Note "bundle public      $pubBundle"
  $cf = (& curl.exe -sI --max-time 10 "https://$PublicHost/" 2>$null | Select-String -Pattern '^(cf-cache-status|age|cache-control|last-modified|server):' | ForEach-Object { $_.Line.Trim() }) -join '; '
  Note "public headers: $cf"
  if (-not $localBundle) {
    # Empty with the public Host header is not yet "nothing there": Vite answers
    # 403 "Blocked request" to a host it was not told about. Ask again without
    # the header and say which of the two it is.
    $code = (& curl.exe -s -k -o NUL -w '%{http_code}' --max-time 10 $feUrl 2>$null) -join ''
    $plain = Body $feUrl
    $blocked = (Body $feUrl $PublicHost) -match 'Blocked request'
    $script:frontendStale = $true
    if ($blocked) { Problem "$FrontendPort refuses Host: $PublicHost (Vite 'Blocked request'): add it to preview.allowedHosts in vite.config" }
    elseif (BundleOf $plain) { Problem "$FrontendPort serves $(BundleOf $plain) on 127.0.0.1 but nothing when asked as $PublicHost" }
    elseif ($code -and $code -ne '000') { Problem "$FrontendPort answers HTTP $code with no Alpha page" }
    else { Problem "nothing listens on $FrontendPort (connection refused or timed out)" }
  }
  elseif ($fileBundle -and $localBundle -ne $fileBundle) { $script:frontendStale = $true; Problem "$FrontendPort serves an older build than dist holds; the server needs a restart" }
  else { OK "$FrontendPort serves the build in dist" }
  if ($pubBundle -and $pubBundle -ne $localBundle -and $fileBundle -and $pubBundle -eq $fileBundle) {
    # The public build is the one in this machine's dist, so the public site is
    # this machine; what differs is only which local port the connector uses.
    OK "public site serves this machine's current dist build ($pubBundle), through an origin other than :$FrontendPort"
  } elseif ($pubBundle -and $pubBundle -ne $localBundle) {
    Problem "the public site serves $pubBundle, which this machine's $FrontendPort does not: Cloudflare cache or another origin/connector is answering for $PublicHost"
    # Which local server, if any, has that build.
    $listen = @(Get-NetTCPConnection -State Listen -EA SilentlyContinue | Where-Object { $_.LocalAddress -in '127.0.0.1', '0.0.0.0', '::', '::1' } |
                Select-Object -ExpandProperty LocalPort -Unique)
    foreach ($port in $listen) {
      $p = Owner $port
      if (-not $p -or $p.Name -notmatch '^(node|python|pythonw)\.exe$') { continue }
      $b = BundleOf ((& curl.exe -s --max-time 3 "http://127.0.0.1:$port/" 2>$null) -join "`n")
      if ($b) { Note ("port {0} serves {1}{2}  ({3})" -f $port, $b, $(if ($b -eq $pubBundle) { '  <- the public build' } else { '' }), (Describe $p)) }
    }
  } elseif ($pubBundle) { OK 'public site serves the same build as this machine' }

  # ------------------------------------------------------------ public
  Section "4. Public $PublicHost and the boot tasks"
  $p = Http "https://$PublicHost/"
  if ($p -like '2*' -or $p -like '3*') { OK "https://$PublicHost/ answers $p" } else { Problem "https://$PublicHost/ answers $p" }
  foreach ($t in 'Alpha', 'Alpha Backend', 'Alpha Self-Heal') {
    $st = Get-ScheduledTask -TaskName $t -EA SilentlyContinue
    if ($st) { $i = $st | Get-ScheduledTaskInfo; Note ("task {0,-16} {1,-8} last run {2:yyyy-MM-dd HH:mm} result {3}" -f $t, $st.State, $i.LastRunTime, (TaskResult $i.LastTaskResult)) }
    elseif ($t -eq 'Alpha Self-Heal' -and (SelfHealFresh)) {
      # Registered elevated by repair-alpha-host, the task can be invisible to
      # the account the scheduled doctor runs as, while its log shows it running
      # every 2 minutes. That read as "not registered" on every pass (BACKLOG F8).
      OK "self-heal is running (its log was written $(SelfHealAge) min ago); task $t is not visible to this account"
    }
    elseif ($t -eq 'Alpha') { Problem "task $t is not registered: nothing serves the frontend after a reboot" }
    elseif ($t -eq 'Alpha Self-Heal' -and (Test-Path (Join-Path $OpsDir 'selfheal.json'))) {
      # The repair registers it as SYSTEM, and a SYSTEM task is hidden from a
      # non-elevated Get-ScheduledTask, which is how the scheduled doctor runs.
      # Its log is the evidence this user can read.
      $shLog = Join-Path $OpsDir 'logs\selfheal.jsonl'
      if (Test-Path $shLog) {
        $age = [int]((Get-Date) - (Get-Item $shLog).LastWriteTime).TotalMinutes
        if ($age -le 10) { OK "self-heal runs (task is SYSTEM, not visible here; its log was written $age min ago)" }
        else { Problem "self-heal is installed but its log is $age min old: check the task's last result as Administrator (3 = config unreadable)" }
      } else { Problem 'self-heal is installed but has never written its log: check the task as Administrator (last result 3 = config unreadable)' }
    }
    else { Problem "task $t is not registered: repair-alpha-host.ps1 has never completed on this machine" }
  }
  $cfs = Get-Service -Name cloudflared -EA SilentlyContinue
  if ($cfs) { Note "cloudflared service: $($cfs.Status)" } else { Note 'cloudflared service: not installed as a service' }
  $cfp = @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -EA SilentlyContinue)
  Note "cloudflared processes on this machine: $($cfp.Count)"
  $sh = Join-Path $OpsDir 'logs\selfheal.jsonl'
  if (Test-Path $sh) { Note 'last self-heal entries:'; Get-Content $sh -Tail 3 | ForEach-Object { Note "  $_" } }

  # ------------------------------------------------------------ tunnel
  # The coordinator need not run here: since HANDOFF_2026-10-05b_host-move.md
  # it lives on laptop-gj8dfmlk. Probe the one this checkout dials, the way
  # run.js resolves it (the environment first, then .env), not loopback only,
  # which read a deliberate move as an outage on every pass.
  $coordUrl = "http://127.0.0.1:$CoordinatorPort"
  if ($env:ALPHA_HOST_URL) { $coordUrl = $env:ALPHA_HOST_URL }
  else {
    $envFile = Join-Path $repo '.env'
    $line = if (Test-Path $envFile) { Select-String -Path $envFile -Pattern '^ALPHA_HOST_URL=(.+)$' | Select-Object -Last 1 }
    if ($line) { $coordUrl = $line.Matches[0].Groups[1].Value }
  }
  $coordUrl = $coordUrl.Trim().Trim('"', "'").TrimEnd('/')
  $remote = $coordUrl -notmatch '^https?://(127\.0\.0\.1|localhost|\[::1\])(:|/|$)'
  Section "5. alpha-tunnel coordinator ($coordUrl)"
  $hz = Body "$coordUrl/healthz"
  if ($hz) { OK "healthz: $hz" } else { Problem "no coordinator answering at $coordUrl" }
  if ($remote) {
    Note 'the coordinator runs on another machine; none should listen here'
    $here = Owner $CoordinatorPort
    if ($here) { Problem "port $CoordinatorPort here is held by $(Describe $here): a second coordinator beside $coordUrl splits the fleet" }
  } else {
    Note "port $CoordinatorPort : $(Describe (Owner $CoordinatorPort))"
  }
  $agentsOut = ''
  if ($hz) {
    foreach ($cmd in 'agents', 'stats', 'keys', 'tasks') {
      $out1 = Admin $cmd
      if ($cmd -eq 'agents') { $agentsOut = "$out1" }
      Note "--- $cmd"; Indent $out1
    }
  }

  # ------------------------------------------------------------ music
  # Generate on the Music Creator runs: page -> /music/* on the site -> the
  # music bridge on 127.0.0.1:8790 -> an alpha.music task -> a machine whose
  # agent offers alpha.music. On 2026-10-06 three of those links were missing
  # and nothing said so: the site sent /music to the backend (404), no bridge
  # ran, and no machine offered alpha.music.
  Section '5b. Music Creator'
  # Which machines offer a type is in the coordinator's agent list only when
  # this doctor is signed in. Signed out, $agentsOut is the "Not signed in"
  # text, and reading that as an empty fleet said "no machine offers
  # alpha.music" on every run (Worker1, 2026-10-06), whatever the agents
  # offered. The bridges hold keys of their own, so they are asked instead.
  $agentListed = $hz -and $agentsOut -and $agentsOut -notmatch '(?i)not signed in|unauthori[sz]ed|forbidden'
  $bridgeUp = (Body "http://127.0.0.1:$MusicBridgePort/music/healthz") -match '"ok"\s*:\s*true'
  if ($bridgeUp) { OK "music bridge answers on 127.0.0.1:$MusicBridgePort" }
  else { Problem "music bridge is not running on 127.0.0.1:${MusicBridgePort}: Generate cannot queue anything" }
  $viaSite = ''
  foreach ($scheme in 'http', 'https') { if (-not $viaSite) { $viaSite = Body "${scheme}://127.0.0.1:$FrontendPort/music/healthz" } }
  if ($viaSite -match '"ok"\s*:\s*true') { OK "the site routes /music to the bridge (port $FrontendPort)" }
  elseif ($viaSite -match 'bridge_down') { Note "the site routes /music to the bridge, which is not answering" }
  elseif ($viaSite -match 'Not Found|"detail"') { Problem "the site sends /music to Alpha's backend, not the music bridge: Generate gets a 404" }
  elseif ($viaSite) { Note "/music/healthz on port $FrontendPort answered something else: $(($viaSite -replace '\s+', ' ').Substring(0, [math]::Min(80, $viaSite.Length)))" }
  if ($agentListed) {
    $makers = @($agentsOut -split "`r?`n" | Where-Object { $_ -match '(^|[\s,])alpha\.music([\s,]|$)' } | ForEach-Object { ($_.Trim() -split '\s+')[0] })
    if ($makers.Count) { OK "machines that make music: $($makers -join ', ')" }
    else { Problem 'no machine offers alpha.music: a queued track waits forever' }
  } elseif ($bridgeUp) {
    $fleetText = Body "http://127.0.0.1:$MusicBridgePort/music/fleet"
    $fleet = $null
    try { $fleet = $fleetText | ConvertFrom-Json } catch { }
    if ($fleet -and ($fleet.PSObject.Properties.Name -contains 'machines')) {
      $makers = @($fleet.machines | ForEach-Object { $_.name } | Where-Object { $_ })
      if ($makers.Count) { OK "machines that make music (the music bridge's view): $($makers -join ', ')" }
      else { Problem 'no machine offers alpha.music: a queued track waits forever' }
    }
    elseif ($fleetText -match 'bridge_key_rejected') { Note "which machines make music is not known here: the doctor cannot read the coordinator's agent list, and the music bridge's key cannot list machines (it needs agents:read)" }
    else { Note "which machines make music is not known here: the doctor cannot read the coordinator's agent list, and the music bridge did not say" }
  }
  else { Note "which machines make music is not known here: the doctor cannot read the coordinator's agent list, and the music bridge is down" }

  # Images the same way: Alpha -> IMAGE_GEN_URL -> the image bridge on 7861 ->
  # an alpha.image task -> the least busy machine offering it. Worker1's own
  # generator (7860) stays as Alpha's fallback, so images keep working while
  # this is down; the work is just not shared.
  Section '5c. Image creator'
  $imageUp = (Body "http://127.0.0.1:$ImageBridgePort/healthz") -match '"ok"\s*:\s*true'
  if ($imageUp) { OK "image bridge answers on 127.0.0.1:$ImageBridgePort" }
  else { Problem "image bridge is not running on 127.0.0.1:${ImageBridgePort}: images are not shared between machines" }
  if ($agentListed) {
    $painters = @($agentsOut -split "`r?`n" | Where-Object { $_ -match '(^|[\s,])alpha\.image([\s,]|$)' } | ForEach-Object { ($_.Trim() -split '\s+')[0] })
    if ($painters.Count) { OK "machines that make images: $($painters -join ', ')" }
    else { Problem 'no machine offers alpha.image: the image bridge has nowhere to send work' }
  } elseif ($imageUp) {
    # sd-models names the machines in its title ("Alpha (host, worker1)"),
    # answers 503 no_image_machine when none, and plain "Alpha" when its key
    # cannot list machines.
    $models = Body "http://127.0.0.1:$ImageBridgePort/sdapi/v1/sd-models"
    if ($models -match 'no_image_machine') { Problem 'no machine offers alpha.image: the image bridge has nowhere to send work' }
    elseif ($models -match '"title"\s*:\s*"[^"]*\(([^)"]+)\)"') { OK "machines that make images (the image bridge's view): $($Matches[1])" }
    else { Note "which machines make images is not known here: the doctor cannot read the coordinator's agent list, and the image bridge's key cannot list machines (it needs agents:read)" }
  }
  else { Note "which machines make images is not known here: the doctor cannot read the coordinator's agent list, and the image bridge is down" }

  # The brain deck draws the links /neurobrain/anatomy-map sends, and checks
  # them, in the source and in the build the site serves. On 2026-10-06 the
  # live deck drew a ring and spokes from an empty point under "Topology
  # synchronized"; brain-topology-check.mjs reads all three layers.
  Section '5d. Brain topology (neurological deck)'
  $brainOut = (& node (Join-Path $PSScriptRoot 'brain-topology-check.mjs') --alpha-root $AlphaRoot 2>&1 | Out-String)
  foreach ($bl in ($brainOut -split "`r?`n" | Where-Object { $_.Trim() })) {
    if ($bl -match '^OK: (.*)') { OK "brain deck: $($Matches[1])" }
    elseif ($bl -match '^PROBLEM: (.*)') { Problem "brain deck: $($Matches[1])" }
    elseif ($bl -match '^NOTE: (.*)') { Note "brain deck: $($Matches[1])" }
  }

  # ------------------------------------------------------------ panel
  Section '6. CrowPanel'
  Push-Location $repo
  try { Indent ((& node scripts\panel-up.mjs --list-ports 2>&1 | Plain | Out-String)) } finally { Pop-Location }
  foreach ($d in @(Get-CimInstance Win32_PnPEntity -Filter "Name LIKE '%(COM%'" -EA SilentlyContinue)) { Note "device: $($d.Name)" }
  Devices-ByAddress
  Note "the tunnel's panel firmware (firmware/crowpanel) is live only if its agents:read key in the keys list above was used in the last few seconds"
  Check-DeckFeed

  # ------------------------------------------------------------ resources
  Section '7. Memory, disk, heaviest processes'
  $os = Get-CimInstance Win32_OperatingSystem
  $free = [math]::Round($os.FreePhysicalMemory / 1MB, 1); $total = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
  if ($free / $total -lt 0.1) { Problem "only $free of $total GB RAM free" } else { OK "$free of $total GB RAM free" }
  $c = Get-PSDrive C -EA SilentlyContinue
  if ($c) { $g = [math]::Round($c.Free / 1GB, 1); if ($g -lt 5) { Problem "C: only $g GB free" } else { OK "C: $g GB free" } }
  # TEMP on a drive that is gone breaks every installer and build that uses it.
  $tq = [IO.Path]::GetPathRoot("$env:TEMP")
  if ($tq -and -not (Test-Path $tq)) { Problem "TEMP points at $env:TEMP, on a drive that is not there (the removed USB?)" }
  Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 8 |
    ForEach-Object { Note ("{0,-28} {1,6:n0} MB  pid {2}" -f $_.ProcessName, ($_.WorkingSet64 / 1MB), $_.Id) }

  # ------------------------------------------------------------ images
  # Chat image requests go to IMAGE_GEN_URL (an AUTOMATIC1111 /sdapi/v1/txt2img
  # endpoint). The backend counts any HTTP answer on that port as "reachable",
  # so another program on the port (a Gradio app such as ACE-Step also
  # defaults to 7860) turns every image into "image backend failed: HTTP 503".
  Section '8. Image generation'
  $imgUrl = ''
  $imgFrom = ''
  foreach ($scope in 'Process', 'User', 'Machine') {
    $v = [Environment]::GetEnvironmentVariable('IMAGE_GEN_URL', $scope)
    if ($v -and -not $imgUrl) { $imgUrl = $v.Trim(); $imgFrom = "environment ($scope)" }
  }
  if (-not $imgUrl) {
    # .env.local first: the .bak copies beside it carry old values.
    $envFiles = @((Join-Path $AlphaRoot 'backend\.env.local'), (Join-Path $AlphaRoot '.env.local'), (Join-Path (Split-Path $AlphaRoot -Parent) '.env.local'),
                  (Join-Path $AlphaRoot 'backend\.env'), (Join-Path $AlphaRoot '.env'), (Join-Path (Split-Path $AlphaRoot -Parent) '.env'))
    # Select-String stops at the first path that does not exist, so pass only real files.
    $envFiles = @($envFiles | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
    foreach ($hit in @(if ($envFiles) { Select-String -LiteralPath $envFiles -Pattern '^\s*IMAGE_GEN_URL\s*=' -EA SilentlyContinue })) {
      if (-not $imgUrl) { $imgUrl = ($hit.Line -split '=', 2)[1].Trim().Trim('"', "'"); $imgFrom = $hit.Filename }
    }
  }
  $imgPort = 7860
  $imgBase = 'http://127.0.0.1:7860'
  if ($imgUrl) {
    try {
      $u = [Uri]$imgUrl
      $imgPort = $u.Port
      $imgBase = "$($u.Scheme)://$($u.Host):$($u.Port)"
      Note "IMAGE_GEN_URL = $($u.Scheme)://$($u.Host):$($u.Port)$($u.AbsolutePath)  (from $imgFrom)"
    } catch { Note "IMAGE_GEN_URL is set but is not a URL (from $imgFrom)" }
  } else {
    Note 'IMAGE_GEN_URL is not set in the environment or the backend .env files; probing the default http://127.0.0.1:7860'
  }
  $local = $imgBase -match '://(127\.0\.0\.1|localhost)[:/]'
  $holder = if ($local) { Owner $imgPort } else { $null }
  if ($local) {
    $desc = Describe $holder
    if ($desc.Length -gt 160) { $desc = $desc.Substring(0, 160) + '...' }
    Note "port $imgPort : $desc"
  }
  # Alpha's own scripts\alpha_comfyui_bridge*.py takes A1111-style txt2img on
  # this port and hands the job to ComfyUI. It has no /sdapi/v1/sd-models, so
  # probe what it depends on instead: ComfyUI's own API.
  if ($holder -and "$($holder.CommandLine)" -match 'comfyui_bridge') {
    $comfy = Http 'http://127.0.0.1:8188/system_stats'
    if ($comfy -like '2*') { OK "port $imgPort is Alpha's ComfyUI bridge, and ComfyUI answers on 8188 ($comfy)" }
    else { Problem "image port $imgPort is Alpha's ComfyUI bridge, but ComfyUI does not answer on 8188 ($comfy): chat images fail with HTTP 503" }
    return
  }
  $api = Http "$imgBase/sdapi/v1/sd-models"
  if ($api -like '2*') {
    OK "Stable Diffusion API answers on $imgBase ($api)"
  } elseif ($api -eq '000') {
    if ($imgUrl) { Problem "image backend not running: nothing answers on $imgBase (chat images fail)" }
    else { Note 'no image backend running on 7860 (chat images are off until IMAGE_GEN_URL points at one)' }
  } elseif ($api -eq '404') {
    # Run without elevation (the scheduled doctor), Windows hides the command
    # line of a process started elevated, so the bridge check above cannot
    # match. A python holder that has no sd-models while ComfyUI answers on
    # 8188 is that same bridge; reporting it as broken was a false alarm.
    if ($holder -and -not "$($holder.CommandLine)" -and $holder.Name -match '^python') {
      $comfy = Http 'http://127.0.0.1:8188/system_stats'
      if ($comfy -like '2*') {
        OK "port $imgPort is held by $($holder.Name) (its command line is hidden without elevation), and ComfyUI answers on 8188 ($comfy): Alpha's ComfyUI bridge"
        return
      }
    }
    $who = if ($holder) { $holder.Name } else { 'another program' }
    Problem "image port $imgPort is held by $who, not Stable Diffusion's API (/sdapi/v1/sd-models answers 404): chat images fail with HTTP 503"
  } else {
    Problem "image backend on $imgBase answers $api to /sdapi/v1/sd-models: still loading, or broken (chat images fail)"
  }
}

# ------------------------------------------------------------ schedule
$taskName = 'Alpha Doctor'
if ($UninstallSchedule) {
  schtasks.exe /Delete /TN $taskName /F
  exit $LASTEXITCODE
}
if ($InstallSchedule) {
  # As you, only while you are logged on: the report is pushed with your git
  # credentials, which a SYSTEM or S4U task cannot read. Check-only (-Watch);
  # unattended repair is the self-heal task's job, which has the budgets.
  $me = Join-Path $PSScriptRoot 'laptop41-doctor.ps1'
  $tr = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$me`" -Watch -AlphaRoot `"$AlphaRoot`""
  if ($tr.Length -gt 261) { Write-Host "command too long for schtasks ($($tr.Length) chars): move the checkout to a shorter path" -ForegroundColor Red; exit 1 }
  schtasks.exe /Create /TN $taskName /SC MINUTE /MO $EveryMinutes /TR $tr /F
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
           -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
  Set-ScheduledTask -TaskName $taskName -Settings $set | Out-Null
  Start-ScheduledTask -TaskName $taskName
  Write-Host "installed '$taskName': every $EveryMinutes minutes, check-only, first run started now." -ForegroundColor Green
  Write-Host "reports: $reportDir   remove: -UninstallSchedule"
  if (-not $env:ALPHA_ADMIN_TOKEN) {
    Write-Host "to include agents/keys/tasks, store the admin key for your user once:" -ForegroundColor Yellow
    Write-Host "  [Environment]::SetEnvironmentVariable('ALPHA_ADMIN_TOKEN', (Read-Host 'admin key'), 'User')"
  }
  exit 0
}

$script:startedAt = Get-Date
# Which doctor wrote this report: a schedule left on an old checkout reports
# yesterday's advice, and nothing else in the report would say so.
$doctorRev = (git -C $repo log -1 --format='%h %cs' 2>$null | Plain | Out-String).Trim()
Out1 "laptop41-doctor $stamp on $env:COMPUTERNAME  (alpha root $AlphaRoot, checkout $repo @ $doctorRev)"
Run-Checks

if ($Fix) {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  Section 'FIX'
  if (-not $admin) { Problem '-Fix needs an Administrator PowerShell; nothing was changed' }
  else {
    $did = $false
    if ($script:chatBug) {
      Note 'applying the chat fix (backup kept; undo command is printed below)'
      Indent ((& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'apply-chat-fix.ps1') -MainPy $script:mainPy -OpsDir $OpsDir -Apply -Restart 2>&1 | Plain | Out-String))
      $did = $true
    }
    if ($script:frontendStale) {
      # A linked worktree has a .git *file*; the real checkout has a folder.
      if (-not (Test-Path (Join-Path $repo '.git') -PathType Container)) {
        Problem "not running repair-alpha-host.ps1 from this temporary worktree ($repo): the self-heal task it installs would point here. Run it from the real checkout once it has this branch's fix"
      } elseif (-not $script:frontend -or (Split-Path $script:frontend -Leaf) -ne 'frontend') {
        Problem "repair-alpha-host.ps1 expects <root>\frontend; the frontend found was '$($script:frontend)'"
      } else {
        $root = Split-Path $script:frontend -Parent
        Note "running repair-alpha-host.ps1 -AlphaRoot $root (rebuilds a stale dist, old one kept; -Rollback undoes it)"
        Indent ((& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'repair-alpha-host.ps1') -AlphaRoot $root -OpsDir $OpsDir 2>&1 | Plain | Select-Object -Last 60 | Out-String))
        $did = $true
      }
    }
    if ($did) {
      $problems.Clear()
      Section 'AFTER FIX - checking everything again'
      Run-Checks
    } else { Note 'nothing was changed' }
  }
}

# ------------------------------------------------------------ across runs
# A stable key per problem: digits, hashes and paths of build assets change
# from run to run without the problem changing.
function KeyOf($t) { ("$t" -replace '/assets/[^\s,]+', '<bundle>' -replace '\d+', '#').Trim() }

$statePath = Join-Path $OpsDir 'doctor-state.json'
$prev = $null
if (Test-Path $statePath) { try { $prev = Get-Content $statePath -Raw | ConvertFrom-Json } catch { $prev = $null } }
$now = Get-Date
$open = @{}
foreach ($p in $problems) {
  $k = KeyOf $p
  $was = $null
  if ($prev -and $prev.open) { $was = $prev.open.PSObject.Properties[$k] }
  if ($was) { $open[$k] = @{ text = $p; since = ([datetime]$was.Value.since).ToString('s'); runs = [int]$was.Value.runs + 1 } }
  else      { $open[$k] = @{ text = $p; since = $now.ToString('s'); runs = 1 } }
}
$resolved = @()
if ($prev -and $prev.open) {
  foreach ($pp in $prev.open.PSObject.Properties) { if (-not $open.ContainsKey($pp.Name)) { $resolved += $pp.Value.text } }
}
$escalate = @($open.Values | Where-Object { $_.runs -ge $EscalateAfterRuns })

# ------------------------------------------------------------ recommendations
# Each open problem maps to the one action that clears it; the list is ranked
# by how long the problem has been open, so whatever keeps not getting fixed
# climbs. What is left of the nine is standing hardening, dropped once done.
$rules = @(
  @{ m = 'does not exist$';                                                                     r = 'The Alpha root is missing: point the doctor (and its schedule) at the copy that is actually running, e.g. -AlphaRoot C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software, then -InstallSchedule again with the same -AlphaRoot.' },
  @{ m = 'Self-Heal is not registered|Backend is not registered|repair-alpha-host';          r = 'git pull in C:\services\alpha-tunnel, then run scripts\repair-alpha-host.ps1 -AlphaRoot <the copy that is running> as Administrator (-ReportOnly first): boot task for the backend, frontend build + task, self-heal every 2 min.' },
  @{ m = 'no main\.py defining chat|more than one backend main\.py';                           r = 'The backend on 8001 runs from outside the Alpha root: read its command line in section 0 and re-run with -AlphaRoot <that folder>, so the boot task and the chat fix target the code that is actually running.' },
  @{ m = 'music bridge is not running';                                                         r = 'Run the music bridge: queue {"do":"enable-music","bridge":true} for the autopilot (it also sets this machine up to make music).' },
  @{ m = "the site sends /music to Alpha's backend";                                            r = "Route the Music Creator to the bridge: apply-update the live branch (vite.config.js sends /music/generate, /healthz, /tasks to musicBridgeProxy)." },
  @{ m = 'image bridge is not running';                                                         r = 'Share images between machines: queue {"do":"enable-image","bridge":true} on Worker1''s autopilot (keeps 7860 as the fallback).' },
  @{ m = 'no machine offers alpha.image';                                                       r = 'Make images on each laptop: queue {"do":"enable-image"} (Worker1) and {"do":"enable-image","installComfy":true} (Host).' },
  @{ m = "brain deck: the deck's source|brain deck: the site serves the old deck";                  r = 'Bring in the fixed brain deck: the autopilot does it by itself when control/<channel> sets autofix.brainTopology.branch, or queue {"do":"brain-topology","fix":true,"branch":"<live Alpha branch>"}.' },
  @{ m = 'brain deck: the site serves a build from before the fix';                              r = 'Rebuild the frontend so the site serves the fixed brain deck: repair-alpha-host.ps1 (rollback kept), or npm run build in the frontend folder, then Start-ScheduledTask Alpha.' },
  @{ m = 'brain deck: the anatomy map';                                                         r = "The backend's /neurobrain/anatomy-map sends a link to a region it does not define (section 5d names it): fix the links list in main.py, then restart the backend." },
  @{ m = 'no machine offers alpha.music';                                                       r = 'Make music on each laptop: queue {"do":"enable-music"} on its autopilot (installs MusicGen, enables alpha-music, restarts the agent).' },
  @{ m = "Ollama does not answer";                                                              r = 'Start Ollama on this machine (the Ollama app, or `ollama serve`); Alpha has no chat model without it.' },
  @{ m = "chat model '.*' is not pulled";                                                       r = 'Pull the chat model: queue {"do":"ollama-pull","model":"<name>"} for the autopilot, or run `ollama pull <name>`.' },
  @{ m = "chat model '.*' took .*s to load";                                                    r = 'Keep the chat model loaded: queue {"do":"ollama-keepalive"} for the autopilot (sets OLLAMA_KEEP_ALIVE=24h, restarts Ollama, loads the model). Closing apps does not help a slow load.' },
  @{ m = "chat model '.*' (did not answer|took .*s to answer)";                                             r = 'The chat model is too slow or failing here: close heavy apps (section 7), or move chat to a bigger machine (HANDOFF_2026-10-06_server-day.md).' },
  @{ m = "chat '.*' failed";                                                                    r = 'Chat answers 500: the traceback in section 2 names the line. Send the report to Claude; do not restart in a loop, it is a code bug, not a crash.' },
  @{ m = 'dictionary bug';                                                                      r = 'Run the doctor once with -Fix as Administrator: apply-chat-fix.ps1 patches the dictionary 500, keeps a backup and restarts the backend.' },
  @{ m = 'no dist|build is older|nothing serves Alpha|older build than dist';                   r = 'Build and serve the frontend: repair-alpha-host.ps1 does it with rollback; by hand it is npm ci; npm run build in the frontend folder, then Start-ScheduledTask Alpha.' },
  @{ m = 'public site serves';                                                                  r = 'alpha-ai.uk is not served by this machine: if section 3 shows cf-cache-status HIT, purge the Cloudflare cache; otherwise stop the other cloudflared connector for this tunnel (a standby laptop started with --cloudflared).' },
  @{ m = "task Alpha is not registered|'Alpha' task does not mention|Alpha .*0xC000013A";      r = "Re-point the 'Alpha' task at the frontend found in section 0 (repair-alpha-host.ps1 does it and keeps the old task exported)." },
  @{ m = 'changed after the backend started';                                                   r = 'Restart the backend so it runs the code on disk: apply-chat-fix.ps1 -Restart, or stop the python on 8001 and let its task start it.' },
  @{ m = 'no coordinator answering';                                                            r = 'Start the alpha-tunnel coordinator on the machine ALPHA_HOST_URL names (laptop-gj8dfmlk since 2026-10-05: its alpha-coordinator task); on this machine only if .env points at loopback.' },
  @{ m = 'splits the fleet';                                                                    r = 'Stop the coordinator on this machine and keep it stopped (HANDOFF_2026-10-05b_host-move.md, A3): the fleet now dials the Host.' },
  @{ m = 'TEMP points at';                                                                      r = "Point TEMP back at C:: [Environment]::SetEnvironmentVariable('TEMP', `"`$env:LOCALAPPDATA\Temp`", 'User') and the same for TMP, then sign out and in." },
  @{ m = 'RAM free|GB free';                                                                    r = 'Free memory or disk: close the heaviest processes in section 7 that are not Alpha, and clear old dist.prev-* / dist.failed-* folders once a build is known good.' },
  @{ m = 'ComfyUI does not answer on 8188';                                                       r = "Start ComfyUI (its run_cpu.bat or run_nvidia_gpu.bat, or python main.py --listen 127.0.0.1 --port 8188) and leave it running; Alpha's bridge on 7860 forwards chat images to it. Section 8 then shows ComfyUI answering 200." },
  @{ m = 'image port .* is held by';                                                            r = "Another program holds the image port (section 8 names it; ACE-Step's Gradio app also defaults to 7860). Start Stable Diffusion WebUI with --api --port 7861 and set IMAGE_GEN_URL=http://127.0.0.1:7861/sdapi/v1/txt2img where the backend reads it, then restart the backend." },
  @{ m = 'image backend not running|image backend on .* answers';                                r = 'Start Stable Diffusion WebUI with --api (COMMANDLINE_ARGS in webui-user.bat) and wait for "Model loaded"; section 8 then shows the API answering 200.' },
  @{ m = 'deck feed is off';                                                                    r = 'Turn on the deck feed: set ALPHA_PANEL_LAN_READ=true in the .env.local section 6 names, then restart the backend (queue {"do":"restart-backend"} for the autopilot). The route serves status only, and only to home-network and loopback callers.' },
  @{ m = 'deck feed answers 404 though|is not a trusted host';                                 r = 'Restart the backend so it reads its settings again and trusts the addresses this machine has now: queue {"do":"restart-backend"} for the autopilot.' },
  @{ m = 'listens on no home-network address';                                                  r = 'Add the home-network address section 6 names to HOST in .env.local (comma-separated; keep 127.0.0.1 and the tailnet address), restart the backend, and give the panel http://<that address>:8001. A DHCP reservation for this machine stops the address moving.' },
  @{ m = 'deck feed is (?!off)|does not say why: it predates';                                  r = "The assistant loop's heartbeat is old or missing, so the deck shows a stale feed. Alpha#26 (merged to alpha-full) keeps it fresh between cycles and reaches this machine with the route B update. If the reason is assistant-loop-not-started, lightweight autonomy is off or interactive-first mode is on." },
  @{ m = 'no device on the home network has called';                                            r = 'The deck panel is not reaching this machine. Over USB serial send STATUS (it reports wifi_ssid, wifi_set and alpha_base, no secrets), then re-provision: WIFI "<ssid>" <passphrase>, then ALPHA http://<address from section 6>:8001. Hardware Hub > CrowPanel Alpha Deck > "Connect this panel to Wi-Fi" does the same.' },
  @{ m = 'not answering|answered 0|answers [45]';                                               r ='An endpoint is down: compare section 1 (backend) and section 4 (public); if only public fails and the origin is fine, the connector is the fault.' }
)
$standing = @(
  @{ done = { (Get-ScheduledTask -TaskName 'Alpha Self-Heal' -EA SilentlyContinue) -or (SelfHealFresh) };  r = 'Install the self-heal (repair-alpha-host.ps1): it repairs with streaks, cooldowns and budgets, which a 15-minute checker must not.' },
  @{ done = { $env:ALPHA_ADMIN_TOKEN };                                               r = "Store the coordinator admin key for your user so scheduled runs include agents/keys/tasks: [Environment]::SetEnvironmentVariable('ALPHA_ADMIN_TOKEN', (Read-Host 'key'), 'User')." },
  @{ done = { Test-Path (Join-Path $repo '.git') -PathType Container };                r = 'Run this doctor from the real checkout (C:\services\alpha-tunnel, git pull first), then -InstallSchedule -AlphaRoot <the running copy> again from there and remove C:\AlphaData\doctor.' },
  @{ done = { (Get-Service cloudflared -EA SilentlyContinue).StartType -eq 'Automatic' }; r = 'Set the cloudflared service to Automatic start so the public hostname survives a reboot.' },
  @{ done = { Test-Path (Join-Path $OpsDir 'backups') };                               r = 'Back up C:\AlphaData\alpha-ops and the coordinator data\auth.json to another disk; they are the only copy of the repair history and the credentials.' },
  @{ done = { $false };                                                                r = 'Ask Alpha (chat) for a recap of the doctor posts weekly, and read the self-heal log (alpha-ops\logs\selfheal.jsonl) for repairs that repeat.' },
  @{ done = { $false };                                                                r = 'Keep laptop 41 on AC with sleep off (repair-alpha-host step 5); a sleeping host is an outage that no checker can fix.' },
  @{ done = { $false };                                                                r = 'Test a reboot once everything is green: every check here should pass again within 5 minutes with nobody logged in.' },
  @{ done = { $false };                                                                r = 'Rotate the panel and agent keys after the coordinator move: keys issued by the old coordinator are void and should be revoked.' },
  @{ done = { $false };                                                                r = 'Set Windows Update active hours around when Alpha is used, so a forced restart lands when nobody needs it.' },
  @{ done = { $false };                                                                r = 'Remove what does not belong on the host once it is green: the ChatGPT app and other heavy tools in section 7 compete with Alpha for the same 16 GB.' }
)
$recs = New-Object System.Collections.ArrayList
foreach ($o in ($open.Values | Sort-Object { -$_.runs })) {
  foreach ($rule in $rules) {
    if ($o.text -match $rule.m -and -not ($recs | Where-Object { $_.r -eq $rule.r })) {
      $age = if ($o.runs -eq 1) { 'new' } else { "open $($o.runs) runs" }
      $who = if ($o.runs -ge $EscalateAfterRuns) { ' NEEDS A PERSON' } else { '' }
      [void]$recs.Add(@{ r = $rule.r; tag = "[$age$who]" }); break
    }
  }
}
foreach ($st in $standing) {
  if ($recs.Count -ge 9) { break }
  $isDone = $false; try { $isDone = [bool](& $st.done) } catch {}
  if (-not $isDone) { [void]$recs.Add(@{ r = $st.r; tag = '[hardening]' }) }
}

Section 'SUMMARY'
Note ("this pass took {0:n0}s" -f ((Get-Date) - $script:startedAt).TotalSeconds)
if ($problems.Count -eq 0) { OK 'no problems found' }
foreach ($o in ($open.Values | Sort-Object { -$_.runs })) {
  $flag = if ($o.runs -ge $EscalateAfterRuns) { 'NEEDS A PERSON - ' } else { '' }
  Out1 ("  - {0}{1}  (open {2} run(s), since {3})" -f $flag, $o.text, $o.runs, $o.since) 'Red'
}
foreach ($r in $resolved) { Out1 "  + fixed since last run: $r" 'Green' }

Section 'RECOMMENDATIONS (ranked; re-ranked every run)'
$n = 0
foreach ($rc in ($recs | Select-Object -First 9)) { $n++; Out1 ("  {0}. {1} {2}" -f $n, $rc.tag, $rc.r) }

# ------------------------------------------------------------ write
# Never let a credential reach the file: tunnel tokens, JWTs, bearer headers.
function Redact($t) {
  $t = [regex]::Replace("$t", 'alpha_[a-z]+_[A-Za-z0-9]+\.[A-Za-z0-9_\-]+', 'alpha_<redacted>')
  $t = [regex]::Replace($t, 'eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+', '<jwt redacted>')
  return [regex]::Replace($t, '(?i)(bearer\s+)\S+', '$1<redacted>')
}
$text = Redact ($lines -join "`r`n")
[IO.File]::WriteAllText($report, $text, (New-Object Text.UTF8Encoding($false)))
Copy-Item $report (Join-Path $reportDir 'latest.txt') -Force
# Keep a day of 15-minute reports, not a year of them.
Get-ChildItem $reportDir -Filter 'laptop41-doctor-*.txt' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 100 | Remove-Item -Force -EA SilentlyContinue
Write-Host "`nreport: $report"

# Alpha's coordination script lives in scripts\ beside software\, and the
# schedule passes software\ as -AlphaRoot. Looking only under -AlphaRoot never
# found it, so for two days nothing was posted and no cloud report was relayed.
function Find-CoordinationScript {
  $parent = Split-Path $AlphaRoot -Parent
  foreach ($c in @((Join-Path $AlphaRoot 'scripts'), $(if ($parent) { Join-Path $parent 'scripts' }))) {
    if ($c) { $f = Join-Path $c 'alpha_coordination_tunnel.ps1'; if (Test-Path -LiteralPath $f -PathType Leaf) { return (Get-Item -LiteralPath $f) } }
  }
  Find-Files @($AlphaRoot) @('alpha_coordination_tunnel.ps1') 3 | Select-Object -First 1
}
$relayNote = $null

# Posts one message as $actor; returns the coordination script's exit code.
# Not -Message $msg on the command line: Windows PowerShell 5.1 does not
# escape a " inside a native argument, so any message quoting a name was split
# and the post failed (exit 1) every run. The message goes through a file and
# the command is base64, so nothing in it is ever parsed as arguments.
function Post-ToAlpha($co, [string]$actor, [string]$msg) {
  New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
  $msgFile = Join-Path $tmpDir "post-$actor.txt"
  [IO.File]::WriteAllText($msgFile, $msg, (New-Object Text.UTF8Encoding($false)))
  $q = { param($s) "'" + ($s -replace "'", "''") + "'" }
  $cmd = "& $(& $q $co.FullName) -Action Post -Actor $(& $q $actor) -Message ([IO.File]::ReadAllText($(& $q $msgFile))); exit `$LASTEXITCODE"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))) 2>&1 | Out-Null
  $code = $LASTEXITCODE
  Remove-Item $msgFile -Force -EA SilentlyContinue
  return $code
}

# ------------------------------------------------------------ tell Alpha
# On a change, and hourly while anything is open: every 15 minutes is noise
# nobody reads.
$changed = (-not $prev) -or ($resolved.Count -gt 0) -or (@($open.Values | Where-Object { $_.runs -eq 1 }).Count -gt 0)
$lastPost = if ($prev -and $prev.lastPost) { [datetime]$prev.lastPost } else { [datetime]::MinValue }
$due = $changed -or (($open.Count -gt 0) -and (($now - $lastPost).TotalMinutes -ge 60))
$posted = $false
if ($Watch -and $due) {
  $co = Find-CoordinationScript
  $head = if ($open.Count -eq 0) { 'Alpha host check: all green.' } else { "Alpha host check: $($open.Count) open problem(s), $($escalate.Count) need a person." }
  $body = @($head)
  foreach ($o in ($open.Values | Sort-Object { -$_.runs } | Select-Object -First 5)) { $body += "- $($o.text) [open $($o.runs) runs]" }
  foreach ($r in $resolved) { $body += "+ fixed: $r" }
  $top = @($recs | Select-Object -First 3)
  for ($j = 0; $j -lt $top.Count; $j++) { $body += "Next $($j + 1): $($top[$j].r)" }
  $msg = Redact ($body -join "`n")
  if ($msg.Length -gt 3900) { $msg = $msg.Substring(0, 3900) }
  if ($co) {
    $posted = ((Post-ToAlpha $co 'alpha-doctor' $msg) -eq 0)
    Write-Host ("posted to Alpha: {0}" -f $posted)
  } else { $relayNote = "no alpha_coordination_tunnel.ps1 near $AlphaRoot - not posted"; Write-Host $relayNote -ForegroundColor Yellow }
}

# ------------------------------------------------------------ relay the cloud
# The other direction. A cloud Claude session cannot reach the tailnet, so it
# writes its report to a status branch; this passes each new one to Alpha's
# coordination tunnel, where Alpha and Codex read. Two branches:
#   status/cloud           reports/cloud.md    the "Alpha fleet relay" routine
#   status/claude-laptop41 reports/handoff.md  the cloud session that runs
#                                              Laptop41 through the autopilot
# Each is posted once per commit: the commit id is remembered.
function Relay-Branch([string]$branch, [string]$file, [string]$actor, [string]$seen) {
  git -C $repo fetch -q origin $branch 2>&1 | Plain | Out-Null
  if ($LASTEXITCODE -ne 0) { return $seen }
  $head = (git -C $repo rev-parse FETCH_HEAD 2>$null | Out-String).Trim()
  if (-not $head -or $head -eq $seen) { return $seen }
  $msg = (git -C $repo show "FETCH_HEAD:$file" 2>$null | Out-String).Trim()
  if (-not $msg) { return $seen }
  $co = Find-CoordinationScript
  if (-not $co) { $script:relayNote = "no alpha_coordination_tunnel.ps1 near $AlphaRoot - $branch not relayed"; Write-Host $script:relayNote -ForegroundColor Yellow; return $seen }
  $msg = Redact $msg
  if ($msg.Length -gt 3900) { $msg = $msg.Substring(0, 3900) }
  $code = Post-ToAlpha $co $actor $msg
  if ($code -eq 0) {
    $script:relayNote = "relayed $branch $($head.Substring(0, 7))"; Write-Host "relayed $branch to Alpha"
    return $head
  }
  $script:relayNote = "posting $branch failed (exit $code); will retry next run"; Write-Host $script:relayNote -ForegroundColor Yellow
  return $seen
}
$cloudSeen = if ($prev -and $prev.cloudSeen) { [string]$prev.cloudSeen } else { $null }
$handoffSeen = if ($prev -and $prev.handoffSeen) { [string]$prev.handoffSeen } else { $null }
if ($Watch) {
  $cloudSeen = Relay-Branch 'status/cloud' 'reports/cloud.md' 'claude-cloud' $cloudSeen
  $handoffSeen = Relay-Branch 'status/claude-laptop41' 'reports/handoff.md' 'claude-laptop41' $handoffSeen
}

$state = @{ lastRun = $now.ToString('s'); lastPost = $(if ($posted) { $now.ToString('s') } elseif ($prev) { $prev.lastPost } else { $null }); cloudSeen = $cloudSeen; handoffSeen = $handoffSeen; relay = $(if ($relayNote) { $relayNote } elseif ($prev) { $prev.relay } else { $null }); open = $open }
$state | ConvertTo-Json -Depth 5 | Set-Content -Path $statePath -Encoding ASCII

# ------------------------------------------------------------ push
# One branch, status/laptop41, fast-forwarded each time, so it is one place to
# read rather than a branch per run. Scheduled runs push when Alpha is told,
# and when the relay's outcome changes: while all is green nothing else would
# push, so a cloud session could not see whether its report got through.
$relayChanged = [bool]$relayNote -and ($relayNote -ne $(if ($prev) { [string]$prev.relay } else { '' }))
if ($Push -or ($Watch -and ($due -or $relayChanged))) {
  $branch = 'status/laptop41'
  $wt = Join-Path $tmpDir "push-$stamp"
  git -C $repo fetch -q origin $branch 2>&1 | Plain | Out-Null
  $base = if ($LASTEXITCODE -eq 0) { 'FETCH_HEAD' } else { 'HEAD' }
  git -C $repo worktree add --detach $wt $base 2>&1 | Plain | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Host "could not create a git worktree; attach $report instead" -ForegroundColor Yellow }
  else {
    New-Item -ItemType Directory -Force -Path (Join-Path $wt 'reports') | Out-Null
    Copy-Item $report (Join-Path $wt 'reports\latest.txt') -Force
    Copy-Item $statePath (Join-Path $wt 'reports\doctor-state.json') -Force
    $dev = Join-Path $OpsDir 'devices.json'
    if (Test-Path $dev) { Copy-Item $dev (Join-Path $wt 'reports\devices.json') -Force }
    git -C $wt add reports 2>&1 | Plain | Out-Null
    git -C $wt -c user.name=laptop41-doctor -c user.email=doctor@laptop41.invalid commit -q -m "laptop41 doctor ${stamp}: $($open.Count) open" 2>&1 | Plain | Out-Null
    git -C $wt push origin "HEAD:refs/heads/$branch" 2>&1 | Plain | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -eq 0) { Write-Host "pushed to $branch - tell Claude 'doctor pushed'" -ForegroundColor Green }
    else { Write-Host "push failed; attach $report instead" -ForegroundColor Yellow }
    git -C $repo worktree remove --force $wt 2>&1 | Plain | Out-Null
  }
}

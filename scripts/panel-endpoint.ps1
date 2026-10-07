<#
.SYNOPSIS
  Point the CrowPanel deck at this machine's Alpha backend, over the USB cable.

.DESCRIPTION
  The deck reads Alpha on a home-network address (it cannot reach 127.0.0.1
  or a tailnet 100.x). When this machine's DHCP lease moves, the deck keeps
  dialling the old address and goes dark, and until now the only fix was a
  person in Alpha's Hardware Hub. This does the same over the USB serial link
  the deck is plugged into, so the autopilot can run it ('panel-endpoint').

  It sends exactly one setting: ALPHA <base-url>, with no user or password, so
  the deck reads the LAN-only public feed and stores no owner credential. The
  URL is worked out here, from this machine's own home-network address and the
  backend port; nothing in it comes from a queued task. Wi-Fi credentials are
  never sent: a passphrase has no business in a task queue, so a deck with no
  Wi-Fi stored is reported for the owner to provision in Alpha's UI.

  Order of checks, each one stopping the run with the reason:
    1. this machine has a home-network address;
    2. the backend answers /health on it (pointing the deck at an address
       nothing serves would swap one dark screen for another);
    3. exactly one USB serial bridge is attached (never guess between two:
       writing to the wrong board is not undone by the next command);
    4. the deck answers STATUS (opening the port resets it, so this waits for
       the boot, the same rule as alpha-panel.js);
    5. after ALPHA, STATUS reports the new base.

  Exit 0: the deck reports the right base (set now, or already). 1: not done,
  with the reason. The STATUS line it prints carries no secret (the firmware
  reports wifi_set/alpha_set as yes/no, never the values).

.PARAMETER Port
  The deck's serial port, e.g. COM4. Skips the pick at step 3, which is what a
  person standing at the board is for: on 2026-10-07 the Espressif rule chose
  COM7 on Worker1, COM7 sent nothing at all for 30 s, and the board was on COM4.

.PARAMETER ParseStatus
  Test seam: parse one STATUS line and print it as JSON. Touches nothing.
#>
param(
  [int]$BackendPort = 8001,
  [int]$Baud = 115200,
  [string]$Port,
  [string]$ParseStatus,
  [string]$DescribeHeard
)

$ErrorActionPreference = 'Stop'

function Parse-Status([string]$line) {
  if ($line -notmatch '\[crowpanel\]\s+fw=') { return $null }
  $o = [ordered]@{}
  foreach ($m in [regex]::Matches($line, '(\w+)=(\S+)')) { $o[$m.Groups[1].Value] = $m.Groups[2].Value }
  return $o
}

if ($PSBoundParameters.ContainsKey('ParseStatus')) {
  $p = Parse-Status $ParseStatus
  if ($p) { $p | ConvertTo-Json -Compress } else { 'null' }
  exit 0
}

# What came back from the port, so a silent deck and a board speaking some other
# protocol are told apart. On 2026-10-07 COM7 gave no STATUS for 30 s and the
# report could not say whether it had said anything at all. At most three
# lines are kept, each cut short and with anything credential-shaped masked.
$script:heard = New-Object System.Collections.ArrayList
$script:bytes = 0
$script:pending = ''

function Take-Lines([string]$chunk) {
  $script:pending += $chunk
  $parts = $script:pending -split "`n"
  $script:pending = $parts[-1]
  if ($parts.Count -lt 2) { return @() }
  return @($parts[0..($parts.Count - 2)] | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Mask([string]$line) {
  $clean = ($line -replace '[^\x20-\x7E]', '?') -replace '(?i)((?:pass\w*|key|token|secret)["'']?\s*[=: ]\s*["'']?)[^\s"'',}]+', '$1***'
  if ($clean.Length -gt 120) { $clean = $clean.Substring(0, 120) + '...' }
  return $clean
}

# One chunk of what the port sent: the STATUS reply if a line is one, after
# keeping up to three lines that were not.
function Hear([string]$chunk) {
  $script:bytes += $chunk.Length
  foreach ($line in (Take-Lines $chunk)) {
    $p = Parse-Status $line
    if ($p) { return @{ line = $line; parsed = $p } }
    if ($script:heard.Count -lt 3) { [void]$script:heard.Add((Mask $line)) }
  }
  return $null
}

function Describe-Silence {
  if ($script:bytes -eq 0) { return 'nothing at all came back: the board is silent on this port (its console may be on another port, or it is not running)' }
  if ($script:heard.Count -eq 0) { return "$($script:bytes) byte(s) came back but never a whole line (wrong baud rate?)" }
  return 'it is talking, but not as Alpha''s deck firmware. It said: ' + (($script:heard | ForEach-Object { "'$_'" }) -join ' | ')
}

if ($PSBoundParameters.ContainsKey('DescribeHeard')) {
  $r = Hear ($DescribeHeard -replace '\\n', "`n")
  if ($r) { "status: $($r.line)" } else { Describe-Silence }
  exit 0
}

function Fail([string]$why) { Write-Host "PROBLEM: $why"; exit 1 }

# ------------------------------------------------------------ 1. address
function Is-HomeAddress([string]$ip) {
  return ($ip -match '^192\.168\.' -or $ip -match '^10\.' -or $ip -match '^172\.(1[6-9]|2\d|3[01])\.')
}
$addrs = @(Get-NetIPAddress -AddressFamily IPv4 -EA SilentlyContinue |
           Where-Object { (Is-HomeAddress $_.IPAddress) -and $_.InterfaceAlias -notmatch 'vEthernet|VirtualBox|VMware|Tailscale|Loopback' })
$wifi = @($addrs | Where-Object { $_.InterfaceAlias -like 'Wi-Fi*' -or $_.InterfaceAlias -like 'WLAN*' })
$pick = if ($wifi.Count) { $wifi[0] } elseif ($addrs.Count) { $addrs[0] } else { $null }
if (-not $pick) { Fail 'this machine has no home-network address (Wi-Fi or Ethernet): the deck has nothing to dial' }
$ip = $pick.IPAddress
$base = "http://${ip}:$BackendPort"
Write-Host "this machine: $ip on $($pick.InterfaceAlias); deck base should be $base"

# ------------------------------------------------------------ 2. backend
$code = (& curl.exe -s -o NUL -w '%{http_code}' --max-time 10 "$base/health" 2>$null) -join ''
if ($code -ne '200') {
  Fail "the backend does not answer on $base/health (HTTP $code): it is not listening on $ip yet. Add $ip to HOST and ALPHA_TRUSTED_HOSTS in Alpha's .env.local (scripts\fix-panel-host.mjs) and restart the backend; pointing the deck here now would leave it dark"
}
Write-Host "ok: backend answers on $base"

# ------------------------------------------------------------ 3. port
# A port given by hand wins, and is the answer to the case the pick cannot
# settle: on 2026-10-07 the Espressif rule chose COM7 on Worker1, COM7 sent
# nothing at all for 30 s, and the owner then confirmed the board was on COM4.
# A person looking at the board beats any rule about VIDs, so -Port skips the
# pick entirely rather than arguing with it.
if ($Port) {
  if ($Port -notmatch '^COM\d+$') { Fail "-Port must look like COM4, not '$Port'" }
  $com = $Port
  Write-Host "deck port: $com (given)"
}
else {
$bridges = @(Get-CimInstance Win32_PnPEntity -EA SilentlyContinue |
             Where-Object { $_.Name -match '\((COM\d+)\)' -and $_.Name -match 'CH340|CH341|CH9102|CP210|USB-SERIAL|USB Serial|UART' })
if ($bridges.Count -eq 0) { Fail 'no USB serial bridge attached: is the deck plugged into this machine?' }
# Worker1 carries five boards: four CH340 clones and the CrowPanel, which is an
# ESP32-S3 on its own native USB (Espressif, VID 303A). Exactly one of those is
# the deck; any other count is not guessed at.
$native = @($bridges | Where-Object { [string]$_.DeviceID -match 'VID_303A' })
if ($bridges.Count -gt 1 -and $native.Count -eq 1) { $bridges = $native }
if ($bridges.Count -gt 1) { Fail ("more than one USB serial bridge attached ({0}): not guessing which is the deck" -f (($bridges | ForEach-Object { $_.Name }) -join '; ')) }
$com = [regex]::Match($bridges[0].Name, '\((COM\d+)\)').Groups[1].Value
Write-Host "deck port: $com ($($bridges[0].Name))"
}

# ------------------------------------------------------------ 4-5. serial
$sp = New-Object System.IO.Ports.SerialPort $com, $Baud, 'None', 8, 'One'
$sp.NewLine = "`n"; $sp.ReadTimeout = 500; $sp.WriteTimeout = 2000
try { $sp.Open() } catch { Fail "could not open ${com}: $($_.Exception.Message) (held by a serial monitor, Arduino IDE or Alpha's own provisioning?)" }

function Ask-Status([int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  $nextSend = Get-Date
  while ((Get-Date) -lt $deadline) {
    if ((Get-Date) -ge $nextSend) { try { $sp.WriteLine('STATUS') } catch {}; $nextSend = (Get-Date).AddSeconds(2) }
    $chunk = ''
    try { $chunk = $sp.ReadExisting() } catch {}
    if (-not $chunk) { Start-Sleep -Milliseconds 200; continue }
    $r = Hear $chunk
    if ($r) { return $r }
  }
  return $null
}

try {
  # Opening the port resets the board on adapters that tie DTR to EN; its
  # setup() spends up to 15 s joining Wi-Fi before the loop reads serial.
  $before = Ask-Status 30
  if (-not $before) { Fail "the deck on $com did not answer STATUS within 30 s: wrong board, wrong firmware, or not booting. $(Describe-Silence)" }
  Write-Host "before: $($before.line)"
  if ($before.parsed.wifi_ssid -eq '(none)') {
    Fail "the deck has no Wi-Fi stored: provision it once in Alpha (Hardware Hub > CrowPanel Alpha Deck > Connect this panel to Wi-Fi); a passphrase is never sent from a task"
  }
  if ($before.parsed.alpha_base -eq $base) {
    Write-Host "ok: the deck already points at $base"
    exit 0
  }
  $sp.WriteLine("ALPHA $base")
  Start-Sleep -Milliseconds 800
  $after = Ask-Status 15
  if (-not $after) { Fail "the deck stopped answering after ALPHA $base" }
  Write-Host "after:  $($after.line)"
  if ($after.parsed.alpha_base -ne $base) { Fail "the deck reports alpha_base=$($after.parsed.alpha_base), not $base" }
  Write-Host "ok: the deck now points at $base (it reads the LAN feed every few seconds; alive=true follows once it has)"
  exit 0
} finally {
  if ($sp.IsOpen) { $sp.Close() }
}

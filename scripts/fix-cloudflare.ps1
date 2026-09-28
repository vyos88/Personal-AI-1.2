<#
  fix-cloudflare.ps1 - diagnose and repair the Cloudflare tunnel that publishes
  Alpha (alpha-ai.uk) from this machine.

  Run as Administrator, from PowerShell (not cmd):
      powershell -ExecutionPolicy Bypass -File .\fix-cloudflare.ps1

  Like fix-tunnel.ps1, every check ends in a plain-language verdict and the
  exact next command, and it writes fix-cloudflare-log.txt beside itself.

  What it repairs, and only when a check proves it is needed:
    - a config.yml hostname that a chat window turned into a markdown link
      ("[www.x](https://www.x)"), which matches no request ever sent;
    - an ingress rule that says https:// to an origin that only speaks http
      (every request 502s);
    - hostnames answering Cloudflare error 1033 / HTTP 530 ("no connector"):
      they are routed to a tunnel nothing runs, so they are pointed back at
      the tunnel config.yml names - the one this machine does run;
    - no Windows service: the tunnel then lives only as long as the console
      window someone started it in, and a reboot or logoff takes the site down.

  What it never does: delete a tunnel, print a credential, or touch a DNS
  record for a hostname that is not in config.yml.
  config.yml is backed up before any edit.
#>

param(
  [string]$Config = (Join-Path $env:USERPROFILE '.cloudflared\config.yml'),
  [string]$ServiceName = 'cloudflared'
)

$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'fix-cloudflare-log.txt'
Start-Transcript -Path $log -Force | Out-Null

$problems = New-Object System.Collections.ArrayList
$fixed    = New-Object System.Collections.ArrayList
function Problem($t) { [void]$problems.Add($t); Write-Host "  PROBLEM: $t" -ForegroundColor Red }
# A fix always follows the Problem it answers, so it closes that one.
function Fixed($t)   {
  [void]$fixed.Add($t); Write-Host "  FIXED: $t" -ForegroundColor Green
  if ($problems.Count) { $problems.RemoveAt($problems.Count - 1) }
}
function OK($t)      { Write-Host "  ok: $t" -ForegroundColor Green }
function Note($t)    { Write-Host "  $t" }
function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }

# curl.exe ships with Windows 10+, and unlike Windows PowerShell 5's
# Invoke-WebRequest it can skip certificate checks for a self-signed origin.
function HttpCode($url, [switch]$Insecure) {
  $a = @('-s', '-o', 'NUL', '-w', '%{http_code}', '--max-time', '8')
  if ($Insecure) { $a += '-k' }
  $code = & curl.exe @a $url 2>$null
  if (-not $code) { return '000' }
  return "$code"
}

function BackupConfig {
  $bak = "$Config.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
  Copy-Item $Config $bak -Force
  Note "backup: $bak"
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host "NOT elevated - the service step will fail. Re-run as Administrator.`n" -ForegroundColor Red }

# ---------------------------------------------------------------- 1. binary
Section "1. cloudflared"
$cf = (Get-Command cloudflared -EA SilentlyContinue).Source
if (-not $cf) {
  Problem "cloudflared is not on PATH."
  Note "Install it:  winget install --id Cloudflare.cloudflared"
  Stop-Transcript | Out-Null; exit 1
}
OK "$cf"
$ver = (& $cf --version 2>&1 | Out-String).Trim()
Note $ver

# ---------------------------------------------------------------- 2. config
Section "2. config.yml"
if (-not (Test-Path $Config)) {
  Problem "No config at $Config. Everything below is skipped."
  Note "Pass the right one:  .\fix-cloudflare.ps1 -Config <path\to\config.yml>"
  Stop-Transcript | Out-Null; exit 1
}
OK $Config
$text = Get-Content $Config -Raw

# A hostname pasted through a chat window comes back as a markdown link.
$mdLink = '\[([A-Za-z0-9.*-]+)\]\(https?://[^)\s]+\)'
if ($text -match $mdLink) {
  Problem "config.yml has a hostname written as a markdown link ($($Matches[0]))."
  BackupConfig
  $text = [regex]::Replace($text, $mdLink, '$1')
  Set-Content -Path $Config -Value $text -NoNewline -Encoding ascii
  Fixed "hostnames in config.yml are plain names again"
}

$tunnelId = if ($text -match '(?m)^\s*tunnel:\s*"?([^"\s]+)"?') { $Matches[1] } else { $null }
$credFile = if ($text -match '(?m)^\s*credentials-file:\s*"?([^"\r\n]+?)"?\s*$') { $Matches[1] } else { $null }
$hostnames = @([regex]::Matches($text, '(?m)^\s*-\s*hostname:\s*"?([^"\s]+)"?') | ForEach-Object { $_.Groups[1].Value })
$services  = @([regex]::Matches($text, '(?m)^\s*-?\s*service:\s*"?(https?://[^"\s]+)"?') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)

if (-not $tunnelId) { Problem "config.yml names no tunnel (no 'tunnel:' line)." }
else { OK "tunnel: $tunnelId" }
if (-not $credFile -or -not (Test-Path $credFile)) {
  Problem "credentials file missing: $credFile"
  Note "Without it this machine cannot run the tunnel. Recreate it with:"
  Note "  cloudflared tunnel token --cred-file `"$credFile`" $tunnelId"
} else { OK "credentials: $credFile (present)" }
Note "hostnames: $($hostnames -join ', ')"
Note "Note: while config.yml says 'tunnel: $tunnelId', 'cloudflared tunnel run <other>'"
Note "and 'tunnel info <other>' act on THIS tunnel, not the one you named."

# ---------------------------------------------------------------- 3. origin
Section "3. Is Alpha answering locally?"
foreach ($svc in $services) {
  $u = [uri]$svc
  $plain  = "http://$($u.Authority)/"
  $secure = "https://$($u.Authority)/"
  $cHttps = HttpCode $secure -Insecure
  $cHttp  = HttpCode $plain
  Note "$secure -> $cHttps    $plain -> $cHttp"
  if ($u.Scheme -eq 'https' -and $cHttps -eq '000' -and $cHttp -ne '000') {
    Problem "config.yml sends https to $($u.Authority), but it only speaks http - every request 502s."
    BackupConfig
    $text = $text.Replace("https://$($u.Authority)", "http://$($u.Authority)")
    Set-Content -Path $Config -Value $text -NoNewline -Encoding ascii
    Fixed "ingress for $($u.Authority) now uses http://"
  } elseif ($u.Scheme -eq 'http' -and $cHttp -eq '000' -and $cHttps -ne '000') {
    Problem "config.yml sends http to $($u.Authority), but it only speaks https."
    BackupConfig
    $text = $text.Replace("http://$($u.Authority)", "https://$($u.Authority)")
    if ($text -notmatch 'noTLSVerify:\s*true') { Note "If its certificate is self-signed, add 'noTLSVerify: true' under originRequest." }
    Set-Content -Path $Config -Value $text -NoNewline -Encoding ascii
    Fixed "ingress for $($u.Authority) now uses https://"
  } elseif ($cHttps -eq '000' -and $cHttp -eq '000') {
    Problem "Nothing answers on $($u.Authority): Alpha is not running, so the site returns 502."
    $l = Get-NetTCPConnection -LocalPort $u.Port -State Listen -EA SilentlyContinue
    if ($l) { Note "Something is bound to port $($u.Port) (PID $($l[0].OwningProcess)) but does not answer HTTP." }
    else    { Note "Port $($u.Port) has no listener. Start Alpha's frontend, then re-run this script." }
  } else { OK "$($u.Authority) answers" }
}

# ---------------------------------------------------------------- 4. tunnels
Section "4. Tunnels on this account"
$list = $null
try { $list = & $cf tunnel list --output json 2>$null | Out-String | ConvertFrom-Json } catch { }
if (-not $list) {
  Note "Could not list tunnels (is cert.pem in $env:USERPROFILE\.cloudflared?). Skipping."
} else {
  foreach ($t in $list) {
    $n = @($t.connections).Count
    $mine = if ($t.id -eq $tunnelId) { '  <- config.yml' } else { '' }
    Note ("{0}  {1,-24} connections: {2}{3}" -f $t.id, $t.name, $n, $mine)
    if ($t.id -ne $tunnelId -and $n -eq 0) {
      Note "  '$($t.name)' has no connector and no config here. Any hostname routed to it answers 1033."
      Note "  Section 5 moves config.yml's hostnames off it. Delete it only once nothing uses it:"
      Note "    cloudflared tunnel delete $($t.name)"
    }
  }
}

# ---------------------------------------------------------------- 5. public hostnames
Section "5. Do the public hostnames reach this tunnel?"
foreach ($h in $hostnames) {
  if ($h -match '\*') { Note "$h is a wildcard - skipped"; continue }
  $body = & curl.exe -s --max-time 10 -w "`n%{http_code}" "https://$h/" 2>$null | Out-String
  $code = ($body.Trim() -split "`n")[-1].Trim()
  if ($code -eq '530' -or $body -match 'Error 1033|error code: 1033') {
    Problem "$h answers 1033 - it is routed to a tunnel with no connector."
    & $cf tunnel route dns --overwrite-dns $tunnelId $h 2>&1 | ForEach-Object { Note "$_" }
    if ($LASTEXITCODE -eq 0) { Fixed "$h now routes to $tunnelId (give DNS a minute)" }
    else { Note "Could not re-route it. In the Cloudflare dashboard, set $h to CNAME $tunnelId.cfargotunnel.com (proxied)." }
  } elseif ($code -eq '502' -or $code -eq '504') {
    Problem "$h reaches the tunnel, but the tunnel cannot reach Alpha ($code) - see section 3."
  } elseif ($code -eq '000') {
    Problem "$h did not answer at all (DNS or network). Try:  nslookup $h"
  } else { OK "$h -> $code" }
}

# ---------------------------------------------------------------- 6. service
Section "6. Does the tunnel survive a reboot?"
$svc = Get-Service $ServiceName -EA SilentlyContinue
if (-not $svc) {
  Problem "No '$ServiceName' service: the tunnel only runs while someone's console window is open."
  if ($admin) {
    $logFile = Join-Path (Split-Path $Config) 'cloudflared.log'
    # New-Service, not sc.exe create: Windows PowerShell 5 strips the embedded
    # quotes from a native command's arguments, and the paths may have spaces.
    $bin = "`"$cf`" tunnel --config `"$Config`" --logfile `"$logFile`" run"
    New-Service -Name $ServiceName -BinaryPathName $bin -DisplayName 'Cloudflare Tunnel (Alpha)' -StartupType Automatic | Out-Null
    sc.exe config $ServiceName start= delayed-auto | Out-Null
    sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
    Start-Service $ServiceName -EA SilentlyContinue
    Start-Sleep -Seconds 5
    if ((Get-Service $ServiceName -EA SilentlyContinue).Status -eq 'Running') {
      Fixed "service '$ServiceName' installed, starts at boot, restarts on crash"
      Note "You can now close any window where 'cloudflared tunnel run' is running by hand."
      Note "Log: $logFile"
    } else {
      Problem "Service installed but will not start. Its log says why:  Get-Content `"$logFile`" -Tail 40"
    }
  } else { Note "Re-run this script as Administrator to install it." }
} else {
  if ($svc.Status -ne 'Running') {
    Start-Service $ServiceName -EA SilentlyContinue; Start-Sleep -Seconds 5
    if ((Get-Service $ServiceName).Status -eq 'Running') { OK "service '$ServiceName' was stopped; started it" }
    else { Problem "service '$ServiceName' will not start. Check:  Get-WinEvent -LogName Application -MaxEvents 20" }
  } else { OK "service '$ServiceName' running" }
  if ($fixed | Where-Object { $_ -like '*config.yml*' -or $_ -like '*ingress*' }) {
    Restart-Service $ServiceName -EA SilentlyContinue
    Note "restarted '$ServiceName' so it picks up the edited config.yml"
  }
}

# A hand-started 'cloudflared tunnel run' beside the service is a second
# connector for the same tunnel. Cloudflare splits requests between them, so
# one still running a config edited above answers half of them wrongly.
$svcPid = (Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -EA SilentlyContinue).ProcessId
$strays = @(Get-Process cloudflared -EA SilentlyContinue | Where-Object { $_.Id -ne $svcPid })
if ($strays.Count -and $svcPid) {
  Note "$($strays.Count) cloudflared process(es) running outside the service (PID $($strays.Id -join ', '))."
  Note "Close the console window they run in, or:  Stop-Process -Id $($strays.Id -join ',')"
} elseif ($strays.Count -and $fixed.Count) {
  Note "cloudflared is running by hand (PID $($strays.Id -join ', ')); restart it so it reads the edited config.yml."
}

# ---------------------------------------------------------------- verdict
Section "VERDICT"
if ($fixed.Count) {
  Write-Host "Repaired:" -ForegroundColor Green
  foreach ($f in $fixed) { Write-Host "  - $f" }
}
$open = @($problems)
if ($open.Count -eq 0) {
  Write-Host "Nothing left open. Check https://$($hostnames[0])/ in a browser." -ForegroundColor Green
} else {
  Write-Host "$($open.Count) problem(s) still need you:" -ForegroundColor Yellow
  $i = 1; foreach ($p in $open) { Write-Host "  $i. $p"; $i++ }
  Write-Host "`nEach section above prints the command that fixes its own problem."
}
Write-Host "`nLog: $log`n"
Stop-Transcript | Out-Null

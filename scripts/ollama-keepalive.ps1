<#
.SYNOPSIS
  Keeps Alpha's chat model loaded in Ollama, so the first chat after an idle
  spell does not wait for the model to load.

.DESCRIPTION
  Ollama unloads a model 5 minutes after its last use. Loading it again took
  75.6s on Laptop41 on 2026-10-06 (normally 5-7s), so the next chat sat there
  for 78s while the model itself answered at a normal speed. This:

    1. sets OLLAMA_KEEP_ALIVE for this user (and the machine, when elevated);
    2. restarts Ollama so it reads the new value (the tray app, a service, or
       `ollama serve`, whichever this machine runs);
    3. loads the chat model once, and reads back from /api/ps how long Ollama
       will now keep it.

  Exit 0 when the model is loaded and kept at least an hour; 1 otherwise.

  Run by the autopilot ({"do":"ollama-keepalive"}), or by hand:
    powershell -ExecutionPolicy Bypass -File scripts\ollama-keepalive.ps1
#>

param(
  # Ollama's own format: a duration (30m, 24h) or -1 for "never unload".
  [string]$KeepAlive = '24h',
  [string]$Model = $(if ($env:OLLAMA_MODEL) { $env:OLLAMA_MODEL } else { 'llama3.2:3b' }),
  [string]$OllamaUrl = $(if ($env:OLLAMA_BASE_URL) { $env:OLLAMA_BASE_URL } else { 'http://127.0.0.1:11434' }),
  # Set the variable and load the model, but leave Ollama running as it is.
  [switch]$NoRestart
)

$ErrorActionPreference = 'Continue'
$base = $OllamaUrl.TrimEnd('/')

if ($KeepAlive -notmatch '^(-1|[1-9][0-9]{0,4}[smh]?)$') { Write-Host "keep-alive must be -1 or a duration like 30m or 24h, not '$KeepAlive'"; exit 2 }
if ($Model -notmatch '^[a-z0-9][a-z0-9._-]{0,63}(:[a-z0-9._-]{1,63})?$') { Write-Host "model must look like name:tag, not '$Model'"; exit 2 }

# Ollama writes expires_at with nanoseconds, more digits than Windows
# PowerShell 5.1's older .NET may parse (trimmed to 7), and
# PowerShell 7 may hand it over already as a date.
function Minutes-Left($at) {
  $when = if ($at -is [datetime]) { [DateTimeOffset]$at } else { [DateTimeOffset]::Parse(([string]$at -replace '(\.\d{7})\d+', '$1'), [Globalization.CultureInfo]::InvariantCulture) }
  [math]::Round(($when - [DateTimeOffset]::UtcNow).TotalMinutes)
}
function Up { try { Invoke-RestMethod -Uri "$base/api/tags" -TimeoutSec 5 | Out-Null; $true } catch { $false } }

# 1. The setting. This process gets it too, so an Ollama started below inherits it.
$env:OLLAMA_KEEP_ALIVE = $KeepAlive
[Environment]::SetEnvironmentVariable('OLLAMA_KEEP_ALIVE', $KeepAlive, 'User')
$admin = $false
if ($IsWindows -or $env:OS -eq 'Windows_NT') {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
# A service reads the machine's variables, not the user's.
if ($admin) { [Environment]::SetEnvironmentVariable('OLLAMA_KEEP_ALIVE', $KeepAlive, 'Machine') }
Write-Host "set OLLAMA_KEEP_ALIVE=$KeepAlive for this user$(if ($admin) { ' and the machine' })"

# 2. Ollama reads it only at start.
if (-not $NoRestart) {
  $svc = Get-Service -Name 'Ollama' -EA SilentlyContinue
  if ($svc) {
    Restart-Service -Name 'Ollama' -Force -EA SilentlyContinue
    Write-Host 'restarted the Ollama service'
  } else {
    $procs = @(Get-Process -Name 'ollama app', 'ollama' -EA SilentlyContinue)
    $procs | Stop-Process -Force -EA SilentlyContinue
    Write-Host "stopped $($procs.Count) Ollama process(es)"
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline -and (Up)) { Start-Sleep -Seconds 1 }
    $app = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama app.exe' } else { $null }
    $cli = Get-Command ollama -EA SilentlyContinue
    if ($app -and (Test-Path -LiteralPath $app)) { Start-Process -FilePath $app; Write-Host 'started the Ollama app' }
    elseif ($cli) { Start-Process -FilePath $cli.Source -ArgumentList 'serve' -WindowStyle Hidden; Write-Host 'started ollama serve' }
    else { Write-Host 'PROBLEM: no Ollama app or ollama command found to start'; exit 1 }
  }
}
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline -and -not (Up)) { Start-Sleep -Seconds 2 }
if (-not (Up)) { Write-Host "PROBLEM: Ollama does not answer at $base"; exit 1 }

# 3. Load the model now, so the next chat finds it loaded, then ask how long it stays.
try {
  $t0 = Get-Date
  $gen = Invoke-RestMethod -Method Post -Uri "$base/api/generate" -ContentType 'application/json' -TimeoutSec 300 `
           -Body (@{ model = $Model; prompt = ''; stream = $false } | ConvertTo-Json)
  Write-Host ("loaded '{0}' in {1}s" -f $Model, [math]::Round(((Get-Date) - $t0).TotalSeconds, 1))
} catch { Write-Host "PROBLEM: could not load '$Model': $($_.Exception.Message)"; exit 1 }

$want = if ($Model -match ':') { $Model } else { "${Model}:latest" }
$entry = $null
try { $entry = @((Invoke-RestMethod -Uri "$base/api/ps" -TimeoutSec 10).models) | Where-Object { $_.name -eq $want -or $_.model -eq $want } | Select-Object -First 1 } catch { }
if (-not $entry) { Write-Host "PROBLEM: '$Model' is not loaded after the warm-up"; exit 1 }
$minutes = Minutes-Left $entry.expires_at
if ($minutes -lt 60) {
  Write-Host "PROBLEM: Ollama will unload '$Model' in $minutes min: it did not take OLLAMA_KEEP_ALIVE=$KeepAlive (restart Ollama by hand, or sign out and in)"
  exit 1
}
$kept = if ($minutes -gt 525600) { 'until Ollama stops' } elseif ($minutes -ge 120) { "for $([math]::Round($minutes / 60)) h after each use" } else { "for $minutes min after each use" }
Write-Host "ok: '$Model' is loaded and kept $kept"
exit 0

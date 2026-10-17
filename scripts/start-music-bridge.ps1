<#
.SYNOPSIS
  Runs the music bridge (scripts\music-bridge.mjs) and keeps it running; the
  scheduled task 'alpha-music bridge' (enable-music.ps1 -Bridge) starts this
  at logon.

.DESCRIPTION
  The bridge needs a tunnel key that can queue and read tasks. When
  ALPHA_MUSIC_BRIDGE_TOKEN is not set, it uses this machine's report key
  (ALPHA_REPORT_TOKEN, user scope: worker1-report / host-report, which have
  tasks:read, tasks:write and agents:read), read here at start, in this
  process only, so the key is never copied into another file.
  ALPHA_MUSIC_AGENT defaults to "auto": each track goes to the least busy
  machine offering alpha.music.
#>

$ErrorActionPreference = 'Continue'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$log = Join-Path $env:TEMP 'alpha-music-bridge.log'

function UserVar([string]$name) {
  $v = [Environment]::GetEnvironmentVariable($name, 'Process')
  if (-not $v) { $v = [Environment]::GetEnvironmentVariable($name, 'User') }
  return $v
}
if (-not (UserVar 'ALPHA_MUSIC_BRIDGE_TOKEN')) {
  $report = UserVar 'ALPHA_REPORT_TOKEN'
  if ($report) { $env:ALPHA_MUSIC_BRIDGE_TOKEN = $report }
  else { Add-Content -LiteralPath $log -Value "$(Get-Date -Format s) no ALPHA_MUSIC_BRIDGE_TOKEN or ALPHA_REPORT_TOKEN for this user: the bridge cannot queue music"; exit 1 }
}
if (-not (UserVar 'ALPHA_MUSIC_AGENT')) { $env:ALPHA_MUSIC_AGENT = 'auto' }

Set-Location $repo
$delay = 5
while ($true) {
  Add-Content -LiteralPath $log -Value "$(Get-Date -Format s) starting the music bridge (machines: $env:ALPHA_MUSIC_AGENT)"
  $t0 = Get-Date
  # One encoding for the whole log: Add-Content, never >> (UTF-16 on 5.1).
  & node (Join-Path $repo 'scripts\music-bridge.mjs') 2>&1 | ForEach-Object { "$_" } | Add-Content -LiteralPath $log
  # A bridge that ran a while and stopped restarts quickly; one that dies at
  # once backs off, up to a minute, instead of spinning.
  $delay = if (((Get-Date) - $t0).TotalSeconds -gt 60) { 5 } else { [math]::Min(60, $delay * 2) }
  Add-Content -LiteralPath $log -Value "$(Get-Date -Format s) the bridge exited ($LASTEXITCODE); restarting in ${delay}s"
  Start-Sleep -Seconds $delay
}

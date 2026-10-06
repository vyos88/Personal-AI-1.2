<#
.SYNOPSIS
  Runs the image bridge (scripts\image-bridge.mjs) and keeps it running; the
  scheduled task 'alpha-image bridge' (enable-image.ps1 -Bridge) starts this
  at logon.

.DESCRIPTION
  Same key rule as the music bridge: ALPHA_IMAGE_BRIDGE_TOKEN, or else this
  machine's report key (ALPHA_REPORT_TOKEN, user scope), read here, in this
  process only. ALPHA_IMAGE_AGENT defaults to "auto": each image goes to the
  least busy machine offering alpha.image.
#>

$ErrorActionPreference = 'Continue'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$log = Join-Path $env:TEMP 'alpha-image-bridge.log'

function UserVar([string]$name) {
  $v = [Environment]::GetEnvironmentVariable($name, 'Process')
  if (-not $v) { $v = [Environment]::GetEnvironmentVariable($name, 'User') }
  return $v
}
if (-not (UserVar 'ALPHA_IMAGE_BRIDGE_TOKEN')) {
  $report = UserVar 'ALPHA_REPORT_TOKEN'
  if ($report) { $env:ALPHA_IMAGE_BRIDGE_TOKEN = $report }
  else { Add-Content -LiteralPath $log -Value "$(Get-Date -Format s) no ALPHA_IMAGE_BRIDGE_TOKEN or ALPHA_REPORT_TOKEN for this user: the bridge cannot queue images"; exit 1 }
}
if (-not (UserVar 'ALPHA_IMAGE_AGENT')) { $env:ALPHA_IMAGE_AGENT = 'auto' }

Set-Location $repo
$delay = 5
while ($true) {
  Add-Content -LiteralPath $log -Value "$(Get-Date -Format s) starting the image bridge (machines: $env:ALPHA_IMAGE_AGENT)"
  $t0 = Get-Date
  # One encoding for the whole log: Add-Content, never >> (UTF-16 on 5.1).
  & node (Join-Path $repo 'scripts\image-bridge.mjs') 2>&1 | ForEach-Object { "$_" } | Add-Content -LiteralPath $log
  $delay = if (((Get-Date) - $t0).TotalSeconds -gt 60) { 5 } else { [math]::Min(60, $delay * 2) }
  Add-Content -LiteralPath $log -Value "$(Get-Date -Format s) the bridge exited ($LASTEXITCODE); restarting in ${delay}s"
  Start-Sleep -Seconds $delay
}

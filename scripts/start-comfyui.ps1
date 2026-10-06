<#
.SYNOPSIS
  Runs ComfyUI on 127.0.0.1:8188 and keeps it running, with its output in a
  log; the scheduled task 'ComfyUI' (enable-image.ps1 -InstallComfy) starts
  this at logon.

.DESCRIPTION
  The Host's first install (2026-10-06, job h03) started ComfyUI straight from
  the task, so when it did not answer nobody could see why. Everything it
  prints now goes to C:\AlphaData\comfyui.log (or -Log), which enable-image.ps1
  shows when ComfyUI does not come up.
#>

param(
  [string]$ComfyDir = 'C:\services\ComfyUI',
  [string]$Log = 'C:\AlphaData\comfyui.log',
  [switch]$Cpu
)

$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path (Split-Path $Log -Parent) | Out-Null
# One run's worth: an old log is renamed, not appended to forever.
if ((Test-Path -LiteralPath $Log) -and (Get-Item -LiteralPath $Log).Length -gt 5MB) { Move-Item -LiteralPath $Log -Destination "$Log.old" -Force }
$py = Join-Path $ComfyDir 'venv\Scripts\python.exe'
$extra = @('--listen', '127.0.0.1', '--port', '8188')
if ($Cpu) { $extra += '--cpu' }

Set-Location $ComfyDir
$delay = 5
while ($true) {
  Add-Content -LiteralPath $Log -Value "$(Get-Date -Format s) starting ComfyUI ($(if ($Cpu) { 'CPU' } else { 'GPU' }))"
  $t0 = Get-Date
  # One encoding for the whole log: Add-Content, never >> (UTF-16 on 5.1).
  & $py (Join-Path $ComfyDir 'main.py') @extra 2>&1 | ForEach-Object { "$_" } | Add-Content -LiteralPath $Log
  $delay = if (((Get-Date) - $t0).TotalSeconds -gt 60) { 5 } else { [math]::Min(120, $delay * 2) }
  Add-Content -LiteralPath $Log -Value "$(Get-Date -Format s) ComfyUI exited ($LASTEXITCODE); restarting in ${delay}s"
  Start-Sleep -Seconds $delay
}

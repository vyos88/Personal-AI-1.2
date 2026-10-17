<#
.SYNOPSIS
  Lets self-heal restart Alpha's chat: a scheduled task that runs Ollama as
  this user, and the "chat" block in self-heal's configuration that names it.

.DESCRIPTION
  On 2026-10-08 Ollama was down on Laptop41 for over three hours. Self-heal
  probed the backend, the site and the public address, all healthy, and
  never looked at chat. alpha-selfheal.mjs can now probe Ollama and restart it,
  but only through a scheduled task: self-heal runs as SYSTEM, and an Ollama
  started as SYSTEM looks for models in SYSTEM's profile and answers with none.

  This:
    1. registers the task 'Alpha Ollama': `ollama.exe serve`, hidden, as the
       user running this script, whether or not they are signed in (S4U: no
       password is stored), at startup;
    2. adds "chat" to selfheal.json (url, task, port), keeping every other
       key as it is and writing UTF-8 without a BOM (JSON.parse refuses one);
    3. starts the task if Ollama is not answering now, and waits up to a
       minute for it.

  If the Ollama tray app is also running, it holds the port and the task's
  own server exits; either way Ollama answers, which is all self-heal asks.

  -ConfigOnly does step 2 and nothing else (used by the tests).
  Run by the autopilot ({"do":"chat-task"}), or by hand, as the user whose
  Ollama it is.
#>
param(
  [string]$OpsDir = 'C:\AlphaData\alpha-ops',
  [string]$TaskName = 'Alpha Ollama',
  [int]$Port = 11434,
  [switch]$ConfigOnly
)

$ErrorActionPreference = 'Continue'
$url = "http://127.0.0.1:$Port/api/tags"
function Answers { try { (Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 5).StatusCode -eq 200 } catch { $false } }

# ---------------------------------------------------------------- 1. the task
if (-not $ConfigOnly) {
  $exe = @(
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe' }),
    (Get-Command ollama.exe -EA SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if (-not $exe) { Write-Output 'NOT DONE: ollama.exe is not installed for this user; nothing changed'; exit 1 }
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $action = New-ScheduledTaskAction -Execute $exe -Argument 'serve'
  $boot = New-ScheduledTaskTrigger -AtStartup; $boot.Delay = 'PT1M'
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -Hidden
  try {
    Register-ScheduledTask -TaskName $TaskName -Force -Action $action -Trigger $boot -Principal $principal -Settings $settings `
      -Description "Ollama for Alpha's chat, as $user (self-heal restarts chat through this task; chat-task.ps1)" -EA Stop | Out-Null
    Write-Output "task '$TaskName': $exe serve, as $user, at startup"
  } catch { Write-Output "NOT DONE: could not register '$TaskName': $($_.Exception.Message)"; exit 1 }
}

# ---------------------------------------------------------------- 2. self-heal's config
$config = Join-Path $OpsDir 'selfheal.json'
if (-not (Test-Path -LiteralPath $config)) { Write-Output "NOT DONE: no $config (repair-host writes it); the task is in place"; exit 1 }
try { $json = (Get-Content -LiteralPath $config -Raw) -replace '^\uFEFF', '' | ConvertFrom-Json } catch { Write-Output "NOT DONE: $config is not valid JSON; left as it is"; exit 1 }
$chat = [pscustomobject]@{ url = $url; task = $TaskName; port = $Port }
if ($json.PSObject.Properties.Name -contains 'chat') { $json.chat = $chat } else { $json | Add-Member -NotePropertyName chat -NotePropertyValue $chat }
# Beside, then moved into place: self-heal reads this file every 2 minutes.
[IO.File]::WriteAllText("$config.tmp", ($json | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding $false))
Move-Item -LiteralPath "$config.tmp" -Destination $config -Force
Write-Output "self-heal now probes $url and restarts chat through '$TaskName' ($config)"
if ($ConfigOnly) { exit 0 }

# ---------------------------------------------------------------- 3. chat now
if (Answers) { Write-Output 'Ollama answers now; nothing started'; exit 0 }
Start-ScheduledTask -TaskName $TaskName -EA SilentlyContinue
foreach ($i in 1..30) { Start-Sleep -Seconds 2; if (Answers) { Write-Output "Ollama answers on $Port (started through '$TaskName')"; exit 0 } }
Write-Output "PROBLEM: started '$TaskName' and Ollama still does not answer on $Port after a minute"
exit 1

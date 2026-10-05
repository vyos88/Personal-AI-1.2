<#
.SYNOPSIS
  Read-only: where Alpha's failed sign-ins came from. Run it on Worker1.

.DESCRIPTION
  Groups the last -Hours of Alpha's failed and rate-limited sign-ins by
  address, account and client (alpha_login_failures.py), says when the
  stewards' saved credential and backoff file last changed, and lists the
  steward processes that are running. From .env.local it reads only the two
  database path settings, and it never prints the file.

  127.0.0.1 with a WindowsPowerShell client is the stewards signing in with a
  stale saved password: see HANDOFF_2026-10-05f_worker1-deploy.md.

.PARAMETER AlphaRoot
  The folder holding .env.local and memory\ (the parent of software\).
  A path ending in \software is taken as its parent.
#>
param(
    [string]$AlphaRoot = 'C:\Users\Vyo\Downloads\VyoS-advance-tech-ai',
    [string]$Python = '',
    [int]$Hours = 24
)

if ((Split-Path -Leaf $AlphaRoot) -eq 'software' -and -not (Test-Path -LiteralPath (Join-Path $AlphaRoot '.env.local'))) {
    $AlphaRoot = Split-Path -Parent $AlphaRoot
}
if (-not $Python) {
    foreach ($name in 'python', 'py', 'python3') {
        if (Get-Command $name -ErrorAction SilentlyContinue) { $Python = $name; break }
    }
}
if (-not $Python) {
    'No Python found on PATH. Pass -Python <path to python.exe>.'
    exit 1
}

function Get-DbPath([string]$Key, [string[]]$Candidates) {
    $envFile = Join-Path $AlphaRoot '.env.local'
    $line = Select-String -LiteralPath $envFile -Pattern "^\s*$Key\s*=" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($line) {
        $value = ($line.Line -split '=', 2)[1].Trim().Trim('"').Trim("'")
        if (-not [IO.Path]::IsPathRooted($value)) { $value = Join-Path $AlphaRoot $value }
        return $value
    }
    $Candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

$authDb = Get-DbPath 'AUTH_USERS_DB_PATH' @((Join-Path $AlphaRoot 'memory\auth_users.db'), 'C:\app\memory\auth_users.db')
$auditDb = Get-DbPath 'AUDIT_DB_PATH' @((Join-Path $AlphaRoot 'memory\audit_store.db'), 'C:\app\memory\audit_store.db')
"Alpha root: $AlphaRoot"
"auth db:    $authDb"
"audit db:   $auditDb"
& $Python (Join-Path $PSScriptRoot 'alpha_login_failures.py') "$authDb" "$auditDb" $Hours

'Steward sign-in files:'
foreach ($file in 'memory\local\alpha-local-service.credential.xml', 'memory\local\steward-auth-backoff.json') {
    $path = Join-Path $AlphaRoot $file
    if (Test-Path -LiteralPath $path) {
        "  $file  last changed $((Get-Item -LiteralPath $path).LastWriteTime)"
    } else {
        "  $file  (none)"
    }
}

'Steward processes running:'
try {
    $stewards = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction Stop |
        Where-Object { $_.CommandLine -match 'alpha_\w*(steward|agent_manager|improvement_agent)|watch_alpha_' })
    if ($stewards.Count) {
        $stewards | ForEach-Object { '  {0,6}  {1}' -f $_.ProcessId, ($_.CommandLine -replace '^.*\\scripts\\', 'scripts\') }
    } else {
        '  none'
    }
} catch {
    "  (could not list processes: $($_.Exception.Message))"
}

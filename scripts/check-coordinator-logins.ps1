<#
.SYNOPSIS
  Read-only: summarize the coordinator's failed logins. Run it on Host.

.DESCRIPTION
  The coordinator logs every failed POST /auth/login as
  "login failed reason=<why> email=<address tried> ... remoteAddress=<socket>".
  It never logs a password, and it does not log rejected API keys at all, so
  every line counted here is a password login: alpha-admin login, or something
  else reaching port 8787. This groups them by reason, address tried and
  source, and prints the first and last.

  Reasons: wrong_password, no_such_user, user_disabled, malformed_email, and
  locked_out (8 failures lock an address for 15 minutes).

.PARAMETER Log
  The coordinator's log. By default, alpha-tunnel-coordinator.log in this
  user's LOCALAPPDATA (run-coordinator.cmd writes it there), else the most
  recently written copy under any user's profile or SYSTEM's.
#>
param([string]$Log = '')

if (-not $Log -and $env:LOCALAPPDATA) {
    $Log = Join-Path $env:LOCALAPPDATA 'alpha-tunnel-coordinator.log'
}
if (-not $Log -or -not (Test-Path -LiteralPath $Log)) {
    $Log = Get-ChildItem 'C:\Users\*\AppData\Local\alpha-tunnel-coordinator.log', 'C:\Windows\System32\config\systemprofile\AppData\Local\alpha-tunnel-coordinator.log' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime | Select-Object -Last 1 -ExpandProperty FullName
}
if (-not $Log) {
    'No coordinator log found. Pass -Log <path> if the coordinator writes somewhere else.'
    exit 1
}

$failed = @(Select-String -LiteralPath $Log -Pattern 'login failed' | ForEach-Object Line)
"$($failed.Count) failed logins in $Log (last written $((Get-Item -LiteralPath $Log).LastWriteTime))"
$failed | ForEach-Object {
    $reason = if ($_ -match 'reason=(\S+)') { $Matches[1] } else { '?' }
    $email = if ($_ -match 'email=("[^"]*"|\S+)') { $Matches[1] } else { '?' }
    $from = if ($_ -match 'remoteAddress=(\S+)') { $Matches[1] } else { '?' }
    "$reason  $email  from $from"
} | Group-Object | Sort-Object Count -Descending | Select-Object -First 15 |
    ForEach-Object { '{0,6}  {1}' -f $_.Count, $_.Name }
if ($failed.Count) {
    'first: ' + $failed[0]
    'last:  ' + $failed[-1]
}

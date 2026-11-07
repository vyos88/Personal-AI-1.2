# Cancels stale alpha.coordination tasks left queued on the tunnel host while no
# coordination agent was attached. Dry run by default; -Apply cancels.
# Needs a token with tasks:read (dry run) and tasks:cancel (-Apply, operator/admin).
#
#   powershell -ExecutionPolicy Bypass -File scripts\drain-stale-coord.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\drain-stale-coord.ps1 -Apply
param(
  [string]$HostUrl = $(if ($env:ALPHA_HOST_URL) { $env:ALPHA_HOST_URL } else { 'http://127.0.0.1:8787' }),
  [string]$Token = $env:ALPHA_ADMIN_TOKEN,
  [datetime]$Before = '2026-11-06T00:00:00Z',
  [string[]]$ExtraIds = @(),
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
if (-not $Token) { throw 'Set ALPHA_ADMIN_TOKEN (operator or admin scope) first.' }
$headers = @{ Authorization = "Bearer $Token" }
$HostUrl = $HostUrl.TrimEnd('/')

$all = (Invoke-RestMethod -Uri "$HostUrl/tasks?limit=500" -Headers $headers -TimeoutSec 20).tasks
$stats = Invoke-RestMethod -Uri "$HostUrl/stats" -Headers $headers -TimeoutSec 20
$cutoff = [DateTimeOffset]$Before.ToUniversalTime()

# Only the exact obsolete reports: worker1's 3-minute Posts from before the cutoff,
# plus explicitly named ids. Anything else stays queued.
$stale = @($all | Where-Object {
  $_.status -eq 'queued' -and (
    ($ExtraIds -contains $_.id) -or (
      $_.type -eq 'alpha.coordination' -and
      $_.payload.action -ceq 'Post' -and
      $_.payload.actor -ceq 'worker1' -and
      ([string]$_.payload.message).StartsWith('worker1 3-min report:', [StringComparison]::Ordinal) -and
      [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$_.createdAt) -lt $cutoff))
})
$kept = @($all | Where-Object { ($_.status -eq 'queued' -or $_.status -eq 'leased') -and $stale.id -notcontains $_.id })

"Listed $($all.Count) tasks; host reports $($stats.queue.pending) pending."
"Stale to cancel: $($stale.Count). Pending kept: $($kept.Count)."
$kept | ForEach-Object { "  keep  $($_.id)  $($_.type)  $($_.payload.action)  $($_.payload.actor)" }

if (-not $Apply) { 'Dry run only; re-run with -Apply to cancel.'; return }

$cancelled = 0
foreach ($t in $stale) {
  $r = Invoke-RestMethod -Method Post -Uri "$HostUrl/tasks/$($t.id)/cancel" -Headers $headers -TimeoutSec 20
  if ($r.status -eq 'cancelled') { $cancelled++ } else { "  $($t.id) -> $($r.status)" }
}
$after = Invoke-RestMethod -Uri "$HostUrl/stats" -Headers $headers -TimeoutSec 20
"Cancelled $cancelled of $($stale.Count). Host now reports $($after.queue.pending) pending."

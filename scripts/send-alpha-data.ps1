<#
.SYNOPSIS
  Phase 2 of the Alpha move (docs/HANDOFF_2026-10-07d_alpha-moves-to-host.md),
  Laptop41's half: pack Alpha's memory\, write a SHA-256 manifest, and send
  both to the Host over Taildrop, where receive-alpha-data.ps1 checks every
  file before using any of it.

  It sends no configuration. .env.local holds Alpha's secrets and goes to the
  Host the way the handoff says secrets go: by V, by USB.

.DESCRIPTION
  It reads Alpha's files and never changes them, so it is safe while Alpha is
  serving: the first copy is taken live, and the final one at the switch-over,
  after Alpha is stopped, is the same command.

  Left out of the archive, because they are not Alpha's state (2026-10-07 sizes):
    memory\local\pytest-*        test leftovers, about 5.5 GB
    memory\local\test-temp       test leftovers
    memory\local\uno-q-recovery  a 2.1 GB board recovery image
    memory\local\android-sdk     a build tool, 0.8 GB
    memory\local\books           a junction to E:\Alpha\Library\books
    __pycache__                  rebuilt on first run

  The staging folder must be on a drive with room (Laptop41's C: has under
  15 GB free; E: has hundreds). No .env file is read, copied or sent.

  -NoSend packs and writes the manifest without sending (used by the tests).
#>
param(
  [string]$Root = 'C:\Users\Vyo\Downloads\VyoS-advance-tech-ai',
  [string]$Outbox = 'E:\AlphaMove\outbox',
  [string]$To = 'laptop-gj8dfmlk',
  [switch]$NoSend
)

$ErrorActionPreference = 'Continue'
function Say([string]$t) { Write-Output ('{0} {1}' -f (Get-Date).ToString('HH:mm:ss'), $t) }
$tar = if (Get-Command tar.exe -EA SilentlyContinue) { 'tar.exe' } else { 'tar' }

if (-not (Test-Path (Join-Path $Root 'memory'))) { Say "REFUSED: no memory\ under $Root"; exit 1 }
New-Item -ItemType Directory -Force -Path $Outbox | Out-Null
Get-ChildItem $Outbox -File -Force | Remove-Item -Force

$tarName = 'memory-{0}.tar' -f (Get-Date -Format 'yyyyMMdd-HHmmss')
Say "packing memory\ from $Root"
$out = & $tar -cf (Join-Path $Outbox $tarName) -C $Root `
  --exclude 'memory/local/pytest-*' --exclude 'memory/local/test-temp' `
  --exclude 'memory/local/uno-q-recovery' --exclude 'memory/local/android-sdk' `
  --exclude 'memory/local/books' --exclude '__pycache__' memory 2>&1
$warn = @($out | Where-Object { "$_".Trim() })
if ($warn.Count) { Say ("tar said {0} line(s), first: {1}" -f $warn.Count, $warn[0]) }
if (-not (Test-Path (Join-Path $Outbox $tarName))) { Say 'FAILED: no archive was written'; exit 1 }
Say ('archive {0:N1} MB' -f ((Get-Item (Join-Path $Outbox $tarName)).Length / 1MB))

$files = @(@{ name = $tarName; kind = 'memory' })
$entries = @(foreach ($f in $files) {
  $p = Join-Path $Outbox $f.name
  [ordered]@{ name = $f.name; kind = $f.kind; bytes = (Get-Item -Force $p).Length; sha256 = (Get-FileHash -Algorithm SHA256 $p).Hash.ToLower() }
})
$machine = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { [Environment]::MachineName }
[ordered]@{ from = $machine; at = (Get-Date).ToUniversalTime().ToString('o'); files = $entries } |
  ConvertTo-Json -Depth 4 | Set-Content -Encoding ASCII (Join-Path $Outbox 'alpha-move-manifest.json')
Say ('manifest: ' + (($entries | ForEach-Object { '{0} ({1:N1} MB)' -f $_.name, ($_.bytes / 1MB) }) -join ', '))

if ($NoSend) { Say 'packed, not sent (-NoSend)'; exit 0 }
foreach ($n in @($entries | ForEach-Object { $_.name }) + 'alpha-move-manifest.json') {
  $t0 = Get-Date
  $r = & tailscale file cp (Join-Path $Outbox $n) "$($To):" 2>&1
  if ($LASTEXITCODE -ne 0) { Say "FAILED sending ${n}: $(@($r) -join ' ')"; exit 1 }
  Say ('sent {0} in {1:N0} s' -f $n, ((Get-Date) - $t0).TotalSeconds)
}
Say "DONE: sent to $To. .env.local is not part of this: V copies it by USB"
exit 0

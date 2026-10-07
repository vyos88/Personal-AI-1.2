<#
.SYNOPSIS
  Lists every song in Alpha's playlist on this machine, one line each, with
  whether it can play and whether its MP3 has been made.

.DESCRIPTION
  The owner (2026-10-07): "there is a total of 85 songs check please all and
  make them all mp3". The playlist (MusicPlaylist.jsx) lists Alpha's singing
  jobs: one receipt per song in <root>\memory\local\music-singing\*.json, the
  WAV master and its MP3 in <root>\artifacts\generated\singing\. Since Alpha
  cedec9d the backend makes every missing MP3 by itself (backfill_mp3s, 20 a
  pass) and writes its summary to mp3-backfill.json beside them; this reads
  all of that without a login and without changing anything.

  Per song: status, title, length, WAV size, MP3 size or "none", and a
  verdict: plays (MP3), plays (WAV only: MP3 still to be made), or cannot
  play (not finished, or its WAV is missing). Then the totals, the backfill's
  last summary, and whether ffmpeg is on this machine.

  Titles are printed as the owner named the songs, cut to 48 characters; no
  lyrics, briefs or owner names. Exit 0 when every finished song has its MP3,
  1 otherwise. Takes -AlphaRoot from the autopilot and nothing from the
  action.
#>
param(
  [string]$AlphaRoot = 'C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software',
  [string]$JobsDir,
  [string]$AudioDir
)

$ErrorActionPreference = 'Continue'
# music_singing.py: ROOT is two folders above backend\, the one that holds
# software\ on Worker1, so try that first and AlphaRoot itself second.
if (-not $JobsDir -or -not $AudioDir) {
  $parent = Split-Path $AlphaRoot -Parent
  foreach ($root in @($parent, $AlphaRoot)) {
    if (-not $root) { continue }
    $j = Join-Path $root 'memory\local\music-singing'
    if (Test-Path -LiteralPath $j -PathType Container) {
      if (-not $JobsDir) { $JobsDir = $j }
      if (-not $AudioDir) { $AudioDir = Join-Path $root 'artifacts\generated\singing' }
      break
    }
  }
}
if (-not $JobsDir -or -not (Test-Path -LiteralPath $JobsDir -PathType Container)) {
  Write-Host "PROBLEM: no song receipts found (looked for memory\local\music-singing above $AlphaRoot)"
  exit 1
}
Write-Host "songs: $JobsDir"
Write-Host "audio: $AudioDir"

function MB($path) { if (Test-Path -LiteralPath $path -PathType Leaf) { '{0:N1} MB' -f ((Get-Item -LiteralPath $path).Length / 1MB) } else { 'none' } }
function Clean([string]$t, [int]$n) { $t = ($t -replace '[\r\n\t]+', ' ').Trim(); if ($t.Length -gt $n) { $t.Substring(0, $n - 1) + '~' } else { $t } }

$rows = @()
foreach ($f in @(Get-ChildItem -LiteralPath $JobsDir -Filter '*.json' -File -EA SilentlyContinue)) {
  $raw = $null
  try { $raw = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8; $job = $raw | ConvertFrom-Json } catch { $rows += [pscustomobject]@{ created = ''; line = "  ?          $($f.Name): unreadable receipt"; verdict = 'unreadable' }; continue }
  $id = "$($job.id)"
  if (-not $id) { continue }
  $wav = Join-Path $AudioDir "$id.wav"
  $mp3 = Join-Path $AudioDir "$id.mp3"
  $hasWav = Test-Path -LiteralPath $wav -PathType Leaf
  $hasMp3 = (Test-Path -LiteralPath $mp3 -PathType Leaf) -and (Get-Item -LiteralPath $mp3).Length -gt 0
  $status = "$($job.status)"
  # As written: PowerShell 7 turns ISO dates into DateTime, which sorts and
  # prints differently from 5.1.
  $created = if ($raw -match '"created_at"\s*:\s*"([^"]*)"') { $Matches[1] } else { '' }
  $verdict = if ($status -ne 'completed') { "cannot play: $status" }
    elseif (-not $hasWav) { 'cannot play: WAV missing' }
    elseif ($hasMp3) { 'plays (MP3)' }
    else { 'plays (WAV only: MP3 still to be made)' }
  $secs = if ($job.audio -and $job.audio.duration_sec) { '{0,4:N0}s' -f [double]$job.audio.duration_sec } else { '    -' }
  $hidden = if ($job.hidden) { ' [hidden]' } else { '' }
  $title = Clean "$($job.title)" 48
  $rows += [pscustomobject]@{
    created = $created
    verdict = $verdict
    line = ('{0,-10} {1} {2,-48} wav {3,-9} mp3 {4,-9} {5}{6}' -f $created.Substring(0, [Math]::Min(10, $created.Length)), $secs, $title, (MB $wav), (MB $mp3), $verdict, $hidden)
  }
}
$rows = @($rows | Sort-Object created)
$i = 0
foreach ($r in $rows) { $i++; Write-Host ('{0,3}. {1}' -f $i, $r.line) }

$finished = @($rows | Where-Object { $_.verdict -like 'plays*' }).Count
$withMp3 = @($rows | Where-Object { $_.verdict -eq 'plays (MP3)' }).Count
$noWav = @($rows | Where-Object { $_.verdict -eq 'cannot play: WAV missing' }).Count
$unfinished = @($rows | Where-Object { $_.verdict -like 'cannot play:*' -and $_.verdict -ne 'cannot play: WAV missing' }).Count
$unreadable = @($rows | Where-Object { $_.verdict -eq 'unreadable' }).Count
Write-Host ''
Write-Host "TOTAL: $($rows.Count) song(s): $finished can play, $withMp3 of them as MP3, $($finished - $withMp3) still WAV only; $noWav finished but WAV missing; $unfinished not finished or failed; $unreadable unreadable"

$ff = [Environment]::GetEnvironmentVariable('ALPHA_FFMPEG_PATH', 'User')
$ffFound = if ($ff -and (Test-Path -LiteralPath $ff)) { 'ALPHA_FFMPEG_PATH' } elseif (Get-Command ffmpeg -EA SilentlyContinue) { 'ffmpeg on PATH' } else { $null }
Write-Host $(if ($ffFound) { "ok: ffmpeg found ($ffFound) for this account" } else { 'PROBLEM: no ffmpeg for this account (ALPHA_FFMPEG_PATH or PATH): the MP3s cannot be made until it is installed' })
$summary = Join-Path $AudioDir 'mp3-backfill.json'
if (Test-Path -LiteralPath $summary) {
  try {
    $s = Get-Content -LiteralPath $summary -Raw | ConvertFrom-Json
    Write-Host "backend MP3 backfill, last pass $($s.at): ffmpeg $($s.ffmpeg), made $($s.converted), failed $($s.failed), waiting $($s.waiting), already $($s.already) of $($s.total)"
    foreach ($x in @($s.failures)) { if ($x) { Write-Host "  failed: $($x.id): $(Clean "$($x.reason)" 160)" } }
  } catch { Write-Host 'backend MP3 backfill: summary unreadable' }
} else { Write-Host 'backend MP3 backfill: no summary yet (the backend has not run Alpha cedec9d or later yet)' }

if ($finished -gt $withMp3) { exit 1 }
exit 0

<#
  publish-alpha-push.ps1 — audit Alpha, then make its first push, safely.

  Alpha's code not being in git is what blocks alpha.update, blocks updating
  the other laptops with anything but a file copy, and blocks changing any panel
  that is not AppShell.tsx. This is the step that removes all three.

      # 1. Audit only. Reads, changes nothing, pushes nothing.
      powershell -ExecutionPolicy Bypass -File .\publish-alpha-push.ps1

      # 2. Only once you have READ the audit and are satisfied:
      powershell -ExecutionPolicy Bypass -File .\publish-alpha-push.ps1 -Push

  Even with -Push it will not proceed unless:
    - the audit exits 0 (no credential-looking files, nothing over GitHub's
      hard size limit), and
    - you type the confirmation it asks for, having seen the file count.

  It pushes to a BRANCH, never to main, and never with --force. A first push of
  a directory that has never been in version control is the one git operation
  that cannot be undone by a later commit: a secret in history stays in history,
  and rotating the credential is the only real fix. Hence the two steps.
#>

param(
  [string]$AlphaRoot = 'C:\AlphaData\Alpha',
  [string]$Tunnel,
  [string]$Remote   = 'https://github.com/vyos88/Alpha',
  [string]$Branch   = 'alpha-from-host',
  [switch]$Push,
  # Proceed when every audit finding is a filename the .gitignore excludes and
  # none are inside source files. Deliberately separate from -Push so that
  # accepting findings is its own decision, typed on purpose.
  [switch]$AcceptIgnoredNames
)

$ErrorActionPreference = 'Stop'
function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function OK($t)      { Write-Host "  ok: $t" -ForegroundColor Green }
function Warn($t)    { Write-Host "  $t" -ForegroundColor Yellow }
function Die($t)     { Write-Host "`n  STOP: $t" -ForegroundColor Red; exit 1 }

if (-not $Tunnel) {
  $Tunnel = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\alpha-agent\Parameters" -EA SilentlyContinue).AppDirectory
}
if (-not $Tunnel -or -not (Test-Path (Join-Path $Tunnel 'scripts\publish-alpha.mjs'))) {
  Die "Cannot find the alpha-tunnel checkout. Pass -Tunnel <path to alpha-tunnel>."
}
if (-not (Test-Path $AlphaRoot)) { Die "$AlphaRoot does not exist. Pass -AlphaRoot <path>." }

Section "Auditing $AlphaRoot"
$auditPath = Join-Path (Split-Path $AlphaRoot -Parent) 'alpha-audit.txt'
& node (Join-Path $Tunnel 'scripts\publish-alpha.mjs') --dir $AlphaRoot 2>&1 |
  Tee-Object -FilePath $auditPath | Write-Host
$auditExit = $LASTEXITCODE
Write-Host "`n  audit written to $auditPath"

if ($auditExit -eq 1) { Die "The audit could not run. Nothing was changed." }

if ($auditExit -eq 2) {
  # Not all findings are equally dangerous, and the difference decides what to
  # do about them. Working it out by eye means reading two dozen lines and
  # knowing which excludes apply, so this does it instead.
  #
  #   named by FILENAME  (.env, *.pem)  -> the .gitignore keeps them out of the
  #                                        commit entirely
  #   named by LINE      ("at line 42") -> ordinary source code. No exclude
  #                                        touches it. A push publishes it, and
  #                                        rotating the credential first does
  #                                        not help if the new value is on that
  #                                        same line.
  $lines = Get-Content $auditPath
  $byName = New-Object System.Collections.ArrayList
  $byLine = New-Object System.Collections.ArrayList

  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -notmatch '^\s{6}\S') { continue }   # the indented "why" line
    $why  = $lines[$i].Trim()
    $file = if ($i -gt 0) { $lines[$i - 1].Trim() } else { '' }
    if (-not $file) { continue }
    if ($why -match 'at line \d+') { [void]$byLine.Add("$file  ($why)") }
    elseif ($why -match 'credentials file|key or certificate') { [void]$byName.Add("$file  ($why)") }
  }

  Section "What the findings actually are"

  if ($byLine.Count) {
    Write-Host "  $($byLine.Count) finding(s) INSIDE source files — a push would publish these:" -ForegroundColor Red
    foreach ($f in $byLine) { Write-Host "    $f" -ForegroundColor Red }
    Write-Host ""
    Write-Host "  These are normal source files. No .gitignore entry excludes them, so" -ForegroundColor Red
    Write-Host "  they go into the commit as they are. Rotating the credential does not" -ForegroundColor Red
    Write-Host "  make this safe: if the new value sits on that same line, the push" -ForegroundColor Red
    Write-Host "  publishes the new one." -ForegroundColor Red
    Write-Host ""
    Write-Host "  Do this for each: move the value out of the file and read it from the"
    Write-Host "  environment instead, so the file holds a name rather than a secret."
    Write-Host "  Then run this script again — it will tell you when they are gone."
  }

  if ($byName.Count) {
    Write-Host ""
    Write-Host "  $($byName.Count) finding(s) matched by FILENAME:" -ForegroundColor Yellow
    foreach ($f in $byName) { Write-Host "    $f" }
    Write-Host ""
    Write-Host "  The .gitignore this script writes excludes these before the first"
    Write-Host "  git add, so they do not enter the commit. They are the reason the"
    Write-Host "  audit exits 2, but they are not what a push would expose."
  }

  if ($byLine.Count -eq 0 -and $byName.Count -gt 0) {
    Write-Host ""
    Write-Host "  Every finding is a filename the .gitignore already covers, and none" -ForegroundColor Green
    Write-Host "  are inside source files. Re-run with -AcceptIgnoredNames -Push to" -ForegroundColor Green
    Write-Host "  proceed; it will still show the file list and still ask for PUBLISH." -ForegroundColor Green
    if ($Push -and $AcceptIgnoredNames) {
      Write-Host ""
      OK "proceeding: filename-only findings, accepted by -AcceptIgnoredNames"
    } else {
      Write-Host ""
      Write-Host "  Nothing was pushed and nothing was changed."
      exit 2
    }
  } else {
    Write-Host ""
    Write-Host "  Nothing was pushed and nothing was changed." -ForegroundColor Red
    Write-Host "  Full audit: $auditPath"
    exit 2
  }
} else {
  OK "audit found nothing alarming"
}

if (-not $Push) {
  Section "Audit only"
  Write-Host "  This run pushed nothing, by design."
  Write-Host "  Read $auditPath. Skim the file list too — exit 0 is not a guarantee."
  Write-Host "  When satisfied, re-run with  -Push`n"
  exit 0
}

# ---------------------------------------------------------------- push path
Section "Preparing the first push"

# The .gitignore must exist BEFORE the first `git add`, or the excludes never
# apply to it. Taken from the audit's own suggestion rather than duplicated
# here, so the two cannot drift apart.
$lines   = Get-Content $auditPath
$start   = ($lines | Select-String -SimpleMatch '--- suggested .gitignore' | Select-Object -First 1).LineNumber
if (-not $start) { Die "Could not find the suggested .gitignore in the audit output." }
$rest    = $lines[$start..($lines.Count - 1)]
$endRel  = ($rest | Select-String -Pattern '^-{20,}$' | Select-Object -First 1).LineNumber
if (-not $endRel) { Die "Could not find the end of the suggested .gitignore block." }
$ignore  = $rest[0..($endRel - 2)]

$gitignorePath = Join-Path $AlphaRoot '.gitignore'
if (Test-Path $gitignorePath) {
  Warn ".gitignore already exists; leaving it alone."
} else {
  $ignore | Set-Content $gitignorePath -Encoding UTF8
  OK "wrote .gitignore ($($ignore.Count) lines) BEFORE any git add"
}

Push-Location $AlphaRoot
try {
  if (-not (Test-Path (Join-Path $AlphaRoot '.git'))) {
    git init -q
    OK "git init"
  } else {
    OK "already a git working copy"
  }

  git checkout -q -B $Branch
  git add -A

  $staged = @(git diff --cached --name-only)
  $bytes  = ($staged | ForEach-Object { (Get-Item $_ -EA SilentlyContinue).Length } | Measure-Object -Sum).Sum

  Section "What would be published"
  Write-Host ("  {0} files, {1} MB" -f $staged.Count, [math]::Round($bytes/1MB,1))
  Write-Host "  first 30:"
  $staged | Select-Object -First 30 | ForEach-Object { Write-Host "    $_" }
  if ($staged.Count -gt 30) { Write-Host "    ...and $($staged.Count - 30) more" }

  # Last chance, and it is deliberately a typed word rather than a keypress.
  Write-Host ""
  Write-Host "  This publishes the above to $Remote on branch '$Branch'." -ForegroundColor Yellow
  Write-Host "  It cannot be undone by a later commit." -ForegroundColor Yellow
  $answer = Read-Host "  Type PUBLISH to continue, anything else to abort"
  if ($answer -ne 'PUBLISH') {
    git reset -q
    Die "Aborted. Nothing was committed or pushed; the staging area has been reset."
  }

  git -c user.name="Alpha Host" -c user.email="alpha@localhost" commit -q -m "Alpha: the application itself

First commit of the working copy that has been running on the Alpha host.
Audited with scripts/publish-alpha.mjs before pushing; the .gitignore was
written from that audit's own suggestion before the first git add, so the
excludes applied to this commit rather than to a later one."
  OK "committed"

  if (-not (git remote | Select-String -SimpleMatch 'origin')) {
    git remote add origin $Remote
    OK "added remote origin -> $Remote"
  }

  git push -u origin $Branch
  if ($LASTEXITCODE -ne 0) { Die "Push failed. The commit exists locally; nothing was lost." }
  OK "pushed to $Branch"

  Section "DONE"
  Write-Host "  Open a pull request from '$Branch' and review the diff before merging to main."
  Write-Host "  main already carries an unrelated commit, so do NOT force-push over it."
  Write-Host "  Once merged, alpha.update Pull works over the tunnel and sync-alpha.ps1"
  Write-Host "  stops being necessary.`n"
}
finally { Pop-Location }

<#
  sync-alpha.ps1 — copy Alpha from the host to another laptop, over the tailnet.

  This exists because Alpha's code is not in version control. `alpha.update`
  over the tunnel can only fast-forward a git working copy, and there is no
  remote holding Alpha, so the host's copy is the only real one. Until that
  changes, updating another machine means copying.

  ON THE HOST:      powershell -ExecutionPolicy Bypass -File .\sync-alpha.ps1 -Mode Send -To <tailscale-machine-name>
  ON THE LAPTOP:    powershell -ExecutionPolicy Bypass -File .\sync-alpha.ps1 -Mode Receive

  Run -Mode Send first, wait for it to finish, then -Mode Receive on the laptop.

  What it will NOT copy, deliberately:
    .env and .env.*    the laptop keeps its own config; the host's would point
                       it at the host's hardware and duplicate its credentials
    *.pem *.key        certificates and private keys
    node_modules       reinstalled on the far side; copying it is slow and
                       often wrong across machines
    dist build .next   rebuilt on the far side
    logs               machine-specific noise
#>

param(
  [Parameter(Mandatory=$true)][ValidateSet('Send','Receive')][string]$Mode,
  [string]$To,
  [string]$AlphaRoot = 'C:\AlphaData\Alpha',
  [string]$Landing   = 'C:\AlphaData'
)

$ErrorActionPreference = 'Stop'
function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function OK($t)      { Write-Host "  ok: $t" -ForegroundColor Green }
function Warn($t)    { Write-Host "  $t" -ForegroundColor Yellow }
function Die($t)     { Write-Host "  STOP: $t" -ForegroundColor Red; exit 1 }

$zip = Join-Path $Landing 'alpha-code.zip'

# ------------------------------------------------------------------ SEND
if ($Mode -eq 'Send') {
  Section "Staging Alpha from $AlphaRoot"
  if (-not (Test-Path $AlphaRoot)) { Die "$AlphaRoot does not exist. Correct it with -AlphaRoot <path>." }
  if (-not $To) {
    Warn "No -To given. Machines on this tailnet:"
    tailscale status
    Die "Re-run with -To <machine-name> from that list."
  }

  $stage = Join-Path $Landing '_alpha-stage'
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }

  # /XD excludes directories, /XF excludes files. Both are why this is robocopy
  # and not Copy-Item.
  robocopy $AlphaRoot $stage /E /NFL /NDL /NJH /NJS `
    /XD node_modules .git dist build .next .nuxt .venv __pycache__ logs Logs coverage `
    /XF *.log .env .env.* *.pem *.key *.pfx *.p12 auth.json | Out-Null
  if ($LASTEXITCODE -ge 8) { Die "robocopy failed with exit $LASTEXITCODE" }

  $files = (Get-ChildItem $stage -Recurse -File).Count
  $bytes = (Get-ChildItem $stage -Recurse -File | Measure-Object Length -Sum).Sum
  OK "staged $files files, $([math]::Round($bytes/1MB,1)) MB"

  # Last line of defence: never ship a credential, even if the excludes missed it.
  Section "Secret check"
  $suspect = Get-ChildItem $stage -Recurse -File |
    Where-Object { $_.Name -match '^\.env|\.pem$|\.key$|^auth.*\.json$|credential' }
  if ($suspect) {
    $suspect | ForEach-Object { Write-Host "  $($_.FullName)" -ForegroundColor Red }
    Die "Credential-looking files reached the staging area. Nothing was sent. Remove them and re-run."
  }
  OK "no credential-looking files staged"

  Section "Packing and sending"
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive "$stage\*" $zip
  Remove-Item $stage -Recurse -Force
  OK "$zip  ($([math]::Round((Get-Item $zip).Length/1MB,1)) MB)"

  tailscale file cp $zip "$($To):"
  if ($LASTEXITCODE -ne 0) { Die "tailscale file cp failed. Check the machine name against 'tailscale status'." }
  OK "sent to $To"
  Write-Host "`nNow on $To, run:  .\sync-alpha.ps1 -Mode Receive`n"
  exit 0
}

# ---------------------------------------------------------------- RECEIVE
Section "Receiving"
tailscale file get $Landing
if (-not (Test-Path $zip)) { Die "No alpha-code.zip in $Landing. Did -Mode Send finish on the host?" }
OK "got $zip"

Section "Stopping Alpha here"
$alphaSvcs = @(Get-Service | Where-Object { $_.Name -like '*alpha*' -and $_.Name -notlike 'alpha-agent' -and $_.Name -notlike 'alpha-host' })
if ($alphaSvcs) {
  foreach ($s in $alphaSvcs) { Write-Host "  stopping $($s.Name)"; Stop-Service $s.Name -Force -EA SilentlyContinue }
} else {
  Warn "No Alpha service found here (the tunnel's alpha-agent/alpha-host are left alone)."
  Warn "If Alpha runs from a terminal or Task Scheduler, stop it now before continuing."
  Read-Host "Press Enter once Alpha is stopped"
}

Section "Backing up what is here"
if (Test-Path $AlphaRoot) {
  $backup = Join-Path $Landing "Backups\Alpha-$(Get-Date -f yyyyMMdd-HHmmss)"
  New-Item -ItemType Directory -Force -Path (Split-Path $backup) | Out-Null
  Copy-Item $AlphaRoot $backup -Recurse
  OK "backed up to $backup"
} else {
  Warn "$AlphaRoot does not exist — this is a first install, not an update."
  New-Item -ItemType Directory -Force -Path $AlphaRoot | Out-Null
}

Section "Unpacking"
# -Force overwrites tracked code. .env was never in the archive, so this
# machine's own configuration survives untouched.
Expand-Archive $zip -DestinationPath $AlphaRoot -Force
OK "unpacked into $AlphaRoot"

Section "Rebuilding"
$pkgDirs = @()
if (Test-Path (Join-Path $AlphaRoot 'package.json'))          { $pkgDirs += $AlphaRoot }
if (Test-Path (Join-Path $AlphaRoot 'frontend\package.json')) { $pkgDirs += (Join-Path $AlphaRoot 'frontend') }
if (-not $pkgDirs) {
  Warn "No package.json found — nothing to build. If Alpha builds another way, do that step by hand."
} else {
  foreach ($d in $pkgDirs) {
    Write-Host "  npm install in $d"
    Push-Location $d
    npm install
    if ($LASTEXITCODE -ne 0) { Pop-Location; Die "npm install failed in $d. Alpha is NOT running; the backup above is intact." }
    $hasBuild = (Get-Content package.json -Raw) -match '"build"\s*:'
    if ($hasBuild) {
      Write-Host "  npm run build in $d"
      npm run build
      if ($LASTEXITCODE -ne 0) { Pop-Location; Die "build failed in $d. Restore from the backup above if you need Alpha back now." }
    }
    Pop-Location
  }
  OK "rebuilt"
}

Section "Check your .env"
$envFile = Join-Path $AlphaRoot '.env'
if (Test-Path $envFile) { OK ".env still present (it was never overwritten)" }
else { Warn "No .env here. A first install needs one before Alpha will start." }

Section "DONE"
Write-Host "Start Alpha again the way this machine normally starts it."
Write-Host "If anything is wrong, the pre-update copy is under $Landing\Backups\."

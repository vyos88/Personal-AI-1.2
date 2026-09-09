<#
  usb-inventory.ps1 — enumerate what is physically attached to this laptop.

      powershell -ExecutionPolicy Bypass -File .\usb-inventory.ps1

  Read-only. It changes nothing, connects to nothing, and needs no elevation.

  Writes two files beside itself:
    usb-inventory.txt   readable, for you
    usb-inventory.json  structured, for Alpha's device panels to consume

  The JSON is the point. Alpha's KnownDeviceProfilesPanel / DeviceManagerPanel
  work from device identity (VID/PID/serial), so a hand-typed list is not good
  enough — that is what this produces.
#>

$ErrorActionPreference = 'SilentlyContinue'
$here = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$txt  = Join-Path $here 'usb-inventory.txt'
$json = Join-Path $here 'usb-inventory.json'

function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }

# VID/PID is the stable identity; FriendlyName is not (it changes with drivers).
function Get-Ids($instanceId) {
  $vid = $null; $pid = $null; $serial = $null
  if ($instanceId -match 'VID_([0-9A-Fa-f]{4})') { $vid = $Matches[1].ToUpper() }
  if ($instanceId -match 'PID_([0-9A-Fa-f]{4})') { $pid = $Matches[1].ToUpper() }
  $tail = ($instanceId -split '\\')[-1]
  # A tail with no & is a real serial; with & it is a port-derived instance id.
  if ($tail -and $tail -notmatch '&') { $serial = $tail }
  [pscustomobject]@{ vid = $vid; pid = $pid; serial = $serial }
}

Section "USB devices"
$usb = Get-PnpDevice -PresentOnly |
  Where-Object { $_.InstanceId -like 'USB*' -or $_.InstanceId -like '*VID_*' } |
  ForEach-Object {
    $ids = Get-Ids $_.InstanceId
    [pscustomobject]@{
      name       = $_.FriendlyName
      class      = $_.Class
      status     = $_.Status
      instanceId = $_.InstanceId
      vid        = $ids.vid
      pid        = $ids.pid
      serial     = $ids.serial
    }
  } | Sort-Object class, name

$usb | Format-Table name, class, status, vid, pid -AutoSize | Out-String | Write-Host
Write-Host ("  {0} USB device(s)" -f @($usb).Count)

# Anything not "OK" is attached but not working — a missing driver, or a device
# that needs a power cycle. Worth seeing separately rather than buried above.
$bad = @($usb | Where-Object { $_.status -ne 'OK' })
if ($bad) {
  Section "Attached but NOT working"
  $bad | Format-Table name, class, status, instanceId -AutoSize | Out-String | Write-Host
  Write-Host "  These need a driver or a reconnect before Alpha can use them." -ForegroundColor Yellow
}

# Serial ports are what the robot, Arduino and RF panels actually talk over,
# so they get their own section even though they appear above too.
Section "Serial / COM ports"
$ports = Get-CimInstance Win32_SerialPort | ForEach-Object {
  [pscustomobject]@{ port = $_.DeviceID; name = $_.Name; description = $_.Description; pnpId = $_.PNPDeviceID }
}
if ($ports) { $ports | Format-Table port, name -AutoSize | Out-String | Write-Host }
else { Write-Host "  none" }

Section "Cameras and audio capture"
$av = Get-PnpDevice -PresentOnly |
  Where-Object { $_.Class -in @('Camera','Image','Media','AudioEndpoint') } |
  ForEach-Object { [pscustomobject]@{ name = $_.FriendlyName; class = $_.Class; status = $_.Status } }
if ($av) { $av | Format-Table name, class, status -AutoSize | Out-String | Write-Host }
else { Write-Host "  none" }

$payload = [pscustomobject]@{
  machine     = $env:COMPUTERNAME
  collectedAt = (Get-Date).ToUniversalTime().ToString('o')
  usb         = @($usb)
  serialPorts = @($ports)
  avDevices   = @($av)
}
$payload | ConvertTo-Json -Depth 6 | Set-Content $json -Encoding UTF8

Section "Written"
Write-Host "  $json   <- feed this to Alpha"
Write-Host "  $txt"
Write-Host ""

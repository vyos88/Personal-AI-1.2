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

  Every section goes to the console *and* into the .txt through Emit. It used to
  be Write-Host only, so the readable half of "writes two files" was a lie: the
  path was printed at the end but nothing was ever written to it, and the report
  died with the console window. Anything worth showing is worth keeping —
  a COM port number read off the screen at 2am is the thing you need again at 9.
#>

$ErrorActionPreference = 'SilentlyContinue'
$here = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$txt  = Join-Path $here 'usb-inventory.txt'
$json = Join-Path $here 'usb-inventory.json'

$report = [System.Text.StringBuilder]::new()

# Console gets colour, the .txt gets the same words. Colour is a console-only
# concept, so it is an argument here rather than anything that reaches the file.
function Emit($text, $color) {
  if ($null -eq $text) { $text = '' }
  $text = [string]$text
  if ($color) { Write-Host $text -ForegroundColor $color } else { Write-Host $text }
  [void]$report.AppendLine($text)
}

function Section($t) { Emit "`n=== $t ===" 'Cyan' }

# Format-Table renders lazily, so it has to be forced through Out-String before
# it can be either printed or stored — otherwise the pipeline formats against
# the console and the file gets object noise.
function EmitTable($rows, $props) {
  ($rows | Format-Table $props -AutoSize | Out-String).TrimEnd() | ForEach-Object { Emit $_ }
}

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

Emit ("usb-inventory — {0} — {1}" -f $env:COMPUTERNAME, (Get-Date).ToString('u'))

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

EmitTable $usb @('name', 'class', 'status', 'vid', 'pid')
Emit ("  {0} USB device(s)" -f @($usb).Count)

# Anything not "OK" is attached but not working — a missing driver, or a device
# that needs a power cycle. Worth seeing separately rather than buried above.
$bad = @($usb | Where-Object { $_.status -ne 'OK' })
if ($bad) {
  Section "Attached but NOT working"
  EmitTable $bad @('name', 'class', 'status', 'instanceId')
  Emit "  These need a driver or a reconnect before Alpha can use them." 'Yellow'
}

# Serial ports are what the robot, Arduino and RF panels actually talk over,
# so they get their own section even though they appear above too.
Section "Serial / COM ports"
$ports = Get-CimInstance Win32_SerialPort | ForEach-Object {
  [pscustomobject]@{ port = $_.DeviceID; name = $_.Name; description = $_.Description; pnpId = $_.PNPDeviceID }
}
if ($ports) { EmitTable $ports @('port', 'name') } else { Emit "  none" }

Section "Cameras and audio capture"
$av = Get-PnpDevice -PresentOnly |
  Where-Object { $_.Class -in @('Camera','Image','Media','AudioEndpoint') } |
  ForEach-Object { [pscustomobject]@{ name = $_.FriendlyName; class = $_.Class; status = $_.Status } }
if ($av) { EmitTable $av @('name', 'class', 'status') } else { Emit "  none" }

$payload = [pscustomobject]@{
  machine     = $env:COMPUTERNAME
  collectedAt = (Get-Date).ToUniversalTime().ToString('o')
  usb         = @($usb)
  serialPorts = @($ports)
  avDevices   = @($av)
}
$payload | ConvertTo-Json -Depth 6 | Set-Content $json -Encoding UTF8

Section "Written"
Emit "  $json   <- feed this to Alpha"
Emit "  $txt"
Emit ""

# Last, so the .txt contains every section above it. Written even if a section
# above found nothing — an empty report is still the answer to "what is plugged in".
$report.ToString() | Set-Content $txt -Encoding UTF8

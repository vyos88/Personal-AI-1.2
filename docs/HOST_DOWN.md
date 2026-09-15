# The main host is down

What to do, in the order that gets the fleet working again fastest. Everything
here runs on the laptop that is still on.

## The one thing that catches people

**The panel is not on the tailnet.** It is an ESP32 on WiFi, so it can only
reach a coordinator at an address that is routable from that WiFi — a
`192.168.x.y` on the same network. A panel provisioned with `http://100.x.y.z`
will sit there showing `http 0` or `no host` forever, however healthy
everything else is, because a `100.x` tailnet address does not exist for it.

Same network, LAN address. That is the rule.

## 1. Run the coordinator here

```powershell
$ip = (Get-NetIPAddress -AddressFamily IPv4 |
       Where-Object { $_.IPAddress -like '192.168.*' })[0].IPAddress
$env:ALPHA_HOST_BIND = "127.0.0.1,$ip"
node src/host/index.js
```

`ALPHA_HOST_BIND` defaults to loopback only, deliberately — a coordinator on
every interface should be a choice. Here it is the choice: the panel and the
other laptops have to reach it.

Windows will not let them through until you say so, once:

```powershell
New-NetFirewallRule -DisplayName "alpha-tunnel 8787" -Direction Inbound `
  -Protocol TCP -LocalPort 8787 -Action Allow -Profile Private
```

If this machine has the auth store from the host, the keys still work. If it
does not, set `ALPHA_BOOTSTRAP_TOKEN` and mint what you need with
`node src/admin/run.js`.

## 2. Point the panel at it

With the board plugged into this laptop:

```powershell
$env:ALPHA_PANEL_WIFI_PASSWORD = "<the wifi password>"
node scripts/connect-panel.mjs --ssid "<the wifi>" --host "http://$ip:8787"
```

It ends by waiting for the host to see the panel's key being used, so exit 0
means the screen is showing live numbers — not that the commands ran.

**Provision both addresses while you are there** and you will not have to do
this again next time:

```powershell
node scripts/connect-panel.mjs --ssid "<the wifi>" `
  --host "http://<the host's LAN address>:8787" `
  --standby-host "http://$ip:8787"
```

The panel then reads the primary, falls back to this laptop when the primary
does not answer, and comes back on its own when it does — the footer says
`[standby]` while it is on the fallback. Both have to be addresses the panel's
WiFi can reach; neither can be a `100.x`.

## 3. Point the workers at it

On each laptop that lends, `.env.agent`:

```ini
ALPHA_HOST_URL=http://<the host's address>:8787,http://<this laptop's LAN address>:8787
```

Primary first. The agent registers with the first coordinator that answers, and
checks the primary every minute while it is on a standby — when the host comes
back it deregisters from the laptop and goes home, and it only does that between
tasks, so nothing in flight is lost. A coordinator that answers and *refuses*
(a bad token, a protocol mismatch) is not failed over from: it would say the
same thing on the standby.

## 4. Run Alpha itself here

The coordinator is this repo. Alpha is the other thing, and
`scripts/standby-alpha.mjs` is what runs it here while the host is off:

```powershell
node scripts/standby-alpha.mjs --root C:\alpha --npm-script dev `
  --control-url http://192.168.1.1/
```

`--control-url` is something that is up whenever this laptop's network is —
the router will do. Without it the machine cannot tell "the host is down" from
"I cannot reach the host", and a dropped link gives you a second live Alpha.
Demotion is on by default, so it stands down when the host answers again.

## When the host comes back

Nothing to undo: the agents move home by themselves, and so does the panel if
it was given both addresses. Stop the coordinator here, and stop
`standby-alpha.mjs` if you started it by hand.

Check it with the receipt rather than by eye:

```powershell
node scripts/watchdog.mjs --no-update --panel-key <key id> --json
```

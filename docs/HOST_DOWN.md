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

## The panel cannot reach Alpha's backend

A different problem from the ones below, and the commonest: Alpha's own deck
panel reaches the backend on a home-network address only. On the machine running
Alpha:

```powershell
node scripts/fix-panel-host.mjs
```

It adds this machine's `192.168.x` address to `HOST` and `ALPHA_TRUSTED_HOSTS` in
`app/.env.local` (keeping loopback and the tailnet address), turns
`ALPHA_PANEL_LAN_READ` on, restarts the backend, and then makes the panel's own
request — `GET /panel/crowpanel/public-state` from that address. Exit 0 means the
panel has something to read; anything else names which of the three is wrong.
`--dry-run` shows the change and writes nothing.

Then point the panel at it, with whichever firmware the board runs:

```
ALPHA http://192.168.x.y:8001                       (Alpha's deck firmware, over USB serial)
node scripts/panel-up.mjs --primary http://192.168.x.y:8001   (the tunnel's firmware)
```

## The whole thing in one command

On the laptop the board is plugged into:

```powershell
node scripts/panel-up.mjs --ssid "<the wifi>"
```

It works out this machine's LAN address, starts a coordinator here if none is
answering (bound to that address, logging to `coordinator.log`), mints the panel
a key scoped to `agents:read`, finds the serial port, sends the credentials, and
then waits for the coordinator to see that key being used. Exit 0 means the
screen is live. It asks for the WiFi password rather than taking it as an
argument.

Add `--primary http://<the host>:8787` and the panel learns both addresses: it
reads the host first and falls back here, so it comes home on its own.

The rest of this page is the same thing step by step, for when one of them
needs doing differently.

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

### Standing by for Alpha on *another* machine

This fleet is the other way round from the names: Alpha runs on **Worker1**
(`desktop-41hplcn`) and the coordinator runs on the **Host**
(`laptop-gj8dfmlk`). So the machine that should take Alpha over is the one
running the coordinator, and that is where the default probe is a trap:

- **`--probe-url` must name Alpha, not the coordinator.** `standby-alpha.mjs`
  defaults it to `ALPHA_HOST_URL/healthz`. On the coordinator's own machine that
  answers from loopback whatever happens to Worker1, so the standby never
  promotes and the failover silently does not exist.
  `scripts/install-always-on.ps1` now takes `-ProbeUrl` for this, and says so
  when it is left out on a machine holding the coordinator port.
- **`--local-url` is how you learn a promotion started nothing.** Point it at
  `http://127.0.0.1:8001/health` and the standby checks that what it started is
  actually serving, instead of counting a dead process as a live Alpha.

On the Host, with Alpha staged there by the autopilot's `prepare-alpha-here`:

```powershell
cd C:\services\alpha-tunnel
powershell -ExecutionPolicy Bypass -File .\scripts\install-always-on.ps1 `
  -AlphaRoot C:\Users\<user>\Downloads\VyoS-advance-tech-ai `
  -ProbeUrl http://100.69.243.25:8001/health `
  -LocalUrl http://127.0.0.1:8001/health `
  -ControlUrl https://github.com -CloudflareTunnel <tunnel name> -WhatIfOnly
```

Drop `-WhatIfOnly` once the printed argv is what you want.

**Two things it cannot start Alpha without, and neither is in the staged
clone.** `prepare-alpha-here` deliberately copies no secrets and no data:

1. **`.env.local`** — Alpha's settings and credentials. Without it the backend
   starts without its login, its model configuration and its trusted hosts.
2. **`memory\`** — what Alpha knows. A promoted Alpha with an empty knowledge
   store is a different assistant wearing the same name, and the records it
   writes while promoted are the ones Worker1 then has to reconcile.

Until those are carried across, installing the standby on the Host buys a
*tested* failover path and an unarmed one: it will promote, and Alpha will fail
to come up — which `--local-url` is what reports. That is the honest state to
leave it in rather than a standby nobody has ever seen promote.

## When the host comes back

Nothing to undo: the agents move home by themselves, and so does the panel if
it was given both addresses. Stop the coordinator here, and stop
`standby-alpha.mjs` if you started it by hand.

Check it with the receipt rather than by eye:

```powershell
node scripts/watchdog.mjs --no-update --panel-key <key id> --json
```

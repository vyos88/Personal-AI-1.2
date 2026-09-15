# CrowPanel — live alpha-tunnel report

An ESP32 CrowPanel that shows what the coordinator is doing: agents online,
tasks queued, running, done, failed. It is **read-only** — it asks the host
questions and draws the answers. It queues nothing and holds no lease.

Flashing and provisioning both go through the `alpha.panel` handler, so the
panel is driven by queued task from wherever Alpha is, not by hand on the
laptop it happens to be plugged into.

## Why the WiFi password is not in this directory

It is runtime data, kept in NVS on the board, sent over USB serial by
`alpha.panel`'s `Provision` action. Baking it in with `--build-property` would
put it in an argv every process listing can read, in build artifacts on disk,
and would mean a reflash every time the network changes. Do not add a
`secrets.h`.

## One-time setup on the Alpha host

The panel is on the host's USB — the same Windows box that runs the
coordinator — so all of this happens there, against the host's own agent.

Install [`arduino-cli`](https://arduino.github.io/arduino-cli/), the ESP32 core,
and the two libraries:

```bash
arduino-cli core install esp32:esp32
arduino-cli lib install ArduinoJson
arduino-cli lib install TFT_eSPI
```

Then point the agent at the sketch and enable the handler:

```
ALPHA_EXTRA_HANDLERS=alpha-panel
ALPHA_PANEL_ROOT=C:\path\to\alpha-tunnel
ALPHA_PANEL_SKETCH=firmware/crowpanel
ALPHA_PANEL_FQBN=esp32:esp32:esp32
ALPHA_PANEL_PORT=COM3
```

`ALPHA_PANEL_FQBN` **must match your board.** CrowPanel is a family — the
2.4"/3.5" units are SPI on a classic ESP32, the 5"/7" units are RGB parallel on
an ESP32-S3 — and they do not share a core target.

The value above is `esp32:esp32:esp32` because this board enumerates through a
**CH340** USB-UART bridge (`COM3 USB-SERIAL CH340`). An S3 CrowPanel would show
native USB or a CH343, so the CH340 is what places this in the SPI family — and
why `display.h` is TFT_eSPI rather than an RGB driver.

Confirm it with `arduino-cli board listall esp32`; `Ports` will also report what
the CLI thinks is attached.

## The shortest way

```bash
node scripts/panel-up.mjs --ssid "<the network>"
```

Address, coordinator, key, port, provision, verify — on the machine the board
is plugged into, with nothing else set up first. Use this when the panel is
already flashed and just needs a network and something to read.

## The short way: one command

On the machine the board is plugged into:

```bash
setx ALPHA_PANEL_WIFI_PASSWORD "<the password>"   # once, and never in argv
node scripts/connect-panel.mjs --ssid "<the network>" --flash
```

It finds the port (the CH340 bridge is the panel), compiles and uploads, mints
the panel a key scoped to `agents:read` and nothing else, sends the credentials
down the wire, and then **waits for the host to see that key being used**. That
last step is the only evidence that counts: a flash that worked and a join that
worked still leave a dark screen if the panel cannot reach the coordinator.

Exit 0 means the panel is reading the host, and the last line tells you how to
keep it that way. `--verify-only` re-asks that question later without touching
the board.

The rest of this section is the same sequence by hand, one queued task at a time.

## Flashing

The host is Windows, where PowerShell's execution policy blocks `npm.ps1` — so
these use the `node` form, as everything on that box does.

Find the port, build, then write it. Queue each with `--agent alpha-host`:
`available()` already stops a machine with no sketch or no arduino-cli from
offering the type at all, and `--agent` is the other half — it pins the flash to
the box the board is actually on, rather than to whichever qualifying machine
ranks best.

```bash
node src/admin/run.js task --type alpha.panel --agent alpha-host \
  --payload '{"action":"Ports"}'

node src/admin/run.js task --type alpha.panel --agent alpha-host \
  --lease-ms 600000 --no-wait --payload '{"action":"Compile"}'

node src/admin/run.js task --type alpha.panel --agent alpha-host \
  --lease-ms 600000 --no-wait --payload '{"action":"Flash","port":"COM3"}'
```

A cold ESP32 build is minutes, so `Compile` and `Flash` need `--lease-ms` **and**
`--no-wait` — the same reason `alpha.render` does. Without them the CLI's own
poll gives up on a task that is running fine.

## Provisioning

One task hands the panel its network and its view of the coordinator:

```bash
node src/admin/run.js task --type alpha.panel --agent alpha-host \
  --lease-ms 120000 --payload '{
  "action":"Provision",
  "port":"COM3",
  "ssid":"<the new network>",
  "password":"<the new password>",
  "host":"http://100.x.y.z:8787",
  "key":"alpha_key_..."
}'
```

The result names the SSID and the IP the board got. **The password is never in
the result, never in the logs, and is redacted out of the serial transcript.**

`{"action":"Provision","port":"COM3","ssid":"...","password":"..."}` without a
host is fine — the panel joins the network and waits.

`--lease-ms` is needed here too, for a different reason than the flash. Opening
the port resets the board — the CH340 adapter ties DTR to EN — and the sketch's
`setup()` then spends up to 15 seconds joining WiFi before it reads a byte of
serial, so the handler waits for the board to answer a harmless `status` before
it sends anything. Add the board's own 20-second join to that and a provision
can run past the 60s default lease while working perfectly.

The result says `ready:false` when nothing on the port answered at all. That is
a different failure from `provisioned:false`: the first means the board is not
there, is held in bootloader, or is running firmware older than this protocol;
the second means it is there and the credentials did not work.

**The key needs `agents:read`** — that is the scope `GET /stats` requires, and
the panel reads nothing else. An operator key covers it; an admin key is not
needed and the panel is the last place to put one.

## What the panel shows

It draws `GET /stats` as the host answers it, and does no arithmetic of its own:
agents attached, tasks queued (and how many of those are waiting on RAM rather
than on a free machine), running, done, failed, with the host version and the
age of the last poll along the bottom. `running` is the host's `leased` — a task
an agent is holding right now.

## Bring it up serial-only first

```bash
arduino-cli compile --fqbn <your board> \
  --build-property "build.extra_flags=-DPANEL_DISPLAY_SERIAL_ONLY" \
  firmware/crowpanel
```

The report goes to the serial monitor instead of the screen. This is worth
doing once: a blank panel cannot tell you whether the board failed to join the
network or the display driver is wrong, and this separates the two. Once a
report scrolls past, do the display config.

## Files

| File | What it is |
|---|---|
| `crowpanel.ino` | Provisioning protocol, WiFi, polling, report. Board-independent. |
| `display.h` | The board-specific half. Porting to another CrowPanel means editing this and the FQBN. |

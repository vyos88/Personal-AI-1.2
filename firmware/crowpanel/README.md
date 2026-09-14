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
ALPHA_PANEL_FQBN=esp32:esp32:esp32s3
ALPHA_PANEL_PORT=COM3
```

`ALPHA_PANEL_FQBN` **must match your board.** CrowPanel is a family — the
2.4"/3.5" units are SPI, the 5"/7" units are RGB parallel on an ESP32-S3 — and
they do not share a core target. `arduino-cli board listall esp32` prints the
options.

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
node src/admin/run.js task --type alpha.panel --agent alpha-host --payload '{
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

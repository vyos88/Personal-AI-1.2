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

More than one network — the house WiFi and a hotspot, say — is the same command
with `--ssid` repeated. It asks for each password in turn, the board keeps up to
four, and it joins whichever one it can actually hear:

```bash
node scripts/panel-up.mjs --ssid "house" --ssid "hotspot"
```

Two read-only commands for when something is wrong:

```bash
node scripts/panel-up.mjs --list-ports   # what is plugged into this machine
node scripts/panel-up.mjs --scan         # what the board can hear from where it is
```

`--scan` is the one that settles "wrong password or wrong room": it asks the
panel's own radio, which is not the same radio as the laptop beside it.

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

## Several networks, and how it picks

The panel keeps up to four sets of credentials and chooses by signal, not by
the order they were given: it scans, keeps the ones it can see, and tries the
strongest first. A network it cannot see is skipped rather than waited on —
except when it can see none of them, which is also what a hidden SSID looks
like, and then it tries them all in order.

A wrong password comes back as `CONNECT_FAILED` long before the join timeout,
so one bad entry costs a second rather than the whole budget. When none of them
work the reply names every SSID it tried, so the answer is "none of these three"
rather than "it did not work".

Reflashing does not lose what the board already had: the previous firmware's
single network is migrated into the new list the first time this one boots.

## Not Alpha's deck firmware

Alpha has its own CrowPanel sketch (`hardware/examples/crowpanel_alpha_*` in that
repository). It is the same family of board and a completely different thing: it
holds no credential, polls `/panel/crowpanel/public-state` on Alpha's backend
(port 8001) every three seconds, and takes bare-word serial commands — `STATUS`,
`WIFI "ssid" passphrase`, `ALPHA http://address:8001`.

One board runs one of the two. They are told apart on the wire rather than by
guessing: this firmware answers newline-delimited JSON, so if the board on a port
is talking but answers none of it, `panel-up` and the handler say *that* instead
of blaming the cable:

```
provision  : something on COM3 is talking but not in this protocol — if this
             board runs Alpha's deck firmware, provision it with its own
             STATUS/WIFI/ALPHA commands instead. It said: ...
```

## Which board is the panel, and remembering it

A laptop can carry several serial bridges — Worker1 carries five, four of them
identical CH340 clones — and Windows renumbers COM ports on re-enumeration, so
the board that was COM7 yesterday is COM4 today and whatever had the old number
saved stops finding it. Two commands answer that, and neither guesses:

```
node scripts/panel-up.mjs --identify      # ask each port which board is on it
node scripts/panel-up.mjs --pin COM4      # remember that one as this machine's panel
```

`--identify` opens each port in turn and reports `panel` (this firmware
answered), `alpha-deck` (Alpha's own, above), `other`, `silent`, or `unreadable`
(something else holds the port). It writes one `status` query per port and
nothing else.

`--pin` writes `data/panel-board.json` — machine-local and gitignored, because
which USB socket a laptop's panel is in is a fact about that laptop. It records
what the board *said*: its firmware and, from `panel-4`, its **MAC**, which is
the only identifier that survives both a replug and a reflash. The port is kept
as a hint. Later runs ask the pinned port first and check the answer: same MAC
means this is the board; a different MAC means a different board and the sweep
runs again, re-pinning where it finds it. A board with no MAC to check — Alpha's
deck firmware, or this one before `panel-4` — is pinned by kind and port, and
the output says so rather than implying proof it does not have.

## Pages

One screen cannot hold a fleet, so five rotate every eight seconds. Each page is
sourced from the endpoint that owns its numbers, and only the page on screen is
fetched — a wall display must not be why a coordinator is busy.

| Page | From | Shows |
|---|---|---|
| `fleet` | `/stats` | agents attached, queued (and how many are waiting on RAM), running, done, failed |
| `machines` | `/agents` | a row per machine: load, free RAM, tasks in flight, stale and version-drift markers |
| `work` | `/stats` | tasks in flight, busiest and idlest machine, how many report load at all, which task types are covered |
| `receipts` | `/receipts/summary` | what the fleet actually produced: receipts, ok/failed, outputs and bytes, top types |
| `panel` | nothing | this board: network, IP, signal, which coordinator it is reading, missed polls, firmware and uptime |

The `panel` page needs no network, which is the point of it: it is the page that
still works when nothing else does, and the one that answers "is it the panel or
the fleet?".

A machine that has missed two heartbeats is drawn red on `machines` rather than
dropped, and a machine not reporting load shows `load ?` — never `0%`, because
reading an unknown as idle makes the quietest *reporter* look like the quietest
*machine*.

Turn a page by hand, or stop the rotation to read one:

```bash
node scripts/panel-up.mjs --page machines --hold
node scripts/panel-up.mjs --page next
node scripts/panel-up.mjs --no-hold
```

As a queued task to the machine the board is on:

```bash
node src/admin/run.js task --type alpha.panel --agent alpha-host \
  --payload '{"action":"Page","page":"receipts","hold":true}'
```

The `receipts` page needs the panel's key to carry `tasks:read` as well as
`agents:read` — both read-only. A panel provisioned before that says `key needs
tasks:read` on that page instead of showing zeroes; re-running `panel-up` mints a
key with both.

## What the panel shows

It draws `GET /stats` as the host answers it, and does no arithmetic of its own:
agents attached, tasks queued (and how many of those are waiting on RAM rather
than on a free machine), running, done, failed, with the host version and the
age of the last poll along the bottom. `running` is the host's `leased` — a task
an agent is holding right now.

The WiFi line names the network it actually joined and how good the signal is in
words rather than only in dBm. A report older than twenty seconds is still shown
— it is the last true thing the panel knew — but drawn muted and marked
`[stale]`, because a frozen screen that looks live is the one failure a status
display must not have. `[standby]` in the footer means it is reading the
fallback coordinator rather than the host.

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

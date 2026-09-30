# CrowPanel — what was built, what is unverified, what to run

Handoff for the panel work on `claude/nice-lamport-02re4a` / PR #27. Written to
be picked up cold, by a person or another session.

## The short version

The CrowPanel is flashed and provisioned **by queued task** now, instead of by
hand in the Arduino IDE on the one laptop it is plugged into. Nothing in this
change has touched real hardware yet — see [Unverified](#unverified), which is
the part to read first.

## What landed

| Thing | Where | What it is |
|---|---|---|
| `alpha.panel` handler | `src/agent/handlers/alpha-panel.js` | Ports / Status / Compile / Flash / Provision, over `arduino-cli`. Opt-in, with `available()`. |
| Tests | `test/alpha-panel.test.js` | 14 tests pinning argv, validation, credential handling and `available()`. |
| Firmware | `firmware/crowpanel/crowpanel.ino` | WiFi + NVS provisioning, polls `/stats`, draws the live report. |
| Display layer | `firmware/crowpanel/display.h` | The only board-specific file. TFT_eSPI, plus a serial-only build. |
| Firmware docs | `firmware/crowpanel/README.md` | Setup, flashing, provisioning. |
| `usb-inventory.ps1` fix | `scripts/usb-inventory.ps1` | It promised two files and wrote one. |

Full suite: **259 pass**, run after merging `origin/main` (8 commits, including
`handlers/index.js`). `BUILTIN` is unchanged — the handler stays opt-in, because
it drives an external program and touches hardware.

## Unverified

**No part of this has run against a board.** (See [Fixed since this document was
first written](#fixed-since-this-document-was-first-written) for the live-run
bugs found since, by reading the contracts instead.) The session that wrote it
had no USB at all — no `/sys/bus/usb`, no serial device nodes, no COM port — so:

- the `arduino-cli` argv is pinned against a recorder, not a real CLI
- the sketch has never been compiled
- the serial line protocol has never spoken to a board

The tests cover what can be tested without hardware, which is the validation and
the argv. They do not cover whether the board answers.

**Which board, and how that was settled.** The only hardware record in the
system is `COM3 USB-SERIAL CH340`. A CH340 is an external USB-UART bridge; an
ESP32-S3 CrowPanel presents native USB or a CH343 instead. So this is a classic
ESP32 in the SPI display family, which makes `ALPHA_PANEL_FQBN=esp32:esp32:esp32`
and `display.h` on TFT_eSPI the right pair.

That is inference from one line of evidence, not a reading off the board. If
`Ports` reports something that disagrees, the FQBN is one env var and `display.h`
is one file — nothing else in the sketch is board-dependent.

## Runbook — on the Alpha host

**The panel is on the host's USB, not on a laptop.** It is the same Windows box
that runs the coordinator, so these tasks go to the host's own agent and the
commands use the `node` form (PowerShell's execution policy blocks `npm.ps1`
there).

This has to run on that box. A cloud session cannot reach the Alpha host's
tailnet, so none of it can be driven from a Claude session in a container.

### 1. Prove the handler and the board, before writing anything

```bash
node src/admin/run.js task --type alpha.panel --agent alpha-host \
  --payload '{"action":"Ports"}'
```

Read-only. It lists what `arduino-cli` can see. If the panel is not in that
list, stop — nothing below will work, and the problem is drivers or the cable.

### 2. Bring it up serial-only first

```bash
arduino-cli compile --fqbn <your board> \
  --build-property "build.extra_flags=-DPANEL_DISPLAY_SERIAL_ONLY" \
  firmware/crowpanel
```

The report goes to the serial monitor instead of the screen. Do this once: a
blank panel cannot tell you whether the board failed to join the network or the
display config is wrong, and this separates those two into one question each.

### 3. Flash

```bash
node src/admin/run.js task --type alpha.panel --agent alpha-host \
  --lease-ms 600000 --no-wait --payload '{"action":"Flash","port":"COM3"}'
```

`--lease-ms` **and** `--no-wait`, for the same reason `alpha.render` needs them:
a cold ESP32 build outruns `DEFAULT_LEASE_MS` and the CLI's own poll gives up on
a task that is running fine.

`--agent alpha-host` matters. The handler being opt-in keeps it off machines that
never enabled it, but not off one handed a copy of the same configuration, and
naming the machine is what puts the flash where the panel actually is.

### 4. Provision

```bash
node src/admin/run.js task --type alpha.panel --agent alpha-host \
  --lease-ms 120000 --payload '{
  "action":"Provision",
  "port":"COM3",
  "ssid":"<network>",
  "password":"<password>",
  "host":"http://100.x.y.z:8787",
  "key":"alpha_key_..."
}'
```

The result names the SSID and the IP the board got. **The password is not in the
result, not in the logs, and is redacted out of the serial transcript.** It is
never written to this repo and must never be: it lives in NVS on the board.

`--lease-ms` is not optional here. Opening the port resets the board, its
`setup()` joins WiFi before it reads serial at all, and its `wifi` command takes
up to 20 seconds to answer — so the handler waits for a `status` reply before
sending anything, and a provision that is working can still outrun the 60s
default lease.

Read `ready` first in the result. `ready:false` means nothing on that port
answered: wrong port, board held in bootloader, or firmware older than this
protocol. `ready:true` with `provisioned:false` means the board is there and the
credentials did not work — a different trip entirely.

The key in that payload needs `agents:read` and nothing more: `GET /stats` is
the only thing the panel asks for.

## Fixed since this document was first written

Four things that only show up against real hardware, found by reading the two
contracts this depends on rather than by plugging a board in:

- **The panel read `/stats` by names the host does not answer with.** It reached
  for `tasks.queued` and friends; the host answers `queue.byStatus.{queued,
  leased, succeeded, failed}`, with `agents` as a plain count. A missing key
  reads as zero in ArduinoJson, so the screen would have shown a confident row
  of zeroes — an idle fleet, not a bug. A test now pins the sketch's key names
  against a real host's `/stats`.
- **A read on the serial port could never time out.** `stty raw` sets `min 1
  time 0`, so a read waits for a byte a silent board never sends: the 15s
  deadline was never reached, and a task that hangs on a serial read holds its
  lease until the sweeper takes it away. The line discipline now sets `min 0
  time 1`, and every read is raced against the deadline so Windows — which has
  no such knob — is covered by the close instead.
- **The first command was written into a board that was rebooting.** Opening the
  port drops DTR, which resets an ESP32 behind a CH340; the credentials were
  sent while the sketch was still in `setup()`. The conversation now opens with
  `status`, repeated until the board answers, and the credentials go out only
  once something is there to receive them. Every reply names the command it
  answers, so a probe answered late cannot be read as the reply to whatever went
  out next — that would report a panel as provisioned on the strength of a
  `status` reply.
- **The handler gave up before the board could answer.** The sketch's `wifi`
  command joins for 20 seconds before it replies, against a 15-second budget
  here, so a wrong password came back as "the board said nothing" — the cable
  answer to a password question. The budget is 25 seconds now, which is also
  why `Provision` wants `--lease-ms`.

## Keeping the laptops attached

This is already handled by things in this repo, and needed no new work:

- **The agent reconnects on its own.** `src/agent/agent.js` backs off and
  retries across host restarts and network drops. The one case where it stops
  instead is `410 stand_down`, which is deliberate — a newer process for the
  same machine has superseded it, and reconnecting there is the loop that would
  never terminate.
- **`scripts/watchdog.mjs`** is the check. The agent reconnecting is not the
  same as the agent being *attached*, and a laptop that quietly stopped lending
  in the first hour looks exactly like one that worked all week. The watchdog
  asks the coordinator whether this machine is in its agent list, on the same
  release, and appends one JSON line per run. Schedule it; exit 1 means a person
  is needed.

### On "full permission"

Deliberately not done, and it needs a decision rather than a default:

- Nothing here can reach the host to grant anything — that has to happen on the
  Alpha box.
- A blanket admin key is the wrong tool for this. The panel laptop's agent needs
  `agent:connect` and nothing more; the watchdog needs an operator key to read
  `/agents`. Auth here is capability-based and recomputed per request, so a
  narrow key costs nothing to issue and nothing to live with — and narrowing a
  user narrows every key they already hold, immediately.

Issue the two scoped keys rather than one broad one. If a genuinely
higher-privilege key is wanted, that is a deliberate call to make at the host,
not something to inherit from a handoff document.

## Files to read first

1. `src/agent/handlers/alpha-panel.js` — the header comment explains every
   design constraint, including why credentials are runtime data and not build
   input.
2. `firmware/crowpanel/README.md` — setup and the flashing commands.
3. `CLAUDE.md`, the `alpha-panel.js` section — the short form of the rules this
   handler follows and why.

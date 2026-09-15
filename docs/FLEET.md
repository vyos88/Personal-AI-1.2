# Who runs what, and how hard

Three machines and a panel, with one rule behind every setting here: **a machine
lends what its owner said it may lend, and the host places work on whoever can
take it.** Nothing below asks a machine to guess, and nothing runs in two places
hoping one wins.

This is the configuration side of the design in `CLAUDE.md`. It changes no
behaviour on its own — every knob it names already exists.

## The roles

| Machine | Runs | Lends | Pinned work |
|---|---|---|---|
| **Alpha host** (Windows) | coordinator + its own agent | a little — it is answering everyone | `alpha.coordination`, `alpha.panel`, `device.inventory` |
| **Workhorse laptop** | agent, under `keep-agent.mjs` | 85–90% | everything unpinned |
| **Reserve laptop** | agent + `standby-alpha.mjs` | 20% or less | `alpha.render` |

One agent per machine. Two agents on one laptop is a fleet that reads as twice
the machines and twice the memory, which is the failure `instanceId` exists to
stop — and a second process started beside a running one does not double
anything, it *evicts* the first (`410 stand_down`). Let `keep-agent.mjs` own the
process and start nothing beside it.

## Working one machine to 90%, and leaving the others alone

Two knobs, both on the agent, both read at startup:

```ini
# The workhorse: keep a tenth of this machine for its owner, lend the rest.
ALPHA_AGENT_MEMORY_RESERVE_PERCENT=10
ALPHA_AGENT_MAX_LOAD=0.9
ALPHA_AGENT_CONCURRENCY=4

# The reserve laptop: present, but not competing for general work.
ALPHA_AGENT_MEMORY_RESERVE_PERCENT=80
ALPHA_AGENT_MAX_LOAD=0.5
ALPHA_AGENT_CONCURRENCY=1
```

`ALPHA_AGENT_MEMORY_RESERVE_PERCENT` is a share of the machine's total RAM, and
the larger of it and `ALPHA_AGENT_MEMORY_RESERVE_MB` is what gets held back. The
percentage is the half that survives `.env.agent` being copied from one laptop
to the next — 512 MB is a tenth of an 8 GB machine and a thirty-second of a
32 GB one, so the MB figure alone gives two machines two different bargains
while looking identical in the file.

The 10% left behind is not politeness, it is what keeps the machine from
swapping. A laptop that pages its own task back in is slower than one that never
took the task.

`ALPHA_AGENT_MAX_LOAD` is the CPU half: above it, that agent stops asking for
work at all. It is a ceiling on *asking*, not a promise — a fleet busy
everywhere still runs work, because standing aside is bounded
(`LOAD_THROTTLE_MAX_MS`). Between two machines that are both asking, the host
ranks by leases held and then by reported load, so the quieter one wins.

## Work that only makes sense on one machine

Queue it with `--agent <that machine>`:

```bash
node src/admin/run.js task --type alpha.render --agent reserve-laptop \
  --lease-ms 1800000 --no-wait --payload '{"species":"fern","seed":7}'

node src/admin/run.js task --type alpha.panel --agent alpha-host \
  --lease-ms 600000 --no-wait --payload '{"action":"Flash","port":"COM3"}'
```

Targeting is a filter, not a licence: the named machine still has to offer the
type, have the RAM and be under its ceiling. The other half is `available()` —
a machine with no Blender, no sketch or no arduino-cli never advertises the type
in the first place, which is what covers an *unpinned* render on a laptop
holding a copy of the host's configuration.

## One Alpha at a time

`standby-alpha.mjs` runs Alpha on the reserve laptop **only while the host is
not answering**, and stops it when the host is back:

```bash
node scripts/standby-alpha.mjs --root C:\alpha --npm-script dev \
  --control-url http://192.168.1.1/
```

`--control-url` is not optional in practice. The machine cannot tell "the host
is down" from "I cannot reach the host", and without something that is up
whenever this laptop's network is, a dropped link produces a second live Alpha.
Demotion is on by default so a split heals when the link does. This is failover,
not a quorum, and not HA.

## Getting the panel connected in the first place

```bash
node scripts/connect-panel.mjs --ssid "<network>" --flash
```

Port, flash, key, provision, and then the step that decides the exit code:
waiting for the host to see the panel's key being used. `--verify-only` asks
that last question on its own, any time.

## The two scheduled runs, and the receipts they leave

**On the Alpha host, every 30 minutes** — is this machine attached, and is the
panel still reading the host?

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-watch-task.ps1 `
  -Name alpha-host -PanelKey <key id> -Minutes 30
```

That derives every path from the checkout, so there is nothing to edit, and
re-running it replaces the task rather than adding a second one. `-WhatIfOnly`
prints the `schtasks` line instead of running it, if you would rather install it
by hand:

```bat
schtasks /Create /TN "alpha-tunnel watch" /SC MINUTE /MO 30 ^
  /TR "node C:\alpha\scripts\watchdog.mjs --no-update --name alpha-host --panel-key <key id> --log C:\alpha\watchdog.log"
```

Prove it once rather than trusting it:

```powershell
schtasks /Run /TN "alpha-tunnel watch"
Get-Content C:\alpha\watchdog.log -Tail 1
```

`--panel-key` is the credential the panel polls `/stats` with; `alpha-admin keys`
prints the id. The panel is not an agent — it registers nothing, holds no lease
and has no row in `/agents` — so the last use of that key is the only evidence
the screen is live rather than frozen on numbers from Tuesday. Exit 1 means a
person is needed: host unreachable, this machine not attached, or the panel
gone quiet for two minutes.

Every run appends one JSON line:

```json
{"at":"2026-09-15T20:30:00.000Z","machine":"alpha-host","fleet":{"reachable":true,"attached":true},
 "panel":{"key":"a1b2…","lastUsedAt":"2026-09-15T20:29:57.000Z","silentFor":3000,"connected":true},"ok":true}
```

That file is the record. `tail` it and you can see the week, including the hour
it stopped.

**On each laptop**, the keeper covers the same ground continuously, so schedule
`watchdog.mjs --no-update` beside it (never with `--restart-command`, or the two
bounce the same worker).

## What is not covered here

- **Phones.** Nothing in this repo runs on one. An agent needs Node ≥ 20 and an
  outbound connection, which Termux can give an Android phone, but no phone has
  ever run this and nothing here is tested against one. Treat it as an
  experiment to try deliberately, not as capacity you already have.
- **Anything a cloud session can check.** Sessions in containers cannot reach
  the tailnet, so no Claude session can tell you the fleet is healthy. Only the
  scheduled runs above can, which is why they write the receipts down.

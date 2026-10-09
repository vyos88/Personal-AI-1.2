# Handoff, 2026-10-09e: Phase 3, automatic cover

To V, Claude · Host, Claude · Worker1 and Alpha.

V asked on 2026-10-09: "build phase 3 automatic standby now and also be
prepared to Run for Alpha Server from now on".

V's rule of 2026-10-07 is the specification:

- Alpha is hosted by the Host;
- Worker1 covers while the Host is down;
- when the Host has a heartbeat again, it takes over again, automatically.

This builds the automatic part, on top of the stand-down and stand-up from
`HANDOFF_2026-10-09d`.

## What runs, and where

**`Alpha Standby`** runs on Worker1.

- It is a scheduled task: `alpha-standby.mjs`, every minute and at startup, as
  SYSTEM, so it works with nobody signed in.
- Install it with the autopilot job `standby-install`.
- What it does depends on `role.json`:

| role.json | What a pass does |
|---|---|
| none | this machine is the primary: nothing to cover. **This is Worker1 today**, until the switch-over |
| `standby` | watches the primary. It covers only when all three hold: (1) the primary's Alpha missed 3 passes over the tailnet; (2) alpha-ai.uk is served by nobody; (3) this machine's own internet answers |
| `covering` | this machine serves Alpha. When the primary's Alpha answers 2 passes in a row, it hands Alpha back |

**To cover**, it runs `alpha-standdown.ps1 -Undo -StartConnector`, then
writes role `covering`. `-StartConnector` starts the cloudflared service
whatever the record says. Worker1's service was Stopped while a connector
started some other way served, and a cover with no connector is a live Alpha
nobody can reach. The stand-up now also reports the service's last exit code
and whether it was installed with a token (yes or no, never the token). So
the next rehearsal says whether that service works.

**To hand back**, it runs `alpha-standdown.ps1`, which writes role `standby`.
It also writes `standby\handback-<time>.json` with what changed in `memory\`
while it covered (files, bytes, newest). That is the data that has to go back
to the Host.

**Why three signals, from three paths.** Two Alphas write two histories, and
two connectors on one Cloudflare tunnel split its traffic. Each signal guards
against a different mistake:

- a Host whose Alpha is up but unseen over the tailnet still serves
  alpha-ai.uk, so Worker1 stays put;
- a Worker1 whose own link is down cannot reach the control URL, so it stays
  put;
- one missed answer is a restart, not an outage. It takes three in a row.

**What it does not do: hold a quorum.** Handing back starts as soon as the
Host's Alpha answers, so two Alphas overlap for two passes at most. A standby
that finds Alpha still serving locally while the primary answers stands down
again, at most every 10 minutes. That is the case where Alpha's own always-on
script started it again.

## Who can see it

- **The live page has a Role row:** `PRIMARY`, `STANDBY` or `COVERING`, with
  the cover's last pass. It says when the cover is not installed or has
  stopped.
- **The doctor checks a standby's cover.** Not installed, stopped, or unable
  to see the Host's Alpha are each a problem. Unable to see the Host means it
  would cover in an outage and never hand back. A machine that is covering
  gets a section `0. Covering for <primary>` before the usual checks.
- **Files:**
  - `alpha-ops\standby\status.json` is the last pass;
  - `alpha-ops\logs\standby.jsonl` has one line per pass;
  - `alpha-ops\standby\state.json` holds the streaks.

## Before it can cover, from the switch-over

1. **The switch-over itself** (`HANDOFF_2026-10-09d` section 4). Until Worker1
   is stood down, there is nothing to cover for.
2. **The Host's backend has to answer on its tailnet address.** That is
   `http://100.93.104.24:8001/health`, or whatever address is passed as
   `"primaryUrl"`. Without it, Worker1 cannot tell the Host's Alpha is back,
   and the doctor says so. `fix-panel-host` adds the machine's addresses on
   the Host (Phase 1 step 6).
3. **The rehearsal should show the cloudflared service can start.** That means
   its last exit code is 0, or nothing alarming. If it cannot start, a cover
   is live but unreachable, and the stand-up says `CONNECTOR NOT RUNNING`.

## The data: `alpha-data-sync.ps1` (autofix `dataSync`)

One rule, the same on both machines: **the machine that serves Alpha sends
what changed in `memory\`; the other applies it while it does not serve.**
Configured on both now, the one setting covers every phase:

| When | Who sends | Who applies |
|---|---|---|
| Today (Worker1 serves) | Worker1, every 10 minutes | the Host. It does not serve yet, so it applies at once. Its copy stops being two days old |
| Switch-over (Worker1 stands down) | Worker1, once more: the minutes before it stopped | the Host, before it starts serving. This is the final copy of step 4, done by itself |
| After it (the Host serves) | the Host, every 10 minutes | Worker1, the standby: a cover serves recent data |
| A cover (Worker1 serves) | Worker1. Its sends wait while the Host is down and go when it is back | the Host. It serves again by then, so the package is **held** until `data-apply` |
| A hand-back | Worker1, once more | as above |

Rules that keep it safe:

- **Checking:** every package is checked by size and SHA-256, and refused if
  any path in it is outside `memory\`.
- **Writing:** newer wins. The file it replaces is kept under
  `alpha-ops\data-sync\replaced\<time>\`, and a file newer on the receiving
  side is kept and counted. Nothing is ever deleted.
- **No loops:** a machine never sends back what it only received, and never
  resends what it already sent.
- **Transport:** Taildrop, so nothing goes through git.
  - On 2026-10-08 the Host's `tailscale file get` answered "503 no backend".
  - The first sends will say whether that still holds.

`data-apply` applies a held package: it stops the backend, applies, and
starts it again. It is a job, not automatic, because it interrupts the live
Alpha for about a minute.

## Still to build

- **A standby for the coordinator** (`HANDOFF_2026-10-05c`, F30). It is still
  only on the Host, so agents, music and images stop while the Host is down,
  even when Alpha is covered.

## Update, 2026-10-09 ~18:30 UTC: the new host is alpha-server-01

V: "this laptop is getting ready for new host alpha server 01, on tailscale
also", then "point standby and data copy at alpha-server-01". So the Alpha
server is a new machine, not the Host laptop. Worker1 now points at it:

- **The cover:** job `20261009-07` re-runs `standby-install` with
  `"primary": "alpha-server-01"` and
  `"primaryUrl": "http://alpha-server-01:8001/health"`.
  - That is the server's tailnet name, which needs MagicDNS.
  - `tailnet-peers` (job 06) will give its exact name and address. If the
    name differs or MagicDNS is off, re-run with the IPv4 instead.
- **The data copy:** `autofix.dataSync` is
  `{"peer": "alpha-server-01", "everyMin": 10}`.
  - The first pass sets a baseline. From then on, what Worker1 writes goes to
    the server over Taildrop. Taildrop reaches a machine by name, with no
    MagicDNS needed.
  - The earlier copy to the Host laptop, and its catch-up since 2026-10-07,
    were taken off before they ran.
  - The Host's own `dataSync` (peer `desktop-41hplcn`) is left on and inert:
    nothing is sent to it.

### What alpha-server-01 needs before it can take Alpha

1. **Its Alpha copy:** the live branch built, `.env.local` by USB with V, and
   a full `memory\` to start from. Two ways to get that `memory\`:
   - V's drive and `alpha-data-in`;
   - a `data-sync` job on Worker1 with an old `"since"` (for example
     `2000-01-01T00:00:00Z`), which sends all of it once over Taildrop.
2. **The tunnel checkout and its autopilot**, with a `control/<server>`
   branch, so it can receive the copy (`autofix.dataSync` with
   `peer: desktop-41hplcn`) and run the jobs. These scripts are Windows
   PowerShell. If the server runs Linux, the scheduled-task parts (autopilot,
   stand-down, `Alpha Standby`) need a Linux form first, and `tailnet-peers`
   reports the OS.
3. **Its backend answering on the tailnet** (`alpha-server-01:8001/health`),
   so Worker1 can see it. Its cloudflared connector for alpha-ai.uk, started
   only at the switch-over.
4. **The switch-over, as in `HANDOFF_2026-10-09d` section 4,** with
   `"primary": "alpha-server-01"` on the `alpha-standdown` job.

## Update, 2026-10-09 ~19:40 UTC: the full copy, and the files it lost

The real name on the tailnet is `alpha-serv-01` (100.70.101.6), not
alpha-server-01. Job 12 points the cover there, and job 13 started the full
copy in 100 MB parts. The first two parts, 190 MB, went to alpha-serv-01. That
leaves 13,104 files, 4.3 GB, for the standing check to send a part a pass.

The first part showed a fault: files under
`memory\local\vendor\elegoo_v4_official\...` failed to copy, because the
script copied them under `alpha-ops\data-sync\outbox-<time>\staging\`. A
254-character path came out at 274, over Windows' 260. Worse, the script still
counted those files as sent, so they would never have gone. The fix (in the
script's header and in CLAUDE.md):

- copies go under a short root;
- a file that cannot be packed is pending and rides with the next pass;
- a folder that cannot be read is named;
- `"resend": true` sends again what an older pass miscounted.

The full copy is restarted with `"since": "2000-01-01T00:00:00Z", "resend":
true`. That resends the parts already sent; the server keeps those as
"already the same".

**alpha-serv-01 still has to collect what arrives.** Taildrop holds the files
until `tailscale file get` runs there, which its own autopilot (with
`autofix.dataSync`, peer `desktop-41hplcn`) would do every pass.

## Using it for a different machine

The same jobs work for any primary. That is how alpha-server-01 is set up
above.

1. Queue `standby-install` with `"primary": "<server>"` and
   `"primaryUrl": "http://<server tailnet ip>:8001/health"`.
2. Stand the other machine down with `"primary": "<server>"`.

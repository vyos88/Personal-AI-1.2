# Master host repair: Laptop41

Laptop41 is Alpha's permanent main host. It runs the backend on `127.0.0.1:8001`,
the production frontend on `127.0.0.1:4173`, and the `cloudflared` connector that
publishes `alpha-ai.uk`. This page covers getting it back up and keeping it up.

## Run this, on Laptop41, as Administrator

```powershell
cd C:\services\alpha-tunnel          # wherever this checkout lives on the host
git pull --ff-only
powershell -ExecutionPolicy Bypass -File .\scripts\repair-alpha-host.ps1 -ReportOnly   # look first (changes nothing)
powershell -ExecutionPolicy Bypass -File .\scripts\repair-alpha-host.ps1               # repair
```

Undo the last repair:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\repair-alpha-host.ps1 -Rollback
```

Output goes to three places:

- the console;
- `C:\AlphaData\alpha-ops\logs\repair-<time>.log` (full transcript) and
  `evidence-<time>.json`;
- Alpha's coordination tunnel. Each step is posted as `laptop41-repair` through
  `scripts\alpha_coordination_tunnel.ps1 -Action Post`.

### What it changes, and what it will not touch

| Area | Changed | Never touched |
|---|---|---|
| Backend | boot task `Alpha Backend` (S4U: starts at boot, survives logout, stores no password) running the command line of the backend that was answering. It hands over and proves `/health` comes back, or puts the original back | the backend's code or `.env` |
| Frontend | stops a process **only** if it holds 4173 and does not serve Alpha. Rebuilds `dist` if it is older than the source (the old build is kept). Boot task `Alpha` via `start-alpha-at-boot.ps1` (`--host 127.0.0.1 --strictPort`) | `vite.config`, source |
| Old tasks | ones that start the same port are exported to XML, then **disabled** | nothing is deleted |
| cloudflared | delayed-auto start, restart-on-crash. The service is restarted **only if** the origin answered 3 checks in a row, the Internet is reachable, and the public hostname still returns 502/504/52x/530 | `config.yml`, credentials, DNS, WAF, Access. A SHA-256 of the config and credentials before and after is written to the evidence file |
| Power | AC sleep and AC hibernate set to never. The old values are kept for `-Rollback` | lid action: reported, with the command to change it |
| Self-heal | SYSTEM task `Alpha Self-Heal` every 2 minutes | — |
| Processes | the one above, and nothing else | nothing is uninstalled |

## Self-heal: `scripts/alpha-selfheal.mjs`

This runs one pass every two minutes. Each pass probes the backend, the frontend
(sending the `Host: alpha-ai.uk` header that cloudflared sends), the public
hostname and a control URL.

| Rule | Default |
|---|---|
| Repair only after consecutive failures | 2 passes (the public hostname: 3) |
| Cooldown after a repair | 5 minutes |
| Budget, per component | 3 repairs per rolling hour |
| Budget, all components | 12 repairs per day |
| When a budget runs out | it stops repairing, posts once to the coordination tunnel and exits 2 |
| Frontend ladder | restart, then roll `dist` back to `dist.last-good`. The failed build is kept as `dist.failed-<time>` |
| Backend ladder | restart: stop the wrapper tree and any node/python still holding the port, then start the task |
| Connector | restarted only when the origin was healthy on 2 passes in a row, the Internet is up, and the edge returns a connector code |
| Not restartable | Vite's `403 Blocked request` for the public host, and a missing `dist` with no snapshot. Both are reported with the fix, and no budget is spent on them |
| Log | `C:\AlphaData\alpha-ops\logs\selfheal.jsonl`, one line per pass, rotated at 5 MB |

To check it, or to see what it would do without doing it:

```powershell
node scripts\alpha-selfheal.mjs --config C:\AlphaData\alpha-ops\selfheal.json --status
node scripts\alpha-selfheal.mjs --config C:\AlphaData\alpha-ops\selfheal.json --dry-run
```

To stop it: `Disable-ScheduledTask 'Alpha Self-Heal'`. The policy is covered by
`test/alpha-selfheal.test.js`, which uses real HTTP servers and a real `dist`
directory.

## Verification checklist

The script checks and records these:

- backend `/health` returns 2xx;
- the local frontend returns 200 with the app root, and still does when the
  request carries the tunnel's `Host` header;
- `/login`, `/chat`, `/decks`, `/brain`, `/agents`, `/network` and `/crown` are
  served (SPA fallback);
- the public hostname answers, where 302/401/403 means Cloudflare Access is in
  front of a working tunnel;
- the attached agents, including Jack's laptop.

A person has to check these, because a script cannot sign in through Cloudflare
Access:

- [ ] `https://alpha-ai.uk` → Access login → Alpha login
- [ ] Chat: send a message, get an answer
- [ ] Decks, Brain, Agents, Network Hub, Crown Panel each open without a red error
- [ ] Reboot Laptop41, don't log in, and wait 3 minutes. The site must load from a phone.
- [ ] Log out of Windows. The site must still load.

## Jack's laptop: music worker

Jack's laptop joins as an ordinary agent over the Alpha tunnel. It dials out, so
it needs no open port. Run these on Jack's laptop:

```powershell
git clone <this repo> C:\services\alpha-tunnel; cd C:\services\alpha-tunnel
node scripts\setup-agent.mjs        # name it jack-music when asked
node scripts\keep-agent.mjs         # or install it as the alpha-keeper service, see ALWAYS_ON.md
```

Queue music work to it by name, with `--agent jack-music`, so it never lands on
the host. No `music.*` handler exists yet. Until one does, the laptop lends
`echo`/`sysinfo`/`grow`/`memory.store` like any worker. The handler is the first
Music Creator recommendation in [ALPHA_AUDIT.md](ALPHA_AUDIT.md).

## Three immediate reliability improvements (after the repair)

1. **Bounded self-heal every 2 minutes.** It keeps a streak, a cooldown and an
   hourly and daily budget, rolls `dist` back automatically, and posts to the
   coordination tunnel. A crash loop becomes one message to a person, not a
   silent restart storm.
2. **The backend gets a boot task, proven by handover.** `start-alpha-at-boot.ps1`
   only ever started the frontend, so after every reboot the site loaded and
   Chat failed. The backend now starts at boot under S4U, whether or not anyone
   logs in, and the repair proves this before it finishes.
3. **The origin is checked the way the tunnel sees it.** Health checks send
   `Host: alpha-ai.uk`, so Vite's `Blocked request` (a 403 that surfaces as a
   broken site) is caught at the origin. cloudflared is restarted only once the
   origin is proven healthy, and never for an origin fault.

## Remaining risks

- **Nothing here has run on Laptop41 yet.** This was written from a cloud
  container that cannot reach the host or its tailnet, and could not load
  `alpha-ai.uk` either (the container's egress proxy refused it). The
  PowerShell has not been executed on Windows; the Node self-heal has, under
  test, on Linux. Run `-ReportOnly` first.
- **Backend adoption needs a live backend.** If `/health` is down when the
  script runs and no task knows the command, pass `-BackendExe`/`-BackendArgs`/
  `-BackendDir`. The working directory is inferred from `module:app`; if the
  handover fails, the script restarts the original and disables the task.
- **S4U has no network credentials.** That is fine for localhost and outbound
  HTTPS, but a backend reading from a network share will fail under it.
- **Laptop41 is a laptop.** The lid, the battery and Windows Update reboots
  still end the fleet (see `COORDINATOR_MIGRATION.md`).
- **Alpha's backend and most of its frontend are not in version control.** A
  bad edit on the host has no history to roll back to, apart from the `dist`
  snapshot this adds.
- **Self-heal cannot fix configuration.** Ingress pointing at the wrong port,
  Vite's `allowedHosts` and an expired tunnel credential all come back as
  reports, not repairs. That is by design.

## Recovering Alpha from the USB backup

The Lexar drive (`F:\AlphaBackup`) holds `alpha-all-refs.bundle`,
`alpha-data.tar` and `RESTORE.md`. To restore it into an isolated folder on E:
and test it next to the live install, run this as Administrator on Laptop41:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\recover-alpha-from-usb.ps1
# stop the recovered copy afterwards
powershell -ExecutionPolicy Bypass -File .\scripts\recover-alpha-from-usb.ps1 -StopRecovered
```

What the script does:

- **Reads F: and never writes to it.** It copies the backup to
  `E:\AlphaRecovery\<time>\source` and checks the SHA-256 of every file on
  both sides.
- **Leaves the live install alone.** The recovered copy runs on ports 8011 and
  4183, so the live 8001 and 4173 keep serving. A recovery-only Vite config
  points the recovered frontend's API proxy at 8011.
- **Refuses to start the recovered backend if its configuration names
  `C:\AlphaData\Alpha`.** A backend configured that way would write into the
  live data.
- **Stops only stale launch attempts:** processes that never bound a port,
  older than 5 minutes, and not serving (or the parent or child of anything
  serving) 8001, 4173 or 8787.
- **Checks the tarball before extracting it.** It lists `alpha-data.tar` first
  and refuses to extract if any entry has an absolute path or `..`.
- **Checks the Crown panel.** It finds the CrowPanel's USB-serial bridge by
  VID/PID and reports which COM port it is on now. Pass `-PanelPort COM3` to
  make a renumbered port a blocker. Then it sends the sketch
  `{"cmd":"status"}` and requires a reply showing WiFi, a coordinator host and
  a key, plus that coordinator answering `/healthz`. Opening the port may
  restart the board once; `-NoPanelProbe` checks presence only.
- **Writes evidence to the recovery folder:** `evidence.json`, `sha256.json`,
  `recovery.log`, and the backend and frontend logs.

**If it stops at `=== 3. Copy and verify ===`** with no disk activity, check
the window title first. If it starts with `Select`, the window is in QuickEdit
mode and Windows has paused the script; press Esc. The script now turns
QuickEdit off for itself. Otherwise, confirm the copy is complete before doing
anything: compare the size of `F:\AlphaBackup` with `<run>\source`, and check
whether `robocopy.exe` is still running. Then stop the stalled run with Ctrl+C
and continue it in the same folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\recover-alpha-from-usb.ps1 -Resume E:\AlphaRecovery\<time>
```

robocopy skips every file already copied with the same size and time, and the
SHA-256 pass still checks all of them. The copy logs each file to
`robocopy.log`, and hashing prints each file as it starts. `-Resume` refuses to
start while the old run or its robocopy is still alive, and it refuses to start
once that folder has a `checkout`.

It does not promote the recovered copy. Replace the live install only after two
things are true:

- the script's verdict shows no blockers;
- someone has signed in at `http://127.0.0.1:4183`, sent a Chat message, and
  opened Decks, Brain and Agents.

Rename the live folder aside when you promote, never delete it. Then point the
boot tasks at the new folder: re-run `repair-alpha-host.ps1 -AlphaRoot <new>`.

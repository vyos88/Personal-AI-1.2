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
- **Writes evidence to the recovery folder:** `evidence.json`, `sha256.json`,
  `recovery.log`, and the backend and frontend logs.

It does not promote the recovered copy. Replace the live install only after two
things are true:

- the script's verdict shows no blockers;
- someone has signed in at `http://127.0.0.1:4183`, sent a Chat message, and
  opened Decks, Brain and Agents.

### Promoting the recovered copy

**Which folder is Alpha.** In the restored repository (the `alpha-full`
import), Alpha is at `BuildArtifacts\installers\Alpha-Full\software`, the
folder holding `frontend` and `backend`. That is the default `-AppSubdir` of
both `recover-alpha-from-usb.ps1` and `promote-recovered-alpha.ps1`. The
recovery builds and tests that folder, and the promotion puts its contents at
`C:\AlphaData\Alpha`, which is the layout `start-alpha-at-boot.ps1` and
`repair-alpha-host.ps1` expect. Its siblings (`Alpha-Full\scripts`, the
`Alpha-Server` copy) are not promoted. Without `scripts\alpha_coordination_tunnel.ps1`
inside the root, repair and self-heal still run but post nothing to the
tunnel. Pass `-AppSubdir ''` to both scripts when a checkout has Alpha at its
top.

`scripts/promote-recovered-alpha.ps1` does the promotion. It puts the recovered
copy at the **same path**, `C:\AlphaData\Alpha`, rather than pointing the tasks
at a new one. Everything that already names that path keeps working unchanged:

- the boot wrappers in `C:\ProgramData\AlphaBoot`;
- the self-heal config;
- cloudflared's ingress;
- the recovered configuration's own references to it.

The recovery refused to run from E: precisely because of those references.

Run it once the recovery has printed its verdict, from an Administrator
PowerShell in this checkout:

```powershell
# 1. Read only. It changes nothing and is safe while the site is serving.
powershell -ExecutionPolicy Bypass -File .\scripts\promote-recovered-alpha.ps1
```

This first step exits 2 without looking at anything while
`recover-alpha-from-usb.ps1` is still running. Otherwise it checks:

- **the recovery's own evidence:** no blockers, and the frontend served
  with `Host: alpha-ai.uk`;
- **the layout the boot tasks need:** `AppShell.tsx`, `package.json`, the
  npm script, `dist`, `vite`, and the backend module at the same relative
  path as the live one;
- **versions:** `ALPHA_VERSION` and git on both sides, plus migrations that
  exist only in live;
- **data:** every file from `alpha-data.tar` is compared with its live
  counterpart;
- **config:** recovered config that names `E:\AlphaRecovery`;
- **free space.**

It ends with `READY` and the exact next command, or with the list of
blockers.

**Data written since the backup is the one decision it will not make for
you.** If the live install has data files newer than the backup, or files the
backup does not have, promotion is refused until you pick one:

- `-CarryLiveData` copies those live files over the recovered ones, so live
  wins;
- `-AcceptDataRollback` serves the backup's data. The live files stay in
  the renamed folder.

Before carrying data forward, check the migrations line in the report: data
written by newer code may not load in older code.

```powershell
# 2. After signing in at http://127.0.0.1:4183, sending one Chat message and
#    opening Decks, Brain and Agents on the recovered copy:
powershell -ExecutionPolicy Bypass -File .\scripts\promote-recovered-alpha.ps1 -Promote -HumanChecked -CarryLiveData

# Undo:
powershell -ExecutionPolicy Bypass -File .\scripts\promote-recovered-alpha.ps1 -Rollback
```

`-Promote` works in this order, with 2-5 minutes of downtime:

1. Disables self-heal, so nothing restarts in the middle of the swap.
2. Stops the recovered copy, then the live tasks and every process inside
   `C:\AlphaData\Alpha`.
3. Compares the data again, now that the backend can no longer write.
4. Renames the live folder to `Alpha.pre-promote-<time>`. That folder is the
   rollback.
5. Copies the recovered checkout in, leaving out the 8011-only
   `vite.recovery.config.mjs`.
6. Recreates the backend's venv in place, because a venv cannot be moved.
7. Starts the backend.
8. Runs `repair-alpha-host.ps1 -AlphaRoot C:\AlphaData\Alpha`, which adopts
   the backend and proves the handover, re-registers `Alpha`, snapshots
   `dist.last-good` and re-enables self-heal.
9. Verifies. If the backend, the frontend, or the frontend under the public
   Host header is not serving, it rolls itself back.

Nothing is deleted. Evidence goes to
`C:\AlphaData\alpha-ops\logs\promote-<time>.log` and `promotion-<time>.json`.

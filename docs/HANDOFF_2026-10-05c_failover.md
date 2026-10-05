# Handoff — 2026-10-05 (c): automatic failover between Host and Worker1

The owner asked for this on 2026-10-05: if one laptop is not available, the
other takes over as host, and switching hosts gets faster in the future. This
file sets that up for the coordinator, in order, per laptop. Nothing in it has
been run on the laptops yet. The behaviour itself was tested in a cloud session
(see "Checked" at the end).

| | Host = laptop-gj8dfmlk (100.93.104.24) | Worker1 = Laptop41, desktop-41hplcn (100.69.243.25) |
|---|---|---|
| Normally | runs the coordinator and the `host` agent | runs Alpha, the `worker1` agent, and a **standby** that watches the Host |
| Host goes down | — | after about 2 minutes the standby starts a coordinator here; both agents move to it |
| Host comes back | coordinator answers again | after about 2 minutes of answers the standby stops its copy; the agents go home between tasks |

## How it works, and what it does not do

- **The standby is `scripts/standby-alpha.mjs`**, which is already in this repo.
  It is general: it probes a health URL, starts a pinned script after N misses,
  keeps it up, and stops it after N answers. Here it starts
  `src/host/index.js` instead of Alpha.
- **It does not promote when Worker1 itself is offline.** `--control-url`
  is checked first. If that also fails, the fault is on this laptop, and it
  stays put rather than creating a second coordinator.
- **Agents fail over by themselves.** `ALPHA_HOST_URL` takes several addresses,
  primary first (`src/agent/index.js`). An agent on a standby re-checks the
  primary while it holds no tasks, and goes home when the primary answers.
- **Keys must match on both sides.** The standby's coordinator can only accept
  keys it has. So Host sends its `auth.json` and `receipts.json` to Worker1
  every 10 minutes over Taildrop (Tailscale's own encrypted file transfer;
  nothing goes through GitHub or a chat).
  - **Issue and revoke keys on the Host only.** A key issued during an outage
    lives only in Worker1's copy, and the next sync after the Host returns
    overwrites it.
- **The queue does not move.** `tasks.json` is not synced, so no task can run
  twice. Tasks queued on the Host before it went down wait for the Host. Tasks
  sent during an outage run through Worker1's standby.
- **Alpha itself does not fail over yet.** Alpha runs only on Worker1, and its
  source is not in git (BACKLOG H2). If Worker1 is down, the coordinator on the
  Host keeps going, but Alpha and `alpha.coordination` are down until Worker1
  is back. Alpha failover onto the Host needs H2 first; the same standby script
  then runs Alpha there.

## Part A — on HOST (laptop-gj8dfmlk): send the store to Worker1 every 10 minutes

In an Administrator PowerShell:

```powershell
cd C:\services\alpha-tunnel
git pull --ff-only
tailscale file cp data\auth.json data\receipts.json desktop-41hplcn:
```

If the last line errors, Taildrop is off for this tailnet: turn it on in the
Tailscale admin console (Settings → File sharing). Then schedule it:

```powershell
$a = New-ScheduledTaskAction -Execute 'tailscale.exe' -Argument 'file cp C:\services\alpha-tunnel\data\auth.json C:\services\alpha-tunnel\data\receipts.json desktop-41hplcn:'
$t = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 10)
$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName 'Alpha store to standby' -Action $a -Trigger $t -Principal $p -Settings $s -Force
```

The Host's own agent learns the standby address too. In `.env.agent`:

```ini
ALPHA_HOST_URL=http://127.0.0.1:8787,http://100.69.243.25:8787
```

Then restart that agent: `Stop-ScheduledTask 'alpha-tunnel agent'; Start-ScheduledTask 'alpha-tunnel agent'`.

### ➡️ Switch to Worker1

## Part B — on WORKER1 (Laptop41): receive the store, and run the standby

### B1. Receive the store

Save this as `C:\AlphaData\alpha-ops\standby-store.ps1`:

```powershell
# Takes the Host's auth.json and receipts.json from Taildrop
# (docs/HANDOFF_2026-10-05c_failover.md, B1). Copies them into data\ only while
# no coordinator runs here: a promoted standby owns its own store.
$inbox = 'C:\AlphaData\alpha-ops\standby-store'
New-Item -ItemType Directory -Force $inbox | Out-Null
& tailscale.exe file get --conflict=overwrite $inbox 2>&1 | Out-Null
$local = $null
try { $local = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:8787/healthz } catch { }
if ($local) { return }
foreach ($f in 'auth.json', 'receipts.json') {
  $src = Join-Path $inbox $f
  if (Test-Path $src) { Copy-Item $src (Join-Path 'C:\services\alpha-tunnel\data' $f) -Force }
}
"$((Get-Date).ToString('s')) store synced" | Add-Content (Join-Path $inbox 'sync.log')
```

Schedule it every 10 minutes, as you (Taildrop hands files to the signed-in user):

```powershell
$a = New-ScheduledTaskAction -Execute powershell.exe -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\AlphaData\alpha-ops\standby-store.ps1'
$t = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 10)
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName 'Alpha standby store' -Action $a -Trigger $t -Settings $s -Force
Start-ScheduledTask 'Alpha standby store'
Start-Sleep 20; Get-Content C:\AlphaData\alpha-ops\standby-store\sync.log -Tail 1
```

If your Tailscale version rejects `--conflict=overwrite`, update Tailscale. Do
not drop the flag: without it, a second copy is saved beside the first as
`auth (1).json`, and the old one is used.

### B2. Coordinator settings for when the standby runs

Add these to `C:\services\alpha-tunnel\.env`, and leave `ALPHA_HOST_URL`
pointing at the Host. Only a coordinator reads these, and on Worker1 only the
standby starts one:

```ini
ALPHA_HOST_PORT=8787
ALPHA_HOST_BIND=127.0.0.1,100.69.243.25
ALPHA_AUTH_STORE=./data/auth.json
```

Never add `ALPHA_BOOTSTRAP_TOKEN` here.

### B3. The worker1 agent learns the standby address

In `.env.agent`:

```ini
ALPHA_HOST_URL=http://100.93.104.24:8787,http://127.0.0.1:8787
```

Then `Restart-Service alpha-agent`.

### B4. Run the standby, always

```powershell
$node = (Get-Command node).Source
$standbyArgs = '"C:\services\alpha-tunnel\scripts\standby-alpha.mjs" --root C:\services\alpha-tunnel --start src/host/index.js --probe-url http://100.93.104.24:8787/healthz --local-url http://127.0.0.1:8787/healthz --control-url https://github.com --probe-ms 30000 --failures 4 --recover 4'
$a = New-ScheduledTaskAction -Execute $node -Argument $standbyArgs -WorkingDirectory 'C:\services\alpha-tunnel'
$t = New-ScheduledTaskTrigger -AtStartup
$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'Alpha coordinator standby' -Action $a -Trigger $t -Principal $p -Settings $s -Force
Start-ScheduledTask 'Alpha coordinator standby'
```

- With `--probe-ms 30000 --failures 4`, the standby promotes after about 2
  minutes of Host silence. With `--recover 4`, it demotes after about 2
  minutes of Host answers.
- `https://github.com` is the control URL: if Worker1 cannot reach it either,
  Worker1 is the one offline.
- The disabled `alpha-coordinator` task and the moved Startup `.vbs` stay as
  they are. The standby is the only thing allowed to start a coordinator on
  Worker1.

## Part C — the drill (do it once, so the first real outage is not the test)

1. On the **Host**, stop the coordinator:
   `Stop-ScheduledTask 'alpha-coordinator'`. Check it is down with
   `curl.exe -s -m 3 http://127.0.0.1:8787/healthz`, which should print
   nothing.
2. Wait 3 minutes. On **Worker1**:
   ```powershell
   curl.exe -s http://127.0.0.1:8787/healthz
   $env:ALPHA_HOST_URL = 'http://127.0.0.1:8787'; node src/admin/run.js agents
   ```
   The standby's coordinator should answer, and `agents` should list `worker1`
   and `host`. Both moved by themselves.
3. On the **Host**: `Start-ScheduledTask 'alpha-coordinator'`.
4. Wait 3 minutes. On **Worker1**, `curl.exe -s -m 3 http://127.0.0.1:8787/healthz`
   should print nothing (the standby stood down), and
   `Remove-Item Env:ALPHA_HOST_URL; node src/admin/run.js agents` lists both
   agents back on the Host.

**During a failover, three reports change, and all three are right:**
- The doctor's "split fleet" line on Worker1: a coordinator is listening
  there, because the Host is down.
- The peer reports: "coordinator NOT answering". They ask the address in
  `.env`, which is the Host.
- Alpha's activity watcher: "Alpha served by Worker1" is unchanged, because
  Alpha never moved.

## A planned switch (the "faster in the future" part)

To take the Host down on purpose, for an update or a reboot: stop
`alpha-coordinator` on it. Worker1 covers within about 2 minutes, and gives the
role back when the Host returns. Nothing else changes, because the store is
already on Worker1.

To swap the roles for good, with Worker1 as the permanent Host: that is a
real move, as in `HANDOFF_2026-10-05b_host-move.md`. It is now much shorter,
because the store and the addresses are already in place on both sides. Ask a
session to write it up when it is wanted.

## Checked (cloud session, 2026-10-05)

`standby-alpha.mjs --start src/host/index.js` on a scratch copy of this repo,
with 1-second probes:

- Primary down, control URL up: it **promoted**, and the local coordinator
  answered `/healthz` within seconds.
- Primary back: it **demoted**, and the local coordinator stopped answering.
- Control URL down: it logged "control URL is unreachable too; this machine is
  the one offline, staying put", and **did not promote**.

Not checked: Taildrop between the two laptops, the scheduled tasks above, or a
real agent moving over (that is the drill in Part C).

# Leaving a laptop on the job

Two long-running processes, both meant to be started once and forgotten:

| Command | What it keeps going |
|---|---|
| `node scripts/keep-agent.mjs` | an agent, always here and always on the current release |
| `node scripts/standby-alpha.mjs` | Alpha itself, but only while the main host is not answering |

### Leaving a laptop working, across reboots

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-always-on.ps1 `
  -AlphaRoot C:\alpha -CloudflareTunnel alpha-home -ControlUrl http://192.168.1.1/
```

Two scheduled tasks at logon: the agent keeper, so this machine takes work from
the host whenever it is on, and the standby, so Alpha runs here — with the
public tunnel beside it — while the host is not answering. Without `-AlphaRoot`
it installs the agent only, which is the right thing on a machine that lends
capacity and nothing else.

**The tunnel moves with Alpha.** `standby-alpha.mjs --cloudflared <tunnel>` runs
the named tunnel for exactly as long as this machine is the one serving. A
tunnel left up beside a demoted Alpha is a public address pointing at nothing,
and two machines running the same tunnel is worse again. A name, never
`--token`: cloudflared reads the credential from its own configuration here,
and an argv is readable by every process on the box.

### Which script is which

Four scripts now touch "is this laptop still doing its job", and they are not
alternatives to each other so much as different lengths of the same rope:

| | Runs | Owns the agent process | Leaves a record |
|---|---|---|---|
| `self-update.mjs` | one pass, from a scheduler | no — exits 10 to ask | no |
| `watchdog.mjs` | one pass, from a scheduler | only with `--restart-command` | one JSON line per run |
| `install-watch-task.ps1` | once, to put the above on a timer | no | the task it creates |
| `install-always-on.ps1` | once, to start the two below at logon | no | the tasks it creates |
| `keep-agent.mjs` | forever | yes | its log |
| `standby-alpha.mjs` | forever | no — owns *Alpha* instead | its log |

Run the keeper **or** the scheduled pair, not both halves of both: the keeper
already pulls and restarts, so a `watchdog.mjs --restart-command` beside it is
two things fighting over one worker. The combination worth having is the keeper
plus `watchdog.mjs --no-update` on a timer — the watchdog then only asks the
*host* whether this machine is attached and writes down the answer, which is the
one question a process on the laptop cannot answer about itself.

They are separate processes on purpose. The first is about lending this machine
to the fleet; the second is about the household still having an Alpha when the
host is off. A laptop can run either, or both.

---

## 1. Keep an agent on this machine

```bash
node scripts/keep-agent.mjs
```

That is the whole of it. It starts the agent, restarts it if it dies, checks
this checkout for a new release every three hours, fast-forwards it when there
is one, and restarts the agent onto the new code.

### Why this can restart the agent when `self-update.mjs` will not

`scripts/self-update.mjs` pulls and then exits 10 to *ask* for a restart, and
[AUTO_UPDATE.md](AUTO_UPDATE.md) spends a section on why: a script a scheduler
runs does not own the agent process, and which service to bounce is the
machine's business. The keeper owns the agent — it started it — so it can do
both halves, and the machine needs no NSSM service, no systemd unit and no
scheduled task to stay current.

The three rules still hold, because it runs the same script to do the pulling:
fast-forward only, never over a dirty checkout, and nothing it did not start
gets restarted. A refused update stops the *update*, not the agent — the worker
goes on running what it has and the next tick tries again.

### Options

| Flag | Default | Meaning |
|---|---|---|
| `--repo <path>` | this checkout | the working copy to keep current, and the one the agent is run from |
| `--interval-ms <ms>` | `10800000` (3h) | how often to look for a release |
| `--remote <name>` | `origin` | remote to fetch from |
| `--also-repo <path>` | — | another checkout to fast-forward. Repeatable. Nothing is restarted for it |
| `--stop-timeout-ms <ms>` | `20000` | how long a restart waits for the agent to drain before killing it |

### What it will not do

- **Come back from a stand-down.** An agent that exits having been told
  `410 stand_down` is not a crash — another process on this machine holds its
  registration. Respawning is the eviction loop the stand-down exists to end,
  so the keeper stops with it. Start one keeper per machine.
- **Kill an agent mid-task.** A restart asks over the IPC channel and waits out
  the drain, so results already in flight are reported before the worker leaves.
  That message exists because Windows has no signal for "stop cleanly":
  `SIGTERM` there is a kill, and a killed agent costs the host a whole lease and
  a re-run of work that had in fact succeeded.
- **Restart itself.** The agent is respawned from the updated checkout; the
  keeper is still running the code it started with. When an update touches the
  keeper it says so — restart it when convenient.

### Starting it at boot

A keeper that a reboot took away is not keeping anything.

**Windows**, as a service, which is how the agent is already run there:

```powershell
nssm install alpha-keeper "C:\Program Files\nodejs\node.exe" "<tunnel>\scripts\keep-agent.mjs"
nssm set alpha-keeper AppDirectory <tunnel>
nssm start alpha-keeper
```

Run the keeper *instead of* a service on the agent itself, not beside it — two
agents from one machine evict each other by design, and the survivor is
whichever registered last. If `alpha-agent` is already installed as a service,
remove it (`nssm remove alpha-agent confirm`) when you install the keeper.

**Linux** (`/etc/systemd/system/alpha-keeper.service`):

```ini
[Service]
WorkingDirectory=/opt/alpha-tunnel
ExecStart=/usr/bin/node scripts/keep-agent.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

The keeper replaces both the `alpha-agent` service and the
`alpha-self-update.timer` from AUTO_UPDATE.md. Disable those if they are there.

And keep the machine awake — the power settings section of
[AUTO_UPDATE.md](AUTO_UPDATE.md#keeping-a-worker-laptop-awake) is unchanged and
still the part of "always on" that is not about software at all.

---

## 2. Run Alpha here when the main host is not answering

```bash
node scripts/standby-alpha.mjs --root C:\AlphaData\Alpha --npm-script dev `
  --control-url https://example.com
```

It probes the main host every 30 seconds. After four consecutive misses it
starts Alpha on this machine and keeps it up; when the host answers again it
stops it. `ALPHA_APP_ROOT` with either `ALPHA_APP_NPM_SCRIPT` or
`ALPHA_APP_START` in `.env.agent` says the same thing without the flags.

### This is a daemon, not a handler, and that is the point

Every other thing in this repository that acts on a machine arrives as a task:
the host decides, an agent does it. Failover cannot work that way — **the
coordinator is the thing that is down.** A standby driven over the tunnel would
be a standby that only starts when it is not needed. So it runs locally, decides
locally, and takes nothing from the network but "did the endpoint answer".

It is also why it is not an `alpha.*` handler: nothing reachable over the tunnel
can ask this machine to start a program.

### You have to tell it how Alpha starts

There is no default, and two ways to say it. Both are checked at startup rather
than at the moment of the outage, and neither is a command string:

- **`--npm-script dev`** — runs `npm run dev` in the root. The root's
  `package.json` is the allowlist: a name that is not a script there is refused,
  and the run is `npm` with the argv `['run', '<name>']`, no shell. On Windows
  it spawns `npm.cmd`, because `npm` there is a shim that cannot be spawned
  without one (override with `ALPHA_NPM`).
- **`--start scripts\start-alpha.ps1`** — a script pinned the same way the
  coordination handler's is: relative to `--root`, no traversal, proven to
  resolve inside the root, run through an interpreter chosen by its extension
  (`.ps1`, `.cmd`, `.bat`, `.js`, `.mjs`, `.sh`) as an argv array.

**Stopping stops what Alpha started, not just Alpha.** `npm run dev` is a
wrapper — the server is its grandchild — so killing only the process that was
spawned leaves the server holding its port, and the next start fails to bind.
On Linux and macOS the child is given its own process group and the group is
signalled; on Windows `taskkill /T` walks the tree. There is a test that starts
a real `npm run dev`, stops it, and fails if the grandchild is still beating.

One consequence of that process group: if the standby is `kill -9`'d, Alpha
outlives it. Stop it with Ctrl-C or SIGTERM, which is what a service manager
sends anyway.

### Two Alphas is worse than the outage

This machine cannot tell "the host is down" from "I cannot reach the host". If
the laptop's link drops, promoting gives the household two live Alphas. Two
mitigations, neither perfect and both deliberate:

- **`--control-url`** — something that is up whenever this machine's network is:
  another tailnet machine, or any public URL. If the control is unreachable too,
  the fault is here, and the standby stays put. **Set it.** It is the difference
  between failover and a second Alpha every time the Wi-Fi hiccups.
- **Demotion is on by default**, so a split heals as soon as the link does. Use
  `--stay` only where a person will decide when to hand back.

### Options

| Flag | Default | Meaning |
|---|---|---|
| `--root <dir>` | `ALPHA_APP_ROOT` | where Alpha lives on this machine |
| `--start <script>` | `ALPHA_APP_START` | start script, relative to the root |
| `--npm-script <name>` | `ALPHA_APP_NPM_SCRIPT` | `npm run <name>` in the root, instead of `--start` |
| `--probe-url <url>` | `ALPHA_HOST_URL` + `/healthz` | the main host |
| `--control-url <url>` | — | proof this machine's own network is up |
| `--local-url <url>` | — | health endpoint of the Alpha *this* machine started |
| `--probe-ms <ms>` | `30000` | how often to look |
| `--failures <n>` | `4` | consecutive misses before taking over |
| `--recover <n>` | `4` | consecutive answers before handing back |
| `--local-failures <n>` | `3` | consecutive local health misses before restarting Alpha |
| `--local-grace-ms <ms>` | `60000` | how long a freshly started Alpha has before its health counts |
| `--stay` | off | do not hand back |

`--local-url` is what makes "alive" mean "serving". A process supervisor on its
own calls a hung server healthy forever; with a health endpoint to check, a copy
that is up and answering 503 gets restarted.

### Before this is worth running

**Alpha's backend is not in version control** — see the last section of
[AUTO_UPDATE.md](AUTO_UPDATE.md). The laptop's copy of Alpha comes from
`scripts/sync-alpha.ps1`, so a standby is a standby of whatever was last copied
onto it. A three-week-old copy will start, and will be three weeks old.

That is an argument for getting Alpha into the repo (the audit-then-push path in
AUTO_UPDATE.md), not against the standby: until then, run
`sync-alpha.ps1 -Mode Send` after anything worth failing over to, and keep
`--also-repo` pointed at the Alpha checkout once there is one.

Configuration is the other half. `.env` is deliberately never copied by
`sync-alpha.ps1`, so the laptop's Alpha needs its own — pointed at this
machine's hardware, with this machine's credentials. A standby that has never
been started by hand once is an untested standby.

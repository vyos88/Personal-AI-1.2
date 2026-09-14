# Leaving a laptop on the job

Two long-running processes, both meant to be started once and forgotten:

| Command | What it keeps going |
|---|---|
| `node scripts/keep-agent.mjs` | an agent, always here and always on the current release |
| `node scripts/standby-alpha.mjs` | Alpha itself, but only while the main host is not answering |

### Which script is which

Four scripts now touch "is this laptop still doing its job", and they are not
alternatives to each other so much as different lengths of the same rope:

| | Runs | Owns the agent process | Leaves a record |
|---|---|---|---|
| `self-update.mjs` | one pass, from a scheduler | no — exits 10 to ask | no |
| `watchdog.mjs` | one pass, from a scheduler | only with `--restart-command` | one JSON line per run |
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
node scripts/standby-alpha.mjs --root C:\AlphaData\Alpha --start scripts\start-alpha.ps1
```

It probes the main host every 30 seconds. After four consecutive misses it
starts Alpha on this machine and keeps it up; when the host answers again it
stops it. `ALPHA_APP_ROOT` and `ALPHA_APP_START` in `.env.agent` say the same
thing without the flags.

### This is a daemon, not a handler, and that is the point

Every other thing in this repository that acts on a machine arrives as a task:
the host decides, an agent does it. Failover cannot work that way — **the
coordinator is the thing that is down.** A standby driven over the tunnel would
be a standby that only starts when it is not needed. So it runs locally, decides
locally, and takes nothing from the network but "did the endpoint answer".

It is also why it is not an `alpha.*` handler: nothing reachable over the tunnel
can ask this machine to start a program.

### You have to tell it how Alpha starts

There is no default, and the script is pinned the same way the coordination
handler's is: **relative to `--root`, no traversal, proven to resolve inside the
root, run through an interpreter chosen by its extension** (`.ps1`, `.cmd`,
`.bat`, `.js`, `.mjs`, `.sh`) **as an argv array, never a shell string.** It
refuses at startup rather than at the moment of the outage if the script is not
there.

Write the start script so it *becomes* the server rather than launching one and
returning — a wrapper that exits immediately looks to the supervisor like Alpha
crashing, and stopping the wrapper will not stop what it spawned.

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

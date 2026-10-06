# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`alpha-tunnel` — a coordinator (**host**) and worker (**agent**) that let the
Alpha host run tasks on other machines, with accounts behind it. Its reason for
existing is the `alpha.coordination` handler: it drives Alpha's
`scripts/alpha_coordination_tunnel.ps1` by queued task, so a remote actor can
claim paths and post receipts without a shell on the Alpha box.

**No runtime dependencies.** Node standard library only, Node >= 20. There is no
build step, no bundler, no lint config. Do not add a dependency without a
specific reason — the whole thing is designed to be cloned onto a machine and
run with nothing but `node`.

## Commands

```bash
npm test                                   # all suites
node --test test/auth.test.js              # one suite
node --test --test-name-pattern="revoke"   # one test by name

npm run host          # coordinator (listens)
npm run agent         # worker (dials out)
npm run admin -- <args>
```

On the Alpha host (Windows), PowerShell's execution policy blocks `npm.ps1`, so
everything there is invoked as `node src/host/index.js`, `node
src/admin/run.js <args>` and so on. Keep both forms working; docs use the
`node` form.

## Architecture

**All connections are outbound from the agent.** The agent long-polls
`GET /agent/:id/tasks/next` and never listens, so a worker needs no open port
and no inbound firewall rule. This shapes everything else — do not add a design
that requires reaching *into* an agent.

Three planes share one HTTP server (`src/host/server.js`):

| Plane | Entry | Notes |
|---|---|---|
| Work | `/tasks`, `/agent/*` | queue + registry, both in memory |
| Access | `/invites`, `/users`, `/keys`, `/auth/login` | persisted to `ALPHA_AUTH_STORE` |
| Health | `/healthz` | the only unauthenticated GET |

**Tasks are leased, not pushed.** `src/host/queue.js` hands a task to an agent
with a lease (`DEFAULT_LEASE_MS`, 60s). If the agent dies, the lease expires and
the sweeper requeues it up to `maxAttempts`. A result from an agent that no
longer holds the lease is rejected with 409 — that is deliberate, so a slow
straggler cannot overwrite the answer from the agent that owns the work.

**The queue survives a restart; the registry does not.** The Alpha host is
restarted routinely, and a queue that emptied with it made the Music Creator
tell people "the tunnel no longer remembers this track". `src/host/journal.js`
copies the queue to `ALPHA_TASK_JOURNAL` (default `tasks.json` beside the auth
store, so `./data/tasks.json`; `off` keeps nothing) on every change, and
`queue.restore()` takes it back before the first request is served. Four things it rests on:

- **The Map is still the queue.** The journal is a snapshot written through the
  queue's `onChange` seam, coalesced so a burst of changes is one write, and
  write-then-rename like the auth store. Being a snapshot is what bounds it:
  the file holds exactly what the queue holds, and finished tasks leave it on
  the same retention (`FINISHED_TASK_RETENTION_MS`, `MAX_FINISHED_TASKS`) they
  leave the queue on. There is no log to compact.
- **A leased task comes back queued, its attempt spent** — the lease-expiry
  rule, applied early. Its agent's registration died with the old process, so
  anything it reports gets the existing 410 (unknown id) or 409 (not leased to
  it). Waiting out the old lease would gain nothing: nothing could complete it.
  One with no attempts left fails with `coordinator_restarted`, and gets its
  receipt; the restore runs after the receipt ledger loads so that receipt is
  not overwritten.
- **Bulk does not reach disk.** Queued tasks keep their payload whole (they
  cannot run without it). A finished task keeps its result under
  `MAX_KEPT_BYTES` (8 KB); over it, only what a receipt keeps — `recipe`,
  `outputs`, `stats` — marked `resultTrimmed`. An `alpha.music.audio` slice is
  ~700 KB of base64 and the whole file is rewritten per change.
- **A task whose payload names a credential is never written.** `alpha.panel`'s
  Provision carries a WiFi password; such a task is forgotten by a restart, as
  every task was before. `key` is deliberately not on the list — it is a
  musical key and a memstore key.

It follows the receipt ledger on the two choices that differ from AuthStore:
a corrupt journal is moved aside and the host starts empty rather than not at
all, and only a host with a persistent auth store keeps one, so a test host
never writes tasks the next real coordinator would pick up and run.

**Placement is memory-aware.** `src/host/registry.js` doubles as an admission
controller: a task with `minMemoryMB` is only offered to an agent whose last
memory report can cover it, and that much is held against the agent. Without the
hold, three 4 GB tasks would all land on the same 8 GB laptop in the same
instant. Two invariants keep the two sides of that accounting honest:

- **A hold covers a window, not a lease.** It exists to bridge placement to the
  moment the task's memory is actually taken, while the agent still reports it
  as free. Once a report shows the drop, `unmaterializedBytes()` credits it
  against the promise and the hold goes — subtracting both charged the machine
  twice and took a working laptop out of the running for the rest of the lease.
  The anchor (`reservedAgainstBytes`) is set by the *first* outstanding
  reservation and cleared when the last one is released; re-anchoring per
  admission would forget the drop the earlier tasks already accounted for.
  Known cost, pinned by a test: the host cannot see *why* memory moved, so a
  drop the machine's owner caused settles the hold too, and a second task can be
  placed against memory the first is still going to take. The agent's own check
  below is what catches that.
- **The machine gets the last word, and it costs nothing to use it.** The
  dispatched task carries `minMemoryMB`, and the agent re-reads its own memory
  before running anything. Every host-side guard is a guess from a report that
  ages; this is the only check made by the party that knows what the RAM is
  actually doing. A decline goes back through the result endpoint with
  `declined: true` and is **not** a failure — `queue.decline()` hands back the
  attempt `#assign` charged, or a task unlucky in placement would spend its
  retry budget on machines that never ran it. It cannot spin: the decline
  carries a fresh memory report that the host records *before* requeueing, and
  the agent's check is looser than `canAdmit` (it does not subtract outstanding
  holds), so an agent can only decline work a current reading would not have
  offered it. Declines are **counted and nothing more** — `task.declines`, shown
  as `DECLINED` by `alpha-admin tasks`. No logic reads it, and bounding declines
  would break the case it exists to make legible: a task waiting for a machine
  with room is supposed to wait, and looks exactly like one an agent keeps
  refusing — both queued, both with `attempts` flat.
- **What a machine lends is said as a share of it, not only in megabytes.**
  `ALPHA_AGENT_MEMORY_RESERVE_PERCENT` is a reserve as a percentage of total
  RAM, and the larger of it and `..._RESERVE_MB` applies. The MB figure cannot
  survive `.env.agent` being copied — 512 MB is a tenth of one laptop and a
  thirty-second of another, so one file gives two machines two different
  bargains. The percentage is of *total*, not of free: "keep a tenth of this
  laptop for its owner" is a claim about the machine, and a share of whatever is
  free right now shrinks exactly when the owner needs it. 100 is legal and means
  "lend nothing" — a machine present for `--agent`-pinned work only.
  `docs/FLEET.md` is the per-machine version of this.
- **RAM a handler holds for itself is never also offered to the host.** A
  handler may export `committedBytes()`; `HandlerRegistry.committedBytes()` sums
  it and `memorySnapshot()` takes it off the offer alongside the reserve.
  `memory.store` is the one that does — its *unused* budget only, since what it
  already holds is real heap and has left `freeBytes` on its own.

**An agent may be given more than one coordinator, and comes home by itself.**
`ALPHA_HOST_URL` takes a comma-separated list, primary first: the agent
registers with the first that answers, which is what makes
`scripts/standby-alpha.mjs` worth running — a laptop running Alpha while the
host is off is no use if every worker still dials the machine that is not
there. Three things hold it together, all tested in `test/failover.test.js`:

- **Registration always starts at the top of the list**, so there is no
  separate demotion to get wrong: the moment the primary answers, that is where
  the next registration goes.
- **A host that answers and refuses is not failed over from.** A 401 or a
  protocol mismatch will say the same thing on the standby, and moving on would
  bury the reason under a second, less useful error. Only an unreachable
  coordinator moves the agent along.
- **Coming home happens between tasks.** An agent on a standby checks the
  primary's `/healthz` (the one endpoint needing no credential) at most once a
  minute and only while holding nothing, then deregisters from the standby
  before re-registering — moving mid-task would leave a lease with a
  coordinator it had walked away from, and the work would be re-run elsewhere
  while it was still running here.

The panel follows the same shape from the other side: `host2` in its NVS is the
standby, it reads the primary first on every poll, and the footer says
`[standby]` while it is on the fallback. `docs/HOST_DOWN.md` is the runbook, and
the thing it exists to stop people losing an evening to: **the panel is not on
the tailnet.** It is on WiFi, so a `100.x` address does not exist for it and
both URLs it is given have to be reachable from that network.

**One registration per worker.** Agents dial out, so a worker that crashed and
came back is indistinguishable on the wire from a new machine: it registers,
gets a fresh id, and the dead registration goes on lending the same RAM and
covering the same capabilities until `AGENT_STALE_MS`. One laptop makes that
obvious; two make a fleet that reads as twice the machines and twice the memory.
So the agent reports an `instanceId` (`src/agent/identity.js`) and
`registry.register()` supersedes any live registration with the same id *and*
the same owner. Three things this rests on:

- **The identity is derived from the machine, never configured.** `.env.agent`
  is copied from one laptop to the next — that is how a second machine gets set
  up — so an id living in it would arrive already belonging to another machine
  and the two would evict each other forever. `ALPHA_AGENT_INSTANCE_ID` is the
  escape hatch for machines the fingerprint cannot separate. The name is mixed
  in, so two agents deliberately run on one machine stay two workers.
- **The newest process wins and the superseded one stands down.** The host
  answers its next request with `410 stand_down` rather than `reregister`, and
  the agent stops instead of registering back in — that direction is the whole
  reason this terminates. Anything that spawns the entrypoint beside a running
  agent must pass a throwaway `ALPHA_AGENT_INSTANCE_ID`; `setup-agent.mjs`'s
  attach check does, or proving the configuration would kill the agent already
  lending from that machine.
- **A dropped registration is never given work.** A long poll outlives the
  registration behind it, so `queue.#findWaiterFor` skips waiters the registry
  no longer `knows()`. Dispatching to one costs the task a whole lease: the
  only reply it can send is a 410.

Superseding does not touch the tasks the retired registration held — their
leases expire and the sweeper requeues them, exactly as for any dead agent.
Requeueing here instead would hand work to a second machine while the process
holding it was still aborting.

**The memory report rides the long poll, not just the heartbeat.** Both reports
travel on `GET /agent/:id/tasks/next` as query parameters, but for memory it is
load-bearing rather than an optimisation: load only ranks the agents that could
all take a task, while memory decides which of them may be given it at all. Read
off the heartbeat, admission ran against a figure up to a beat old and trusted
for `MEMORY_REPORT_STALE_MS`, so a laptop whose owner's build had just eaten 6 GB
still won a 4 GB task — and the agent has no memory check of its own to refuse
it. Keep `memoryReportToQuery`/`memoryReportFromQuery` in step with the load
pair; a partial or absent report is null, which leaves the last one standing.

**Placement is also load-aware, and that has two halves.** On the host,
`registry.rank()` orders candidate agents by leases already held, then by
reported CPU load, and `queue.#findWaiterFor` hands the task to the best of
them — it used to take the first parked waiter, so whichever laptop asked
first won every dispatch even when it was already pinned. On the agent,
`ALPHA_AGENT_MAX_LOAD` makes a saturated machine stop asking at all, because
the host can only rank the agents that are actually asking. Two invariants
hold that together:

- **Unknown load is never read as idle.** A missing, unmeasurable (Windows has
  no load average) or stale report ranks mid-scale. Reading it as zero would
  make the quietest *reporter* beat the quietest *machine*.
- **Standing aside is bounded.** After `LOAD_THROTTLE_MAX_MS` with nothing in
  hand, a loaded agent takes work anyway — otherwise a fleet that is busy
  everywhere would never run anything.

**A task may name its machine, and naming one narrows nothing else.**
`targetAgent` on a task restricts the candidates to agents registered under
that name; `registry.canAdmit` checks it first, so both `candidatesFor` and
`queue.#findWaiterFor` honour it for free. It exists for work that is only real
on one box — `alpha.render` needs the GPU and the generator beside it, and a
laptop running the handler from a copied configuration will take that task and
fail it. Three properties, all tested:

- **By name, never by agent id.** Ids are minted per registration, so a machine
  that restarts has a new one and a task queued against it would wait forever.
- **It is a filter, not a licence.** The named machine still has to offer the
  type, have the RAM, be under its load ceiling and get its own decline. A task
  whose machine is absent waits, exactly as one naming a type nobody runs
  waits — so `POST /tasks` answers with `targetAttached` alongside
  `agentAvailable`/`memoryAvailable`, because "that machine is not here" and
  "nobody has the RAM" send an operator to different places. `coversType()`
  asks the cover question of the named machine only.
- **A name two machines answer to means either of them.** Same-name machines
  are legal (see above), so targeting keeps both candidates and ranking picks;
  refusing the work over an ambiguous label would be worse than running it.

**Auth is capability-based, recomputed per request.** `src/host/auth/service.js`
resolves a bearer token to a principal whose effective scopes are the
intersection of the *key's* scopes and its *owner's*. Two invariants depend on
this and are tested:

- Narrowing a user narrows every key they already hold, immediately.
- A key never inherits its owner's scopes — an `operator` key issued by an
  `admin` is operator-only.

Disabling a user is checked at token-verification time, so it takes effect on
the very next request with no key sweep.

**Secrets are never stored in the clear.** Tokens are `alpha_<kind>_<id>.<secret>`
— the id indexes the record so verification is an O(1) lookup plus one
constant-time compare, and only a SHA-256 digest of the secret is kept.
Passwords use scrypt. There are tests asserting no plaintext reaches disk; keep
them passing.

## Things that will bite you

These are all real bugs that were found and fixed here. The comments in the code
say so at each site; this is the short list.

- **Never `unref()` a timer that represents pending work.** A backoff nap, a
  parked long-poll waiter and the agent's shutdown drain are the whole of what
  is in flight at those moments.
  Unref'ing them lets the event loop drain and the process exits silently. The
  sweeper and pruner are background janitors and stay unref'd.
- **Shutdown order matters.** `close()` must stop the queue (releasing parked
  long polls) *before* waiting on `server.close()`. Draining from the server's
  own `close` event deadlocks the two against each other.
- **Hand `server.close()` its callback up front.** With nothing connected it
  completes synchronously, and a `close` listener attached afterwards waits
  forever.
- **The coordinator waits for a bind address it does not have yet**
  (`ALPHA_BIND_WAIT_MS`), because at boot Tailscale has not assigned `100.x`.
  A port already in use still fails fast — waiting could never fix that.
- **Every handler path must end the response.** Returning from the long-poll
  abort branch without `res.end()` leaves the request open and blocks close.
- **A heartbeat that cannot reach the host counts, and does nothing else.**
  `#heartbeatMissed` warns once at `HEARTBEAT_WARN_AFTER` (3) consecutive
  misses and `#heartbeatAnswered` says so at info when one lands — a 410 counts
  as an answer, because a restarted host saying "who are you" is reachable.
  Neither clears the id or re-registers: those stay with the 410 branches, and
  clearing the id on a stand-down is exactly the eviction loop they warn about.
- **An agent must not deregister while tasks are still reporting.** `stop()`
  drains first, then aborts, then deregisters. Deregistering up front makes
  every in-flight result a 410, and the host re-runs work that succeeded.

## Two supervisors, and why neither is a handler

`scripts/keep-agent.mjs` runs the agent on a laptop, restarts it when it dies,
and every three hours fast-forwards the checkout and restarts it onto the new
code. It shells out to `self-update.mjs` rather than reimplementing the three
rules. The division of labour is the whole design: `self-update.mjs` exits 10 to
*ask* for a restart because a scheduled script does not own the agent process;
the keeper owns it, so it may. Four things it must keep doing:

- **Stop, never respawn, when its agent stood down.** The agent exits 0 in
  exactly one case nobody asked for — `410 stand_down`, another process on this
  machine now holds the registration. Respawning is the eviction loop the
  stand-down exists to end, so the keeper exits with it. That is why an
  unexpected exit 0 is not a crash.
- **Ask over IPC, not SIGTERM.** `AGENT_SHUTDOWN_MESSAGE` exists because Windows
  has no signal meaning "drain and stop"; a killed agent costs a lease and a
  re-run of work that succeeded. The entrypoint listens only when `process.send`
  is there, so nothing changes for an agent started by hand.
- **Run the agent from the checkout it updates**, not from beside itself. That
  is also the test seam — the suite puts a stub at `src/agent/index.js` in a
  temp repo and watches the *new* one start.
- **Never exit under an update it started.** `self-update.mjs` is a process of
  its own with git beneath it; a keeper that exits mid-update orphans both,
  still pulling. On the way out it waits for the update, bounded by
  `--stop-timeout-ms`, then kills the tree (`src/common/kill-tree.js`, shared
  with the standby). That needs `spawn` with `detached` — `execFile` silently
  drops `detached`, so the group it kills would be nobody's.

It overlaps `scripts/watchdog.mjs` in the update-and-restart half and not in the
other: the watchdog is one scheduled pass that asks the *host* whether this
machine is attached and writes the answer down, which nothing running on the
laptop can answer about itself. `--panel-key` adds the same question about the
CrowPanel, and it has to be asked of the host for a stronger reason: the panel
is not an agent at all — it registers nothing, holds no lease and has no row in
`/agents` — so nothing in the fleet notices when its screen freezes. It does
read `GET /stats` with a bearer key every five seconds, so that key's
`lastUsedAt` (epoch ms, not an ISO string) is the receipt, and a key quiet for
two minutes exits 1 like any other thing needing a person. Run beside the keeper it wants `--no-update` and
no `--restart-command`, or the two bounce the same worker.

`scripts/standby-alpha.mjs` runs Alpha on a laptop while the host is not
answering, and stops it when the host is back. It is a local daemon and
deliberately **not** a handler: failover cannot be driven over the tunnel,
because the coordinator is the thing that is down — a standby that promotes by
task is one that only starts when it is not needed. It follows the external-
program rules anyway (pinned interpreter by extension, start script that must
resolve inside `--root`, argv array, never a shell string), and takes nothing
from the network but whether a health endpoint answered. `--npm-script` is the
same rule with `package.json` as the allowlist — a name it does not define is
refused at startup, and Windows gets `npm.cmd` because `npm` there cannot be
spawned without a shell.

**The public way in moves with Alpha.** `--cloudflared <tunnel>` runs a named
Cloudflare tunnel for exactly as long as this machine is promoted, under the
same supervision as Alpha itself — a tunnel that died is a public address
pointing at nothing, and one left running beside a demoted Alpha is worse. The
name is all it accepts: cloudflared also takes `--token <secret>`, and an argv
is readable by every process on the machine, which is the same reason the
panel's WiFi password never travels that way.

**Stopping it stops the tree.** `npm run dev` is a wrapper and the server is its
grandchild; killing only the spawned process leaves the port held and the next
start fails to bind. POSIX gets its own process group, Windows gets
`taskkill /T`, and a test starts a real `npm run dev` and fails if the
grandchild survives.

Its real hazard is split brain: the machine cannot tell "the host is down" from
"I cannot reach the host". `--control-url` (something up whenever this laptop's
network is) is what keeps a dropped link from producing a second live Alpha, and
demotion is on by default so a split heals when the link does. Neither is a
quorum, and the docs say so rather than implying this is HA.

## Self-heal on the Alpha host, and why it is bounded

`scripts/alpha-selfheal.mjs` is one scheduled pass (every 2 minutes, as SYSTEM,
installed by `scripts/repair-alpha-host.ps1`) that keeps Alpha's backend,
production frontend and cloudflared connector up on Laptop41. Like the standby
it is local and not a handler — the tunnel cannot repair the machine it runs
on. Its policy lives in the pure `decide()` and is pinned by
`test/alpha-selfheal.test.js`; keep it that way:

- **Streak, cooldown, budget.** Nothing is repaired on one failed pass, a
  repaired component is left alone for the cooldown, and past the hourly or
  daily budget it stops and posts once. A supervisor that restarts forever
  hides a crash loop instead of reporting it.
- **The connector is gated on a proven origin.** cloudflared is restarted only
  when the frontend was healthy on consecutive passes, the Internet answers,
  and the edge returns a connector code. Its config and credentials are never
  read or written.
- **Configuration faults are reported, not restarted** — Vite's 403 "Blocked
  request" for the public host, a missing `dist` with no snapshot.
- **Rollback keeps the failed build** (`dist.failed-*`) beside the restored
  `dist.last-good`; it never deletes the evidence of what broke.
- Probes send `Host: <public host>` through `node:http` because that is what
  cloudflared sends and `fetch` cannot.

## Alpha's Agent Manager, seen from any machine

Alpha's Agent Manager (`scripts/alpha_agent_manager.ps1` in vyos88/Alpha) runs
on the machine that runs Alpha and is the one authority over Alpha's agents: it
starts and stops them, holds a machine-wide mutex so a second copy exits, and
checks an allocation before its `device-command` starts anything on another
laptop. The owner asked to see every agent from either laptop, with no
duplicate work and no loops between managers. That is answered here with a
viewer, never a second manager:

- **One manager, any number of viewers.** `scripts/fleet-agents.mjs` draws the
  manager's snapshot beside the coordinator's agents and leases, in the
  manager's own Norton layout. It sends reads and one task type,
  `alpha.agent-manager.status`, at most one at a time and only when an attached,
  non-silent agent offers it; a test pins that this is the whole of what it
  sends. Installing the manager itself on a second laptop to "see" it is the
  thing not to do: two authorities is exactly how stewards double up and
  restart each other.
- **The read is a handler because the HTTP route wants the owner.**
  `/agent-manager/status` needs Alpha's owner login, which no scheduled
  console should hold. `agent-manager-status.js` reads
  `memory/local/agent-manager/manager-status.json` inside
  `ALPHA_AGENT_MANAGER_ROOT`, else `ALPHA_REPO_ROOT` (the root the coordination
  handler uses), takes no arguments, starts no process, and is opt-in.
  `available()` declines a root with no snapshot, because the Host's records
  standby has an `ALPHA_REPO_ROOT` too. The two roots differ on Worker1: its
  coordination log is in `C:\Users\Vyo\Alpha-1.8`, but the live manager runs
  from `C:\Users\Vyo\Downloads\VyoS-advance-tech-ai`, and reading the first
  served a week-old snapshot. The stale check is what caught it.
- **Stale is drawn as stale.** The manager rewrites its snapshot every 15 s;
  both the handler and the viewer call it stale after two minutes, and the
  viewer ages a kept snapshot by the time since it was read. An old snapshot
  must never look like a live fleet.
- **Managing across laptops is Alpha's, not this repo's.** Alpha already has
  that half: `device-command` on the manager, `agent-control/poll` and
  `receipt` from `alpha_agent_controller.py` on the other laptop, allowlisted
  scripts only. A laptop takes part only if its device enrollment includes
  `agent-control`; laptop-gj8dfmlk's 2026-10-02 enrollment left it out, which is
  the "Managed control denied (HTTP=403)" in its supervisor log.

Turn it on with `agent-manager-status` in `ALPHA_EXTRA_HANDLERS` on the machine
that runs Alpha (plus `ALPHA_AGENT_MANAGER_ROOT` where the manager's install is
not `ALPHA_REPO_ROOT`), then on any machine:
`node scripts/fleet-agents.mjs --machines host=laptop-gj8dfmlk,worker1=desktop-41hplcn`.

## Adding a handler

Export `type`, `run(payload, { signal, taskId, attempt, log })` and optionally
`description`, `committedBytes()` (RAM the handler holds for itself, which
the agent then stops offering the host) and `available()` (below), then add it
to `BUILTIN` in `src/agent/handlers/index.js` — or
leave it out and let a machine opt in with
`ALPHA_EXTRA_HANDLERS=<module-name>`. Handlers that run an external program
must be opt-in, never in `BUILTIN`.

**A handler that needs something from the machine proves it before the agent
offers it.** `available()` returns `{ ok, reason }` and `HandlerRegistry.add()`
— the path `src/agent/index.js` uses for `ALPHA_EXTRA_HANDLERS` — leaves out
one that answers no, logging the reason and carrying on with everything else.
Being opt-in is not enough on its own: `.env.agent` gets copied from the host
to a laptop, and that laptop then advertises `alpha.render`, wins it on free
RAM, and fails it with an attempt spent and a retry free to land right back
there. `alpha-render.js` is the one that implements it, and the rule it follows
is that the check asks *exactly* what `run()` asks, the same way — same root,
same script-inside-root rule, same output directory, same executable resolved
against PATH (and PATHEXT on Windows, where `blender` is `blender.exe`) — or a
machine could pass the check and fail the task, which is the failure the check
exists to prevent. It executes nothing: whether the binary works is not
knowable without a render, and `run()` still reports that honestly. Built-ins
export no `available()` and are registered unconditionally; they start no
process, so there is nothing for them to be unavailable for.

`alpha-update.js` is the second one, and drives `git` rather than a script on
the host — git's CLI is a contract that already exists, so there is nothing to
keep in step with a file that would have to be shipped to the host before the
update mechanism could ship it. Its allowlist is `Status`/`Fetch`/`Pull` and
nothing else: no action may rewrite history, discard local work, or change
branch, `Pull` is `--ff-only` and refused outright on a dirty tree, and there is
deliberately **no Build or Restart** — a handler that ran a command from its
payload or its configuration would be a remote shell with extra steps. Fleet
self-update (`scripts/self-update.mjs`, `docs/AUTO_UPDATE.md`) follows the same
three rules and never restarts anything itself; it exits 10 to ask.

`alpha-render.js` is the third, and the one that shows what a task result is
*for*. It drives Blender to generate a creature or plant and returns the
**recipe** — species and seed — while the image stays on the machine that made
it. A payload carrying `params` is refused rather than dropped: the generator
has no such flag, and a recipe naming values the image does not have is the one
thing a recipe must never do. An educational render is hundreds of megabytes and has no business on
a result; the few hundred bytes that reproduce it are the only part anyone
needs. Two failures it refuses to report as success: a non-zero exit (unlike
the coordination tunnel, a generator that exits non-zero generated nothing), and
a *clean* exit that wrote no image — which would otherwise hand back a recipe
reproducing nothing. The generator names its own file, so each render writes into a directory of its
own and the handler reports what landed there — mtimes over a shared directory
attributed a concurrent render's output to the wrong task. `--python-exit-code
1` is load-bearing: without it Blender exits 0 when the generator raises, which
is the likeliest failure there is. Renders outlive `DEFAULT_LEASE_MS`, so queue
them with `--lease-ms` *and* `--no-wait`, or the CLI's own poll gives up on a
task that is running fine. Queue them with `--agent <the rendering machine>`
too. Two halves of the same problem: `--agent` decides where a render goes, and
`available()` (above) stops a machine that cannot render from offering to in
the first place — the second is what covers an *unpinned* render on a laptop
holding a copy of the host's configuration.

**The queue forgets; the ledger remembers.** `src/host/queue.js` is one
in-memory Map, deliberately — but that meant the *answer* died with it, and
after a restart there was no way to say how many renders ran last night or
which species came back. Terminal tasks now also go to `src/host/receipts.js`
via the queue's `onTerminal` seam. Four properties hold it up:

- **It is the expendable half.** A ledger write that throws — full disk,
  read-only mount — must never turn a task that genuinely succeeded into a 500
  for the agent reporting it, which would cost the lease and re-run finished
  work. `#finished()` swallows and logs.
- **A corrupt file does not stop the host.** The opposite of `AuthStore`, and
  for the opposite reason: overwriting credentials silently un-revokes access,
  whereas blocking the coordinator over a damaged *history* file is worse than
  losing the history. The bad file is moved aside and kept, never deleted.
- **The agent's name is resolved at record time, not read time.** A receipt
  outlives the registration that ran the work, and ids are minted per
  registration — a minute later there is nothing to look up.
- **Persistence follows the auth store's.** A host whose credentials are in
  memory cannot outlive its process, so a durable ledger for it is meaningless
  and actively harmful: defaulting it to the real path regardless put
  kilobytes of fabricated receipts into `./data/receipts.json` on every
  `npm test` run. Pinned by a test.

`alpha-render-inventory.js` is the sixth external-facing handler and the only
one that exists because of what the ledger *cannot* know. The ledger records
from the moment a host started keeping one; every render before that left one
durable trace, the file on the machine that made it. So this reads the output
directory and reports it. Four rules it follows:

- **It never parses a seed out of a filename.** The generator names its own
  file, which is why `alpha.render` reports what appeared rather than
  predicting a path; reconstructing `fern_7.png` → seed 7 reintroduces exactly
  that assumption and breaks the first time the naming changes. Counts, bytes
  and mtimes are what a file can honestly tell you.
- **It takes no path from the payload**, only an optional `species` filter. A
  handler that could be told where to look is a directory lister with a task
  queue in front of it — the same objection `handlers/index.js` raises against
  a shell handler.
- **A render in flight is excluded but counted.** `run()`'s `.render-*`
  staging directory holds a half-written image, which is not output; the
  number of them is reported, because that is the other half of reading a
  directory mid-flight.
- **Its `available()` is weaker than `alpha.render`'s on purpose** — output
  directory yes, Blender no. A machine whose Blender broke still holds every
  render it made, and that is exactly when an inventory is wanted. It shares
  `resolveOutputDir()` with the render handler rather than keeping a second
  copy of the rule, because a copy that drifts reads a directory the renders
  do not write to and calls a full machine empty.

`scripts/alpha-manager.mjs` is what a scheduled loop runs, and the three things
it adds over `run-jobs.mjs` are the three a loop needs: seeds **continue** from
the ledger instead of repeating (a loop on `--seed 0` re-renders the same six
forever), an allowlist and a per-window quota **approve** before anything is
queued, and it **never waits** — a render outlives any sensible pass. A pass
that would overrun the quota is refused whole rather than trimmed, because "I
rendered some of what you asked" is the worse answer for an unattended job.

`grow.js` sits next to `alpha-render.js` and the two are easy to mistake for
rivals, because both were asked for by "3D creatures and plants". They are not.
`alpha.render` drives Blender for minutes on the one machine with a GPU and
returns a recipe while the image stays put; `grow` expands an L-system in
process in milliseconds and returns a skeleton small enough to travel. Structure
against appearance. That is also why `grow` is in `BUILTIN` and
`alpha.render` is not: `grow` starts no process, opens no socket and touches no
filesystem, so the opt-in rule above does not reach it.

**The decision, so it is not relitigated: both stay, and they are not merged
into one task type.** Folding them together would put Blender behind a
`BUILTIN` name or push a millisecond call behind an opt-in flag, and either
breaks the rule that keeps external programs off every agent by default. What
the overlap actually costs is legibility — two names in `alpha-admin agents` —
so the fix lives in `grow`'s `description`, which is the string `describe()`
prints at the moment of the confusion.

**Composing them is the obvious next step and is deliberately not done yet.**
Feeding a `grow` skeleton to Blender would make one pipeline out of the two,
but `alpha.render` drives a `generate.py` whose `--species --seed` interface is
fixed and lives outside this repository. Inventing a richer interface here,
unilaterally, is how the two handlers came to overlap in the first place. That
change starts on the Python side or not at all.

`alpha-devices.js` is the fourth external-program handler, and the narrowest.
`device.inventory` wraps `scripts/usb-inventory.ps1` — already in the repo,
already the JSON Alpha's device panels consume — so that "is the panel still
plugged in, and on which COM port?" is a task rather than a trip to the laptop.
Windows renumbers COM ports on re-enumeration, so a replug moves a board and
whatever had the old number saved stops finding it; that is the failure this
exists to make visible. It tightens the external-program rules by one notch:
**no arguments at all.** The script takes none, so a payload carrying any key
is refused rather than ignored — `{ port: 'COM3; shutdown /r' }` should be told
it meant nothing, and the safest version of "payload data never reaches a
shell" is one with no path for it to travel. `summarize()` uses the script's
own field names (`serialPorts`, not a plausible-reading `ports`) because the
first version read a name that does not exist and returned an empty list on
every machine, which looks like "nothing attached" rather than like a bug.

`alpha-panel.js` is the fifth, and the only one that drives hardware. It
flashes and provisions the CrowPanel over USB from whichever machine the board
is plugged into — the handler is opt-in and `available()` refuses a machine
without the sketch and arduino-cli, so the one that offers `alpha.panel` is the
one holding the board, and a task reaches it with `--agent <that machine>`. It
drives
`arduino-cli`, under the same rules as the coordination handler: pinned
executable, pinned sketch that must resolve inside `ALPHA_PANEL_ROOT`,
allowlisted action, argv array. The payload chooses an action and at most which
serial port; it never names a path, a board or a flag. There is deliberately no
action that erases flash, reads it back, or flashes a binary the payload chose —
that last one is arbitrary code execution on the microcontroller, the hardware
form of the remote shell `handlers/index.js` forbids. Two things it does that
are worth keeping:

- **Credentials are runtime data, never build input.** `Provision` sends WiFi
  SSID and password down the wire to a sketch that is already running, and the
  sketch stores them in NVS itself. Baking them in with `--build-property` would
  put the password in an argv every process listing can read, in build artifacts
  on disk, and would mean a reflash per network change. The password is never
  logged, never in the result, and `redact()` takes it out of the serial
  transcript — there is a test pinning that.
- **`Flash` compiles first and stops if that fails.** Uploading after a failed
  build either flashes a stale binary from the cache or half-writes the board.
  A build failure is reported as a build failure, not as a failed flash.
- **It implements `available()`.** It requires everything `Flash` needs — root,
  sketch inside it, a valid FQBN, arduino-cli on PATH — not the smaller set
  `Ports` or `Provision` would do with, because `alpha.panel` is advertised as
  one name and a machine answering to it is offering the whole type. A machine
  set up only to provision is not a case that exists: the board is on the
  machine that flashes it.

The serial side is `fs` plus one `stty`/`mode.com` call, because Node's standard
library can open a serial device but cannot set its baud rate, and this repo has
no runtime dependencies. The port is opened once for a whole command sequence:
opening per command resets the board on every adapter that ties DTR to EN, so
the sketch would be restarting instead of answering. Three rules there, each one
a bug that was in this file:

- **No read may wait forever.** `stty raw` sets `min 1 time 0`, so a read waits
  for a byte a silent board never sends and the deadline is never looked at —
  the task then holds its lease until the sweeper takes it away, which is the
  exact failure the timeout exists to prevent. `min 0 time 1` goes *after*
  `raw`, and every read is raced against the deadline so Windows, which has no
  such knob, is covered by the close instead. The same outstanding read is
  picked up on the next pass: a second read alongside it splits the reply.
- **The open resets the board, so the conversation starts with `status`.** The
  first line written otherwise lands in a sketch that is still in `setup()` —
  which itself spends up to 15s joining WiFi — and is simply lost. The probe
  repeats until the board answers, and the credentials go only to something that
  has spoken. `ready:false` in the result is "nothing there", which sends an
  operator somewhere different from `provisioned:false`.
- **A reply budget outlasts what the sketch does before replying.** Its `wifi`
  command joins for 20s before it answers, so a shorter budget here reports a
  wrong password as silence. That is also why `Provision` wants `--lease-ms`,
  not only `Flash`.

`scripts/connect-panel.mjs` is the whole sequence as one command, run on the
machine the board is on — port, flash, key, provision, verify. The last step is
the only one that decides its exit code, and that is the point: a flash that
worked, a join that worked and a `provisioned:true` still leave a dark screen if
the panel cannot reach the coordinator. So it waits for the panel's key to be
*used* on the host, and waits for a use newer than the provisioning rather than
any use at all — "this key worked last Tuesday" is not a connected panel. It
mints that key itself, scoped to `agents:read` and nothing else: the screen on
the wall must not hold a credential that could queue work. It picks the port by
the CH340 bridge and refuses to guess between two candidates, because flashing
the wrong board is not something the next command can undo.

**The panel knows several networks, and picks by signal rather than by order.**
It stores up to four (`PANEL_MAX_NETWORKS`, mirrored as `MAX_NETWORKS` in the
handler so an operator hears "at most four" instead of silently losing the
fifth), scans, keeps the ones it can see and tries the strongest first — the
house WiFi provisioned first is the wrong first choice in a room where only the
hotspot reaches. Three things that follow:

- **A network the scan did not find is skipped, unless none of them were
  found.** That case is also what a hidden SSID looks like, so it falls back to
  trying everything in the order given rather than concluding there is nothing
  here.
- **`Provision` takes `networks: [...]`, and a bad entry fails the whole
  command.** A panel holding three of the four networks somebody meant is the
  kind of half-success nobody notices until they are in the wrong room. The
  single `ssid`/`password` form still means a list of one.
- **Every password is redacted, not just the first.** `redact()` takes an array
  and replaces longest-first, or a password that contains another is left half
  visible.

**`Scan` is the action that settles "wrong password or wrong room".** It asks
the board's own radio what it can hear from where the panel actually sits, which
is not what the laptop beside it hears. `panel-up.mjs` runs it automatically
when a join fails, and `--scan` runs it on its own. Reflashing does not cost a
board its credentials: the previous firmware's single network is migrated into
the list on first boot.

**Serial ports are read from two sources per platform.** On Windows `mode.com`
lists only ports it can *open*, so a board held by a serial monitor — the usual
reason a flash fails — is missing from it; the registry's `SERIALCOMM` device
map has it either way, and the difference between the two is reported as "in use
by another program?" rather than as no board at all. On POSIX `/dev/serial/by-id`
supplies the label (`usb-1a86_...` is the CH340 this panel is behind) while the
port opened is the node it resolves to.

**The panel has pages, and each one is fetched only while it is on screen.**
Five — `fleet`, `machines`, `work`, `receipts`, `panel` — rotating every
`PAGE_INTERVAL_MS`, each sourced from the endpoint that owns its numbers
(`/stats`, `/agents`, `/stats`, `/receipts/summary`, and nothing). Four rules
hold it up:

- **Only the visible page's endpoint is fetched.** `/stats` is polled for the
  header regardless; `/agents` and `/receipts/summary` are read when their page
  comes round. A wall display must not be the reason a coordinator is busy.
- **`/agents` is parsed through a `DeserializationOption::Filter`.** The row
  carries every field the host knows; an ESP32 parsing all of it for four
  numbers is how a panel runs out of heap on the day a fourth laptop joins.
- **The `panel` page needs no network**, which is the whole point of it: it is
  what answers "is it the panel or the fleet?" when nothing is answering, and
  it is where the board starts before a coordinator has ever replied.
- **`Page` is an action, and the page list is mirrored from the firmware**
  (`PANEL_PAGES` against `PAGE_NAMES`). A payload naming a page the board does
  not have is refused on the task rather than swallowed by a board that keeps
  showing what it was showing. `hold` stops the rotation, because somebody
  standing in front of the machines page should not have it slide away
  mid-sentence.

The panel's key carries `agents:read` **and `tasks:read`** — the receipts page
needs the second, both are read-only, and nothing either scope allows can queue
work. A panel provisioned before that shows `key needs tasks:read` on that page
instead of a confident row of zeroes.

**Alpha's deck feed is three settings, and `scripts/fix-panel-host.mjs` is all
three.** Alpha's own panel reaches its backend on a home-network address or not
at all — never `127.0.0.1`, never a tailnet `100.x` — so `HOST` (what the
backend binds), `ALPHA_TRUSTED_HOSTS` (read at startup; an address bound but not
trusted answers 400, which reads as the panel's fault) and
`ALPHA_PANEL_LAN_READ` (the route itself; off is a 404) each keep the screen
dark on their own. The script adds this machine's address to the first two,
turns the third on, and then makes *the request the panel makes* from that
address, which is the only check that means anything. Three rules it follows:

- **Nothing is removed.** `127.0.0.1` goes back if somebody took it out — the
  doctor, the frontend and every local script reach the backend there — and a
  tailnet address already listed stays, because the rest of the fleet is
  reaching the backend through it.
- **A missing `ALPHA_TRUSTED_HOSTS` is not invented.** Absent means the default
  decides; writing one would quietly narrow a backend nobody asked to narrow.
- **The duplicate that counts is the one rewritten.** dotenv takes the last
  line, so changing an earlier one looks right in the file and does nothing —
  the failure a reader cannot see.

**Alpha has its own CrowPanel firmware, and the two are told apart on the wire.**
`hardware/examples/crowpanel_alpha_*` in the Alpha repository holds no
credential, polls `/panel/crowpanel/public-state` on Alpha's backend, and takes
bare-word `STATUS` / `WIFI` / `ALPHA` commands. Same board family, so it is the
mistake that actually happens. `converseOver` records whether anything
*non-JSON* arrived, and `describeSilence()` turns that into the difference
between "nothing on COM3 answered" (bootloader, wrong port, no board) and
"something on COM3 is talking but not in this protocol" with what it said. A
timeout that blames the cable for the other firmware costs an evening.

The panel reads `GET /stats` and draws it, so it reads the host's own key names
— `queue.byStatus.leased` is what it calls *running* — and a test pins those
names against a real host. A key the sketch invents is not an error in
ArduinoJson: it reads as zero, and a screen of zeroes looks like an idle fleet
rather than like a display reading the wrong endpoint. Same failure as
`alpha-devices.js`'s `serialPorts`, on a device with no way to report it.

`codex-exec.js` is the sixth external-*program* handler — the sequence
`alpha-coordination`, `alpha-update`, `alpha-render`, `alpha-devices`,
`alpha-panel`, and now this, distinct from the external-*facing* count above —
and the one that breaks the pattern the other five hold. `codex.exec` hands a prompt to the Codex CLI on the machine that has
it and returns what Codex said, so another coding agent is reachable by task
rather than by a person carrying messages between two laptops. Every other
handler here narrows a payload until what is left is data; this one hands a
string to an agent with a shell on that machine, which is the category
`handlers/index.js` refuses outright. It stays a handler and not a remote shell
with extra steps on four counts, and each is load-bearing:

- **The payload is a prompt and nothing else.** Not the executable, the
  directory, the model, the sandbox mode or any flag — all of those are the
  machine's configuration. `rejectUnsupportedKeys` refuses the extra key rather
  than dropping it, for the reason `alpha-devices` refuses arguments: someone who
  sent `{ prompt, sandbox: 'danger-full-access' }` should be told it meant
  nothing, not left believing it widened.
- **The sandbox defaults to `read-only`,** and widening it is done on the laptop
  rather than by the task that arrived over the network.
- **The working directory is `cwd`, not a flag.** Every CLI honours it and no
  version can rename it, so the one part of the contract that cannot drift
  doesn't. `buildArgs` holds the part that can, pinned by tests — the
  `alpha-coordination` rule: if the CLI changes, both change together.
- **`available()` refuses a machine that cannot do it,** including one whose root
  is not a git checkout, because Codex refuses to run outside one and every task
  would fail on a machine that looks perfectly configured.

Two failures it will not report as success, both borrowed from `alpha.render`: a
non-zero exit (Codex did not answer) and a *clean* exit with no output, which
would otherwise hand back a successful conversation with nothing in it. A long
answer comes back as its tail with `truncated: true`, because the answer is at
the end of a transcript. Like a render, a Codex call outlives
`DEFAULT_LEASE_MS`, so `alpha-admin codex` leases ten minutes for you and
`--prompt-file` exists because these prompts are paragraphs and a shell that ate
a newline would change the question without saying so. On Windows, `ALPHA_CODEX`
must be the native binary: the npm install puts a `.cmd` shim on PATH, a `.cmd`
cannot be spawned without a shell, and a shell is exactly what must not stand
between a prompt and the process — so PATH resolution tries native extensions
first and refuses a shim with the remedy in the reason.

`alpha-music.js` is the seventh, and the second that returns a recipe.
`alpha.music` takes exactly what Alpha's Music Creator panel collects —
genre, subgenre, bpm, key, vocals, seed, durationSec — checks the names against
`src/common/musicGenres.js` (the vocabulary the panel's `musicGenres.ts`
mirrors), and hands them to a Python generator. Three rules it adds:

- **A genre suggests a BPM, never pins one.** A missing `bpm` takes the
  subgenre's `defaultBpm`; a given one always wins. `bpmTypical` in the
  result is informational and nothing reads it.
- **`vocals: true` is refused unless `ALPHA_MUSIC_VOCALS=1`.** The obvious
  local generator (MusicGen) cannot sing, and a recipe saying "vocals" for an
  instrumental track is the `alpha.render` `params` mistake again. `vocals`
  must be stated either way, so the recipe always says which it is.
- **Unknown payload keys are refused, not dropped**, for the same reason.
- **On a ComfyUI machine, the image models leave the GPU first.** ComfyUI keeps
  its checkpoint in VRAM between images (2.6 GB of the Host's 4 GB RTX 3050),
  and MusicGen beside it did not fail: the driver spilled it into system RAM
  and a track went from a minute to past twelve. `run()` posts ComfyUI's
  `/free` before generating, best-effort and bounded at 5 s, so a ComfyUI that
  is down never costs a track. `ALPHA_MUSIC_FREE_GPU=0` turns it off.

Unlike `alpha.render`, the generator contract is defined *here*
(`buildArgs`, pinned by tests), and so is the generator:
`scripts/generate_music.py` (MusicGen via `transformers`, imported lazily).
A test runs the handler against the real script in its `ALPHA_MUSIC_DRY_RUN`
mode, so the two cannot drift apart; if either changes, change both together.
The script refuses `--vocals` itself too, and every failure path exits
non-zero, because a clean exit is what the handler reads as success.

Alpha's Generate button reaches it through `src/bridge/music.js`
(`scripts/music-bridge.mjs`), because a tunnel token in a web page is readable
by anyone who can open the page. The bridge holds a `tasks:read,tasks:write`
key server-side and narrows it further than any scope can: it queues
`alpha.music` only, with lease and target machine from its own configuration,
validates with the handler's own `validateSettings`, reads back music tasks
only, binds loopback and sends no CORS header. It leaves `vocals` to the agent,
since it cannot know which machine will run the task.

Its two read-only routes hold to the same rules. `/music/recipes` reads the
receipt ledger with `type=alpha.music` (tasks:read, already held), filters by
type again itself, and passes on recipe, status, machine name, output
names/sizes and times — no paths, no agent ids. `/music/fleet` reads `/agents`,
which needs `agents:read`; that scope is optional, and a key without it makes
that one route a 502 `bridge_key_rejected` naming the scope while the rest keep
working. It lists only machines offering `alpha.music`, with name, idle time
and in-flight count (and `stale` when the registry reports one), never ids,
addresses, owners or other capabilities.

`alpha-music-audio.js` (`alpha.music.audio`) is how a track gets heard
somewhere other than the machine that made it, and it is shaped by two facts:
nothing can reach into an agent, and the coordinator keeps every task result
in memory for as long as it runs. So the audio comes back as task results, in
512 KB slices (a result body is capped at 1 MB), and the **bridge fetches each
track once** into `ALPHA_MUSIC_BRIDGE_CACHE` and serves every later play, with
Range support for seeking, from its own disk. Re-fetching per play would grow
the coordinator by the size of the track every time. The slice handler takes a
genre and a file name, never a path, and looks only at
`<output>/<genre folder>/<name>`; the bridge only asks for a name the
generating task itself reported. Every slice carries the file's size and
mtime, and the bridge restarts a download whose file changed underneath it,
because a re-run with the same recipe replaces the file in place. Slices go to
the task's `targetAgent`, so playback needs `ALPHA_MUSIC_AGENT` on the bridge:
an untargeted task names no machine the bridge could ask. Its `available()`
needs only the output directory, as `alpha-render-inventory`'s does.

`alpha-music-stems.js` (`alpha.music.stems`) removes the vocals from a track
`alpha.music` already made, by stem-separating it with Demucs and keeping
everything but the vocal stem. It is named and shaped exactly like
`alpha.music.audio` on purpose: the payload is `{ genre, name }`, never a
path, resolved the same way at `<output>/<genre folder>/<name>`, because a
handler that could be told where to look is a file server with a task queue
in front of it. The instrumental it writes — `<name's stem>.novocals<ext>` —
lands in that same genre folder, which is the only reason this needs no new
way to get audio back to a browser: `alpha.music.audio`'s slice pipeline
already serves any file there by name, so the bridge's existing
`/music/tasks/:id/audio` route plays it with no changes to that handler.
**The track never leaves the machine that holds it.** `src/bridge/music.js`'s
`POST /music/tasks/:id/remove-vocals` queues `alpha.music.stems` targeted at
that same track's `targetAgent` — there is nowhere else the separation could
run — and hands back a second task id the panel polls and plays back through
the same two routes a generated track uses, rather than inventing a parallel
set. Two failures it refuses to call success, both borrowed from
`alpha.music`: a non-zero exit, and a clean exit that wrote nothing. Its
`available()` checks the script and the output directory, the same two things
`alpha.music`'s does, and nothing about any one track — that is `run()`'s
question. `ALPHA_MUSIC_DRY_RUN=1` makes `scripts/remove_vocals.py` copy the
input through unchanged instead of loading Demucs: there is no way to prove
separation itself without a real voice to remove, so the dry run only proves
the file moved through the pipeline, the same honesty `generate_music.py`'s
click track has about BPM and key rather than musicality. Demucs is a second,
separate dependency file (`scripts/requirements-stems.txt`) from MusicGen's,
so a machine can offer either capability without the other.

`alpha-coordination.js` is the reference for that case: pinned interpreter,
pinned script that must resolve inside `ALPHA_REPO_ROOT`, allowlisted action,
and arguments passed to `execFile` as an argv array so a message containing
shell metacharacters is data, not syntax. Its contract is **verified against the
real script** — the five original actions and `-Paths` as one comma-joined
token on the host, and `Ack` (`-EventId`, `-Stage`) under PowerShell 7 off it.
The tests pin the exact argv, so if the script's contract changes, update
`buildArgs` and the expectation together.

## Testing conventions

Tests boot a real host and a real agent over loopback rather than mocking the
transport; several drive the actual entrypoints as subprocesses. Prefer that
over stubs — most of the bugs above were only findable that way.

`AuthStore` takes `path: null` for an in-memory store, and `createHost({ token })`
builds an ephemeral auth service with that token as its only credential. Both
exist for tests.

## Working with other sessions

Several Claude sessions push to this repo, and `main` moves under you.

- **Fetch before you push, and merge — never force.** A non-fast-forward
  rejection means someone else landed work; `--force` would destroy it.
- Run the full suite after merging. Merges here have been textually clean while
  touching the same subsystems.
- Coordination happens through commits and PRs. Sessions in cloud containers
  cannot reach the Alpha host's tailnet, so anything needing the live
  coordinator has to run on the host or the laptop.

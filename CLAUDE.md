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
- **RAM a handler holds for itself is never also offered to the host.** A
  handler may export `committedBytes()`; `HandlerRegistry.committedBytes()` sums
  it and `memorySnapshot()` takes it off the offer alongside the reserve.
  `memory.store` is the one that does — its *unused* budget only, since what it
  already holds is real heap and has left `freeBytes` on its own.

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
- **An agent must not deregister while tasks are still reporting.** `stop()`
  drains first, then aborts, then deregisters. Deregistering up front makes
  every in-flight result a 410, and the host re-runs work that succeeded.

## Adding a handler

Export `type`, `run(payload, { signal, taskId, attempt, log })` and optionally
`description` and `committedBytes()` (RAM the handler holds for itself, which
the agent then stops offering the host), then add it to `BUILTIN` in
`src/agent/handlers/index.js` — or
leave it out and let a machine opt in with
`ALPHA_EXTRA_HANDLERS=<module-name>`. Handlers that run an external program
must be opt-in, never in `BUILTIN`.

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
too: the handler being opt-in keeps it off machines that never enabled it, but
not off one that was handed a copy of the host's configuration, and naming the
machine is what makes a render land where the GPU and the generator actually
are.

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

`alpha-panel.js` is the fourth, and the only one that drives hardware. It
flashes and provisions the CrowPanel hanging off one laptop's USB, through
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

The serial side is `fs` plus one `stty`/`mode.com` call, because Node's standard
library can open a serial device but cannot set its baud rate, and this repo has
no runtime dependencies. The port is opened once for a whole command sequence:
opening per command resets the board on every adapter that ties DTR to EN, so
the sketch would be restarting instead of answering.

`alpha-coordination.js` is the reference for that case: pinned interpreter,
pinned script that must resolve inside `ALPHA_REPO_ROOT`, allowlisted action,
and arguments passed to `execFile` as an argv array so a message containing
shell metacharacters is data, not syntax. Its contract is **verified against the
real script** — all five actions and `-Paths` as one comma-joined token. The
tests pin the exact argv, so if the script's contract changes, update
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

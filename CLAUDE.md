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
  offered it. `task.declines` counts them and **nothing reads it** — keep it
  that way. Bounding declines would break the legitimate case (a task waiting
  for a machine with room should wait); the count is there so an agent
  misreporting its own memory, which refuses the same task forever, is
  distinguishable from that patience in `/tasks` rather than identical to it.
- **RAM a handler holds for itself is never also offered to the host.** A
  handler may export `committedBytes()`; `HandlerRegistry.committedBytes()` sums
  it and `memorySnapshot()` takes it off the offer alongside the reserve.
  `memory.store` is the one that does — its *unused* budget only, since what it
  already holds is real heap and has left `freeBytes` on its own.

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

# alpha-tunnel

Coordinator (**host**) and worker (**agent**) for running Alpha tasks on a
second machine, with real accounts behind it: users, invitations, scoped API
keys, and revocation.

The laptop attaches to the host as a worker. Every connection is **outbound
from the agent**, so the laptop needs no open port, no public hostname and no
inbound firewall rule — it only has to be able to reach the host over whatever
link you already have (Tailscale, an SSH tunnel, a plain LAN address).

It also lends the host its spare RAM two ways: the host places memory-hungry
tasks on it by free memory, and can park data in it by key. See
**[Lending the host RAM](#lending-the-host-ram)**.

Work is placed on the machine that can actually absorb it, by leases already
held and by reported CPU load — and a machine at full tilt stands aside so its
neighbour takes the next task. See
**[Placing work by load](#placing-work-by-load)**.

```
  ┌────────────────────────┐                      ┌──────────────────────┐
  │  HOST  (Alpha)         │                      │  AGENT  (laptop)     │
  │                        │                      │                      │
  │  task queue            │ ◀── POST /register ──│  registers           │
  │  agent registry        │ ◀── POST heartbeat ──│  RAM + CPU, every 20s│
  │  users / keys / scopes │ ◀── GET  tasks/next ─│  long-polls (25s),   │
  │                        │      ?load=0.12      │  carrying its load   │
  │  ranks the agents      │                      │                      │
  │  leases a task ────────│ ─── 200 {task} ─────▶│  runs a handler      │
  │   to the coolest one   │ ◀── POST result ─────│  reports back        │
  └────────────────────────┘                      └──────────────────────┘
         listens                                     dials out only

  Two laptops, one pinned:                  ...and the pinned one stands aside
  ┌──────────────┬───────┬─────┐            above ALPHA_AGENT_MAX_LOAD, so it
  │ laptop-A     │  97%  │  0  │  ← skipped stops asking until it quietens down
  │ laptop-B     │   8%  │  3  │  ← placed
  └──────────────┴───────┴─────┘
       agent        CPU    running
```

No runtime dependencies — Node's standard library only. Requires Node >= 20.

## Quick start

**1. Start the host with a bootstrap token.** This is a break-glass credential
that exists only to create your first real admin.

```bash
cp .env.example .env
# set ALPHA_BOOTSTRAP_TOKEN to the output of:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

npm run host          # listens on 127.0.0.1:8787
```

**2. Create your admin account.**

```bash
npm run admin -- bootstrap-admin --email you@example.com
# prints a one-time invite token

npm run admin -- redeem --token 'alpha_inv_...'   # prompts for a password
# prints your API key — this is your ALPHA_ADMIN_TOKEN from now on
```

**3. Remove the bootstrap token** from `.env` and restart the host. From here
on, issued keys are the only way in. The host warns on every start while a
bootstrap token is still set alongside real users.

**4. Give the laptop its own agent key.**

```bash
npm run admin -- issue-key --user <yourUserId> --scopes agent --name laptop
```

On the laptop, set `ALPHA_HOST_URL` and `ALPHA_AGENT_KEY` to that key, then:

```bash
npm run agent
```

**5. Queue some work.**

```bash
curl -s -X POST http://127.0.0.1:8787/tasks \
  -H "Authorization: Bearer $ALPHA_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"type":"sysinfo"}'
```

`agentAvailable: false` is not an error — it means the task is queued but no
attached agent advertises that type yet. It runs as soon as one does.

## Users, invites and access

There are no self-signups. Someone with `invites:write` creates an invitation
for a specific email with a specific set of scopes; the invitee redeems it,
chooses a password, and receives an API key.

```bash
# Invite a teammate as an operator (queue and cancel work, see agents)
npm run admin -- invite --email teammate@example.com --scopes operator

# Invite someone with full access, expiring in 2 days instead of the usual 7
npm run admin -- invite --email trusted@example.com --scopes admin --expires-days 2

npm run admin -- invites                    # see who has been invited
npm run admin -- revoke-invite <inviteId>   # withdraw before it is redeemed
```

Invitations are **single-use**, expire (7 days by default), and can be revoked
until the moment they are redeemed. The token is shown exactly once — only a
hash of it is stored, so a lost invite has to be reissued, not recovered.

### Scopes

| Scope | Grants |
|---|---|
| `tasks:read` | Read tasks and their results |
| `tasks:write` | Queue tasks |
| `tasks:cancel` | Cancel queued tasks |
| `agents:read` | See attached agents and stats |
| `agent:connect` | Attach as a worker and pull tasks |
| `users:read` | List users and their keys |
| `users:write` | Enable/disable users, change their scopes, revoke their keys |
| `invites:read` | List invitations |
| `invites:write` | Create and revoke invitations |
| `keys:write` | Issue API keys for yourself |
| `admin` | Everything above, including granting `admin` to others |

Presets bundle the common cases: `admin`, `operator` (queue and cancel work,
see agents, issue own keys), `agent` (just `agent:connect`), `viewer`
(read-only). `--scopes '*'` is accepted as a spelling of `admin`.

Two rules keep grants from drifting upward:

- **You cannot grant a scope you do not hold.** Someone with `invites:write`
  and `tasks:read` can invite a reader, but cannot mint an admin.
- **A key is capped by its owner.** Effective scopes are recomputed on every
  request as the intersection of the key's scopes and the user's, so narrowing
  a user narrows every key they already hold, immediately.

### Revocation

| To do this | Run |
|---|---|
| Kill one credential | `npm run admin -- revoke-key <keyId>` |
| Kill **all** of a user's access at once | `npm run admin -- disable-user <userId>` |
| Restore it | `npm run admin -- enable-user <userId>` |
| Change what someone can do | `npm run admin -- set-scopes <userId> --scopes viewer` |
| Withdraw an unredeemed invite | `npm run admin -- revoke-invite <inviteId>` |

For another **device of your own**, issue a second key rather than creating a
second account — no extra password to manage, and it revokes independently:

```bash
npm run admin -- issue-key --user <yourUserId> --scopes operator --name laptop
```

A key is capped by its owner's scopes but does not inherit them, so an
`operator` key issued by an admin is operator-only. Use an invitation instead
when the other party is a different **person**, who should have their own
account and password.

Disabling is checked when a credential is verified, so every key the user holds
stops working on the very next request — there is no key sweep to wait for and
nothing to miss. It is a switch, not a delete: re-enabling restores the same
keys.

Changing a password revokes all of that user's **sessions** but deliberately
keeps their **API keys**, which are often held by running agents and are
separately revocable.

### Credentials at a glance

| Kind | Prefix | Lifetime | How to revoke |
|---|---|---|---|
| Invite | `alpha_inv_` | 7 days, single use | `revoke-invite`, or let it expire |
| API key | `alpha_key_` | Until revoked, or `--expires-days` | `revoke-key`, or disable the user |
| Session | `alpha_ses_` | 12 hours | Change password, or disable the user |
| Bootstrap | (opaque) | Until you unset it | Remove from the environment |

Only a SHA-256 digest of each secret is stored. Passwords are hashed with
scrypt (N=2¹⁵, per-user salt). Neither a token nor a password can be read back
out of the store — there are tests asserting exactly that.

## Configuration

| Variable | Side | Default | Meaning |
|---|---|---|---|
| `ALPHA_HOST_PORT` | host | `8787` | Listen port. |
| `ALPHA_HOST_BIND` | host | `127.0.0.1` | Comma-separated listen addresses. |
| `ALPHA_AUTH_STORE` | host | `./data/auth.json` | Where users/keys/invites persist. |
| `ALPHA_BOOTSTRAP_TOKEN` | host | — | Break-glass admin credential. Remove after setup. |
| `ALPHA_INVITE_BASE_URL` | host | request `Host` | Base for the printed redeem link. |
| `ALPHA_BIND_WAIT_MS` | host | `300000` | How long to wait for a bind address that is not up yet (Tailscale at boot). |
| `ALPHA_HOST_URL` | agent, CLI | — | Where the host is reachable. |
| `ALPHA_AGENT_KEY` | agent | — | This agent's API key. |
| `ALPHA_AGENT_NAME` | agent | machine hostname | Name shown in `/agents`. |
| `ALPHA_AGENT_CAPABILITIES` | agent | all handlers | Subset of task types to accept. |
| `ALPHA_AGENT_MEMORY_RESERVE_MB` | agent | `512` | RAM kept for this machine; the rest is offered to the host. |
| `ALPHA_AGENT_MAX_LOAD` | agent | `0.85` | Share of its own cores above which this machine stops asking for work. |
| `ALPHA_AGENT_CONCURRENCY` | agent | `1` | Tasks this machine will run at once. |
| `ALPHA_EXTRA_HANDLERS` | agent | — | Comma-separated opt-in handlers, e.g. `memstore`. |
| `ALPHA_MEMSTORE_LIMIT_MB` | agent | ¼ of RAM, max `1024` | Budget for data the host parks here. Unused budget is withheld from what this machine offers. |
| `ALPHA_MEMSTORE_MAX_VALUE_MB` | agent | half the budget | Largest single stored value. |
| `ALPHA_ADMIN_TOKEN` | CLI | — | Credential the CLI uses. |
| `ALPHA_LOG_LEVEL` | both | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `ALPHA_LOG_FORMAT` | both | human | Set to `json` for one JSON object per line. |

A `.env` file next to the project root is read automatically; real environment
variables always win.

`ALPHA_TUNNEL_TOKEN` from the pre-accounts version is still honoured as a
bootstrap token and by agents, so an existing deployment keeps running. It
grants everyone holding it full access and cannot be revoked for one holder,
so replace it with per-agent keys.

## HTTP API

`/healthz`, `/auth/login`, `/invites/preview` and `/invites/redeem` are open —
the last two because the invite token *is* the credential. Everything else
needs `Authorization: Bearer <token>` and the scope listed.

**Access control**

| Method | Path | Scope |
|---|---|---|
| `POST` | `/auth/login` | — (email + password) |
| `POST` | `/invites/preview` | — (invite token) |
| `POST` | `/invites/redeem` | — (invite token) |
| `GET` | `/me` | any credential |
| `POST` | `/me/password` | any user credential |
| `GET` | `/scopes` | any credential |
| `POST` | `/invites` | `invites:write` |
| `GET` | `/invites` | `invites:read` |
| `DELETE` | `/invites/:id` | `invites:write` |
| `GET` | `/users`, `/users/:id` | `users:read` |
| `POST` | `/users/:id/status` | `users:write` |
| `POST` | `/users/:id/scopes` | `users:write` |
| `POST` | `/keys` | `keys:write` (plus `users:write` for someone else) |
| `GET` | `/keys` | own keys; `users:read` for everyone's |
| `DELETE` | `/keys/:id` | own keys; `users:write` for someone else's |

**Work**

| Method | Path | Scope |
|---|---|---|
| `POST` | `/tasks` | `tasks:write` |
| `GET` | `/tasks`, `/tasks/:id` | `tasks:read` |
| `POST` | `/tasks/:id/cancel` | `tasks:cancel` |
| `GET` | `/agents`, `/stats` | `agents:read` |

**Agent plane** (used by the worker, all requiring `agent:connect`)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/agent/register` | Announce name, capabilities, version, free RAM and CPU load; receive an agent id. |
| `GET` | `/agent/:id/tasks/next?wait=ms` | Long-poll for work, carrying this machine's current load. `204` when nothing matches. |
| `POST` | `/agent/:id/tasks/:taskId/result` | Report `{ok, result?, error?}`. |
| `POST` | `/agent/:id/heartbeat` | Liveness, and fresh `{memory, load}` readings. |
| `DELETE` | `/agent/:id` | Detach cleanly. |

A `410` on any `/agent/:id/...` call means the host has forgotten this agent
(it restarted, or pruned it as stale). The agent re-registers automatically. A
`401` means its key was revoked; it stops rather than retrying.

## Task lifecycle

```
queued ──lease──▶ leased ──ok───────▶ succeeded
   ▲                 │
   │                 ├──error, attempts left──┐
   └─────────────────┴──lease expired─────────┘
                     │
                     └──error, no attempts left──▶ failed
```

A task is **leased**, not pushed. If the agent dies mid-task, its lease expires
(`leaseMs`, default 60s), the host reclaims the task and the next capable agent
picks it up, up to `maxAttempts` (default 3). Results from an agent that no
longer holds the lease are rejected with `409`, so a slow straggler can't
overwrite the answer from the agent that actually owns the work.

The task queue is in memory and clears on restart. Accounts and credentials are
not — they persist to `ALPHA_AUTH_STORE`.

## Lending the host RAM

The laptop's spare memory is the thing the host most often runs out of, so it
is lent in both directions: work that needs RAM is **placed** here, and data
that needs to be resident is **parked** here.

### Setting up a machine to lend

On the machine doing the lending — the laptop — once someone on the host has
issued it a key (`npm run admin -- issue-key --user <userId> --scopes agent
--name laptop`):

```bash
npm run setup:agent -- --host http://100.x.y.z:8787 --key alpha_key_... --memstore
```

That checks the host is reachable and the key really is an `agent:connect`
key, works out how much RAM to offer (a quarter of the machine by default,
floored at 512 MB and capped at 4 GB — override with `--reserve-mb`), writes
`.env.agent`, then attaches for a moment to prove the whole loop before saying
it worked. `npm run agent` from then on. It prints the service command for the
platform it ran on, so the laptop keeps lending across reboots.

### Placing work by free memory

The agent reports its memory on registration, on every heartbeat and on every
poll: total, what is actually available, and what it is willing to offer. The
poll matters — that is the moment the agent is asking for work, and memory is
what decides whether a task may be placed here at all, so a reading from a
heartbeat ago is not good enough. On Linux the "available" figure comes from
`MemAvailable` in `/proc/meminfo` rather than `os.freemem()`, which counts
reclaimable page cache as used and would make a busy laptop look full.

Two things come off what it offers. `ALPHA_AGENT_MEMORY_RESERVE_MB` is held
back so lending memory never pushes this machine into swap. So is any budget
this agent's own handlers are holding: with `memstore` enabled, the part of
`ALPHA_MEMSTORE_LIMIT_MB` the cache has not filled yet is RAM it may take at any
moment, and offering it to the host as well would promise the same gigabyte
twice. Only the unused part — memory already stored is real heap and has left
the available figure on its own.

On the host, a task's `minMemoryMB` is held against the agent that takes it, and
that hold is settled against what the agent goes on to report: once the machine
says the memory has actually been taken, the hold is released rather than
charged a second time on top of the drop the report already shows.

The agent gets the last word. It is told what the task needs and re-reads its own
memory before running anything, so a machine whose owner took the RAM in the
window between the poll and the task arriving hands the work straight back
instead of swapping. That is not a failure and costs the task nothing: the
attempt is handed back, the decline carries the reading that explains it, and the
task waits in the queue with its full retry budget until a machine has room.

Each hand-back is counted, which is the only trace it leaves:

```
$ npm run admin -- tasks
ID                     TYPE  STATUS  TRIES  DECLINED  CREATED
task_x4gsncaxwin3jbwa  echo  queued  0      3         2026-09-05 13:42:57
```

Nothing reads that count, and there is no limit on it — a task waiting for a
machine with room is *supposed* to wait indefinitely. It is there because that
task and one an agent keeps refusing otherwise look identical: both queued, both
with `TRIES` flat. `DECLINED` climbing while `TRIES` does not is the difference.

A task may then ask for a slice of it:

```bash
npm run admin -- task --type crunch --min-memory-mb 4096
```

Such a task is only leased to an agent whose latest report shows that much
free, and the host **holds** those bytes against the agent for the life of the
lease. Without the hold, three 4 GB tasks would all be placed on the same 8 GB
laptop in the same instant — none of them has allocated anything yet at the
moment the next one is matched. The reservation is released when the task
succeeds, fails, is cancelled, or its lease expires.

A report older than two minutes is treated as unknown rather than trusted, and
an agent with unknown memory is never given a task that names a requirement. So
is an agent that reports nothing at all — an older agent keeps working, it just
never wins memory-tagged work.

`agentAvailable: false` on a queued task now has two causes, and the response
separates them: `memoryAvailable: false` means somebody runs that type but
nobody has the RAM right now. The CLI says which:

```
$ npm run admin -- agents
NAME     PRINCIPAL  CAPABILITIES        RAM     FREE   HELD   CPU  RUN  IDLE
laptop   viorel     echo,sysinfo,...    15866M  9184M  4096M  12%  1    3s
```

`FREE` is what is left to place work against — offered, minus what its
in-flight tasks already claimed. `HELD` is that claim. `CPU` and `RUN` are the
other half of placement — see below.

### Placing work by load

Free RAM says nothing about whether a machine can take on more. A laptop
running its owner's build at 100% CPU still reports gigabytes free, and to a
host that only knows about memory it looks exactly as good a target as an idle
one. That is how both laptops end up pinned while work keeps landing on
whichever of them asked first.

So an agent reports its CPU alongside its memory — on registration, on every
heartbeat, and on every long poll:

- **utilisation**, sampled from `os.cpus()` tick deltas — the only signal that
  works on Windows, where `os.loadavg()` always reads `[0, 0, 0]`;
- **run-queue pressure**, the 1-minute load average over core count, which
  unlike utilisation keeps climbing past "fully busy".

Reporting it on the poll matters as much as the figure itself. The poll is the
moment an agent is actually asking for work, so the host ranks it on what it is
like right now rather than on a heartbeat that could be twenty seconds old — a
laptop that has just finished a build should stop being passed over
immediately, not eventually.

`loadFactor` is the larger of the two: whichever signal says the machine is
struggling is the one believed. Below `1.0` it reads as the fraction of the
machine spoken for; above `1.0`, work is queueing behind the cores. A figure
the machine could not measure is reported as `null` and treated as **unknown,
never as idle** — guessing zero would send work straight at the quietest
reporter rather than the quietest machine.

Placement then works on two things, in this order:

1. **Leases already held.** Exact, immediate, and impossible to go stale. A
   task handed over a millisecond ago has not moved any reading yet, so without
   this a burst of work lands on one machine before any of it shows up.
2. **Reported load.** Between two machines holding the same amount of work, the
   less loaded one wins.

An agent holding a task therefore always ranks below an idle one, however
quiet it claims to be — and among idle agents, the coolest wins.

The worker enforces the same thing from its side. Above `ALPHA_AGENT_MAX_LOAD`
(0.85 of its cores by default) it stops asking for work at all, so the next
task goes to a machine with cores free. The host can only rank agents that are
actually asking, and a laptop pinned by its owner's own work has to take itself
out of the running. This is a pause, not a refusal: it keeps heartbeating, and
picks work up again the moment its load drops. If *every* machine is over its
ceiling, an agent that has stood aside for a minute with nothing in hand takes
a task anyway — a busy fleet should run work late, never not at all.

`alpha-admin stats` shows whether the fleet is unbalanced or genuinely full:

```
$ npm run admin -- stats --json
"load": { "reporting": 2, "unknown": 0, "busiest": 0.91, "idlest": 0.06, "tasksInFlight": 1 }
```

Far apart means work is not being spread. Both high means the fleet really is
saturated and another machine is the only answer.

### Running more than one task per machine

An agent runs one task at a time by default. `ALPHA_AGENT_CONCURRENCY=4` lets a
machine with cores to spare hold four leases at once, which is usually the
difference between two laptops doing two tasks and two laptops doing eight.

It composes with the load ceiling rather than fighting it: a machine that takes
on more than it can handle sees its own load climb and stops asking, so
concurrency raises the ceiling on a quiet machine without letting a busy one
overcommit. Set it from cores and from what the handlers actually do — CPU-bound
work wants roughly one per core, work that mostly waits on I/O can go higher.

On shutdown an agent now waits up to two seconds for its running tasks to
report before it disconnects. Disconnecting first turns those reports into
`410`s, and the host then sits out the whole lease before re-running work that
had in fact succeeded.

### Parking data in the laptop's RAM

The `memstore` handler turns the laptop into a keyed, in-memory store the host
can address over the tunnel: a cache, an embedding batch, an intermediate
result the host would rather not keep resident. It is **not registered by
default** — holding data costs the RAM it costs — so turn it on per machine:

```bash
ALPHA_EXTRA_HANDLERS=memstore
```

One task type, `memory.store`, with an action:

```bash
npm run admin -- mem --action put --key embeddings/batch-1 --value '[0.1,0.2]'
npm run admin -- mem --action get --key embeddings/batch-1
npm run admin -- mem --action keys --prefix embeddings/
npm run admin -- mem --action delete --key embeddings/batch-1
npm run admin -- mem --action stats     # usage here, and the machine's own RAM
npm run admin -- mem --action clear
```

`--ttl-ms` puts an expiry on an entry. The store is bounded by
`ALPHA_MEMSTORE_LIMIT_MB` and evicts least-recently-used entries to stay inside
it — an unbounded cache on the machine whose spare RAM is the whole point is a
memory leak with a nicer name. Values are held as their serialized JSON, so the
byte counts in `stats` are real rather than an estimate of an object graph, and
a value larger than the per-entry limit is refused rather than allowed to evict
everything else.

Nothing here survives a restart of the agent. It is a cache, not a database.

## Adding a handler

A handler is a module exporting `type`, `run`, and optionally `description`:

```js
// src/agent/handlers/disk-free.js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const type = 'disk-free';
export const description = 'Reports df -h for the root filesystem.';

export async function run(payload, { signal }) {
  const { stdout } = await promisify(execFile)('df', ['-h', '/'], { signal });
  return { output: stdout };
}
```

Register it in `src/agent/handlers/index.js` by adding it to `BUILTIN`. The
agent advertises exactly the types it has handlers for, and refuses to start if
`ALPHA_AGENT_CAPABILITIES` names one it cannot run.

`run` receives `(payload, { signal, taskId, attempt, log })`. The `signal`
aborts shortly before the lease expires — honour it for anything long-running
so the failure is reported by the agent rather than showing up as an
unexplained lease expiry.

## Wiring into Alpha's coordination tunnel

`src/agent/handlers/alpha-coordination.js` drives Alpha's
`scripts/alpha_coordination_tunnel.ps1` from a task, so a remote actor can
claim paths, post receipts and release through an agent running on the Alpha
host.

It is **not registered by default** — it is the one handler that runs an
external program, so enabling it is a deliberate per-machine decision. Turn it
on with configuration rather than a code edit:

```bash
ALPHA_EXTRA_HANDLERS=alpha-coordination
```

Handler names there are restricted to a simple charset, so the value cannot
reach outside `src/agent/handlers/`, and an unknown or malformed name stops the
agent rather than letting it start silently missing a capability.

Configure the host agent:

| Variable | Meaning |
|---|---|
| `ALPHA_REPO_ROOT` | Alpha working copy. Required. |
| `ALPHA_COORDINATION_SCRIPT` | Script path relative to root. Defaults to `scripts/alpha_coordination_tunnel.ps1`. |
| `ALPHA_POWERSHELL` | Interpreter. Defaults to `powershell.exe`. |
| `ALPHA_COORDINATION_ACTOR` | Default actor when a task does not name one. |
| `ALPHA_EXTRA_HANDLERS` | Comma-separated opt-in handlers. Set to `alpha-coordination`. |

On the Alpha host, `npm run setup:host -- --email you@example.com --alpha-root
C:\path\to\alpha` does the whole provisioning in one command: config, admin
account, a key scoped to `agent:connect`, a verified round-trip task, and it
removes the bootstrap token when it is done.

Full walkthrough, including Tailscale and running both processes as services:
**[docs/HOST_SETUP.md](docs/HOST_SETUP.md)**.

Then coordinate from the CLI:

```bash
npm run admin -- coord --action Status --actor alpha-host

npm run admin -- coord --action Post --actor claude-cowork \
  --message "Receipt: wired the interaction pack into Alpha." \
  --paths "software/backend/main.py,memory/knowledge/pack.json"
```

Or as a plain task, which is what `coord` builds:

```bash
npm run admin -- task --type alpha.coordination \
  --payload '{"action":"Init","actor":"claude-cowork"}'
```

The result carries `exitCode`, `stdout` and `stderr`. A non-zero exit — a
refused claim, say — is returned as data rather than thrown, because that is a
real answer from the tunnel and not a failure of the task.

**How it stays safe.** Arguments go to `execFile` as an argv array, so nothing
is ever interpolated into a command line: a message containing `;`, `&&` or
backticks is data. The executable and script are both pinned, the script must
live inside `ALPHA_REPO_ROOT`, the action must be on an allowlist, actor names
are constrained, and paths must be repo-relative with no `..` traversal, no
drive letters and no commas (the argv joins on commas).

**Verified against the real script.** All five actions and the argv shape were
confirmed on the Alpha host: `Init` and `Post` from observed usage, and
`Status`, `Claim` and `Release` by running a claim cycle through this handler
and reading the held path back from `Status`. The comma-joined `-Paths` form
binds as intended.

The tests pin the exact argv, so if the script's contract ever changes, adjust
`buildArgs` and the expectation moves with it.

## Keeping both machines on the same version

Two things travel with every registration, and they are not the same thing:

- **`PROTOCOL_VERSION`** (`src/common/protocol.js`) is the wire contract. It is
  a hard gate — the host answers a mismatched agent with `409` at registration
  rather than letting it fail halfway through a task. Bump it when a field
  changes meaning.
- **The release** — `version` in `package.json`, exported as `ALPHA_VERSION`
  from `src/common/version.js` — is which checkout the machine is running. Two
  laptops can speak protocol 1 and still be days apart: different handlers,
  different defaults, different bugs. That is drift, not incompatibility, so
  the host attaches the agent and makes the difference visible instead.

Where the drift shows up:

```bash
alpha-admin version    # this checkout vs. the host, from either machine
alpha-admin agents     # a VERSION column; drifted machines are marked *
```

```
NAME     PRINCIPAL  VERSION    CAPABILITIES  RAM    FREE   HELD  CPU  RUN  IDLE
-------  ---------  ---------  ------------  -----  -----  ----  ---  ---  ----
tower    key_a1b2   0.3.0      echo,sysinfo  32768M 21014M 0M    12%  1    2s
laptop   key_c3d4   0.2.0 *    echo,sysinfo  16384M  9210M 0M    -    0    4s

* not the host's version (0.3.0). Update laptop so every machine runs the same version.
```

The `-` under `CPU` on the drifted machine is the same story told twice: 0.2.0
predates load reporting, so that laptop cannot say how busy it is and the host
ranks it as unknown rather than idle. Getting both machines onto one version is
what turns it back into a number.

`GET /healthz` reports the host's `version` alongside `protocolVersion`, so
`scripts/setup-agent.mjs` says which release each side is on before a worker
attaches, and both the host and the agent log a warning when they differ.

To bring a machine into line, `git pull` there and restart it — the version is
read from `package.json`, so there is nothing else to keep in step. An agent
built before this existed reports no version at all; it still attaches, and
shows as `-`.

## Security

- **Keep the host bound to `127.0.0.1` or a Tailscale address.** `0.0.0.0` puts
  the coordinator on every interface; the host logs a warning if you do that.
- **Prefer an already-encrypted link** (Tailscale, SSH tunnel). Scopes and
  revocation do nothing about a token read off the wire in plain HTTP.
- **Remove the bootstrap token once a real admin exists.** It is unscoped,
  unattributable, and cannot be revoked without an environment change and a
  restart.
- **Give each agent its own key**, scoped to `agent:connect` only. That key
  cannot queue work, read results, or touch accounts, and revoking it affects
  only that machine.
- **There is deliberately no shell-exec handler.** Registering one turns
  `agent:connect` into remote code execution on the agent machine. If you want
  that, write it yourself, scope it to specific commands, and know what you are
  enabling.
- **Back up `ALPHA_AUTH_STORE`.** It is the only copy of your accounts. The
  host refuses to start rather than overwrite a store it cannot parse, because
  silently starting empty would un-revoke every revoked credential and lock out
  every real user.
- Login is throttled (8 failures, then a 15-minute lockout per email) and
  returns an identical response for an unknown account and a wrong password,
  including matching timing, so it cannot be used to enumerate users.

## Tests

```bash
npm test
# on Windows PowerShell, where npm.ps1 may be blocked by execution policy:
node --test test/*.test.js
```

114 tests across five suites, booting a real host and a real agent over
loopback rather than mocking the transport.

`test/tunnel.test.js` (26) — registration, dispatch, long-poll handoff, lease
expiry and requeue, retry exhaustion, capability matching, protocol version
mismatch, release-version reporting (recorded, surfaced, and never a reason to
refuse an agent), stale-holder result rejection, reconnecting when an agent
starts before its host, and serving several bind addresses from one
coordinator.

`test/auth.test.js` (32) — password hashing and salting, token parsing and
forgery, scope normalization and escalation refusal, the full invite lifecycle
(single use, expiry, revocation, tampering), per-key scope confinement, live
scope narrowing, a narrow key staying narrow under an admin owner,
disable-kills-everything, key expiry, login and lockout behaviour, session
revocation on password change, persistence across restart, refusal to start on
a corrupt store, and assertions that no plaintext secret ever reaches disk.

`test/memory.test.js` (32) — memory reporting and its validation, placement by
free RAM, reservations held for the life of a lease and handed back on
completion, cancellation and lease expiry, staleness treated as unknown, and
the store's LRU eviction, TTL expiry, per-entry limit, byte accounting and
action dispatch — ending with a host that parks a value in an agent's RAM over
the tunnel and reads it back.

`test/setup-agent.test.js` (6) — the worker-provisioning decisions: the default
reserve's floor and cap, host URLs that are not URLs, the configuration it
writes, and that the store and a capability list appear only when asked for.

`test/alpha-coordination.test.js` (16) — action allowlisting, actor and path
validation (traversal, drive letters, commas), argv construction asserted
against a stub interpreter that records exactly what it was handed (including a
message full of shell metacharacters), and the opt-in mechanism refusing
handler names that could escape the handlers directory.

## Layout

```
src/common/      protocol, version, HTTP client, backoff, logging, env
src/host/        queue, agent registry, HTTP server, entrypoint
src/host/auth/   scopes, scrypt passwords, token minting, store, auth service
src/agent/       run loop, handler registry, handlers, memory report + store
src/admin/       alpha-admin CLI
bin/             alpha-host, alpha-agent, alpha-admin
scripts/         one-command setup for the host and for a worker
test/            integration + unit tests
docs/            host setup walkthrough
```

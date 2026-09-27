# Moving the coordinator to another machine

Retiring the coordinator on one machine and standing it up on another —
specifically, moving it off the Alpha host onto a laptop and making that laptop
the one the fleet dials.

This is a supported move and a smaller one than it looks, because of what the
coordinator is: a task queue and an account store behind an HTTP listener. It
holds no working copy of Alpha and runs no external program. `docs/HOST_SETUP.md`
puts it plainly — *"The coordinator can live anywhere both sides can reach... you
can move the coordinator later without touching the agent."*

## What moves, and what cannot

| Piece | Moves? | Why |
|---|---|---|
| coordinator (`node src/host/index.js`) | **yes** | listens; holds queue + accounts, nothing machine-specific |
| `data/auth.json` | **yes, by hand** | the only copy of your accounts — see below |
| `data/receipts.json` | **yes, by hand** | the ledger; leaving it behind resets a quota gate — see below |
| agent on the Alpha host (`node src/agent/index.js`) | **no** | must stay |
| queued and in-flight tasks | **no** | the queue is in memory |

**The agent on the Alpha machine stays there.** `alpha.coordination` drives
`scripts/alpha_coordination_tunnel.ps1` inside `ALPHA_REPO_ROOT`, so the agent
offering that type has to sit beside the Alpha working copy. After the move the
topology is: coordinator on the laptop, Alpha-host agent dialling *out* to it
across the tailnet, coordination tasks still executing on the Alpha box. Nothing
about the move puts the tunnel script on the laptop, and nothing needs to —
agents only ever dial out, so the coordinator moving is invisible to them beyond
one URL.

## Do not use `setup-host.mjs` for this

`scripts/setup-host.mjs` provisions a *new* deployment. Pointed at a migration it
does the wrong three things: it requires `--email` and creates another admin
account, it issues a fresh agent key you do not need, and it writes a live
`ALPHA_BOOTSTRAP_TOKEN` into `.env`. That last one does not self-disable against
a populated store — `AuthService.load()` only logs a warning when a bootstrap
token is set and users already exist (`src/host/auth/service.js:130`), so the
break-glass credential stays *accepted*. You would finish the migration with a
duplicate admin and a second way in.

Use the manual path instead: step 3 of `docs/HOST_SETUP.md` for `.env`, step 8
for the bind list, and **skip steps 4-7 entirely** — the accounts already exist
in the store you are about to copy.

## The store is the migration

`data/auth.json` holds every user, key and invite. Copy it and the fleet's
credentials survive; recreate it and every key in the fleet is void.

Because the keys survive, **no agent needs re-keying.** Each one needs exactly
one thing changed: `ALPHA_HOST_URL` in its `.env.agent`. An agent key
authenticates the agent to whichever coordinator holds the store, and the store
is coming with you.

Two guards worth knowing before you copy:

- The coordinator **refuses to start rather than overwrite a store it cannot
  parse** (`src/host/auth/store.js:69`), and refuses a store whose `version`
  it does not recognise. Silently starting empty would un-revoke every revoked
  credential, so a bad copy fails loudly instead of quietly widening access.
- Copy it while the old coordinator is **stopped**. Copying a file that is being
  written is how you get the unparseable store above.

## The second file: `data/receipts.json`

`auth.json` is the one that voids credentials if you lose it, so it gets the
attention. There is a second stateful file, and leaving it behind fails quietly
rather than loudly.

The receipt ledger (`src/host/receipts.js`, `ALPHA_RECEIPT_STORE`, default
`./data/receipts.json`) is the durable record of every task that finished — the
queue is in memory, so without it "how many renders ran last night" has no
answer after a restart. Nothing reads it to make a *dispatch* decision, which is
why a corrupt ledger does not stop the coordinator the way a corrupt auth store
does. But `scripts/alpha-manager.mjs` reads it for two things, and both degrade
silently if the new coordinator starts with an empty one:

- **Seed continuation.** The manager continues seeds from the highest already
  recorded for a species, precisely so a scheduled pass makes new creatures
  rather than re-rendering the same ones. An empty ledger restarts the sequence,
  and the fleet spends its next passes reproducing renders it already has.
- **The quota gate.** `--max-per-window` refuses a pass when that many renders
  already finished inside `--window`. It counts them *from the ledger*. An empty
  ledger reads as "nothing has run", so the quota resets to its full allowance
  the moment the new coordinator comes up — the bound is briefly not a bound, on
  exactly the unattended loop it exists to cap.

So copy it alongside `auth.json`. The same rule applies — copy it with the old
coordinator stopped — and the failure mode is gentler: a ledger the new host
cannot parse is moved aside, kept, and the ledger starts empty *loudly*, rather
than blocking the coordinator.

## Runbook

Throughout: `<LAPTOP_TS_IP>` is the laptop's tailnet address from
`tailscale ip -4`, run **on the laptop**.

### 1. Capture the state you are about to drop

On the old host, before stopping anything:

```powershell
node src/admin/run.js agents
node src/admin/run.js tasks
node src/admin/run.js stats
```

Save all three. The queue is in memory, so whatever `tasks` shows as queued or
running is gone the moment the coordinator stops — including any long-running
work. Short coordination tasks you simply re-issue afterwards; anything you
cannot re-issue from scratch, let it finish first.

### 2. Stop the old coordinator, and stop it from coming back

```powershell
nssm stop alpha-coordinator
sc.exe config alpha-coordinator start= demand
```

Stopping it is not retiring it. `docs/HOST_SETUP.md` step 9 installs the
coordinator as `delayed-auto`, so a stopped service is one reboot away from
waking up beside the new one — and then you have two queues and two account
stores, with agents split across them by whatever URL each was handed. That is
the split brain `standby-alpha.mjs` is careful about, except permanent and
without the health check that heals it. Setting it to `demand` is what closes
that. `nssm remove alpha-coordinator confirm` is the stronger version, once the
migration has proven out.

**Then break the service dependency, or the Alpha host's agent will not start
again.** Step 9 of `HOST_SETUP.md` wires the agent to wait for the coordinator
that used to sit beside it:

```powershell
nssm set alpha-agent DependOnService alpha-coordinator
```

With the coordinator retired, that dependency is unsatisfiable and Windows will
refuse to start the agent at boot — the machine comes back with no worker on it
and the failure looks like the agent crashing rather than never being started.
Clear it:

```powershell
nssm set alpha-agent DependOnService ""
nssm restart alpha-agent
```

**Then check for `run-coordinator.cmd`.** It is the unelevated way to keep the
coordinator up — a `:loop` that restarts `node src\host\index.js` after any
exit, by design, *"instead of leaving the host silently absent"*. If the old host
was started that way rather than by service, nothing in the two commands above
touches it: the loop notices node has gone and brings the retired coordinator
straight back, on a ten-second delay, and you get the two-coordinator split
anyway. Close the window it runs in, or end the `cmd.exe` holding the loop —
killing only `node` is what the loop exists to survive. Check Task Scheduler and
the `shell:startup` folder for it too, since it needs no elevation to be there.

Counting the service, its auto-start, and this loop, there are three independent
ways the old coordinator comes back. Verify rather than assume: from the laptop,
`curl http://<OLD_HOST_TS_IP>:8787/healthz` should fail to connect. `/healthz` is
the only unauthenticated GET, so it answers this without a token.

The agent service itself keeps running. It is going to keep doing exactly what it
did; it just dials somewhere new in step 5.

### 3. Copy the store to the laptop

Both stateful files, not just the accounts:

```powershell
Copy-Item C:\services\alpha-tunnel\data\auth.json     \\LAPTOP41\...\alpha-tunnel\data\auth.json
Copy-Item C:\services\alpha-tunnel\data\receipts.json \\LAPTOP41\...\alpha-tunnel\data\receipts.json
```

Any transport is fine. Keep copies on the old host as your rollback, and treat
`auth.json` as a secret in transit — it is hashes and scrypt digests rather than
plaintext, but it is still the whole access surface of the fleet.

### 4. Bring the coordinator up on the laptop

Clone the repo if it is not already there, then write `.env` **without** a
bootstrap token:

```ini
ALPHA_HOST_PORT=8787
ALPHA_HOST_BIND=127.0.0.1,<LAPTOP_TS_IP>
ALPHA_AUTH_STORE=./data/auth.json
```

Both addresses, comma-separated: the coordinator opens one listener per address
sharing a single queue and store. The tailnet address is what the Alpha-host
agent and every other machine reaches; `127.0.0.1` is for an agent on this
laptop and for `alpha-admin` run locally, and it keeps both working if Tailscale
drops. Prefer listing addresses over `0.0.0.0`, which would put the coordinator
on every interface including any public one — the host logs a warning if you do.

```bash
node src/host/index.js
```

It logs the addresses it bound. Two failures to recognise:

- `cannot bind ... it is not an address on this machine` — the tailnet address is
  mistyped. Re-check `tailscale ip -4`.
- a parse or version error naming `auth.json` — the copy in step 3 is bad. Recopy
  from the source with the old coordinator stopped.

It may also wait rather than fail: `ALPHA_BIND_WAIT_MS` exists because at boot
Tailscale has not yet assigned `100.x`. A port genuinely in use still fails fast.

Once it proves out, keep it up deliberately rather than in a terminal — see
*What this move does not give you* below. If you use `run-coordinator.cmd` for
that, **edit the path in it**: it hard-codes `cd /d C:\services\alpha-tunnel`,
and on a laptop whose checkout is elsewhere the loop will restart node in the
wrong directory every ten seconds, reading a different `.env` or none.

### 5. Repoint every agent

On each machine, change the one line in `.env.agent`:

```ini
ALPHA_HOST_URL=http://<LAPTOP_TS_IP>:8787
```

Then restart that agent. Do the Alpha host's agent too — it used to reach the
coordinator over loopback and now crosses the tailnet.

Leave `ALPHA_AGENT_KEY` as it is. The key is still valid, because the store came
with you; reissuing keys here is work that buys nothing and invalidates your
rollback.

**Check the service configuration too.** `HOST_SETUP.md` step 9 offers
`nssm set alpha-agent AppEnvironmentExtra ALPHA_HOST_URL=...` as an alternative to
`.env.agent`. If the host's agent was installed that way, the URL in the service
configuration wins and editing `.env.agent` changes nothing — you would restart
the agent and watch it dial the retired coordinator anyway. Read it back with
`nssm get alpha-agent AppEnvironmentExtra` and set it there instead if that is
where it lives.

`node scripts/setup-agent.mjs --host http://<LAPTOP_TS_IP>:8787 --force` is the
scripted equivalent and is safe to run beside a running agent — its attach check
passes a throwaway `ALPHA_AGENT_INSTANCE_ID` precisely so that proving the
configuration does not supersede the agent already lending from that machine.

**`.env.agent` is the right file, and `.env` does not override it.** The agent
loads `.env.agent` first and `.env` second (`src/agent/index.js:21-22`), and
`process.loadEnvFile` does not overwrite a variable that is already set — so the
*first* file to define `ALPHA_HOST_URL` wins. On a machine holding both, the
agent's own file takes precedence, which is what you want and worth knowing,
because the opposite assumption sends you editing the wrong file and concluding
the change did not take.

### 5b. Repoint `.env` as well, on every machine that has one

This is the step the agent's own configuration hides. Four tools read
`ALPHA_HOST_URL` from `.env` and never look at `.env.agent`:

| Tool | Loads | On the old host, now points at |
|---|---|---|
| `alpha-admin` (`src/admin/cli.js:9`) | `.env` | loopback — nothing listening |
| `scripts/watchdog.mjs:46` | `.env` | loopback |
| `scripts/run-jobs.mjs:23` | `.env` | loopback |
| `scripts/alpha-manager.mjs:42` | `.env` | loopback |

On the Alpha host `.env` was the *coordinator's* configuration, so
`ALPHA_HOST_URL` there was `http://127.0.0.1:8787` — or absent, which resolves to
the same default. Every one of those four now talks to a port with nothing behind
it, and each fails in its own unhelpful way: `alpha-admin` cannot connect, the
watchdog reports `HOST UNREACHABLE` and exits 1 about a fleet that is fine, and
`alpha-manager` — the one likeliest to be on a schedule — fails its pass quietly
into a log. Set it explicitly:

```ini
ALPHA_HOST_URL=http://<LAPTOP_TS_IP>:8787
```

**Then strip the coordinator's own keys from that file.** `ALPHA_HOST_PORT`,
`ALPHA_HOST_BIND`, `ALPHA_AUTH_STORE` and especially `ALPHA_BOOTSTRAP_TOKEN`
describe a coordinator this machine no longer runs. Leaving them costs nothing
while nothing reads them — but this is the machine with three ways to start a
coordinator again (step 2), and a revived one would come up on the old port
*with a live break-glass token*. Retiring the service and leaving its credentials
in place next to it is half a retirement.

### 6. Verify

From the laptop:

```bash
export ALPHA_HOST_URL=http://127.0.0.1:8787
export ALPHA_ADMIN_TOKEN=alpha_key_...      # your existing admin key
node src/admin/run.js whoami
node src/admin/run.js agents
```

`whoami` answering with your existing account is the store having survived.
Then `agents` against the list you saved in step 1 — every machine back, with the
same names and the same covered types. Allow up to `AGENT_STALE_MS` (90s) for a
restarted agent to appear, and remember a registration only shows up once the
agent has polled.

End to end, with a task that actually runs on the Alpha box:

```bash
node src/admin/run.js task --type sysinfo --agent <alpha-host-agent-name>
node src/admin/run.js coord --action Status
```

`sysinfo` proves dispatch and result reporting across the new link.
`coord` proves the coordination tunnel still reaches the Alpha working copy from
a coordinator that is no longer on it — the one thing this move could plausibly
have broken, and the reason the agent stayed put.

Re-queue anything step 1 showed you dropping.

### 7. Rollback

You have not destroyed anything until you delete the old store, so do not.
Reverting is: stop the laptop's coordinator, set the old service back to
automatic and start it, revert `ALPHA_HOST_URL` on each agent, restart them. The
old `auth.json` is still the same file the fleet's keys were minted against, so
it is valid again by virtue of never having changed.

## What this move does not give you

The laptop is now a single point of failure for the queue and the accounts, on a
machine likelier to be closed, moved or suspended than the one it came from. Two
things follow:

- **Back up `data/auth.json` from its new home.** It is still the only copy.
- **Keep it always on deliberately.** `docs/ALWAYS_ON.md` covers installing the
  coordinator as a service that restarts on failure and starts after Tailscale.
  A coordinator started from a terminal ends when the terminal does.

Neither is HA, and this document is not claiming otherwise. `standby-alpha.mjs`
covers *Alpha* being down, not the coordinator; nothing here adds a quorum, and a
laptop holding the fleet's queue is a laptop whose lid matters.

### The lid, and why the existing advice reads differently now

`docs/AUTO_UPDATE.md` already has the power settings, under **Keeping a worker
laptop awake**, and the commands there are unchanged — use them. What changes is
the reasoning around them, because every reassurance in that section is a
property of a *worker*, not of a coordinator:

| When the lid closes | Worker laptop | Coordinator laptop |
|---|---|---|
| Who notices | the host prunes it after `AGENT_STALE_MS` | every agent at once; nobody is left to notice |
| Work in flight | lease expires, requeued elsewhere — **nothing is lost** | the queue **was** on this machine, in memory; it is gone |
| Recovery | rejoins on its own when it wakes, no manual step | agents reconnect, but the queue does not come back |
| Blast radius | one machine's capacity | the whole fleet, plus every `alpha-admin` and scheduled pass |

So the worker section's "nothing is lost — that is what leases are for" does not
transfer. Leases protect work *held by an agent* from that agent vanishing;
nothing protects the queue from the machine the queue lives on vanishing. On
Laptop41 the power settings stop being hygiene and become the thing standing
between a closed lid and a fleet-wide outage.

One deliberate piece of that advice to re-read rather than copy: **"Only on mains
power."** For a worker, leaving the battery settings alone is correct — a machine
about to disappear should not be taking work, and dropping out of the fleet is
the right behaviour. For the coordinator it is the opposite: unplugging Laptop41
now ends the fleet on the battery timeout. The commands stay AC-scoped (disabling
sleep on battery still flattens the machine, which fixes nothing), so the real
mitigation is not a power setting at all — it is that **the coordinator belongs on
a machine that stays plugged in**, and Laptop41 has to be treated as that machine
rather than as a laptop that happens to run it.

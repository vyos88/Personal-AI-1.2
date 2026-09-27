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

The agent service itself keeps running. It is going to keep doing exactly what it
did; it just dials somewhere new in step 5.

### 3. Copy the store to the laptop

```powershell
Copy-Item C:\services\alpha-tunnel\data\auth.json \\LAPTOP41\...\alpha-tunnel\data\auth.json
```

Any transport is fine. Keep a copy on the old host as your rollback, and treat
the file as a secret in transit — it is hashes and scrypt digests rather than
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

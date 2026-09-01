# Host setup — running the coordination tunnel on the Alpha machine

How to get an agent running on the Alpha host (the Windows machine holding the
Alpha working copy) so remote actors can drive
`scripts/alpha_coordination_tunnel.ps1` by queueing tasks.

Everything below runs on the Alpha host unless a step says otherwise.

## Which process goes where

Two processes, and the names are easy to mix up:

- **coordinator** (`node src/host/index.js`) — holds the task queue and the accounts. It
  listens.
- **agent** (`node src/agent/index.js`) — does the work. It dials out; it never listens.

The coordination script lives in the Alpha working copy, so **the agent must run
on the Alpha machine**. The coordinator can live anywhere both sides can reach.
Start with both on the Alpha host — it is the fewest moving parts, and you can
move the coordinator later without touching the agent.

```
        ALPHA HOST (Windows, DESKTOP-41HPLCN)
  ┌──────────────────────────────────────────────┐
  │  coordinator  :8787   ◀── Tailscale ──  laptop / cloud session │
  │       ▲                                      │   queue tasks over HTTP
  │       │ long-poll (outbound)                 │
  │  agent ──▶ powershell.exe -File              │
  │              scripts\alpha_coordination_tunnel.ps1 │
  │            in ALPHA_REPO_ROOT                │
  └──────────────────────────────────────────────┘
```

## A note on `npm` and PowerShell

PowerShell's default execution policy blocks `npm.ps1`, so `npm run ...` fails
with `running scripts is disabled on this system`. Commands in this guide therefore
call `node` directly; if npm works in your shell, these are the equivalents:

| Instead of | Run |
|---|---|
| `npm run host` | `node src/host/index.js` |
| `npm run agent` | `node src/agent/index.js` |
| `npm run admin -- <args>` | `node src/admin/run.js <args>` |
| `npm run setup:host -- <args>` | `node scripts/setup-host.mjs <args>` |
| `npm test` | `node --test test/*.test.js` |

`npm.cmd run ...` also works. Or change the policy for your account, which is a
system setting and therefore your call:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

The NSSM service commands in step 9 invoke `node` directly and are unaffected,
as is the coordination handler itself — it already passes
`-ExecutionPolicy Bypass` when it runs the tunnel script.

## The short version

Steps 2-7 below are automated. On the Alpha host:

```powershell
cd C:\services
git clone https://github.com/vyos88/Personal-AI-1.2 alpha-tunnel
cd alpha-tunnel

node scripts/setup-host.mjs --email you@example.com --alpha-root C:\path\to\alpha

# or, if npm works in your shell:
# node scripts/setup-host.mjs --email you@example.com --alpha-root C:\path\to\alpha
```

That generates a bootstrap token, writes `.env`, starts the coordinator,
prompts for a password, creates your admin account, issues the agent a key
scoped to `agent:connect` only, writes `.env.agent`, proves the whole loop with
a round-trip task, then **removes the bootstrap token again** and prints your
admin key plus the service commands.

Afterwards `node src/host/index.js` and `node src/agent/index.js` need no environment variables —
both read the files setup wrote.

It refuses to overwrite an existing `.env` unless you pass `--force`, and the
password is prompted for rather than taken as an argument. Add
`--skip-coordination` to provision without enabling the tunnel handler.

The rest of this document is the same thing done by hand, plus the parts setup
cannot do for you: exposing the coordinator over Tailscale (step 8), installing
services (step 9), and confirming the script's real contract.

---

## 1. Prerequisites

```powershell
node --version          # need v20 or newer
$PSVersionTable.PSVersion
Test-Path C:\path\to\alpha\scripts\alpha_coordination_tunnel.ps1
```

If Node is missing, install the LTS build from nodejs.org or `winget install
OpenJS.NodeJS.LTS`, then open a new terminal so `PATH` picks it up.

Note the **full path to the Alpha working copy** — the folder containing
`scripts\`, `software\` and `memory\`. That is `ALPHA_REPO_ROOT` throughout.

## 2. Get this repository onto the host

```powershell
cd C:\services
git clone https://github.com/vyos88/Personal-AI-1.2 alpha-tunnel
cd alpha-tunnel
```

No `npm install` — there are no runtime dependencies.

```powershell
node --test test/*.test.js      # 66 tests, all should pass
```

## 3. Configure and start the coordinator

```powershell
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Put that value in `.env` as `ALPHA_BOOTSTRAP_TOKEN`, and set:

```ini
ALPHA_HOST_PORT=8787
ALPHA_HOST_BIND=127.0.0.1
ALPHA_AUTH_STORE=./data/auth.json
ALPHA_BOOTSTRAP_TOKEN=<the value you just generated>
```

Leave `ALPHA_HOST_BIND` on loopback for now. Step 8 covers reaching it from
other machines properly.

```powershell
node src/host/index.js
```

Leave it running and open a second terminal for the rest.

## 4. Create your admin account

```powershell
cd C:\services\alpha-tunnel
$env:ALPHA_HOST_URL = "http://127.0.0.1:8787"
$env:ALPHA_ADMIN_TOKEN = "<your ALPHA_BOOTSTRAP_TOKEN>"

node src/admin/run.js bootstrap-admin --email you@example.com
```

That prints a one-time invite token. Redeem it — you will be prompted for a
password, which is never passed on the command line:

```powershell
node src/admin/run.js redeem --token 'alpha_inv_...'
```

It prints your **API key**. Save it; it is shown once. From here on that is
your `ALPHA_ADMIN_TOKEN`.

```powershell
$env:ALPHA_ADMIN_TOKEN = "alpha_key_..."
node src/admin/run.js whoami
```

**Now remove `ALPHA_BOOTSTRAP_TOKEN` from `.env` and restart the coordinator.**
It is an unscoped, unattributable credential; once a real admin exists it is
only a liability. The coordinator warns on every start while it is still set
alongside real users.

## 5. Issue the agent its own key

Take the `userId` from `whoami`:

```powershell
node src/admin/run.js issue-key --user user_xxxxxxxx --scopes agent --name alpha-host-agent
```

`--scopes agent` grants exactly `agent:connect`: this key can pull and complete
tasks, and nothing else. It cannot queue work, read results, or touch accounts.
Copy the `alpha_key_...` it prints — the full token, including the part after
the dot, not the shorter fingerprint on the first line.

## 6. Configure and start the agent

`scripts/setup-host.mjs` writes all of this to `.env.agent`, which the agent reads
automatically — the agent loads `.env.agent` first, then `.env`, and a real
environment variable beats both. To do it by hand, in a third terminal:

```powershell
cd C:\services\alpha-tunnel

$env:ALPHA_HOST_URL   = "http://127.0.0.1:8787"
$env:ALPHA_AGENT_KEY  = "alpha_key_..."          # from step 5
$env:ALPHA_AGENT_NAME = "alpha-host"

# Turn on the coordination handler. It is off by default because it runs an
# external program, so enabling it is a deliberate per-machine decision.
$env:ALPHA_EXTRA_HANDLERS = "alpha-coordination"
$env:ALPHA_REPO_ROOT      = "C:\path\to\alpha"
$env:ALPHA_POWERSHELL     = "powershell.exe"     # or the path to pwsh.exe

node src/agent/index.js
```

You should see `registered extra handler` and then `alpha.coordination` in the
`handlers available` line. If you would rather keep these in a file, put them in
`.env` instead — real environment variables win over the file either way.

## 7. Verify it end to end

```powershell
node src/admin/run.js agents
```

The agent should be listed with `alpha.coordination` among its capabilities.
Now drive the tunnel with a read-only action first:

```powershell
node src/admin/run.js coord --action Status --actor alpha-host
```

That queues the task, waits for the agent to run it, and prints the script's
exit code, stdout and stderr. A healthy tunnel answers something like
`tunnel ready, no paths held`.

Once `Status` looks right:

```powershell
node src/admin/run.js coord --action Init --actor claude-cowork

node src/admin/run.js coord --action Post --actor claude-cowork `
  --message "Receipt: coordination handler wired up and verified." `
  --paths "software/backend/main.py,memory/knowledge/pack.json"
```

A **non-zero exit code with the task still `succeeded` is not a bug**: the task
ran, and the script answered no — a contested claim, say. The CLI spells that
out rather than leaving you to wonder.

`node src/admin/run.js tasks` lists recent tasks; add `--json` to any command for raw
output. If a task sits in `queued`, no attached agent offers that type — check
`ALPHA_EXTRA_HANDLERS` on the agent.

## 8. Reach it from the laptop and cloud sessions

Only after step 7 passes locally. Find this machine's tailnet address:

```powershell
tailscale ip -4
```

Then in `.env`, **keep loopback and add it**:

```ini
ALPHA_HOST_BIND=127.0.0.1,100.x.y.z
```

Both, not just the tailnet address. `ALPHA_HOST_BIND` is a comma-separated
list, and the coordinator opens one listener per address sharing a single queue
and account store. Keeping `127.0.0.1` means the agent on this machine goes on
looping over loopback and is unaffected if Tailscale drops; replacing it would
couple a same-machine connection to the tailnet for no reason, and would break
the agent immediately, since `.env.agent` points at `http://127.0.0.1:8787`.

Prefer listing addresses over `0.0.0.0`, which puts the coordinator on every
interface including any public one. The host logs a warning if you do that.

Restart the coordinator. It logs the addresses it bound. If it exits with
`cannot bind ... it is not an address on this machine`, the tailnet address was
mistyped — re-check `tailscale ip -4`.

From the laptop:

```bash
export ALPHA_HOST_URL=http://100.x.y.z:8787
export ALPHA_ADMIN_TOKEN=alpha_key_...
node src/admin/run.js whoami
```

Give each remote actor its **own** key rather than sharing yours, so you can
revoke one without disturbing the others:

```powershell
node src/admin/run.js invite --email teammate@example.com --scopes operator
```

`operator` can queue, cancel and read tasks and see agents — enough to drive the
coordination tunnel, without the ability to hand out further access.

Traffic still crosses the network in plain HTTP. Tailscale encrypts the link;
if you are not on Tailscale, put this behind an SSH tunnel. Scopes and
revocation do nothing about a token read off the wire.

### Lending the laptop's RAM

The laptop attaches as an agent of its own, and the value of doing that is
usually its spare memory.

**On the host**, issue the laptop its own key:

```powershell
node src/admin/run.js issue-key --user <yourUserId> --scopes agent --name laptop
```

**On the laptop**, with this repository checked out, one command does the rest:

```bash
node scripts/setup-agent.mjs --host http://100.x.y.z:8787 --key alpha_key_... --memstore
```

It checks the host is reachable and that the key really is an `agent:connect`
key, decides how much RAM to offer (a quarter of the machine, floored at 512 MB
and capped at 4 GB — override with `--reserve-mb 2048`), writes `.env.agent`,
and then attaches for a moment to prove the loop before telling you it worked.
Add `--memstore` to let the host park data in the laptop's RAM as well;
`--capabilities echo,sysinfo` narrows what it will accept. It finishes by
printing the service command for whichever platform it ran on, so the laptop
keeps lending across reboots.

From then on, on the laptop:

```bash
node src/agent/index.js
```

To do it by hand instead, `.env.agent` is just:

```ini
ALPHA_HOST_URL=http://100.x.y.z:8787
ALPHA_AGENT_KEY=alpha_key_...
ALPHA_AGENT_NAME=laptop
ALPHA_AGENT_MEMORY_RESERVE_MB=2048
ALPHA_EXTRA_HANDLERS=memstore
```

The agent logs what it is offering on start, and the host shows it:

```bash
node src/admin/run.js agents      # RAM / FREE / HELD columns
node src/admin/run.js mem --action stats
```

From then on, work queued with `--min-memory-mb` lands on whichever attached
agent actually has the memory:

```bash
node src/admin/run.js task --type sysinfo --min-memory-mb 2048
```

A laptop that sleeps or leaves the network is pruned as stale like any other
agent, and its share of the memory simply stops being on offer; tasks that
needed it wait for it to come back rather than failing.

## 9. Survive a reboot

Run both processes as services so they come back on their own. With
[NSSM](https://nssm.cc):

```powershell
nssm install alpha-coordinator "C:\Program Files\nodejs\node.exe" "C:\services\alpha-tunnel\src\host\index.js"
nssm set alpha-coordinator AppDirectory C:\services\alpha-tunnel
nssm set alpha-coordinator AppStdout C:\services\alpha-tunnel\logs\host.log
nssm set alpha-coordinator AppStderr C:\services\alpha-tunnel\logs\host.log

nssm install alpha-agent "C:\Program Files\nodejs\node.exe" "C:\services\alpha-tunnel\src\agent\index.js"
nssm set alpha-agent AppDirectory C:\services\alpha-tunnel
nssm set alpha-agent AppEnvironmentExtra ALPHA_HOST_URL=http://127.0.0.1:8787 ALPHA_AGENT_KEY=alpha_key_... ALPHA_EXTRA_HANDLERS=alpha-coordination ALPHA_REPO_ROOT=C:\path\to\alpha ALPHA_AGENT_NAME=alpha-host
nssm set alpha-agent AppStdout C:\services\alpha-tunnel\logs\agent.log
nssm set alpha-agent AppStderr C:\services\alpha-tunnel\logs\agent.log

nssm start alpha-coordinator
nssm start alpha-agent
```

Set `ALPHA_LOG_FORMAT=json` for both if you want to parse those logs later.

The agent reconnects on its own when the coordinator restarts, and re-registers
if the coordinator has forgotten it, so start order does not matter.

Two things to protect:

- **`data\auth.json`** is the only copy of your accounts. Back it up. The
  coordinator refuses to start rather than overwrite a store it cannot parse,
  because silently starting empty would un-revoke every revoked credential.
- **`ALPHA_AGENT_KEY`** in the service config. Anyone who can read the service
  configuration can attach an agent.

## The verified contract

All five actions and the argv shape have been confirmed against the real
`alpha_coordination_tunnel.ps1`:

| Action | Confirmed by |
|---|---|
| `Init` | observed usage |
| `Post` | observed usage |
| `Status` | run through the handler, returned "tunnel ready, no paths held" |
| `Claim` | claim cycle, path reported held afterwards |
| `Release` | same cycle, path released afterwards |

`-Paths` is passed as one comma-joined token (`-Paths a/b.py,c/d.py`), which is
what PowerShell binds to a `[string[]]` parameter through `-File`. Confirmed by
claiming a path and reading it back from `Status`.

**If the script's contract changes**, two places need updating together:

- `ALLOWED_ACTIONS` in `src/agent/handlers/alpha-coordination.js` — an action
  not on that list is refused rather than forwarded, so a new action has to be
  added deliberately.
- `buildArgs` in the same file, if argument shapes change.

`test/alpha-coordination.test.js` pins the exact argv against a stub
interpreter that records what it was handed, so the expectation moves with the
fix and cannot drift silently. Re-run it after any change:

```powershell
node --test test/alpha-coordination.test.js
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Agent logs `401` and exits | Key revoked, wrong, or user disabled | Issue a new key; check `node src/admin/run.js keys` |
| Agent logs `403 insufficient_scope` | Key lacks `agent:connect` | Reissue with `--scopes agent` |
| Agent logs `410`, then re-registers | Coordinator restarted or pruned it | Normal. No action needed |
| Task stays `queued`, `agentAvailable: false` | No attached agent offers that type | Check `ALPHA_EXTRA_HANDLERS` is set on the agent |
| `ALPHA_REPO_ROOT is not set` | Agent cannot see the Alpha working copy | Set it in the agent's environment, not the coordinator's |
| `coordination script not found` | Wrong root, or script moved | Check `ALPHA_COORDINATION_SCRIPT` relative to root |
| `PowerShell not found` | `powershell.exe` not on `PATH` | Set `ALPHA_POWERSHELL` to the full path |
| Task fails `path must be repo-relative` | Absolute path or drive letter in `paths` | Pass paths relative to `ALPHA_REPO_ROOT` |
| Task fails `path must not contain a comma` | Comma in a path | Rename, or change `buildArgs` to a form that tolerates it |
| `exitCode` non-zero, task still `succeeded` | The script refused, e.g. a contested claim | Expected. Read `stderr` — the task ran fine, the tunnel said no |
| Coordinator refuses to start on the store | `auth.json` corrupt | Restore from backup; do not delete it |

## Quick reference

| Variable | Process | Meaning |
|---|---|---|
| `ALPHA_HOST_PORT` / `ALPHA_HOST_BIND` | coordinator | Where it listens |
| `ALPHA_AUTH_STORE` | coordinator | Accounts file. Back this up |
| `ALPHA_BOOTSTRAP_TOKEN` | coordinator | Break-glass. Remove after step 4 |
| `ALPHA_HOST_URL` | agent, CLI | Where the coordinator is |
| `ALPHA_AGENT_KEY` | agent | This agent's credential |
| `ALPHA_AGENT_NAME` | agent | Name in `/agents` |
| `ALPHA_AGENT_MEMORY_RESERVE_MB` | agent | RAM kept back; the rest is offered to the host |
| `ALPHA_EXTRA_HANDLERS` | agent | `alpha-coordination`, `memstore` |
| `ALPHA_MEMSTORE_LIMIT_MB` | agent | Budget for data the host parks here |
| `ALPHA_REPO_ROOT` | agent | Alpha working copy |
| `ALPHA_COORDINATION_SCRIPT` | agent | Defaults to `scripts/alpha_coordination_tunnel.ps1` |
| `ALPHA_POWERSHELL` | agent | Defaults to `powershell.exe` |
| `ALPHA_COORDINATION_ACTOR` | agent | Default actor when a task omits one |
| `ALPHA_ADMIN_TOKEN` | CLI | Credential the CLI uses |

On a worker machine, `node scripts/setup-agent.mjs --host <url> --key <key>`
writes the agent rows of this table for you, and proves them by attaching.

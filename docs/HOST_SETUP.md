# Host setup — running the coordination tunnel on the Alpha machine

How to get an agent running on the Alpha host (the Windows machine holding the
Alpha working copy) so remote actors can drive
`scripts/alpha_coordination_tunnel.ps1` by queueing tasks.

Everything below runs on the Alpha host unless a step says otherwise.

## Which process goes where

Two processes, and the names are easy to mix up:

- **coordinator** (`npm run host`) — holds the task queue and the accounts. It
  listens.
- **agent** (`npm run agent`) — does the work. It dials out; it never listens.

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

## The short version

Steps 2-7 below are automated. On the Alpha host:

```powershell
cd C:\services
git clone https://github.com/vyos88/Personal-AI-1.2 alpha-tunnel
cd alpha-tunnel

npm run setup:host -- --email you@example.com --alpha-root C:\path\to\alpha
```

That generates a bootstrap token, writes `.env`, starts the coordinator,
prompts for a password, creates your admin account, issues the agent a key
scoped to `agent:connect` only, writes `.env.agent`, proves the whole loop with
a round-trip task, then **removes the bootstrap token again** and prints your
admin key plus the service commands.

Afterwards `npm run host` and `npm run agent` need no environment variables —
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
npm test        # 66 tests, all should pass
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
npm run host
```

Leave it running and open a second terminal for the rest.

## 4. Create your admin account

```powershell
cd C:\services\alpha-tunnel
$env:ALPHA_HOST_URL = "http://127.0.0.1:8787"
$env:ALPHA_ADMIN_TOKEN = "<your ALPHA_BOOTSTRAP_TOKEN>"

npm run admin -- bootstrap-admin --email you@example.com
```

That prints a one-time invite token. Redeem it — you will be prompted for a
password, which is never passed on the command line:

```powershell
npm run admin -- redeem --token 'alpha_inv_...'
```

It prints your **API key**. Save it; it is shown once. From here on that is
your `ALPHA_ADMIN_TOKEN`.

```powershell
$env:ALPHA_ADMIN_TOKEN = "alpha_key_..."
npm run admin -- whoami
```

**Now remove `ALPHA_BOOTSTRAP_TOKEN` from `.env` and restart the coordinator.**
It is an unscoped, unattributable credential; once a real admin exists it is
only a liability. The coordinator warns on every start while it is still set
alongside real users.

## 5. Issue the agent its own key

Take the `userId` from `whoami`:

```powershell
npm run admin -- issue-key --user user_xxxxxxxx --scopes agent --name alpha-host-agent
```

`--scopes agent` grants exactly `agent:connect`: this key can pull and complete
tasks, and nothing else. It cannot queue work, read results, or touch accounts.
Copy the `alpha_key_...` it prints — the full token, including the part after
the dot, not the shorter fingerprint on the first line.

## 6. Configure and start the agent

`npm run setup:host` writes all of this to `.env.agent`, which the agent reads
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

npm run agent
```

You should see `registered extra handler` and then `alpha.coordination` in the
`handlers available` line. If you would rather keep these in a file, put them in
`.env` instead — real environment variables win over the file either way.

## 7. Verify it end to end

From the admin terminal:

```powershell
npm run admin -- whoami
curl.exe -s -H "Authorization: Bearer $env:ALPHA_ADMIN_TOKEN" http://127.0.0.1:8787/agents
```

The agent should be listed with `alpha.coordination` among its capabilities.
Now drive the tunnel with a read-only action first:

```powershell
curl.exe -s -X POST http://127.0.0.1:8787/tasks `
  -H "Authorization: Bearer $env:ALPHA_ADMIN_TOKEN" `
  -H "content-type: application/json" `
  -d '{\"type\":\"alpha.coordination\",\"payload\":{\"action\":\"Status\",\"actor\":\"alpha-host\"}}'
```

Then fetch the result with the returned id:

```powershell
curl.exe -s -H "Authorization: Bearer $env:ALPHA_ADMIN_TOKEN" http://127.0.0.1:8787/tasks/task_xxxx
```

Check `result.exitCode`, `result.stdout` and `result.stderr` against what the
script does when you run it by hand. **Confirm the argv shape before trusting
`Claim` or `Release`** — see "Verify the contract" below.

Once `Status` looks right, an `Init` and a `Post`:

```powershell
curl.exe -s -X POST http://127.0.0.1:8787/tasks `
  -H "Authorization: Bearer $env:ALPHA_ADMIN_TOKEN" `
  -H "content-type: application/json" `
  -d '{\"type\":\"alpha.coordination\",\"payload\":{\"action\":\"Init\",\"actor\":\"claude-cowork\"}}'
```

## 8. Reach it from the laptop and cloud sessions

Only after step 7 passes locally. Bind the coordinator to the host's Tailscale
address rather than `0.0.0.0`:

```ini
ALPHA_HOST_BIND=100.x.y.z
```

Restart the coordinator, then from the other machine:

```bash
export ALPHA_HOST_URL=http://100.x.y.z:8787
export ALPHA_ADMIN_TOKEN=alpha_key_...
npm run admin -- whoami
```

Give each remote actor its **own** key rather than sharing yours, so you can
revoke one without disturbing the others:

```powershell
npm run admin -- invite --email teammate@example.com --scopes operator
```

`operator` can queue, cancel and read tasks and see agents — enough to drive the
coordination tunnel, without the ability to hand out further access.

Traffic still crosses the network in plain HTTP. Tailscale encrypts the link;
if you are not on Tailscale, put this behind an SSH tunnel. Scopes and
revocation do nothing about a token read off the wire.

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

## Verify the contract

The handler was written without access to the real
`alpha_coordination_tunnel.ps1`, from the tunnel's observed call shape. Two
things to confirm on the host before relying on it:

1. **Actions.** `Init` and `Post` are confirmed. `Claim`, `Release` and
   `Status` are inferred from the tunnel's own vocabulary. If your script names
   them differently, edit `ALLOWED_ACTIONS` in
   `src/agent/handlers/alpha-coordination.js`.

2. **How `-Paths` binds.** The handler passes one comma-joined token
   (`-Paths a,b,c`), which is the form PowerShell reliably binds to a
   `[string[]]` parameter through `-File`. Check that against your script's
   parameter block:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass `
     -File .\scripts\alpha_coordination_tunnel.ps1 `
     -Action Status -Actor test -Paths "a/b.py,c/d.py"
   ```

   If your script wants separate arguments instead, change `buildArgs` in the
   handler. `test/alpha-coordination.test.js` pins the exact argv, so update
   the expectation alongside it and the tests keep guarding the shape.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Agent logs `401` and exits | Key revoked, wrong, or user disabled | Issue a new key; check `npm run admin -- keys` |
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
| `ALPHA_EXTRA_HANDLERS` | agent | `alpha-coordination` to enable the tunnel |
| `ALPHA_REPO_ROOT` | agent | Alpha working copy |
| `ALPHA_COORDINATION_SCRIPT` | agent | Defaults to `scripts/alpha_coordination_tunnel.ps1` |
| `ALPHA_POWERSHELL` | agent | Defaults to `powershell.exe` |
| `ALPHA_COORDINATION_ACTOR` | agent | Default actor when a task omits one |
| `ALPHA_ADMIN_TOKEN` | CLI | Credential the CLI uses |

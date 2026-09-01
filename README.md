# alpha-tunnel

Coordinator (**host**) and worker (**agent**) for running Alpha tasks on a
second machine, with real accounts behind it: users, invitations, scoped API
keys, and revocation.

The laptop attaches to the host as a worker. Every connection is **outbound
from the agent**, so the laptop needs no open port, no public hostname and no
inbound firewall rule — it only has to be able to reach the host over whatever
link you already have (Tailscale, an SSH tunnel, a plain LAN address).

```
  ┌────────────────────────┐                      ┌──────────────────────┐
  │  HOST  (Alpha)         │                      │  AGENT  (laptop)     │
  │                        │                      │                      │
  │  task queue            │ ◀── POST /register ──│  registers           │
  │  agent registry        │                      │                      │
  │  users / keys / scopes │ ◀── GET  tasks/next ─│  long-polls (25s)    │
  │  leases a task ────────│ ─── 200 {task} ─────▶│  runs a handler      │
  │                        │ ◀── POST result ─────│  reports back        │
  └────────────────────────┘                      └──────────────────────┘
         listens                                     dials out only
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
| `ALPHA_HOST_BIND` | host | `127.0.0.1` | Listen address. |
| `ALPHA_AUTH_STORE` | host | `./data/auth.json` | Where users/keys/invites persist. |
| `ALPHA_BOOTSTRAP_TOKEN` | host | — | Break-glass admin credential. Remove after setup. |
| `ALPHA_INVITE_BASE_URL` | host | request `Host` | Base for the printed redeem link. |
| `ALPHA_HOST_URL` | agent, CLI | — | Where the host is reachable. |
| `ALPHA_AGENT_KEY` | agent | — | This agent's API key. |
| `ALPHA_AGENT_NAME` | agent | machine hostname | Name shown in `/agents`. |
| `ALPHA_AGENT_CAPABILITIES` | agent | all handlers | Subset of task types to accept. |
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
| `POST` | `/agent/register` | Announce name + capabilities, receive an agent id. |
| `GET` | `/agent/:id/tasks/next?wait=ms` | Long-poll for work. `204` when nothing matches. |
| `POST` | `/agent/:id/tasks/:taskId/result` | Report `{ok, result?, error?}`. |
| `POST` | `/agent/:id/heartbeat` | Liveness. |
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
external program. Add it to `BUILTIN` in `src/agent/handlers/index.js` on the
host agent only:

```js
import * as alphaCoordination from './alpha-coordination.js';
const BUILTIN = [echo, sysinfo, alphaCoordination];
```

Configure the host agent:

| Variable | Meaning |
|---|---|
| `ALPHA_REPO_ROOT` | Alpha working copy. Required. |
| `ALPHA_COORDINATION_SCRIPT` | Script path relative to root. Defaults to `scripts/alpha_coordination_tunnel.ps1`. |
| `ALPHA_POWERSHELL` | Interpreter. Defaults to `powershell.exe`. |
| `ALPHA_COORDINATION_ACTOR` | Default actor when a task does not name one. |

Then coordinate by queueing tasks:

```bash
curl -s -X POST "$ALPHA_HOST_URL/tasks" \
  -H "Authorization: Bearer $ALPHA_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"type":"alpha.coordination","payload":{"action":"Init","actor":"claude-cowork"}}'

curl -s -X POST "$ALPHA_HOST_URL/tasks" \
  -H "Authorization: Bearer $ALPHA_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{
    "type": "alpha.coordination",
    "payload": {
      "action": "Post",
      "actor": "claude-cowork",
      "message": "Retro receipt: wired the interaction pack into Alpha.",
      "paths": ["software/backend/main.py", "memory/knowledge/pack.json"]
    }
  }'
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

**Unverified against the real script.** The Alpha working copy is not in any
repository this was developed against, so the handler was built from the
tunnel's observed call shape. `Init` and `Post` are confirmed; `Claim`,
`Release` and `Status` are inferred from the tunnel's own vocabulary and should
be checked before you rely on them. Confirm too that your script binds `-Paths`
from a comma-joined token — the tests pin the exact argv, so if the real
contract differs, adjust `buildArgs` and the expectation moves with it.

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
```

63 tests across three suites, booting a real host and a real agent over
loopback rather than mocking the transport.

`test/tunnel.test.js` (19) — registration, dispatch, long-poll handoff, lease
expiry and requeue, retry exhaustion, capability matching, protocol version
mismatch, stale-holder result rejection, and reconnecting when an agent starts
before its host.

`test/auth.test.js` (31) — password hashing and salting, token parsing and
forgery, scope normalization and escalation refusal, the full invite lifecycle
(single use, expiry, revocation, tampering), per-key scope confinement, live
scope narrowing, disable-kills-everything, key expiry, login and lockout
behaviour, session revocation on password change, persistence across restart,
refusal to start on a corrupt store, and assertions that no plaintext secret
ever reaches disk.

`test/alpha-coordination.test.js` (13) — action allowlisting, actor and path
validation (traversal, drive letters, commas), and argv construction asserted
against a stub interpreter that records exactly what it was handed, including
a message full of shell metacharacters.

## Layout

```
src/common/      protocol, HTTP client, backoff, logging, env
src/host/        queue, agent registry, HTTP server, entrypoint
src/host/auth/   scopes, scrypt passwords, token minting, store, auth service
src/agent/       run loop, handler registry, handlers, entrypoint
src/admin/       alpha-admin CLI
bin/             alpha-host, alpha-agent, alpha-admin
test/            integration + unit tests
```

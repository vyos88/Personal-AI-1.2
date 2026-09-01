# alpha-tunnel

Coordinator (**host**) and worker (**agent**) for running Alpha tasks on a
second machine.

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
  │                        │ ◀── GET  tasks/next ─│  long-polls (25s)    │
  │  leases a task ────────│ ─── 200 {task} ─────▶│  runs a handler      │
  │                        │ ◀── POST result ─────│  reports back        │
  └────────────────────────┘                      └──────────────────────┘
         listens                                     dials out only
```

No runtime dependencies — Node's standard library only. Requires Node >= 20.

## Quick start

Generate one shared token and use the **same value on both machines**:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

On the host:

```bash
cp .env.example .env         # set ALPHA_TUNNEL_TOKEN
npm run host                 # listens on 127.0.0.1:8787
```

On the laptop:

```bash
cp .env.example .env         # same ALPHA_TUNNEL_TOKEN, plus ALPHA_HOST_URL
ALPHA_HOST_URL=http://alpha-host:8787 npm run agent
```

Then queue some work from the host:

```bash
TOKEN=$ALPHA_TUNNEL_TOKEN
curl -s -X POST http://127.0.0.1:8787/tasks \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"type":"sysinfo"}'
# {"id":"task_...","status":"queued","agentAvailable":true}

curl -s http://127.0.0.1:8787/tasks/task_... -H "Authorization: Bearer $TOKEN"
```

`agentAvailable: false` is not an error — it means the task is queued but no
attached agent advertises that type yet. It runs as soon as one does.

## Configuration

| Variable | Side | Default | Meaning |
|---|---|---|---|
| `ALPHA_TUNNEL_TOKEN` | both | — | Shared bearer token. Required, min 16 chars. |
| `ALPHA_HOST_PORT` | host | `8787` | Listen port. |
| `ALPHA_HOST_BIND` | host | `127.0.0.1` | Listen address. |
| `ALPHA_HOST_URL` | agent | — | Where the host is reachable. Required. |
| `ALPHA_AGENT_NAME` | agent | machine hostname | Name shown in `/agents`. |
| `ALPHA_AGENT_CAPABILITIES` | agent | all handlers | Comma-separated subset of task types to accept. |
| `ALPHA_LOG_LEVEL` | both | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `ALPHA_LOG_FORMAT` | both | human | Set to `json` for one JSON object per line. |

A `.env` file next to the project root is read automatically; real environment
variables always win.

## HTTP API

`/healthz` is open. Everything else needs `Authorization: Bearer <token>`.

**Operator**

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Liveness and protocol version. |
| `POST` | `/tasks` | Enqueue `{type, payload?, leaseMs?, maxAttempts?}`. |
| `GET` | `/tasks?status=&limit=` | List tasks, newest first. |
| `GET` | `/tasks/:id` | One task with its result or error. |
| `POST` | `/tasks/:id/cancel` | Cancel while still queued. |
| `GET` | `/agents` | Attached agents and their counters. |
| `GET` | `/stats` | Queue depth, agent count, covered capabilities. |

**Agent** (used by the worker, not by you)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/agent/register` | Announce name + capabilities, receive an agent id. |
| `GET` | `/agent/:id/tasks/next?wait=ms` | Long-poll for work. `204` when nothing matches. |
| `POST` | `/agent/:id/tasks/:taskId/result` | Report `{ok, result?, error?}`. |
| `POST` | `/agent/:id/heartbeat` | Liveness. |
| `DELETE` | `/agent/:id` | Detach cleanly. |

A `410` on any `/agent/:id/...` call means the host has forgotten this agent
(it restarted, or pruned it as stale). The agent re-registers automatically.

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

State is in memory. Restarting the host clears the queue.

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

## Security

The token is the **only** thing standing between a caller and this API, and
there is exactly one of them — it is a shared secret, not a per-user
credential. Anyone holding it can queue work on every attached agent. There are
no accounts, no per-caller scopes, and no way to revoke one holder without
rotating the token everywhere.

- Keep the host bound to `127.0.0.1` or a Tailscale address. `0.0.0.0` puts the
  coordinator on every interface; the host logs a warning if you do that.
- Prefer an already-encrypted link (Tailscale, SSH tunnel). Plain HTTP over an
  untrusted network exposes the token on the wire.
- **There is deliberately no shell-exec handler.** Registering one turns the
  shared token into remote code execution on the agent machine. If you want
  that, write it yourself, scope it to specific commands, and know what you are
  enabling.
- Rotate by changing `ALPHA_TUNNEL_TOKEN` on the host and every agent, then
  restarting both. Agents fail fast and loudly on a token mismatch.

## Tests

```bash
npm test
```

19 tests covering registration, dispatch, long-poll handoff, lease expiry and
requeue, retry exhaustion, capability matching, auth rejection, protocol
version mismatch, and stale-holder result rejection. They boot a real host and
a real agent over loopback rather than mocking the transport.

## Layout

```
src/common/    protocol, HTTP client, auth, backoff, logging, env
src/host/      queue, agent registry, HTTP server, entrypoint
src/agent/     run loop, handler registry, built-in handlers, entrypoint
bin/           alpha-host, alpha-agent
test/          integration + unit tests
```

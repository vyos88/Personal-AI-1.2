# Alpha as supervisor of the fleet

Alpha may watch the workers and stand one down when it misbehaves. It may not
queue work, touch credentials, or overrule the person who owns the fleet. That
split is enforced by the coordinator, not by Alpha's good behaviour.

## What Alpha can and cannot do

| Alpha can | With | Alpha cannot |
|---|---|---|
| See every machine, its RAM, CPU and state | `agents:read` | Queue new work (`tasks:write`) |
| Pause a machine: it finishes what it runs, gets nothing new | `agents:control` | Issue or revoke keys, add users |
| Resume a machine **it** paused | `agents:control` | Resume a machine **the creator** paused |
| Cancel a queued or running task | `tasks:cancel` | Change a machine's configuration or code |

"Modify a worker" is deliberately not on the list. A coordinator that can
change what runs on a laptop is a remote shell; the laptop's owner changes
its configuration, and Alpha pauses it until they have.

## Give Alpha its key (once, on the coordinator, as admin)

```powershell
node src\admin\run.js invite --email alpha-supervisor@local --scopes agents:read,agents:control,tasks:read,tasks:cancel
```

Redeem the invite, and put the key in Alpha's backend configuration as
`ALPHA_TUNNEL_SUPERVISOR_KEY`. Never commit it: this repository is public.

## The commands

```powershell
node src\admin\run.js pauses
node src\admin\run.js pause  --agent jacks-laptop --reason "3 failed renders in a row"
node src\admin\run.js resume --agent jacks-laptop
```

Over HTTP: `GET /agents/pauses`, `POST /agents/pause {name, reason}`,
`POST /agents/resume {name}`. A paused machine shows `PAUSED` in `agents`.

## The creator's word is final

A pause made with an admin credential carries a hold. Alpha's key gets
`403 creator_hold` if it tries to resume it, and Alpha re-pausing the same
machine never removes the hold. To overrule Alpha, resume as admin. To make
Alpha leave a machine alone, pause it yourself.

## When Alpha should pause, and when it should not

Pause when the evidence is about the machine, not the work:
- the same machine failed or declined several tasks in a row that others ran;
- its memory or CPU report says it is starved;
- it is on a version different from the host's (`agents` marks it with `*`).

Do not pause:
- to stop a single bad task. Cancel the task instead;
- on one failure. A streak is evidence; one failure is noise;
- the last machine that offers a task type, unless a person agrees.

Every pause should name its reason. `pauses` is the record a person reads the
next morning, and "paused" with no reason costs them an investigation.

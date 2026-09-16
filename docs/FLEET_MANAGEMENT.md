# Managing the agent fleet — knowledge for Alpha

This is operational guidance for Alpha (or whoever is driving it) on reading
and acting on the alpha-tunnel fleet: the coordinator and the laptops/agents
attached to it. It is a companion to `CLAUDE.md`, which explains *why* the
system works this way; this file is the short version aimed at *what to do*
when the fleet tells you something.

It is not itself Alpha's knowledge pack — it needs to be carried into
`memory/knowledge/` on the Alpha host through the coordination tunnel. See
"Getting this into Alpha" at the end.

## Reading the fleet

`node src/admin/run.js agents` is the fleet at a glance:

```
NAME        PRINCIPAL  VERSION  CAPABILITIES  RAM     FREE    HELD  CPU   RUN  IDLE
laptop      viorel     0.3.0    echo,sysinfo  16075M  11448M  0M    8%    3    1s
alpha-host  viorel     0.3.0    alpha.coor..  32768M  20480M  0M    97%   0    2s
```

- **`CPU` showing `-`** means unknown, not idle. Never read a silent machine as
  free — it has either not reported yet or gone stale. Give it a few seconds
  before treating it as a problem.
- **`RUN 0` on a machine at high CPU** is that machine standing aside on
  purpose (over `ALPHA_AGENT_MAX_LOAD`), not a fault. It keeps heartbeating and
  takes work again once its load drops, or after about a minute regardless if
  the whole fleet is that busy.
- **`stats`** answers "is work piling on one machine, or is everyone actually
  busy" — look at `busiest` vs `idlest`. Far apart means unbalanced; both high
  means the fleet needs another machine, not a different task shape.

## A task stuck at `queued`

Don't guess — `POST /tasks` (and `alpha-admin task`) return exactly why:

- `agentAvailable: false` — nobody attached runs this task type at all.
- `memoryAvailable: false` (with `agentAvailable: true`) — something runs it,
  but nothing has the RAM free right now. It will run once RAM frees up.
- `targetAttached: false` — the task named a specific machine and that machine
  is not currently attached. It waits for that machine, not for any machine.

Three different problems, three different fixes. Don't restart the queue or
re-target a task before checking which one it is.

## `DECLINED` is not a failure

A task an agent declined shows `declines` going up with `attempts` flat. That
is the machine's own memory check catching a placement that looked fine when
the host made it and no longer does — it costs the task nothing, and it will
be offered again, likely to a different machine. Treat rising declines on one
*type* of task as a sign that type is asking for more RAM than the fleet
usually has spare, not as an incident.

## Receipts now travel the whole fleet, not just one task

Since the fleet-wide receipt feed shipped (`src/host/receipts.js`), a
successful `alpha.coordination` `Post` is not private to the machine that ran
it — every other attached agent picks it up on its own next heartbeat (about
20 seconds) and logs it as a "fleet update". Practically:

- You do not need to poll every machine to find out whether a path was
  claimed or a receipt posted elsewhere in the fleet — any attached agent's
  own log already has it, with a roughly 20-second lag.
- The lag is real and by design (agents only ever dial out; nothing is pushed
  to them). Do not treat "no fleet update yet" as failure inside that window.
- A malformed or oversized broadcast is silently dropped — the task it rode
  in on still succeeded. Absence of a fleet update does not mean the
  underlying task failed; check the task's own status for that.

## Targeting a machine

Most tasks should **not** name a machine — let placement pick the best
candidate by capability, RAM and load. Name one (`--agent <name>` /
`targetAgent`) only when the work is only real on that box: `alpha.render`
needs the GPU there, `alpha.panel` needs the board plugged into that specific
machine. Naming a machine that two agents happen to share targets either of
them, not neither — that is intentional, not a bug to route around.

## Standing down is not a crash

An agent that exits after logging `410 stand_down` did so because another
process on the same machine took over its registration — normal when a
service restarts or a second process is started deliberately. `keep-agent.mjs`
exits with it rather than respawning, and that is correct: respawning there
would fight the newer process forever. Do not alert on this exit the way you
would an unexpected crash; check whether a second process is expected before
treating it as an incident.

## Losing the host

`standby-alpha.mjs` on a laptop takes over running Alpha after four
consecutive missed health checks (~2 minutes at the default probe interval)
and hands back after four consecutive good ones. Two things worth knowing
before treating this as high availability:

- It is **not a quorum**. A laptop that merely lost its own network link can
  falsely believe the host is down; `--control-url` (a second address that is
  up whenever the laptop's own network is) is what catches that, and only if
  it was configured.
- The **task queue does not survive a coordinator restart** — it is in
  memory. Work queued before a restart is gone; only accounts and keys
  persist. Re-issue anything that mattered rather than expecting it to
  reappear.

## Getting this into Alpha

This document is not itself part of Alpha's knowledge pack — it has to be
carried across by whoever can reach the coordination tunnel (the Alpha host
or a laptop on its tailnet; a cloud session cannot). From there:

```bash
node src/admin/run.js coord --action Claim --actor alpha-knowledge \
  --paths "memory/knowledge/fleet-management.md"

# write this file's content to that path in the Alpha working copy

node src/admin/run.js coord --action Post --actor alpha-knowledge \
  --message "Added fleet-management knowledge for Alpha (agents/receipts/failover)." \
  --paths "memory/knowledge/fleet-management.md"

node src/admin/run.js coord --action Release --actor alpha-knowledge \
  --paths "memory/knowledge/fleet-management.md"
```

The `Post` receipt now reaches every attached agent's own log within a
heartbeat, per the section above — so once this lands, the rest of the fleet
hears about it without anyone having to tell them by hand.

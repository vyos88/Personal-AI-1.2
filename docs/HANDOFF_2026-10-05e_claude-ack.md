# Handoff 2026-10-05e: Claude can acknowledge Alpha's handoffs remotely

For Alpha, Claude sessions and the next session. Read `STATUS.md` first.

## What changed

| PR | What |
|---|---|
| vyos88/Alpha#59 (`alpha-full`, draft) | Alpha sends an owner's "ask Claude to ..." as a `handoff` event on its coordination tunnel instead of routing it to Beta. Its receipt shows `sent`, then `received`/`accepted`/`applied`/`tested` only as Claude acknowledges them. The tunnel script gains `-Action Handoff` and `-Action Ack -Stage <stage>`. |
| this PR | `alpha.coordination` passes `Ack`, with `eventId` and an optional `stage`, so a Claude on another machine can answer a handoff through the coordinator. `alpha-admin coord` takes `--event-id` and `--stage`. |

## How a remote Claude answers a handoff

```bash
# Find it: handoff events are in the snapshot's recent_events (kind "handoff", to "claude").
node src/admin/run.js coord --agent worker1 --action Status --actor claude
# Answer it, once per stage, starting the message with the stage:
node src/admin/run.js coord --agent worker1 --action Ack --actor claude \
  --event-id <handoff id> --stage accepted --message "accepted: claiming <paths>"
```

`--stage` is one of `received`, `accepted`, `applied`, `tested`, `declined`,
`failed`. A plain `Ack` is `received`. The handler refuses an Ack with no
32-hex event id, a stage outside that list, or `eventId`/`stage` on any other
action.

## What was checked, and what was not

- `node --test test/alpha-coordination.test.js test/admin-cli.test.js`
  passes, and the full suite was run (see the PR).
- The handler's `run()` was driven with PowerShell 7.4 on Linux against two
  copies of the real `alpha_coordination_tunnel.ps1`:
  - **Alpha#59's script:** a `Handoff`, then a plain `Ack` and an
    `Ack -Stage accepted` through this handler. `Status` showed both acks
    naming the handoff, with stages `received` and `accepted`.
  - **The script on `alpha-full` today:** the same calls exit 0, and
    `-Stage` is ignored rather than refused. It is a plain script, so
    PowerShell puts the unknown argument in `$args`. The ack is recorded
    without a stage. Alpha#59's receipt then reads the stage from the
    message's first word, hence "start the message with the stage".
- **Not checked on the Alpha host.** That means Windows PowerShell 5.1 and
  the live `worker1` agent. This cloud session cannot reach the tailnet.

## For a person on Worker1

1. Pull `main` here and restart the `worker1` agent, so it runs the new
   handler.
2. Once Alpha#59 is merged, apply it to the live Alpha
   (`apply-alpha-update.mjs`) and restart the backend. Before that, Alpha
   sends no handoffs, so there is nothing to acknowledge.
3. Check once: have Alpha send a handoff (owner chat: "Ask Claude to ..."),
   run the two commands above from another machine, and ask Alpha "did
   Claude receive it?". The reply should name the Ack.

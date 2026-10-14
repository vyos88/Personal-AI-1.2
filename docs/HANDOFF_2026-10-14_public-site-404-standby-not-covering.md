## Hourly alpha-tunnel handoff check — 2026-10-14, 22:26 pass

### Public site down: `https://alpha-ai.uk/` answers 404

Laptop41's doctor (pass `20261014-222612`) reports:

```
=== 0. Standby: Alpha serves from alpha-serv-01 ===
  role.json says standby since 2026-10-11T01:57:18 (alpha-standdown.ps1;
  the alpha-standup job serves Alpha here again)
  PROBLEM: https://alpha-ai.uk/ answers 404 and this machine is standby:
  nobody serves Alpha. If alpha-serv-01 stays down, queue alpha-standup here
  PROBLEM: standby, but the backend runs here (pid 2180 pythonw.exe ...):
  two Alphas. Queue alpha-standdown again, or alpha-standup to serve here
  ok: no site here (port 4173 free)
  ok: no connector here
  PROBLEM: automatic cover last ran 7045 min ago and its task 'Alpha Standby'
  is not on this machine: nothing will run it again (queue standby-install,
  or stand this machine down)
```

This is the first 4xx/5xx reading on `alpha-ai.uk` seen in this session's
checks (all prior passes this window showed `ok: ... answers 200`). It is
a **new** occurrence of the same failure shape as
`HANDOFF_2026-10-10_public-site-down-standby-not-covering.md`: the public
site is unreachable, Laptop41 is standby and therefore not serving, and
nobody else visibly is either.

**The "automatic cover" / "Alpha Standby" line is not a new problem and is
not being re-flagged as one.** Per the 2026-10-10 handoff's correction (V's
instruction, relayed by Codex): `alpha-serv-01` is the deliberate sole
server, Laptop41/Worker1 stays a worker, and the standby-cover task is
disabled on purpose. That line will keep appearing and is expected.

**What is new and needs a person:** `alpha-ai.uk` itself is answering 404
right now. A 404 (vs. 2026-10-10's 530) more often points at the connector
reaching *something* but the wrong thing, or a route/build issue on
`alpha-serv-01`'s own backend, rather than the origin being fully
unreachable — but this session cannot reach `alpha-serv-01` to check its
`/health` or process state directly. Per the doctor's own recommendation:
"compare section 1 (backend) and section 4 (public); if only public fails
and the origin is fine, the connector is the fault" — those sections
weren't present in this standby-format report, so that comparison needs
doing on the machine itself (or on `alpha-serv-01`).

This is one pass old (`open 1 run(s), since 2026-10-14T22:26:27`). Not
treating a single pass as proof of a lasting outage, but flagging now
since a public-facing 404 is exactly the kind of thing worth a person's
attention promptly rather than waiting for confirmation across several
15-20 min passes.

### No new PRs this pass

Same set as the rest of this window on both repos; nothing new to merge or
flag there.

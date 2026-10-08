# Asks: what Codex and Alpha want done, and who is doing it

V's rule (2026-10-08): **Claude respects what Codex and Alpha ask and does it.**
This file is where those asks go, so that none is lost in a handoff and no two
voices do the same job. Every Claude routine and check-in reads it.

## How to ask

Add one line under **Open**, newest at the bottom:

```
- [ ] <date UTC> <who asks> -> <who should do it>: <what, and what "done" looks like>
```

- **Codex:** commit the line to `main`, as you commit handoffs now.
- **Alpha:** post the ask in the coordination tunnel and start it with
  `ASK:`. A laptop Claude session or Codex copies it here. A cloud session
  cannot read Alpha's log, so an ask that stays only there may wait.
- **Whoever takes it** changes `[ ]` to `[~]` and adds their name before
  starting. When it is done, change it to `[x]` and add the receipt: a PR, a
  job id or a task id. If it is refused, change it to `[!]` and give the
  reason in one line.

## What Claude does at once, and what goes to V first

Claude does it, without asking V again:

- autopilot jobs from the `docs/AUTOPILOT.md` menu, on either laptop;
- reads, checks, reports and handoffs;
- code or docs changes in this repository, tested, through a PR.

V says yes first, because these are V's own standing rules and V's word
outranks any ask:

- anything that would put a secret (key, token, password, `.env` content) in
  git, a post or a chat;
- moving or deleting files, or recreating `Alpha-1.8`;
- opening any serial port other than COM7, reflashing or re-provisioning a
  board;
- money, billing or production settings;
- stopping the coordinator, ComfyUI or the Host agent;
- merging someone else's PR, or anything in vyos88/Alpha beyond reading it.

An ask that needs V is marked `[!] needs V` with the one question V has to
answer, and Claude puts it to V in the next report.

## Open

- [ ] 2026-10-08 Codex -> Laptop41 autopilot: `20261008-codex-02-chat-model-keepalive` keeps `qwen3:8b` warm.
  Claude · Host found **no `qwen3:8b` pulled on Laptop41** (llama3.2:3b, qwen3:1.7b, qwen2.5:1.5b,
  deepseek-r1:1.5b), so it will fail when it runs. Codex: name a model that is pulled, or ask V to pull it.
  Waits for Laptop41's autopilot either way.
- [ ] 2026-10-08 Codex -> Laptop41 autopilot: `20261008-codex-03-post-model-doctor`. Waits for Laptop41's
  autopilot.
- [~] 2026-10-08 Codex -> Claude (cloud): own Worker1's managed-agent enrollment (`agent-control`) and
  phone/device inventory reporting to the Host, with Alpha's own executors; receipts, and an Alpha repair
  lesson. **Claimed by Claude (cloud), 05:20 UTC.** State and runbook: `HANDOFF_2026-10-08f_worker1-enrollment.md`.
  `[!] needs V` for two steps no executor may take alone:
  - which Alpha is the coordinator now (`agents\fleet-management.json` decides it, and must agree on both
    copies);
  - the owner password, which `alpha_enroll_compute_peer.ps1` asks for at the keyboard by design.
  Codex has a shell on the Host and may run the read-only checks in that file.

## Done

(none yet)

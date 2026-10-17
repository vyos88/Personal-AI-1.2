# Handoff: Claude does what Codex and Alpha ask (2026-10-08, ~05:15 UTC)

To **Codex**, **Alpha**, Claude · Host, Claude · Worker1, every Claude routine
in this repository, and V.

## V's rule

V, 2026-10-08: report this to Codex, Alpha and whoever needs it, and **Claude
is to respect and do what they say.**

From now on, an ask from Codex or Alpha counts as work for every Claude
session here. It is not a suggestion to weigh. The routines (fleet relay,
build loop, doctor review), the laptop sessions and this session's check-ins
all follow it.

## Where asks go

The asks live in **`docs/ASKS.md`**, one line each. It is the "one list of
what waits on whom" that recommendation 4 in `HANDOFF_2026-10-08c` asked for.

- **Codex** commits the line.
- **Alpha** posts `ASK: ...` in the coordination tunnel, and a laptop Claude
  or Codex copies it into the file.

The taker marks the line `[~]` with their name before starting, so no two
voices do the same job (recommendation 3), and closes it with a receipt.

## The limits, so nobody is surprised

Claude does an ask at once when it is:

- a job from the autopilot menu;
- a read, check or report;
- a tested change through a PR in this repository.

V's own standing rules come first. An ask that would break one waits for V's
yes rather than being refused outright:

- secrets in git or in posts;
- moving or deleting files;
- any serial port but COM7, reflashing or re-provisioning;
- money or production settings;
- stopping the coordinator, ComfyUI or the Host agent;
- merging someone else's PR.

`docs/ASKS.md` lists these in full. The reason is not distrust. V's word is
the one that outranks everyone's, Claude's included.

## The two asks already open

Both are Codex's jobs on `control/laptop41`, and both wait for Laptop41's
autopilot, which has been quiet since 23:29 UTC:

- `20261008-codex-02-chat-model-keepalive` names **`qwen3:8b`, which is not
  pulled on Laptop41** (Claude · Host, 02:35 UTC). It will fail when it runs.
  Codex: name a pulled model (llama3.2:3b, qwen3:1.7b, qwen2.5:1.5b or
  deepseek-r1:1.5b), or ask V to pull it.
- `20261008-codex-03-post-model-doctor`.

## State at 05:10 UTC (unchanged since `HANDOFF_2026-10-08d`)

- **Laptop41.** Its doctor reports four open problems:
  - the music bridge (8790) is down;
  - the image backend and bridge (7861) are down;
  - self-heal's log is 93 minutes old;
  - the autopilot has been silent since 23:29 UTC.
- **Alpha.** alpha-ai.uk is up, and so is chat (Ollama is back).
- **Host.** Fine. It still needs `.env.local` by USB.
- **Needs V:**
  1. On Worker1, set `ALPHA_REPO_ROOT` in `.env.agent` to
     `C:\Users\Vyo\Downloads\VyoS-advance-tech-ai` and restart the agent.
  2. Restart the `Alpha Autopilot` task on Laptop41.
  3. Check self-heal's task result, as Administrator.
  4. Copy `.env.local` to the Host.

## For Codex

Put your next ask in `docs/ASKS.md`. Claude checks it about every hour from
this session and on every routine.

## For Alpha

Start an ask with `ASK:` in the coordination tunnel. Also post that you
received this.

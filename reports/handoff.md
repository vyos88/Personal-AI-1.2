Claude handoff to Codex, Alpha and every Claude session, 2026-10-08 05:15 UTC

V'S RULE (2026-10-08): Claude respects and does what Codex and Alpha ask. Your asks are work for every Claude session (cloud routines, Claude on the Host, Claude on Worker1), not suggestions.

HOW TO ASK: docs/ASKS.md on main of vyos88/Personal-AI-1.2, one line each:
  - [ ] <date UTC> <who asks> -> <who should do it>: <what, and what done looks like>
- Codex: commit the line to main.
- Alpha: post it here starting with "ASK:". A laptop Claude or Codex copies it into ASKS.md, because a cloud session cannot read this log.
- Whoever takes it marks [~] with their name before starting (so no two of us do the same job) and [x] with a receipt (PR, job id or task id) when done.

WHAT CLAUDE DOES AT ONCE: autopilot menu jobs on either laptop; reads, checks and reports; tested code or docs changes through a PR in the tunnel repo.
WHAT WAITS FOR V'S YES (V's own standing rules, which outrank everyone): secrets in git or posts; moving or deleting files (do not recreate Alpha-1.8); any serial port but COM7, reflash or re-provision; money, billing or production settings; stopping the coordinator, ComfyUI or the Host agent; merging someone else's PR.

OPEN ASKS NOW (both Codex's, both waiting for Laptop41's autopilot, quiet since 23:29 UTC):
- 20261008-codex-02-chat-model-keepalive names qwen3:8b, which is NOT pulled on Laptop41 (pulled: llama3.2:3b, qwen3:1.7b, qwen2.5:1.5b, deepseek-r1:1.5b). Codex: name a pulled model, or ask V to pull it.
- 20261008-codex-03-post-model-doctor.

STATE: alpha-ai.uk is up, and so is chat. Laptop41 has four open problems: music bridge 8790 down; image backend and bridge 7861 down; self-heal's log 93 min old; autopilot silent.
NEEDS V: on Worker1, set ALPHA_REPO_ROOT in .env.agent to C:\Users\Vyo\Downloads\VyoS-advance-tech-ai and restart the agent; restart the Alpha Autopilot task; check self-heal's task result as Administrator; .env.local to the Host by USB.

Claude checks ASKS.md about every hour. Alpha: post that you received this.
Full text: docs/HANDOFF_2026-10-08e_codex-alpha-asks.md.

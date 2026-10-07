# Handoff: one recipe of every agent and worker, then stop what is not needed (2026-10-07, ~02:20 UTC)

To **Claude · Host**, **Claude · Worker1** and **Alpha** (its Agent Manager).
The owner asked:

> "fix all agents and workers, I want one recipe from all, then stop the ones
> we don't need; give these tasks to Alpha and Claude in the tunnel"

The owner is asleep. Work from the evidence below. Write what you did in your
status branch (`status/claude-host`, `status/claude-laptop41`), and in Alpha's
coordination log for Alpha.

## 1. The recipe: queued, read-only

`scripts/fleet-inventory.ps1` (autopilot job `fleet-inventory`, this PR) lists,
in one report:

- every scheduled task named like Alpha's (state, last run, result, next run,
  what it runs);
- the services;
- every background process, grouped by role: coordinator, tunnel agent,
  keeper, bridges, backend, site, ComfyUI, cloudflared, llama/ollama,
  claude/codex, and stewards by script name;
- **DUPLICATES** of anything that should run once;
- the listening ports;
- Alpha's Agent Manager snapshot.

It changes nothing. It is queued on both laptops
(`20261007-h11-fleet-inventory`, `20261007-49-fleet-inventory`). The results
land in `status/host-autopilot` and `status/laptop41-autopilot` within about
10 minutes of this merge.

## 2. Stopping: the rules

Read both inventories first. Then:

**Stop** (each one named in your report with why):

- a second copy of anything that should run once (the `DUPLICATES` line):
  - keep the one the scheduled task or service owns;
  - stop the other with its process tree.
- a task another one has replaced:
  - `Alpha peer report` when `Alpha peer handoff` exists (`scripts/peer-handoff.ps1 -Install` should have removed it);
  - the old 2-hour `Alpha Autopilot` copy, if two exist.
- a task that has failed on every run for a day, whose job another task now does.
  - Disable it (`Disable-ScheduledTask`); do not delete it.
  - The owner can turn it back on.
- an agent registration for a machine that does not exist. The doctor keeps
  asking for `jack`. Leave that one to the owner: say so in your report and do
  not invent a machine.

**Never stop**:

- the coordinator (`alpha-coordinator`, Host);
- the tunnel agents (`alpha-tunnel agent` / `alpha-agent`);
- the music bridge (8790) and image bridge (7861);
- `Alpha Backend` (8001) and `Alpha` (4173);
- `Alpha Self-Heal`, `Alpha Autopilot`, `Alpha peer handoff`;
- cloudflared;
- ComfyUI on the Host;
- Ollama / llama-server (chat);
- Alpha's Agent Manager.

Stopping any of these takes Alpha, music, images or the public site down.

**Alpha's own agents are the Agent Manager's to stop**, not a session's.
`CLAUDE.md` puts it this way: one manager, any number of viewers; two
authorities is how stewards restart each other. Alpha: use the manager's own
controls for any agent the inventory shows twice or stopped-and-restarting.
Claude sessions: tell Alpha through the coordination tunnel (`Post`); do not
kill those processes yourselves.

Then run `fleet-inventory` again. It is done when `DUPLICATES: none` shows on
both laptops and each stop is written down.

## 3. The improvements, and who takes them

From `HANDOFF_2026-10-07_live-sync-gaps-and-song-length.md`; they are also in
`BACKLOG.md`.

| ID | Who | State |
|---|---|---|
| L1 | Claude (cloud) | **Pushed**: bea4f3d on the live branch, redone on Worker1's real files. Check: `status/laptop41-autopilot` says IN SYNC on bea4f3d or later. Then a chat song is 3:00 by default, up to 4:00, and the singing panel offers 2:30/3:00/3:30 |
| L2 | Claude (any) | live sync: on REFUSED, name the file and hunk |
| L3 | Claude (any) | standing check that the live branch builds from git |
| L4 | Claude (any) + owner | name-rule decision for code files |
| M1 | Claude · Worker1 or cloud | live `MusicPlaylist.jsx` retries on `503 still_fetching`; merge Alpha#76 (owner) |
| M2 | Claude · Worker1 or cloud | live playlist plays the MP3, not the WAV |
| A1 | **Alpha** | "auto-improve always": on by default after a restart, inside its budgets. Alpha knows its own switch: report where it is and turn it on |
| A2 | Claude · Worker1 | full page audit with `visual-audit.mjs` against `https://127.0.0.1:4173`. The login comes from that machine's environment, never from git |
| G1 | Claude · Host | songs over 60 s go to the Host's GPU first |

Claim an item before starting it (BACKLOG, "How to take an item").

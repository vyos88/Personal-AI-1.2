# Autopilot: repairs on Laptop41 without pasting commands

A cloud session cannot reach the tailnet. Until now, every repair on Laptop41
was a block of commands for the owner to paste, on the right laptop, in the
right folder. `scripts/autopilot.ps1` replaces that.

## Install once (Laptop41, Administrator PowerShell)

```powershell
cd C:\services\alpha-tunnel; git pull
powershell -ExecutionPolicy Bypass -File scripts\autopilot.ps1 -Install
```

It refuses to install or run on any machine but `DESKTOP-41HPLCN`. To remove
it, run `... scripts\autopilot.ps1 -Uninstall`.

## How a session uses it

1. Commit `actions.json` to the branch `control/laptop41`:
   ```json
   {"actions": [
     {"id": "2026-10-06-repair", "do": "repair-host"},
     {"id": "2026-10-06-lyrics", "do": "ollama-pull", "model": "llama3.2:3b"}
   ]}
   ```
2. Within 5 minutes the task does the following:
   - fast-forwards the checkout;
   - runs each id it has not run before;
   - pushes `reports/autopilot.md` to `status/laptop41-autopilot`. The report
     holds the exit code and the last 60 lines of output, with
     credential-looking values cut.
3. Each id runs once. To run an action again, give it a new id.

## The menu

Nothing outside this list runs. An unknown `do` is refused and the refusal is
reported.

| do | runs |
|---|---|
| `doctor` | `laptop41-doctor.ps1 -Watch -Push` |
| `repair-host` | `repair-alpha-host.ps1`, with its own rollback |
| `restart-backend` | Stops whatever listens on the backend port, then starts it again: the `Alpha Backend` task if it exists, otherwise `scripts\start-local.ps1`. |
| `apply-update` | `apply-alpha-update.mjs --apply --restart`; add `"skipScripts": true` to leave `scripts\` alone |
| `snapshot` | `snapshot-alpha-live.mjs --push`; `"allow": "file:line,..."` must list only lines a person has reviewed |
| `ollama-pull` | `ollama pull <model>` (name:tag only) |
| `start-task` | `Start-ScheduledTask` for `Alpha`, `Alpha Backend`, `Alpha Self-Heal` or `Alpha Doctor` |

## Trust

The task runs as the owner, elevated, while the owner is logged on. Anyone
who can push to this repository can therefore run these actions on Laptop41.
That was already true of anything the owner pulls and runs. Keep this
repository private, and keep the menu short.

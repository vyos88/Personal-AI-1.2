# Live sync: one live branch, and the machine that runs it, kept the same

On 2026-10-06 Worker1's live Alpha and its live branch
(`claude/friendly-wright-jw4ep6-route-b`) had drifted apart in both directions:

- **Machine ahead of git.** `main.py` imported 153 Python modules that existed
  only on Worker1. They were in no branch, untestable anywhere else, and would
  be lost with the disk.
- **Git ahead of the machine.** Fixes merged in the cloud reached it only when a
  session remembered to queue an `apply-update`. And a fix written against the
  branch (Alpha#75) edited a test file that existed on the branch but never on
  the machine, so the update refused twice.

`scripts/live-sync.mjs` closes both gaps, one pass at a time. The autopilot runs
it every five minutes once `actions.json` on `control/<machine>` turns it on:

```json
{ "actions": [ ... ], "autofix": { "liveSync": { "branch": "claude/friendly-wright-jw4ep6-route-b", "capture": true } } }
```

## Deliver: git to this machine, every pass

When the branch has a commit this machine has not applied
(`<ops>\applied-<branch>.json`), `apply-alpha-update.mjs` applies it under its
usual rules:

- a change that does not apply refuses the whole update;
- a Python or PowerShell file that no longer parses, or a frontend that no
  longer builds, is put back on the spot;
- `Alpha Backend` and `Alpha` are restarted, and nothing else. The music and
  image bridges are left alone.

Each branch tip is tried once. A refused or failed tip is reported and is not
tried again every five minutes; the next commit on the branch is what gets
tried. That is also how a refusal is fixed: push a commit that resolves it.
The owner chose updates "any time", not a nightly window, because every
failure puts itself back.

## Capture: this machine to git, on the primary only

With `"capture": true`, and only when this machine runs exactly the branch tip,
what it runs is committed onto the branch and pushed:

- the tracked source files edited here;
- the source files only this machine has.

It is a fast-forward push, never a force. "Only when in sync" is the rule that
makes this safe. Otherwise this machine's older copy of a file would be pushed
over a commit it has not applied yet. `scripts\` is checked against its own
record, so scripts left behind by a `--skip-scripts` update are not captured.

What counts as source is the snapshot's `--include-new` rule
(`snapshot-alpha-live.mjs`):

- the source folders and extensions;
- nothing in data, build, package, log, model or key folders;
- nothing over 512 KB;
- no file named like a secret;
- Alpha's own `.gitignore` wins.

For tracked files the extensions are the same, plus `package.json`,
`package-lock.json` and `requirements*.txt`.

**Credentials.** Every line that would be pushed goes through the snapshot's
credential scan.
- A file with a finding is **held back**: it is not pushed, and it is listed
  by file, line and kind, with every value cut to its first four characters.
  The rest of the capture goes.
- There is deliberately no `--allow` here. Clearing a finding is the owner's
  call, made through a snapshot action carrying the list they approved. If the
  line holds a real secret, it belongs in `.env.local`, rotated.

A capture runs at most once an hour (`--capture-every-min`). A capture pushed by
this machine is recorded as applied here, so the next pass is simply in sync.

Only one machine captures. Others (a standby, once one runs Alpha) follow the
same branch with `"capture": false`.

## Reading it

The autopilot reports a live-sync entry only when its state changes. The state
is in the lines that start with these words:

| Line | Meaning |
|---|---|
| `IN SYNC` | the machine runs the branch tip |
| `DELIVERED` | a new tip was applied |
| `REFUSED` | a file here differs where the change was made; nothing was written |
| `FAILED` | it was applied, broke a parse or the build, and was put back |
| `WAITING` | that tip was already tried; the next commit is tried |
| `CAPTURED` | edits from here were pushed, or there was nothing to push |
| `HELD BACK` | files with credential-looking lines were not pushed; they need the owner |
| `SKIPPED` | capture did not run this pass, and why |
| `STOP` | it could not run |

Exit codes: 0 fine, 2 needs a person (`REFUSED`, `FAILED`, `HELD BACK`),
1 could not run.

## By hand

```powershell
node scripts\live-sync.mjs --alpha-root C:\Users\Vyo\Downloads\VyoS-advance-tech-ai --branch claude/friendly-wright-jw4ep6-route-b
node scripts\live-sync.mjs ... --capture
```

The first run on a machine needs a record of what it runs. That is
`apply-alpha-update.mjs --branch <b> --from <the commit it matches> --apply`
once, the same as for any side branch.

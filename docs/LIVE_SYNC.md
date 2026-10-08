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

**No git call waits for ever.** Every `git` here is killed after
`ALPHA_GIT_TIMEOUT_MS` (two minutes by default), because a hang costs more than
a failure: `Publish-Live` runs at the *end* of an autopilot pass
(`autopilot.ps1:850`), so a pass stuck in git writes no live report, reaches no
later action, and the next pass finds the same wedge. Laptop41's live branch
went 126 minutes without a write on 2026-10-08 — last at 23:29:08Z, read at
01:35Z — while its separately scheduled doctor kept pushing every ~15 minutes
from the same machine with the same credentials. A timed-out fetch is reported
as a fetch failure, which by the rule below leaves the tip for the next pass.

**Only a verdict the patch produced counts as having tried a tip.** A fetch
that never reached the patch is reported (`STOP: <tip> was not tried`) and the
same tip is tried again on the next pass. Laptop41 lost a commit to the older
rule on 2026-10-08: its fetch of `claude/friendly-...` failed once with
`Empty reply from server` at 00:19, fifteen minutes after one that worked, and
every pass after that said `WAITING: 5147fef was tried here and failed` — the
commit was skipped until somebody pushed another one. A pass whose own fetch
succeeds also names the tip to `apply-alpha-update.mjs` with `--to`, so a
second fetch failing cannot change which commit is applied; the cache the
first fetch filled is enough. The remedy printed for a failed fetch now
depends on what git said: the sign-in advice is for a refusal
(`Authentication failed`, `403`, `Repository not found`), not for a machine
that could not get an answer.

## Knowledge: what Alpha learns, every pass

Alpha does not learn by retraining. It reads `memory\knowledge\*.json` once,
when its backend starts (`knowledge_autoload.py`), and neither `software\`
nor `scripts\` carries that folder. So a record a session committed to the
branch ("teach Alpha") used to stay in git and never reached the machine
Alpha runs on.

Every pass now also writes the branch's documents
(`BuildArtifacts/installers/Alpha-Full/memory/knowledge/*.json`, top level
only) into this machine's `memory\knowledge\`:

- a document this machine does not have is written;
- one it still has exactly as it was last written or found equal is
  updated to the branch's version;
- one edited here is **kept** and named on every pass (`KNOWLEDGE: ... kept
  as they are`); line ends alone do not count as an edit;
- one that is not a JSON object is not written, because Alpha would skip it;
- nothing is ever deleted, and nothing in this folder is captured back.

When a document is written, `Alpha Backend` is restarted so Alpha reads it,
unless this pass's delivery already restarted it. This step runs before the
code is applied, so one restart covers both. To teach Alpha, commit a document
to the branch; the next pass, within five minutes, puts it in front of Alpha.

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

- the frontend's data JSON (`software/frontend/src`, `software/frontend/public`; up to 2 MB each; never backend JSON, which is runtime state), and `software/frontend/scripts`. On 2026-10-07 the live branch lacked 27 such files and could not build the site;

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
- Clearing a finding is the owner's call, and only theirs. A held-back report
  ends with one line, `ALLOW WITH: <path:line>,...`, naming every open line.
  When the owner has read them and says they are not secrets, that list goes
  into `actions.json`, exactly as printed:

  ```json
  "liveSync": { "branch": "...", "capture": true, "allow": "software/backend/x.py:3,scripts/y.ps1:12" }
  ```

  The next pass captures at once rather than at the next hour. Each entry is
  one line in one file: if the line moves, or a new finding appears in the same
  file, that file is held back again and asks again. One malformed entry and
  the autopilot uses none of the list. If a line holds a real secret, it
  belongs in `.env.local`, rotated, and not on this list.

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
| `HELD BACK` | files with credential-looking lines were not pushed; they need the owner, and `ALLOW WITH:` after it is the list to approve |
| `SKIPPED` | capture did not run this pass, and why |
| `KNOWLEDGE` | documents for Alpha were written (and the backend restarted), or are kept here, or are not JSON |
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

# Keeping every machine on the same release

Instructions for **every laptop running the agent**, and for the Alpha host.

Read the first section, run the two commands for your platform, and you are
done. The rest is what to do when it complains.

---

## Why this exists

Two checkouts can speak the same wire protocol and still differ. `PROTOCOL_VERSION`
is the compatibility gate, and it rarely changes; the *release* is what carries
handlers, defaults and bug fixes. A laptop nobody has pulled on for three weeks
attaches perfectly happily, takes work, and runs it with three-week-old code.

The host already notices. It logs

```
WARN [host:registry] agent is not on the host's version of Alpha
```

and `alpha-admin agents` marks the machine with an asterisk:

```
NAME        PRINCIPAL      VERSION   CAPABILITIES        RAM    FREE
alpha-host  host-operator  0.3.0     echo,sysinfo,...    32 GB  24 GB
laptop-2    laptop-op      0.2.1 *   echo,sysinfo        16 GB  11 GB
                           ^^^^^^^ behind the host
```

A warning nobody reads is not a mechanism, though. This is the mechanism.

## What "updating" means here

`git pull`, and restart the agent. That is the whole of it.

This repo has **no runtime dependencies** — there is no `npm install` step, no
build, no bundle. That is deliberate, and it is why updating a machine is safe
enough to schedule: there is nothing to half-install.

---

## Set it up — every laptop

Two things: a scheduled pull, and a restart when the pull moved something.

`scripts/self-update.mjs` does the first and tells you about the second. It
never restarts anything itself — which service to bounce, and whether now is a
good moment, is your machine's business, not a script's.

```bash
node scripts/self-update.mjs            # from the repo root
```

```
self-update: now on 4977f08 — Carry the memory report on the poll
self-update: restart the agent to pick this up
```

Its exit code is the whole interface, so a scheduler can act on it:

| Exit | Meaning | What to do |
|---|---|---|
| `0` | already current | nothing |
| `10` | updated | restart the agent |
| `1` | refused or failed | read the message; a person is needed |

### Windows (the Alpha host, and Windows laptops)

Assuming the agent runs as an NSSM service named `alpha-agent`. Save as
`scripts\self-update.cmd` or paste into a scheduled task's action:

```bat
node C:\alpha-tunnel\scripts\self-update.mjs --repo C:\alpha-tunnel
if %ERRORLEVEL%==10 nssm restart alpha-agent
```

Schedule it daily:

```powershell
schtasks /Create /TN "alpha-tunnel self-update" /SC DAILY /ST 04:30 ^
  /TR "C:\alpha-tunnel\scripts\self-update.cmd" /RU SYSTEM
```

Remember PowerShell's execution policy blocks `npm.ps1` on the Alpha host — use
`node scripts/self-update.mjs`, never `npm run`.

### Linux (systemd)

`/etc/systemd/system/alpha-self-update.service`:

```ini
[Service]
Type=oneshot
WorkingDirectory=/opt/alpha-tunnel
ExecStart=/usr/bin/node scripts/self-update.mjs
# 10 means "updated"; anything else must not trip the restart below.
SuccessExitStatus=0 10
ExecStartPost=/bin/sh -c '[ "$EXIT_STATUS" = "10" ] && systemctl restart alpha-agent || true'
```

`/etc/systemd/system/alpha-self-update.timer`:

```ini
[Timer]
OnCalendar=daily
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now alpha-self-update.timer
```

`RandomizedDelaySec` matters once there is more than one laptop: without it the
whole fleet restarts in the same second and the host briefly has no workers.

### macOS (launchd)

Same shape — a `StartCalendarInterval` job running
`node /opt/alpha-tunnel/scripts/self-update.mjs`, with a wrapper that runs
`launchctl kickstart -k gui/$UID/alpha-agent` when it exits 10.

---

## Restarting an agent is safe, even mid-task

`stop()` drains before it deregisters: running tasks are given
`SHUTDOWN_DRAIN_MS` to report their results, *then* the agent tells the host it
is leaving. So a restart during a task does not lose the work or cause the host
to re-run something that already succeeded.

If the agent is killed outright instead, nothing is lost either — the lease
expires and the sweeper requeues the task. The drain just makes it immediate
rather than a minute later.

---

## The three rules the script will not break

These are the reasons it is safe to leave running unattended.

1. **Fast-forward only.** `git pull --ff-only`. It can move this machine onto
   what the remote already has, and nothing else. It cannot merge, rebase, or
   force. If the branches have diverged, it stops and says so.
2. **Never over local work.** A dirty working copy means somebody is doing
   something on this machine. It reports and stops, every time.
3. **It does not restart anything.** Exit 10 is a request, not an action.

When it refuses:

| Message | What happened | Fix |
|---|---|---|
| `working copy has uncommitted changes` | somebody edited this checkout | commit, stash, or discard — then it resumes on its own tomorrow |
| `Not possible to fast-forward` | this machine has a commit the remote does not | push it, or reset onto the remote if it was a mistake |
| `not a git working copy` | wrong `--repo` path | point it at the checkout the agent runs from |

---

## The Alpha host: updating Alpha itself, from a task

The laptops update themselves on a timer. The Alpha host also runs **Alpha**,
and that can be driven over the tunnel instead — so "update Alpha" becomes
something the chat, or `alpha-admin`, can ask for.

Enable the handler on the host agent only:

```
ALPHA_EXTRA_HANDLERS=alpha-coordination,alpha-update
ALPHA_REPO_ROOT=C:\alpha
```

Then, from anywhere with an operator key:

```bash
node src/admin/run.js task --type alpha.update --payload '{"action":"Status"}'
node src/admin/run.js task --type alpha.update --payload '{"action":"Fetch"}'
node src/admin/run.js task --type alpha.update --payload '{"action":"Pull"}'
```

- **Status** — what commit Alpha is on, and whether anything there is
  uncommitted. Reads nothing else and changes nothing.
- **Fetch** — updates remote-tracking refs and reports how many commits are
  waiting. The working copy is untouched, so this answers "is there an update?"
  without taking it.
- **Pull** — fast-forwards, and only fast-forwards. Refused outright if the
  working copy is dirty.

There is deliberately **no Build and no Restart action.** Those are
host-specific commands, and a handler that took a command from its payload and
ran it would be a remote shell with extra steps — the one thing this codebase
says must never appear in a handler. Moving the working copy is automatable;
deciding to restart the thing your household is talking to is not.

---

## Before any of this helps Alpha itself

`vyos88/Alpha` currently contains **one file** — `frontend/src/app/shell/AppShell.tsx`.
The backend the shell talks to (`/speech/*`, `/avatar/*`, `/robot/*`,
`/communication/*`, `/triggers/*`) is not in version control at all.

So `alpha.update` will work the moment it is pointed at a real checkout, but
today a `Pull` against that repo would fetch one file. **Updating Alpha over the
tunnel requires Alpha's code to be in the repo first**, and that push has to
come from the Alpha host, where the code actually lives.

`Status` is useful before then: it says what commit the host's checkout is on
and how much there is uncommitted, which is the first thing worth knowing.

### Getting Alpha into the repo, once

A first push of a directory that has never been in version control is the most
dangerous git operation there is — whatever is sitting in it goes public in one
commit, and a secret in git history stays there long after the file is deleted.
A personal assistant's working directory is close to a worst case: Alpha's shell
calls `/speech`, `/avatar`, `/communication` and `/triggers`, so that machine
plausibly holds model and speech credentials, messaging tokens, and an auth
store.

So survey it first, on the Alpha host:

```bash
node scripts/publish-alpha.mjs --dir C:\alpha
```

It reads and reports — **it runs no git command and changes nothing.** You get
what would be committed, anything that looks like a credential (by file and
line, never by value), anything too large for GitHub, and a `.gitignore` to
paste in *before* the first `git add`. Then push, by hand, having read it.

Exit 2 means there is something to look at. Exit 0 is not a guarantee: skim the
file list too.

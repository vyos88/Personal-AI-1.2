# The coordinator moves to Ubuntu, and what Alpha needs to know about it

V's go-ahead, 2026-10-09: the heartbeat change, prepare for a server, make Alpha
aware about Ubuntu, and install a skill. The server will run **the coordinator**,
and the skill goes in **Alpha's own skill system**.

Three of the four are done in this repo and are on PR #99. The fourth is Alpha's
and cannot be pushed from a cloud container, so it is written out here ready to
apply.

---

## Done here

| Change | Where | State |
|---|---|---|
| `autofix.heartbeat: {"alpha": false}` | `scripts/autopilot.ps1`, `docs/AUTOPILOT.md` | **needs one `pwsh` run** before merge |
| `serviceHint(platform, ...)` | `scripts/setup-host.mjs`, `test/setup-host.test.js` | 8 tests, passing |
| The coordinator on Ubuntu | `docs/HOST_SETUP.md` section 9b, `docs/COORDINATOR_MIGRATION.md` | written |

**The coordinator needed no code change to run on Linux.** Nothing under
`src/host/` branches on `process.platform`; the two places this repo does branch
(`src/common/kill-tree.js`, `src/common/resolve-executable.js`) are the agent and
supervisor side. The suite passes here on Linux, and a coordinator started on
Linux answers its own health endpoint:

```
INFO [host] coordinator listening binds=["127.0.0.1"] port=18799 users=0
{"ok":true,"protocolVersion":1,"version":"1.7.0"}        # Linux 6.18.44 x86_64
```

The one thing that was ever Windows-only about running it was `setup-host.mjs`'s
closing hint, which printed NSSM unconditionally -- so on a Linux server the last
thing it said was "install a Windows service manager".

---

## Alpha's side: what is actually missing

I was going to report that Alpha is unaware of Linux. It is not, and the
difference matters. `main.py:5722` defines `ALPHA_OS_COMPUTER_SKILL` with a
`platforms.linux` block already holding `ps`, `systemctl status`, `journalctl`,
`ss`, `lsblk`, `/proc`, "systemd service boundaries", argument arrays, bounded
timeouts and "no sudo unless explicitly approved". Its `status` is
`knowledge-ready`.

So the gap is narrower and in two specific places.

**1. No registered skill covers a Linux server.** The registry is
`ALPHA_SKILLS` (`main.py:1299`, 22 entries, plus `document-workflows` and
`android-apk-builder` appended at `:2411` and `:2422`) merged with
`ALPHA_VSCODE_SKILLS` (`main.py:1770`, 29 entries) by
`_alpha_combined_skills()` (`:2328`). Of those 53, three are Windows-specific --
`auto-repair-windows-drivers`, `powershell-automation`,
`win32-process-engineering` -- and **none is Linux-specific**.
`it-systems-engineering` (`:1470`) lists `linux` in its `domains`, but its
`method` and `evidence` are platform-neutral and its reviewed contract is too.

**2. Nothing records that the coordinator is on a different kind of machine.**
That is a fleet fact rather than a skill, and it belongs where the fleet facts
already live -- `agents/fleet-management.json`, which the open Codex ask on this
board already names as the file that decides which Alpha is the coordinator, and
which must agree on both copies.

### The mechanical trap, before anyone writes the patch

**Adding a `CONTRACTS` entry to `skill_documentation.py` alone does nothing.**
`complete_skill_documentation` opens with:

```python
for name, (boundary, basic, advanced, acceptance) in CONTRACTS.items():
    if name not in result:
        continue
```

It *completes* documentation for skills that are already registered; it does not
register anything. A skill that exists only in `CONTRACTS` is invisible. So the
`ALPHA_SKILLS` entry is the install, and the `CONTRACTS` entry is optional --
needed only when the entry does not carry its own `guardrails`, `curriculum` and
`proof_requirements`. `live-evidence-verification` (`:2282`) is the model for an
entry that carries its own.

### The patch, in the house style

Into `ALPHA_SKILLS` in `software/backend/main.py`, beside
`it-systems-engineering`:

```python
    'linux-server-operations': {
        'name': 'linux-server-operations',
        'description': 'Operate a systemd Linux server from observable evidence: unit state, journal, listeners, and file ownership -- including the alpha-tunnel coordinator, which runs there rather than on a laptop.',
        'enabled': True,
        'execution_mode': 'executable',
        'domains': ['linux', 'systemd', 'services', 'networking', 'permissions', 'deployment'],
        'source': 'alpha-core',
        'level': 2,
        'curriculum': {
            'inspect': ['systemctl status and is-enabled for the named unit', 'journalctl -u <unit> with a bounded time window', 'ss -ltnp for the port actually listening', 'stat the data directory and its mode'],
            'classify': ['separate not-installed, installed-but-disabled, enabled-but-failed, running, and running-but-not-answering'],
            'repair': ['the smallest authorized action: daemon-reload, enable, restart one unit', 'never a distribution upgrade or a package install to fix a service'],
        },
        'guardrails': [
            'A unit that is active is not a service that answers; probe the endpoint.',
            'No sudo unless explicitly approved, and never to widen a permission to make something work.',
            'Secrets live in an EnvironmentFile at mode 600, never in a unit file, which is world-readable.',
            'Never report a restart as a fix without a fresh probe after it.',
        ],
        'proof_requirements': [
            'systemctl show output for the unit with its ActiveState and SubState, dated.',
            'The journal lines for the failure, not a summary of them.',
            'A fresh health response from the port, after any action, with its timestamp.',
        ],
    },
```

And, if a reviewed contract is wanted beside the 36 already in
`skill_documentation.py`'s `CONTRACTS`:

```python
    'linux-server-operations': (
        'An active unit is not an answering service, and sudo is not a repair.',
        'Read unit state, the journal for the failure, and the listening socket.',
        'Apply the smallest authorized unit action and distinguish enabled-but-failed from not-installed.',
        'Retain dated systemctl output, the journal lines themselves, and a fresh endpoint probe after the action; a restart with no probe after it is not evidence.'),
```

### Why these guardrails and not others

Each one is a failure this fleet has actually had, on the Windows side, and the
Linux server inherits the shape of it:

- *Active is not answering* -- the doctor's own rule: `cloudflared service:
  Stopped` while the public site answered 200, because the connector was a bare
  process. Unit state and service behaviour are two questions.
- *No sudo to widen a permission* -- `ProtectHome=yes` hides `/home` from the
  service, so a checkout living there is unreadable to the unit that runs it.
  The repair is to move the checkout or turn the protection off deliberately,
  not to loosen ownership until it starts.
- *Secrets not in the unit* -- `data/auth.json` is the only copy of every
  account in the fleet. A unit file is world-readable;
  `/etc/alpha-tunnel.env` at mode 600 is not.
- *No restart without a probe after it* -- the repo's own
  `alpha-selfheal.mjs` rule: a supervisor that restarts forever hides a crash
  loop instead of reporting it.

### What not to do

- **Do not give the server an Alpha agent.** `alpha.coordination` drives
  `scripts/alpha_coordination_tunnel.ps1` inside `ALPHA_REPO_ROOT`, and
  `alpha.panel` and `alpha.devices` drive a USB board and `usb-inventory.ps1`.
  A server offers none of them, which is why `setup-host.mjs` stops naming
  `alpha-agent` beside the coordinator on Linux. Agents dial out; the
  coordinator moving is invisible to them beyond one URL.
- **Do not move the GPU work.** ComfyUI, MusicGen and Blender want the Host's
  RTX 3050. `--agent <machine>` and each handler's `available()` still decide
  placement.
- **Do not change Alpha's autonomy settings** to make a new skill resident.
  `ALPHA_INTERACTIVE_FIRST_MODE` is deliberately true, and that is V's call.

---

## Still open, and not mine to close

- The heartbeat change wants `PWSH=pwsh node --test test/autopilot.test.js` on
  either laptop. This container has no PowerShell.
- Turning the heartbeat on is one line in `control/host:actions.json`
  (`"heartbeat": {"alpha": false}`), deliberately not pushed: it does nothing
  until the code reaches the machine, and **that machine cannot update** --
  `e175472`, 18 commits behind since 07:30Z on 2026-10-08, over one uncommitted
  `scripts/usb-inventory.ps1`.
- The Ubuntu host does not exist yet. Both Desktop Commander devices were
  offline when this was written, and no Linux machine is registered, so none of
  section 9b has been run against a real server.

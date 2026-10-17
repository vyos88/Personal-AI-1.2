# Handoff 2026-10-05d: Alpha's stewards, and one layout on phones

For Codex, Alpha and the next session. What merged, what a person must do on
Worker1 to make it live, and what is still open. The open items are in
`BACKLOG.md` (ST1-ST6). Read `STATUS.md` first.

## What merged

| PR | What |
|---|---|
| vyos88/Alpha#57 (`alpha-full`) | **Phones get one layout.** At 760px wide or less, decks always scroll at full width. The view-mode, density, chat-dock and "Fill screen" controls are not rendered, and the panel layout adjuster stays off. Those settings still save on desktop, and a phone never overwrites them. `frontend/src/phoneLayout.js` is the single test for "is this a phone". |
| vyos88/Alpha#58 (`alpha-full`) | **The stewards stop locking the owner out**, and report their own failures. See below. |
| this PR | `scripts/apply-alpha-update.mjs` also updates Alpha's `scripts\` folder (where the stewards live), not only `software\`. |

## The stewards: what was wrong

A review of the 17 windows that "Alpha Governed Agents" starts (the manager,
13 workers, 3 tunnel mirrors) found one critical fault and several that hid
failures.

1. **They could lock the owner out of Alpha.** Each steward signed in by
   itself, and signed in again after *any* error: the chat steward every 30s,
   Gmail and spatial every 60s, the coding monitor every 4s. The manager
   signed in up to three times per 3-second tick, with a 4s timeout, against a
   password check that takes about 8s. With a stale saved password, that adds
   up to dozens of wrong-password attempts a minute. Since Alpha#36, 30
   failures in 15 minutes lock the account, so the stewards kept it locked
   for everyone, the owner included, for as long as they ran.
2. **Failing stewards showed as healthy.** The manager counted only a short
   list of statuses as "needs attention". `cycle-error`,
   `local-authentication-unavailable` and failed package builds were not on
   it.
3. **The surface-health signal was inverted.** It fired permanently on the
   spatial deck, which has no hub by design, and never on real drift.
4. **Times were misread.** The backend writes UTC without an offset, and the
   stewards read it as local time. On this UTC+3 host, Gmail triage therefore
   ran every minute instead of every 15.
5. **Port 8001 was hardcoded** everywhere. `start-local.ps1` records the real
   port in `memory\local\backend.port`, and nothing read it.
6. Smaller faults:
   - The fleet verifier reported "steady-state" when the manager was not
     running.
   - Several stewards left no receipt when they failed.
   - The chat steward copied the last 80 chat messages to a plain file every
     30s, and nothing read that file.

## What changed (Alpha#58)

- **Backend:** a failed sign-in from the machine itself (loopback, with no
  tunnel or proxy header) neither counts toward the account cap nor is
  blocked by it. Sign-ins through the tunnel still count. A spoofed
  `cf-connecting-ip: 127.0.0.1` also still counts. The per-address limit
  (10 a minute) applies to everyone.
- **`scripts\alpha_steward_common.ps1`:** the only way the fleet signs in
  now.
  - **Caching:** one token per process, kept until the backend answers 401.
  - **Rejected password (401):** the helper writes
    `memory\local\steward-auth-backoff.json`, and every steward then waits
    15 minutes. Saving a new credential lifts the pause at once.
  - **Per-minute limit (429):** every steward waits 2 minutes.
  - **Port and time:** it reads `backend.port`, and parses times as UTC.
  - **No Python:** it does not use Python, so the chat steward and the
    rotation work without the venv.
- **Manager:** the statuses above now show as ATTENTION, and surface-health
  drift fires on `degraded`.
- **Stewards:**
  - Gmail runs once per interval.
  - Spatial no longer files its own failures as findings.
  - The fleet verifier says `unverified` when the manager snapshot is missing
    or stale.
  - The package steward writes a failure receipt.
  - The chat steward no longer writes the history file. It deletes the old
    copy once, at start.

**How it was checked:**
- Backend suite: 2114 pass.
- `test_alpha_agent_manager.ps1` passes under PowerShell 7.4. It now fails if
  any fleet script signs in on its own or hardcodes 8001.
- `test_alpha_steward_common.ps1`: 24 checks against a mocked backend.
- A live run against a local backend:
  - four stewards with a wrong password made **one** sign-in attempt between
    them;
  - after the right password was saved, they ran and wrote correct receipts;
  - the manager signed in once for its whole run.
- Agent simulation and QC: 0 findings.

## On Worker1 (Laptop41), where Alpha runs

1. **Bring the update in** (BACKLOG H1). This now covers `scripts\` too:
   ```powershell
   cd C:\services\alpha-tunnel; git checkout main; git pull
   node scripts/apply-alpha-update.mjs --alpha-root C:\Users\Vyo\Downloads\VyoS-advance-tech-ai           # report
   node scripts/apply-alpha-update.mjs --alpha-root C:\Users\Vyo\Downloads\VyoS-advance-tech-ai --apply --restart
   ```
   - If it refuses only on files under `scripts\` (those were edited on the
     laptop), add `--skip-scripts`. That gets the backend and frontend in
     now. The steward scripts then need merging by hand (BACKLOG ST1).
   - It checks every `.ps1` it writes with the PowerShell parser, and puts
     everything back if one does not parse.
2. **Restart the stewards.** They load their scripts once, when they start.
   ```powershell
   $alpha = 'C:\Users\Vyo\Downloads\VyoS-advance-tech-ai'
   (Get-Content "$alpha\memory\local\agent-manager\workers.json" -Raw | ConvertFrom-Json).workers |
     ForEach-Object { $p = Get-Process -Id $_.pid -ErrorAction SilentlyContinue
                      if ($p -and $p.ProcessName -in 'powershell','pwsh') { Stop-Process -Id $p.Id } }
   & "$alpha\scripts\start_visible_alpha_codex_agents.ps1"
   ```
3. **Check them.** After a minute, the manager window lists the workers.
   - If any say `local-authentication-unavailable`, read
     `memory\local\steward-auth-backoff.json`.
   - If it says the saved password was rejected, run
     `scripts\set-alpha-local-credential.ps1`. Run it as the same Windows user
     the stewards run as, because the file is DPAPI-encrypted for that user.
     It tests the password before saving it, and the stewards resume as soon
     as the file changes.
4. **If the account is locked right now** (sign-in answers "Too many failed
   sign-ins for this account"), restarting the backend in step 1 clears it.
   The count is kept in memory.

## Still open: BACKLOG ST1-ST6

- ST1, if step 1 needed `--skip-scripts`: merge the steward changes into
  Worker1's own copies.
- ST2: `-NoExit` keeps a crashed hidden worker "alive", so the manager never
  restarts it. First check each worker's command loops forever.
- ST3: the Python token fallback (manager, deck, API, workspace monitor) has
  no timeout. A hung Python hangs the manager.
- ST4: the package and voice stewards have no DPAPI fallback.
- ST5: process ID reuse is accepted on the process name alone, and
  `-ForceNew` starts a second fleet beside the first.
- ST6: the manager gives a campaign `/run` 30s. Real cycles take longer, so
  they report errors that are not errors.

For Codex (read-only): read `alpha_steward_common.ps1` and say whether any
fleet script still reaches `/auth/login` by another route. The contract test
checks for the literal text only.

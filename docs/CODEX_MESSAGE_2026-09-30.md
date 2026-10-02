# Message for Codex — 2026-09-30

From: Claude Code, working from cloud containers on `vyos88/Personal-AI-1.2`
("alpha-tunnel"). To: Codex. The owner will tell you to read this.

Read **[`ALPHA_HANDOVER_2026-09-30.md`](ALPHA_HANDOVER_2026-09-30.md)** first.
It is the complete audit of Alpha as of today: what runs where, what is
verified, what is broken, what is only simulated, and what to do next. This
file is the change log that goes with it: everything that changed in the
tunnel repo that touches Alpha, so your picture matches `main`.

Update your checkout: `git -C <alpha-tunnel checkout> pull --ff-only`. On a
fleet machine, the keeper does this every three hours if the tree is clean.

---

## 1. Changes today (2026-09-30)

- **PR #55, merged: the keeper no longer orphans its self-update.**
  - `scripts/keep-agent.mjs` now waits for an update already in flight when it exits (on a signal or a stand-down).
  - The wait is bounded by `--stop-timeout-ms`. If the update is wedged, the keeper kills the whole process tree.
  - `selfUpdate` switched from `execFile` to `spawn`, because `execFile` silently drops `detached`.
  - `killTree` moved to `src/common/kill-tree.js`, shared with `standby-alpha.mjs`.
  - Behaviour change: Ctrl+C no longer reaches self-update directly. The keeper lets the update finish, bounded as above.
- **PR #56 (this one): script output no longer blocks self-update.**
  - `usb-inventory.ps1` (run by every `device.inventory` task) and the fix, cleanup and start scripts wrote files into `scripts/`. None of them were ignored.
  - `self-update.mjs` and `alpha.update` refuse to pull on any untracked file.
  - Result: one inventory task, or one fix-script run, silently stopped that machine updating. Those files are now in `.gitignore`.
  - **If a machine is stuck on an old commit**, run `git status` in its checkout. Delete, or now ignore, the leftover `scripts/*-log.txt` and `scripts/usb-inventory.*`.
- **Also in PR #56:** this message and the handover.

## 2. Changes since `codex.exec` landed (2026-09-27 → 09-29)

| PR | Change | What it means for you |
|---|---|---|
| #38 | **`codex.exec`**: a prompt is handed to Codex CLI on the machine that has it, and the answer comes back as the task result | This is how Claude reaches you. The payload is `{prompt}` only. Sandbox defaults to `read-only`. `alpha-admin codex --prompt-file` leases for 10 minutes. |
| #43 | Close Codex's stdin, so `codex.exec` answers instead of hanging. A trapped SIGTERM that exits 0 is now reported as a timeout. | Verified against codex-cli 0.157.1 |
| #39 | Music genre taxonomy: 13 genres, 69 subgenres, BPM suggested but never pinned | `src/common/musicGenres.js`. It is mirrored exactly by `vyos88/Alpha` `frontend/src/data/musicGenres.ts`. |
| #40 | **Music Creator backend:**<br>• `alpha.music` runs the MusicGen generator `scripts/generate_music.py`;<br>• `alpha.music.audio` returns 512 KB slices;<br>• the **music bridge** `scripts/music-bridge.mjs` on `127.0.0.1:8790` | Dry-run only so far: no real audio yet. The panel lives on Alpha `main`, which is **not** the served UI (handover §6.3). |
| #41 | Doc: retire the coordinator and stand it up on another machine | `docs/COORDINATOR_MIGRATION.md` |
| #44 | `fix-cloudflare.ps1` and `start-alpha-at-boot.ps1` keep `alpha-ai.uk` up across reboots | Service created; outcome after a reboot unverified |
| #47 | **Host repair plus bounded self-heal:**<br>• `repair-alpha-host.ps1` (`-ReportOnly`, `-Rollback`);<br>• `alpha-selfheal.mjs` (SYSTEM task every 2 minutes, streak/cooldown/budget) | **Never run on Laptop41 yet** |
| #48 | `recover-alpha-from-usb.ps1`: restores Alpha from the USB bundle side by side on 8011/4183 | Never run |
| #52 | All `.ps1` files are ASCII (PowerShell 5.1 misreads BOM-less UTF-8), with a test | — |
| #53 | `move-coordinator-here.mjs`: the old coordinator left the tailnet, so make Laptop41 the coordinator. Fixes a lost admin key, a missing PowerShell (PATHEXT double-append) and `ALPHA_EXTRA_HANDLERS` shadowing | Stopped at its attach check on the first run; fixed; **needs a re-run** |
| #54 | `open-alpha.ps1` and `use-latest-alpha.ps1`: a desktop shortcut that opens the newest Alpha only once it answers | `use-latest-alpha` re-points the wrong thing (handover B11) |

Earlier history (09-01 → 09-17) covers leases, placement, auth, `alpha.render`,
`device.inventory`, `alpha.panel`, `grow`, the keeper, the standby and the
watchdog. See `git log --first-parent`.

## 3. Findings you should know before touching Alpha

Everything below is detailed in the handover. The short version:

1. **Security (app).** Login does not enforce 2FA. The rate limit trusts a
   spoofed header. One status endpoint is unauthenticated. Owner tokens last
   7 days and cannot be revoked. `/terminal/execute` (owner PowerShell) is
   reachable through the public proxy. A default owner password literal is
   committed in about 12 scripts of the private Alpha repo. The owner has the
   exact locations; **do not copy secrets into any file, prompt or result.**
2. **The served UI is the `alpha-full` Deck** (Vite on 4173). The 4-file
   "Alpha 9.0" shell on Alpha `main` cannot build. Port features to the Deck,
   not to `main`.
3. **The live source is not in git.** `alpha-full` is an installer snapshot
   from 2026-08-27, and the host runs a local working copy. Before editing
   Alpha, confirm which copy the `Alpha` task actually serves.
4. **Up to seven supervisors restart the same processes** (handover §8.2).
   Don't add an eighth.
5. **Tunnel bugs found today and not yet fixed:**
   - a failed receipts write kills the coordinator (unhandled rejection);
   - invite redeem race;
   - a `users:write` holder can demote an admin;
   - finished tasks are never removed from memory;
   - `auth.json` is rewritten on every request;
   - `alpha.coordination` reports a timeout as exit 0;
   - `alpha.render` leaks staging directories;
   - the CrowPanel firmware reads the wrong `/stats` fields.

   Open PR #51 fixes several of the memory items, but **it will conflict with
   #55 in `keep-agent.mjs`.**
6. **Model mismatch:** `OLLAMA_MODEL` defaults to `llama3.2:3b`, which was
   parked on 08-27. Only 1.5–1.7B models are active.

## 4. What would help most from you (Codex, on the host)

Things a cloud session cannot do, in the order that unblocks the most:

1. Confirm what `alpha-ai.uk` actually serves:
   - which folder the `Alpha` task runs;
   - `dist_built_at` from `/_alpha/health/frontend`;
   - `/health` on 8001.
2. `node scripts/move-coordinator-here.mjs` on Laptop41 → `node src/admin/run.js agents` shows who is attached.
3. `powershell -ExecutionPolicy Bypass -File scripts\repair-alpha-host.ps1 -ReportOnly` → post the report path.
4. `scripts\publish-alpha-push.ps1`, audit mode first, so the live Alpha source reaches git (branch `alpha-from-host`).
5. Reply with receipts. Commit them to `docs/` on a branch, or post them through the coordination tunnel as below, so the next session sees evidence instead of guesses.

---

## How the owner can deliver this over the tunnel (run on the host)

Cloud sessions cannot reach the tailnet, so these run on the coordinator machine.

```powershell
# 1. Post a pointer into Alpha's coordination tunnel (visible to every session)
node src/admin/run.js coord --action Post --actor claude-handover `
  --message "Handover + change log for Codex: docs/ALPHA_HANDOVER_2026-09-30.md and docs/CODEX_MESSAGE_2026-09-30.md in vyos88/Personal-AI-1.2 (PR #56)."

# 2. Or hand it to Codex directly (on the machine with codex.exec)
node src/admin/run.js codex --agent <codex machine> --prompt "Read docs/CODEX_MESSAGE_2026-09-30.md and docs/ALPHA_HANDOVER_2026-09-30.md in the alpha-tunnel checkout (git pull first), then reply with anything that is wrong or out of date, and which of section 4's steps you can run."
```

`codex.exec` runs with `cwd` set to `ALPHA_CODEX_ROOT`. The two files are only
readable there if that root is, or contains, an up-to-date alpha-tunnel checkout.

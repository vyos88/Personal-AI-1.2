# Status — start here

The one page for where Alpha and this tunnel stand. Keep it current: a session
that changes what is true here edits this file in the same PR, and puts
anything longer in a dated handoff that this page links to.

*Last updated 2026-10-04.*

## Read this first

- **Use `main`.** This repo's GitHub default branch is set to
  `claude/tunnel-agent-setup-9mnoej`, an old feature branch. A plain
  `git clone` lands there. Clone with `--branch main` until the owner changes
  the default in Settings → General → Default branch.
- **Live state comes from the status branches**, not from docs:
  `git show origin/status/laptop41:reports/latest.txt` (the host's doctor) and
  `git show origin/status/cloud:reports/cloud.md` (the cloud relay). See
  `CLOUD_RELAY.md`.
- **Latest handoff:** [`HANDOFF_2026-10-04b.md`](HANDOFF_2026-10-04b.md).

## Where things are

| What | Where |
|---|---|
| Coordinator, agents, handlers, music bridge | this repo, `main` |
| Alpha app (backend, Deck frontend) | `vyos88/Alpha`, branch `alpha-full`, under `BuildArtifacts/installers/Alpha-Full/software/` |
| Alpha Music Creator shell, agent routine | `vyos88/Alpha`, branch `main` (`AGENTS.md`, `scripts/tunnel-sync.mjs`) |
| What actually runs | Laptop41's local working copy. It is **not in git** yet. See the handoff, step 1. |

## Open, needs a person at Laptop41

0. **Bring the merged Alpha changes into the live install** (fonts, the new
   chrome, login hardening, owner-only audit, the Network hub fix):
   ```powershell
   cd C:\services\alpha-tunnel; git checkout main; git pull
   node scripts/apply-alpha-update.mjs --alpha-root <folder holding Alpha>            # report
   node scripts/apply-alpha-update.mjs --alpha-root <folder holding Alpha> --apply --restart
   ```
   It applies the diff from `alpha-full`, not whole files, so local changes
   elsewhere in a file survive. It refuses the whole update if any edit
   does not fit, backs up first, rebuilds the frontend, and rolls back by
   itself on a failed build or a Python file that does not parse. It prints
   the undo command.
1. Push the live Alpha source with `scripts/publish-alpha.mjs` (audit) and then
   `scripts/publish-alpha-push.ps1 -Push` (to branch `alpha-from-host`).
   Until this happens, every fix in `alpha-full` reaches the host only by
   copying files.
2. `git pull` here and restart the coordinator. The task queue now survives
   restarts (`data/tasks.json`), and three crash and reporting bugs are fixed.
3. The repair sequence in `HANDOFF_2026-10-02_laptop41-repair.md`: nothing
   serves `:4173`, and the backend and self-heal tasks are not registered.

## Open, needs the owner (settings only)

- This repo's default branch → `main`.
- **GitHub Actions cannot run jobs on this account.** In `vyos88/Alpha`
  every run is a `startup_failure` with zero jobs. Here, every job ends within
  three seconds with no runner assigned. Check github.com → Settings →
  Billing and plans (a failed payment or a $0 spending limit locks Actions,
  public repos included) and each repo's Settings → Actions.
  `.github/workflows/test.yml` is ready, but manual-only until then, so it
  does not email a failure on every push. Restore its `push`/`pull_request`
  triggers once a manual run passes.

## The docs here, and which are current

| Current | |
|---|---|
| `HOST_SETUP.md`, `FLEET.md`, `ALWAYS_ON.md`, `AUTO_UPDATE.md`, `HOST_DOWN.md`, `COORDINATOR_MIGRATION.md`, `MASTER_HOST_REPAIR.md` | runbooks |
| `CODEX_BRIDGE.md`, `CLOUD_RELAY.md`, `MUSIC_SUBSCRIPTIONS.md` | how a subsystem works |
| `HANDOFF_2026-10-04b.md`, `HANDOFF_2026-10-04.md`, `HANDOFF_2026-10-02_*.md` | recent handoffs, newest first |

| Superseded (kept for history; do not act on their status sections) | Superseded by |
|---|---|
| `ALPHA_HANDOVER_2026-09-30.md`, `ALPHA_AUDIT.md`, `AUDIT_2026-10-01.md`, `STABILITY_AUDIT_2026-09-29.md`, `WORK_AUDIT_2026-09-15.md` | this page and the 2026-10-04 handoffs. Most of their BROKEN items are now fixed: 2FA, `/chat` 500, receipts crash, the coordination exit code, the render staging leak, the panel `/stats` names. |
| `HANDOFF_LAPTOP41_2026-09-30.md`, `HANDOFF_2026-10-01.md`, `CODEX_MESSAGE_2026-09-30.md` | `HANDOFF_2026-10-02_*.md` and later |
| `MUSIC_CREATOR_STATUS.md`, `MUSIC_GENRES_REPORT.md`, `PANEL_HANDOFF.md` | `HANDOFF_2026-10-02_music-creator.md`; the panel firmware README |

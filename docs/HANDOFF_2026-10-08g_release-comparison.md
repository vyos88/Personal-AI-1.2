# Handoff: Host and Worker1 Alpha compared, and the reversed roles explained (2026-10-08, ~16:20 UTC)

To **Codex**, **Alpha**, V, Claude · Host and Claude · Worker1.

Codex's hourly unification ask (07:28 UTC) had two parts:

- a bounded comparison of the release, root and updater on both machines;
- correcting the role attribution, if the evidence supports it.

The owner's decision is settled and is not asked again: the **Host,
LAPTOP-GJ8DFMLK, is main**, and **Worker1, DESKTOP-41HPLCN**, is the worker.
Device identity and supervisor-root work belong to the existing fifteen-minute
workflow; this handoff does not touch them.

**Sources.** Everything below comes from the machines' own reports on
`status/*` and from git. Nothing was copied, built or restarted.

## The comparison

| | Host LAPTOP-GJ8DFMLK | Worker1 DESKTOP-41HPLCN |
|---|---|---|
| Serving root | `C:\Users\jack\Downloads\VyoS-advance-tech-ai\BuildArtifacts\installers\Alpha-Full\software` (h23, h27) | `C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software` (doctor 14:39 local) |
| Alpha commit | **a3e1350**: the last report, h27 at 01:17 UTC. The site was built from it at h23 (23:04 UTC, 7 Oct) | **20c58f5**: live-sync delivered ab67005 at 05:36 UTC and captured 20c58f5. "Every source file here matches 20c58f5" at 06:44 UTC |
| Bundle (Codex) | `index-DRfHbTbE.js`, HTML 8EF618DC… | `index-DrRVpMIZ.js`, HTML F1DB1207… (the doctor confirms the same bundle in dist, on :4173 and public) |
| Product release | 2.0 | 2.0 |
| "Version" Codex saw | 1.0 | 1.30 |
| Alpha updater | **none.** `control/host` has no `liveSync`. The tunnel autopilot itself cannot fast-forward: "working copy has uncommitted changes … M scripts/usb-inventory.ps1", silent since 07:49 UTC | `liveSync` standing check, in sync, every pass |

**The mismatch is three commits of real code, not drift.** The code difference
`a3e1350..20c58f5` is:

- `5147fef` Songs to MP3;
- `3e9fefb` Debts hub;
- `ab67005` Executor context pack;
- `20c58f5` live edits (three files).

That is 18 files under `software\`.

**Backend compatibility.** Worker1 is a strict superset of the Host:

- three routes added on Worker1: `GET /code/context-pack`,
  `GET` and `PUT /memory/debts/ledger`;
- no route removed;
- no schema or migration change.

So the Host answers everything it serves. A client built from Worker1, such as
the Debts hub sync, gets a 404 from the Host on those three routes. The
frontend also differs: `vite.config.js` forwards ten more API prefixes.

**1.0 against 1.30 is not a version mismatch.** `alpha_release.py` says so:

- "1.30" is `patch_version`, alpha_patch_manager's count of self-applied
  patches on that machine. It is stored in that machine's
  `memory\local\alpha_patch_history.json`.
- "1.0" is the untouched counter on a host that has applied none.
- Both machines report `alpha_version`/`product_release` 2.0.
- One caution: the Host's `memory\` was copied from Worker1's drive (h24). If
  the Host still reads 1.0, it is not reading that copied patch history, or
  not the same `memory\`. Worth one look with Codex's filesystem check.

**"Worker1's schema endpoint returns 404" is by design.** `/openapi.json`,
`/docs` and `/redoc` answer only to a direct loopback request
(`_documentation_or_404`, `main.py`). Over the tailnet's HTTPS ingress they
404 on both machines. Compare backends by commit, as above, not by schema.

**Bundle hashes cannot prove a commit across machines.** Worker1 built
a3e1350 at 23:00 UTC as `index-O7Li-Ohw.js` (doctor, 01:43 UTC). The Host
built the same commit at 23:04 UTC, and Codex now sees `index-DRfHbTbE.js`.

- Same source, different hash. The Host also has no
  `software\frontend\.env.local` (h24 MISSING), and Vite bakes `VITE_*`
  values into the bundle.
- So `DRfHbTbE` is most likely a3e1350 built without that file.
- That is the likely explanation, not proven. The proof is
  `git rev-parse HEAD` plus a hash of `dist\index.html` on each machine,
  which Codex's filesystem check can produce.

## The reversed roles: found, and corrected in the reader

Codex's receipt `task_r1u57pyfsxtgywmy` (`alpha.agent-manager.status`) had the
main-host roles reversed. The cause is a copied file, not a wrong role:

- The Host has never run Alpha's Agent Manager. Claude · Host found its
  controller cannot find its scripts.
- Yet h27 reported "AGENT MANAGER: snapshot here, written 10-07 23:35".
- That snapshot came with `memory\` from Worker1's drive (h24,
  `alpha-move-20261007`). It is Worker1's manager's view from yesterday:
  `DESKTOP-41HPLCN` marked `local` with role `alpha-main`, and
  `LAPTOP-GJ8DFMLK` as `side-worker`.
- The handler labelled it `machine: LAPTOP-GJ8DFMLK`, the reader, so
  Worker1's roles read as the Host's own.

**Fixed in this PR**, with tests:

- `agent-manager-status` now returns `writtenOn`, the device the snapshot
  marks local, and `copied: true` when that is not this machine.
- `fleet-agents.mjs` draws "manager on DESKTOP-41HPLCN … (COPIED: read on
  LAPTOP-GJ8DFMLK; not that machine's manager)" instead of crediting the
  reader.

The two new tests fail without the change and pass with it. The full suite
passes: 855 tests, 0 failures, 86 skipped. The fix reaches the Host when its
checkout can update again.

**What this does not change.** The snapshot's own roles still put Worker1 as
main, because that is what Worker1's manager wrote yesterday. Making Alpha
itself say "Host main" is the owner's policy file,
`agents\fleet-management.json` on both copies, changed in the order
`fleet_placement.coordinator_transition_plan()` sets out. That belongs to the
switch-over and the fifteen-minute workflow, not to this reader.

## Updater outcome

**Nothing was updated.** Nothing was copied or built, and no lease, device
setting or secret was touched.

Two blockers, kept with their evidence:

1. **The Host's tunnel autopilot cannot fast-forward.** A local, uncommitted
   `scripts/usb-inventory.ps1` blocks it. That edit matches Codex's draft
   PR #229, which passes the full suite off Windows (764 pass, 0 fail) and
   merges cleanly with main. Committing it through #229, or stashing it, lets
   the Host take the 30-odd commits it is behind, this fix included. **This is
   for Codex, who has the Host shell.**
2. **The Host's Alpha has no updater.** The existing one is
   `liveSync`/`apply-alpha-update`, fast-forward only. On the Host it would
   want `"capture": false`, because Worker1 already captures to the same
   branch and two capturing writers would race. It also wants task names that
   match the Host's Alpha. Proposed, not queued:
   - it restarts the Host's Alpha;
   - it overlaps the switch-over;
   - this session could not push to `control/host` today (refused earlier by
     its own permissions).

   **For V, or the switch-over owner.**

## Lesson for Alpha

> **Compare commits, not bundles, and never trust a copied state file to
> describe the machine it now sits on.**
>
> - Two builds of one commit had different hashes, because the build reads
>   machine-local configuration.
> - A snapshot copied with `memory\` kept describing the machine it came
>   from.
> - A per-machine patch counter read as a version gap.
>
> Every one of the three looked like a release mismatch, and none was. The
> durable comparison is `git rev-parse HEAD` per serving root. Any
> machine-written file is attributed by the machine that wrote it.

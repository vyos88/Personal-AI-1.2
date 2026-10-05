# Backlog — the standing work queue for Alpha

This is the list Codex, Alpha and every Claude session work from, for as long
as there is work. It holds what is known to be wrong or missing and has not
been done, in order, each item small enough for one PR and checkable when
done. `docs/STATUS.md` says where things stand. This file says what to do
next.

## How to take an item

1. Read `docs/STATUS.md` first, then the item.
2. **Claim it** so two agents do not do the same work. On the Alpha host, post
   a claim through the coordination tunnel:
   `scripts/alpha_coordination_tunnel.ps1 -Action Claim -Actor <you> -Paths <files>`.
   From anywhere else, open a draft PR whose title starts with the item's ID.
3. One item, one PR, on a branch, never `main`. The PR says which item it
   closes and how you checked it.
4. **Done means checked:**
   - the suite passes (backend `pytest`, frontend `npm test`, tunnel `npm test`);
   - for anything visual, `frontend/scripts/visual-audit.mjs` reports no new
     problems on the routes you touched;
   - you ran it, not inferred it.
5. Release the claim (`-Action Release`), and delete the item from this file in the same PR. Add what you found but did
   not do as a new item. The list only works if it stays true.

**Rules that do not bend:**
- Never write a secret anywhere: keys, `auth.json`, `.env` files, passwords.
- Never force-push. Never merge without the suite passing.
- **Codex runs read-only by default** (`codex.exec`). Its items marked
  *report* ask for an answer, not a change. Widening its sandbox is the
  owner's decision on that laptop.

## Now — needs a person at Laptop41

| ID | Item | Done when |
|---|---|---|
| H1 | Bring merged Alpha changes into the live install: `node scripts/apply-alpha-update.mjs --alpha-root <Alpha> --apply --restart` | it prints DONE, alpha-ai.uk shows the new fonts and chrome |
| H2 | Publish the live Alpha source: `scripts/publish-alpha.mjs` then `publish-alpha-push.ps1 -Push` (to `alpha-from-host`) | the branch exists on GitHub |
| H3 | Repair sequence, `HANDOFF_2026-10-02_laptop41-repair.md` | the doctor's report has no NEEDS A PERSON lines |
| H4 | Owner settings: GitHub billing/Actions, this repo's default branch → `main` | a manual run of `.github/workflows/test.yml` passes |
| H5 | Add worker1 to the fleet: key on Laptop41, `setup-agent.mjs --name worker1` and `install-always-on.ps1` on worker1 (`HANDOFF_2026-10-05_worker1.md`) | `run.js task --type sysinfo --agent worker1` comes back from worker1 |

## Next — code (any session)

| ID | Item | Done when |
|---|---|---|
| A1 | Two frontend buttons call routes that do not exist: `/recommendations/debug` (Hubs) and `/arduino/elegoo/install-alpha-firmware` (Devices). Add the route if a backend function already does the job, else remove the button. | both are gone from `KNOWN_MISSING` in `tests/test_frontend_api_contract.py` |
| A2 | Delete the dead copies of shadowed routes, one `api/*.py` module per PR (`tests/route_shadow_baseline.json`, 189 entries; start with `api.missions`, 13). First check that each is identical to the `main.py` copy that serves; one that differs is a bug to raise, not delete. | its lines are gone from the baseline and the suite passes |
| A3 | Split `main.py` (39k lines) one hub at a time into `api/<hub>.py` routers. The shadow ratchet makes each move safe. | one hub per PR, no new shadowing |
| A4 | Replace inline `current_user.get('role') != 'owner'` checks with the `require_owner` dependency. | `grep -c "role') != 'owner'" main.py` reaches 0 |
| V1 | Type floor 8px → 11px, one sheet at a time, with a visual-audit run before and after each. | no text under 11px in `visual-audit.mjs` tiny counts |
| V2 | Move the global sheets to `@layer`. Inside a layer `!important` reverses, so audit every deck before and after. | the nine sheets are layered and the audit is unchanged |
| V3 | Light theme for content panels (atlas-day reaches only the frame today), then `prefers-color-scheme`. | content is readable in atlas-day on every route |
| V4 | Core hub component map: on a phone its labels overlap ("Assistant Loop", "Awakening", "Awareness"). | readable at 412px |
| V5 | Brain deck renders an empty violet panel where the graph should be when WebGL is slow (seen headless). Show the graph's own empty or loading state instead. | the panel says what it is waiting for |
| V6 | Deck heroes: with the full-size gradient slab removed (2026-10-04), several decks (Hardware, Knowledge, Network, Admin, Automation, Terminal) show a large dark hero with only a headline. Give it the deck's real content, or size it to the text. | no hero more than half empty at 1440x900 |
| V7 | The collapsed capability rail floats bottom-left on phones and covers content as you scroll. Its position is deliberate (see the comment in `styles-astral-unification.css`); consider hiding it while scrolling, or docking it in the taskbar. | it never covers text a reader is reading |

## Reports — for Codex (read-only)

| ID | Ask |
|---|---|
| C1 | For A1: does a backend function already do what each missing route should? Name it, or say the button should go. |
| C2 | For A2: for `api.missions`, list which shadowed handlers differ from the `main.py` copy that serves, with the differing lines. |
| C3 | The drive inventory from `status/cloud` (2026-10-03): every backup, archive or old copy over 500 MB under `C:\` (path, size, last modified) and the external drive letter. **Inventory only.** Never list `auth.json`, `.env` or keys. |
| C4 | Read `frontend/visual-audit/summary.txt` after the next audit run on the host, and rank its problems by how many routes each one affects. |

## Ongoing — never "done"

- After every merge to `alpha-full`, run `apply-alpha-update.mjs` on the host
  (H1) so the live Alpha does not drift from the code.
- Run `frontend/scripts/visual-audit.mjs` after any visual change, and weekly.
  Anything it reports goes here as a V item.
- Keep `docs/STATUS.md` true. Write a dated handoff when a session ends with
  work in flight.

# Work audit — the last 72 hours

Window: **2026-09-12 23:00Z → 2026-09-15 23:15Z**. Audited from the repository
and its 14 remote branches. Every figure below is reproducible with the command
shown beside it.

---

## The short version

Five things, in the order they matter.

1. **Nothing has ever been rendered.** Not one image, recipe book or output
   directory exists in this repository or in any of its branches. The render
   pipeline is code and tests only.
2. **`grow` failed on every single task it was given**, and the fix has been
   sitting unmerged in PR #31 for about 22 hours.
3. **The creature library is four presets**, not "all the animals and plants".
   Three plants, one animal. No bugs. No planets.
4. **The suite is green: 285 pass, 0 fail.**
5. **There is no trace of Codex in this repository** — no commit, no branch, no
   string. Whatever it built is somewhere I cannot see.

---

## 1. What landed in the window

```
git log --all --since="2026-09-12T23:00:00Z" --pretty=format:"%h" | sort -u | wc -l
→ 54 commits

git diff --shortstat 031d7b5 origin/main
→ 41 files changed, 8928 insertions(+), 50 deletions(-)
```

**Twelve pull requests merged** — #18 through #29. In order:

| PR | Merged | What it did |
|---|---|---|
| #18 | 09-13 20:54 | `alpha.render` — Blender generator, returns the recipe |
| #19 | 09-13 21:06 | Stop `alpha.render` reporting failed renders as successes |
| #20 | 09-13 23:21 | One registration per worker |
| #21 | 09-14 01:40 | `targetAgent` — a task may name its machine |
| #22 | 09-14 03:02 | `run-jobs.mjs` — batch queueing with a per-machine tally |
| #23 | 09-14 15:00 | `available()` — prove a machine can render before offering to |
| #24 | 09-14 15:05 | `fix-3d.ps1` to pure ASCII |
| #25 | 09-14 19:06 | Batch renders + `--species` + `--save` recipe book |
| #26 | 09-14 19:11 | `watchdog.mjs` — twelve-hourly attachment check |
| #27 | 09-15 01:14 | `alpha.panel` — flash/provision the CrowPanel by task |
| #28 | 09-15 01:15 | `keep-agent.mjs` + `standby-alpha.mjs` |
| #29 | 09-15 01:09 | `device.inventory` — USB inventory as a task |

**Four pull requests still open**, all drafts or unreviewed:

| PR | Opened | What it does | Why it matters |
|---|---|---|---|
| #30 | 09-15 01:17 | Say which of the two device listings to reach for | Docs |
| **#31** | **09-15 01:37** | **Fix `grow` calling the logger as a function** | **See §3 — this is the one** |
| #32 | 09-15 16:10 | Nice external programs; cap a render a core short | Laptop usability during renders |
| #33 | 09-15 17:55 | Panel + fleet survive the host being off; cloudflared | 7 commits, largest open branch |

---

## 2. Renders — how many, and the proof

**Zero.**

```
git log --all --diff-filter=A --name-only --pretty=format: | sort -u \
  | grep -iE "recipe|\.png|output/"
→ (no matches)
```

No `recipes.json`. No `.png`. No `output/` directory. Across all 14 branches and
the entire history. `.gitignore` does not exclude them either — they were never
produced, not merely kept out of git.

**The numbers in the README are illustrative, not measured.** README.md around
line 560 shows:

```
task_sp4mm5tdc2yiq3pr  alpha-host  succeeded 41.2s  tries 1  fern/0 → fern_0.png (182.4 MB)
task_j26b4mwp8sdbvcr3  alpha-host  succeeded 39.8s  tries 1  beetle/1 → beetle_1.png (176.1 MB)
```

Those task ids, durations and file sizes were hand-written into the commit
message for #25 as an example of the output shape. They are not a captured run.
Anyone reading that section could reasonably believe six renders happened; none
did. **That is the single most misleading thing in the repository right now.**

**Why zero is expected, not alarming.** `alpha.render` requires Blender plus
`scripts/generate.py` under `ALPHA_RENDER_ROOT`, and both live on the Alpha host.
This container has no Blender, no generator and no route to the tailnet, so it
cannot render and cannot read what the host rendered. The proof you want exists
only on that box:

```bash
# On the Alpha host — this is the proof-of-work command
node scripts/run-jobs.mjs --type alpha.render --agent alpha-host --count 6 \
  --species fern,beetle --seed 0 --lease-ms 900000 --timeout 1800 \
  --save recipes.json
```

`recipes.json` is the artifact to bring back. It carries species, seed, the
machine that made each one and the bytes it left there — never the image.

---

## 3. `grow` — broken for every task, fix still unmerged

This is the answer to "has everything been updated in Alpha life".

`src/agent/handlers/grow.js` line 416 called the logger as a function:

```js
log?.(`grew ${recipe.kind} "${recipe.name}" seed ${recipe.seed}: ...`);
```

The agent passes `log.child(task.type)` — an **object** with `info`/`warn`/`error`
on it. It is not nullish, so `?.` passed the guard and the call threw
`log is not a function`. Every `grow` task failed, and because a throw is a
failure rather than a decline, each one burned all three attempts before the
queue gave up.

**The suite stayed green the whole time**, because no test passed a logger at
all. Green tests over a handler that failed 100% of real invocations — worth
remembering the next time a suite is cited as evidence.

Fixed in commit `0c0f87d` on `claude/clever-lamport-jqmheg`, open as PR #31 since
**2026-09-15 01:37Z**. Unmerged for roughly 22 hours at the time of writing.
The fix is six lines plus a test that uses the real `createLogger(...).child(...)`,
so the shape it pins is the shape the agent actually passes.

**Merging #31 is the highest-value action available in this repository.** Until
it lands, `grow` produces nothing.

---

## 4. The creature and plant library

`grow`'s presets, from `src/agent/handlers/grow.js` line 49:

| Preset | Kind |
|---|---|
| `fern` | plant |
| `tree` | plant |
| `kelp` | plant |
| `crawler` | animal |

**Four presets: three plants, one animal.** That is the whole library.

Against what was asked for — animals, plants, creatures, bugs, planets:

- **Bugs — none.** `beetle` appears only as a string in README examples and in
  #25's commit message. It is not a `grow` preset, and nothing in this repository
  defines it. If `generate.py` on the host accepts it, that is the host's
  business and not visible here.
- **Planets — none, and `grow` cannot do them.** An L-system describes repeated
  branching. A planet is not a branching structure; it is a sphere with surface
  detail. It is the wrong generator for that shape, not a missing preset.
- **Animals — one.** `crawler`.

`alpha.render` has no species list at all. `ALPHA_RENDER_SPECIES` is an optional
allowlist that is unset by default, which means any well-formed name is passed
straight through to `generate.py`. **So what species actually exist is decided
by a file that is not in this repository** — see §5.

---

## 5. The generator question

You asked whether Codex uses a different generator, and said you would prefer one
shared generator for images. Three separate things are true here.

**There is no trace of Codex in this repository.**

```
git log --all --pretty=format:"%an <%ae>" | sort | uniq -c
→ 77  Claude <noreply@anthropic.com>
→ 24  vyos88 <74215458+vyos88@users.noreply.github.com>

grep -rniE "codex|openai|gpt-|chatgpt" --exclude-dir=.git .
→ (no matches)
```

101 commits, two authors, neither of them Codex. So I cannot compare generators
— I can only describe this side of it.

**This repository already has two generators, and they are deliberately
different.** That is a written decision in CLAUDE.md, not an accident:

| | `grow` | `alpha.render` |
|---|---|---|
| Engine | L-system, in-process JS | Blender + `generate.py` |
| Time | milliseconds | minutes |
| Returns | skeleton (nodes + edges) | a recipe; image stays put |
| Runs on | any agent (`BUILTIN`) | the GPU box only (opt-in) |
| Output | structure | appearance |

CLAUDE.md states plainly that they stay separate and are not merged, because
folding them together would either put Blender behind a `BUILTIN` name or push a
millisecond call behind an opt-in flag — and either breaks the rule keeping
external programs off every agent by default.

**So "use the same generator" needs a decision about which one you mean.** If it
means *images*, there is already exactly one image generator — `generate.py`
under `ALPHA_RENDER_ROOT` — and the fix for divergence is to point Codex at that
same script rather than let it grow its own. If it means *one generator for
everything*, that reopens a decision CLAUDE.md records as settled, and it should
be reopened explicitly rather than drifted into.

Worth flagging: CLAUDE.md also notes that composing the two — feeding a `grow`
skeleton to Blender — is "the obvious next step and is deliberately not done
yet", because `generate.py`'s `--species --seed` interface is fixed and lives
outside this repository. **That change starts on the Python side or not at all.**
If two agents are generating images by different routes, that Python interface is
where the convergence has to happen, and it is not a file either of us can reach
from here.

**To answer the Codex half, I need one of:** the repository or path Codex is
committing to, or `generate.py` itself from the Alpha host.

---

## 6. Test results — proof of work

Full suite, run on this checkout at `f5e3362`:

```
$ npm test
# tests 285
# suites 0
# pass 285
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 25990.606255
```

**285 pass, 0 fail, 0 skipped**, 26.0s. Node v22.22.2, Linux 6.18.44.

The two suites covering creatures and plants, run on their own:

```
$ node --test test/grow.test.js test/alpha-render.test.js
# tests 39
# pass 39
# fail 0
# duration_ms 758.680805
```

Per suite:

| Suite | Tests | | Suite | Tests |
|---|---|---|---|---|
| memory | 54 | | alpha-update | 15 |
| auth | 32 | | alpha-panel | 14 |
| load | 28 | | alpha-devices | 11 |
| tunnel | 28 | | targeting | 10 |
| **alpha-render** | **23** | | setup-agent | 8 |
| fleet | 17 | | standby-alpha | 8 |
| alpha-coordination | 16 | | keep-agent | 5 |
| **grow** | **16** | | | |

**A caveat on what green means here.** §3 is the standing counter-example: the
suite was green while `grow` failed every real task, because no test passed a
logger. These 285 tests cover argv construction, validation, placement and
protocol. **Not one of them runs Blender.** The render path's contract with the
real generator is pinned against a recorder, not against `generate.py`.

---

## 7. What to do next, in order

1. **Merge PR #31.** `grow` produces nothing until it lands. Six lines.
2. **Run the batch render on the Alpha host** (command in §2) and commit
   `recipes.json`. That converts "zero renders" into a real number with evidence
   behind it.
3. **Fix the README's illustrative output** (§2) so it is marked as an example,
   or replace it with a captured run once step 2 produces one.
4. **Settle the generator question** (§5) by naming where Codex's work lives.
5. **Decide whether the creature library is meant to grow** (§4). Four presets is
   a proof of concept. Bugs are a plausible L-system; planets are not.
6. Then triage #30, #32 and #33 — #32 in particular, since it is what stops a
   render making the laptop unusable while it runs.

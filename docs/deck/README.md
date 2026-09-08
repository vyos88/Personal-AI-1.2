# The deck

`alpha-tunnel.pptx` — how work is placed across the Alpha host and the laptops:
why both machines ended up pinned, what decides which one takes a task now, and
how to enrol another peer.

## Rebuilding it

```bash
cd docs/deck
npm install
npm run build
```

That writes `alpha-tunnel.pptx` next to the generator.

**The dependency lives here, not at the repo root.** `alpha-tunnel` is meant to
be cloned onto a machine and run with nothing but `node`, and a deck generator
is no reason to change that. The root `package.json` still has empty
`dependencies` and `devDependencies`, `npm install` at the root still installs
nothing, and nothing under `src/` or `test/` imports anything in this
directory. npm will not descend into here on its own — there are no workspaces
configured — so this folder is only touched when you deliberately build a deck.

## What is derived, and what is deliberately not

**The release** is read from the root `package.json`, so the deck cannot claim
one version while the machines report another — the exact drift this project
exists to make visible. It is derived because it matters and barely moves.

**The suite is checked but not counted.** `node --test` runs at build time and a
red suite fails the build, so the deck can never assert a green one over a
failing one. It used to print the passing count too; that was dropped. Deriving
the figure kept it honest, but a number on a slide is only honest until the next
test lands, and the committed `.pptx` then had to be rebuilt to catch up — four
times in three days, each a commit that changed nothing anybody reads. The check
is the half worth keeping.

So a rebuild is needed when the slides or the release change, and not merely
because the suite grew.

`PRE_LOAD_VERSION` is the one version literal that stays put: it names the
release before agents could report load at all, which is what makes the drift
example on that slide mean anything.

## If you change the slides

Check the result before committing it — the layout is absolute coordinates, so
overflow and collisions are real risks:

```bash
soffice --headless --convert-to pdf alpha-tunnel.pptx   # needs libreoffice-impress
```

Then look at every page. Text that overflows its box is the most common defect
and the easiest to miss.

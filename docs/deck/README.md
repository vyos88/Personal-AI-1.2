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

## What is derived rather than typed

Two figures come from the repository instead of being written into a slide,
because a number typed into a deck is stale the moment somebody changes the
code behind it:

- **The release** is read from the root `package.json`, so the deck cannot
  claim one version while the machines report another — which is the exact
  drift this project exists to make visible.
- **The passing test count** comes from actually running `node --test`. If the
  suite is red the build fails rather than producing a deck that asserts a
  green one.

So a rebuild after a version bump or a new test needs no edits here.

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

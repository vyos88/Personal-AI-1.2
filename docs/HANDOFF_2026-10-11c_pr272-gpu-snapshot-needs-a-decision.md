# Handoff: PR #272 needs a decision before merging, not a merge

## What it is

[#272](https://github.com/vyos88/Personal-AI-1.2/pull/272), "Snapshot: the
GPU-demand and execution-policy code that runs on alpha-serv-01, never
committed." A preservation PR (V asked for it so uncommitted live code isn't
lost), publishing two variants of GPU-demand/execution-policy code that were
sitting uncommitted on two different machines and existed nowhere on GitHub:

1. The Host's edits (`LAPTOP-GJ8DFMLK`, 13 uncommitted files, 2026-10-11
   01:07–05:16 local).
2. alpha-serv-01's variant (a non-git copy there) — four files differ from
   (1), moving the fleet policy to `src/common/fleet-execution-policy.js`.

Tests pass (16/16 on the two new suites; 977/842/0/135 on the merged full
suite — the 135 skips are PowerShell-only, no `pwsh` here), and a secret scan
of every file found nothing. Technically mergeable (`mergeable_state: "clean"`).

## Why this session isn't merging it

The PR's own body says so directly: **"Not run on a machine. Whoever wrote
this (Codex or `claude-alpha-serv`?) should say whether the Host or the
server version is the intended one before it merges."**

That's not a test failure or a style question — it's "which of two live,
divergent variants of GPU-demand/execution-policy code is correct for the
machine that's actually running it," and this session has no way to check
that from the cloud container (per `CLAUDE.md`: "anything needing the live
coordinator has to run on the host or the laptop"). Merging the wrong one
risks landing code that doesn't match what alpha-serv-01 is actually running
its live image bridge against.

## What's needed

Someone with access to alpha-serv-01 (or Codex/`claude-alpha-serv`, who
apparently wrote one of the two variants) confirms which of the two is the
one actually intended to run there, before this merges. Once that's settled,
the merge itself is low-risk — tests pass, no conflicts, secrets scanned
clean.

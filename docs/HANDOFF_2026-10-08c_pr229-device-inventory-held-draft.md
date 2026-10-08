## Hourly alpha-tunnel handoff check — 2026-10-08

### New: Personal-AI-1.2#229 — held in draft by its own author

[PR #229](https://github.com/vyos88/Personal-AI-1.2/pull/229) ("Fix Windows
device inventory JSON and USB IDs") fixes two real bugs in `device.inventory`
found on the Host: PowerShell writing a UTF-8 BOM into the JSON it produces,
and a second failure from assigning to the read-only `$PID` variable. The
producer now writes BOM-free JSON with a separate product-ID variable and
surfaces collection errors; the reader also accepts older BOM-prefixed
reports.

**Not merged, on the PR's own say-so:**

> Both full-suite attempts stalled after the auth case that revokes a narrow
> key. The first was stopped after six minutes without progress; the second
> reproduced the stall... Neither is a passing full-suite result... **Keep
> this draft while the independent full-suite lifecycle blocker is
> diagnosed.**

The producer fix itself is verified a different way — against a real,
completed live task on the Host (`task_1oqp8wxmhws11knn`, 32 USB entries, 1
CIM serial port, 13 AV entries) and 14 focused inventory tests, all passing —
but the author explicitly asks to hold the merge until the separate
full-suite stall (something in the auth-key-revocation test, not this PR's
code) is understood. Respecting that: left as draft, not merged.

### Also this pass

Merged two independently-verified PRs (clean merge with main, full suite
green, no live-host or security judgment calls):

- **#228** — "alpha-runtime: a guard that answers no is a script that
  prints nothing": fixed the shared `.mjs` entrypoint-detection idiom that
  was silently skipping `main()` on Worker1 under a Windows path-casing
  mismatch.
- **#230** — "Three reads that couldn't tell an absence from a failure to
  look": three diagnostic-reading bugs (receipts read from a field that
  never exists on disk, "degraded" awareness misread as a dead loop, and
  `repair-alpha-host.ps1`'s jack-attached check matching stderr text instead
  of checking the exit code). 844 tests, 0 failed.

Laptop41 telemetry: **all clear** — music bridge, image bridge and self-heal
are all `ok`, no open problems this pass.

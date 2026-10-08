## Hourly alpha-tunnel handoff check — 2026-10-08

### Real finding: Alpha's GPU admission gate is stuck shut on Worker1

Surfaced by [PR #231](https://github.com/vyos88/Personal-AI-1.2/pull/231)
(merged — it only adds a read-only CPU check to the doctor) and already
noted by its author in `docs/ASKS.md` as `[!] needs V`. Restating it here
since it's a live production problem, not a code-review question:

Since PR #230 fixed the receipts reader, the doctor can see what
`alpha-runtime` is actually recording on Worker1: **201 retained receipts**,
all `evidence-contract` failures, all the same two messages, roughly every
15 minutes:

- `Timeout: Waiting for system CPU below the configured hold limit; GPU
  admission timed out without starting` — CPU is at or above
  `system_cpu_hold_percent` (90% by default, `config/gpu-routing.json` in
  **vyos88/Alpha**).
- `Timeout: Waiting for fresh per-adapter GPU telemetry; GPU admission timed
  out without starting` — this one **outlasts the CPU spike**: the only call
  that schedules a GPU telemetry refresh is itself guarded on
  `not pressure_reasons`, so while CPU is pinned no refresh is ever
  scheduled, telemetry never becomes `observed`, and admission keeps
  refusing even once CPU has dropped. That's a pressure deadlock, not a
  slow recovery.

Net effect: Alpha's Chat Diagnosis and Fixer agents have been failing at
the admission gate on every scheduled run — not producing wrong output,
producing **no model run at all** — while chat itself still answers (at
6.1 tokens/s per the doctor's own check, which reads as CPU-speed, not
GPU-speed, and is possibly the same root cause: `llama-server` may be doing
inference on the CPU).

**The fix is in vyos88/Alpha** (`gpu_work.py` / `windows_gpu.py`), not in
this repo. This is a real behavior change to a live admission/concurrency
gate — exactly the kind of fix that needs the owner's judgment on intent
(should the telemetry refresh be scheduled unconditionally? should the hold
percent be lower on this machine?) rather than a cloud session's guess.
Flagging rather than patching it.

### Also merged this pass (all independently verified: clean merge with
main, full suite green, no live-host or security judgment involved)

- **#231** — doctor now reads and reports CPU pressure against the hold,
  with the above finding as a side effect of being able to see receipts at
  all (PR #230).
- **#232** — `alpha-coordination`'s `Status` action now parses its full
  output before the 16,000-char clip, so oversized ownership evidence
  degrades to an explicit "unknown" instead of a truncated, invalid JSON
  tail reported as success. Purely additive to the result shape; no change
  to the pinned interpreter, script path, allowlist or argv construction.

### Still held: #229

Device-inventory fix remains in draft at the author's own request (full
suite stalled on an unrelated auth-key-revocation case) — see
`docs/HANDOFF_2026-10-08c_pr229-device-inventory-held-draft.md`.

Laptop41 telemetry otherwise reads `ok: no problems found` this pass.

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
  out without starting` — the telemetry-refresh call that would clear this
  is itself guarded on `not pressure_reasons`, so while CPU is pinned no
  refresh gets scheduled.

  **Correction (PR #233):** I originally wrote that this refusal "outlasts
  the spike" — i.e. that it's a deadlock independent of CPU, not just a
  symptom of it. The doctor's first two real CPU readings point opposite
  ways (49% ok, then 90% held), and at 49% the probe's own guard *allows*
  it to run — so the stronger claim only follows from the code for a brief
  dip, not a sustained drop below the hold. Whether a sustained low-CPU
  window actually clears the gate, or the probe itself fails independent of
  CPU, is still open; a read-only `alpha-runtime` pass is queued on
  Worker1 to check whether any receipt completed during such a window.
  Treat "deadlock independent of CPU" as unconfirmed until that comes back.

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
- **#233** — wording-only correction of the "outlasts the spike" claim
  above (no logic change), merged after the 90%-hold reading in section 7
  below came in right after a 49% "ok" reading.

### Still held: #229

Device-inventory fix remains in draft at the author's own request (full
suite stalled on an unrelated auth-key-revocation case) — see
`docs/HANDOFF_2026-10-08c_pr229-device-inventory-held-draft.md`.

### Update: CPU back down, still unconfirmed whether the gate cleared

Most recent pass: CPU 31% (`ok`), with the 90%-hold hit noted as "fixed
since last run." That's consistent with the hold itself clearing, but
doesn't yet confirm whether the telemetry-refresh side resolved on its own
too — the queued read-only `alpha-runtime` check (see #233 above) is what
would actually settle that. Laptop41 telemetry otherwise reads
`ok: no problems found` this pass.

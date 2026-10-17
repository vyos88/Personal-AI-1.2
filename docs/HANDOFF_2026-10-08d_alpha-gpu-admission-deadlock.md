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

### Settled: the probe is not unscheduled, it never reaches `observed`

That queued check ran — `20261008-08-alpha-runtime`, 10:19 UTC — and the
answer does not use the CPU readings at all. **Five of the eight newest
receipts fail with the *telemetry* message, three with the CPU one:**

```
10:12:48Z Alpha Solutions   ... Waiting for fresh per-adapter GPU telemetry
09:57:18Z Coding Qc         ... Waiting for system CPU below the hold limit
09:41:47Z Coding Fixer      ... Waiting for fresh per-adapter GPU telemetry
09:26:17Z Coding Solutions  ... Waiting for fresh per-adapter GPU telemetry
09:10:46Z Alpha Diagnosis   ... Waiting for system CPU below the hold limit
08:55:16Z Chat Solutions    ... Waiting for fresh per-adapter GPU telemetry
08:39:46Z Chat Fixer        ... Waiting for fresh per-adapter GPU telemetry
08:24:16Z Chat Diagnosis    ... Waiting for system CPU below the hold limit
```

The proof is Alpha's own check order, which is why no CPU trace is needed:

1. `admission_reason` tests CPU **first** and RAM second, returning early.
   So a receipt whose reason is the telemetry one proves CPU was *below* the
   hold and RAM inside its limits at that moment.
2. The admission loop re-evaluates `gpu_snapshot()` every 0.25 s until its
   deadline and raises with the **last** reason, so that held to the timeout
   rather than for an instant.
3. With `pressure_reasons` empty, `gpu_snapshot()` **does** call
   `_schedule_windows_gpu_refresh()`.

So the probe was scheduled, repeatedly, across an hour and a half, and
`gpu_telemetry_status` still never reached `observed`. `windows_gpu.py`
returns `"observed" if measured else "counter-unavailable"`, where
`measured` needs at least one configured adapter carrying a PDH
`utilization_percent`; `_refresh_windows_gpu` passes
`failure_backoff_seconds=300`, so a failing probe stays stale five minutes
at a time.

**So "deadlock independent of CPU" is confirmed, but the mechanism in the
section above is wrong** — including in its corrected form. The refusal does
not persist because the probe is blocked from running; the probe runs and
does not produce `observed`. **Freeing CPU will not fix it.** The four CPU
readings since (31%, 49%, 54%, and one 90% spike) put the host below the
hold most of the time, and the gate is still shut.

CPU pressure is a real second problem, not this one: three receipts blame
the hold, and `llama-server` resident at 1,932 MB (pid 1040) answering chat
at 6–10 tokens/s is CPU-speed inference.

The live question is now in `docs/ASKS.md`: **why does the per-adapter probe
never reach `observed` on this host?** Two read-only checks a shell there
can answer, neither needing Alpha changed — what
`config/gpu-routing.json` names as integrated/dedicated adapters, and
whether their PDH counters read at all. An adapter named there that the
machine does not have leaves `measured` empty forever and refuses every
local model call, which is exactly what the 201 receipts show.

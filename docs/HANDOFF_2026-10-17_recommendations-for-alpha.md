# Recommendations for Alpha — consolidated from this session's monitoring

This gathers everything flagged across the last few days' handoffs into one
list. **None of it can be run from here** — every item needs hands on
Laptop41, `alpha-serv-01`, or a machine on that tailnet. This doc is the
pickup point for whoever does that next (V, Codex, or another session with
host access).

## Needs a person soon

1. **Decide Laptop41's role once, concretely.** `role.json` has said standby
   since 2026-10-11, but the `AlphaPanelFeed` backend (pid 2180 pythonw.exe)
   has kept running there the whole time — "two Alphas" on every single
   doctor pass, now 222+ runs open. Either run `alpha-standdown` on Laptop41
   again (if the backend starting was accidental/leftover), or commit to
   `alpha-standup` there and stand `alpha-serv-01` down. Either resolution
   stops this line being permanent noise. This is the single highest-value
   fix on this list because it also silently resolves the "automatic cover
   absent" line (457+ runs open) — that cover task is only meaningful once
   Laptop41's role is settled.

2. **Investigate alpha-ai.uk's recurring 502/404 blips.** Self-resolved at
   least 7 times in the past week alone (one 404 on 2026-10-14, six
   502/404s on 2026-10-16–17), always while Laptop41 is standby. Per the
   doctor's own diagnostic recommendation: compare `alpha-serv-01`'s backend
   health (section 1) against its public endpoint (section 4) — if only the
   public side fails and the origin answers fine, the connector
   (cloudflared) is the fault, not the Alpha backend itself. Full detail in
   `docs/HANDOFF_2026-10-16_public-site-502.md`.

3. **Chase the recurring CPU-100% spikes**, including one that stalled the
   doctor's own `-Watch` loop for 3+ hours on 2026-10-13 (`HANDOFF_2026-10-13c`)
   and several shorter single-pass spikes since. Chrome and the ChatGPT app
   are the visible load in every reading, but 100+ processes are
   unmeasurable without Administrator. Run the doctor elevated once to see
   the real culprit — sustained 100% stops the agent from accepting tunnel
   tasks at all (`ALPHA_AGENT_MAX_LOAD`).

## Worth doing when convenient (the doctor's own standing hardening list)

4. Store `ALPHA_ADMIN_TOKEN` for the user account so scheduled runs include
   `agents`/`keys`/`tasks` in their reports:
   `[Environment]::SetEnvironmentVariable('ALPHA_ADMIN_TOKEN', (Read-Host 'key'), 'User')`.
5. Set the `cloudflared` service to Automatic start, so the public hostname
   survives a reboot — directly relevant to item 2 above.
6. Keep Laptop41 on AC with sleep disabled (repair-alpha-host step 5); a
   sleeping host is an outage no checker can fix.
7. Set Windows Update active hours around when Alpha is actually used, so a
   forced restart doesn't land mid-use.
8. Rotate the panel and agent keys issued by the old coordinator — they're
   void post-migration and should be revoked rather than left live.
9. Test a full reboot once everything above is green: every doctor check
   should pass again within 5 minutes with nobody logged in.
10. Trim what doesn't belong on the host: ChatGPT and other heavy apps
    compete with Alpha for the same 16GB. `WindowsTerminal` alone climbed
    past 2GB mid-session before something cleared it.

## Lower priority, hygiene

11. Both `vyos88/Personal-AI-1.2` and `vyos88/Alpha` are carrying a long tail
    of draft PRs dating back to September (18 open on each repo as of this
    writing) — none were docs-only/safe fixes, so none were touched by the
    automated monitoring this session. Worth a triage pass by V to close or
    land the ones still relevant and prune the rest.
12. If another session writes a file through this repo's tooling, pass file
    content as plain text, not pre-base64-encoded — this session hit and
    fixed exactly that bug on `HANDOFF_2026-10-16_public-site-502.md`
    (it had been committed as one unreadable base64 line).

## Not on this list (already handled or explicitly out of scope)

- The standby-cover task being absent is **expected**, per V's instruction
  relayed by Codex in `HANDOFF_2026-10-10_public-site-down-standby-not-covering.md`:
  `alpha-serv-01` is the deliberate sole server and Laptop41/Worker1 stays a
  worker. It only becomes actionable once item 1 above is resolved one way
  or the other.
- Items 1–3 are explicitly **not** things a cloud session can act on;
  flagging them here is the full extent of what this session can do.

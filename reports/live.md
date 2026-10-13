# Alpha is STANDBY BUT SERVING - DESKTOP-41HPLCN, 2026-10-14 00:22 +01:00

Written every autopilot pass (5 minutes), whether or not anything changed.

| Check | State | Detail |
|---|---|---|
| Alpha (backend, site, alpha-ai.uk) | STANDBY BUT SERVING | Alpha serves from alpha-serv-01: alpha-ai.uk 200; running HERE too: backend (two Alphas: queue alpha-standdown again, or alpha-standup to serve here) (checked by this pass) |
| Role | STANDBY | alpha-serv-01 serves Alpha; automatic cover is NOT RUNNING (last pass 5721 min ago) |
| Data copy | OWED | sent 680 file(s) to alpha-serv-01 at 2026-10-11T00:20:46Z (4261 min ago) (89 MB still to send) |
| Repair agent (self-heal) | OFF (standby) | off on purpose: another machine serves Alpha |
| Decks | 1 down, 1 static, 1 no feed | not live: all decks: backend (/health) (checked 2026-10-13T21:37:22.404814+00:00 (104 min ago)) |
| Live sync | STOP | STOP: could not fetch claude/frie...(30): git fetch --filter=blob:none https://github.com/vyos88/Alpha gave up after 120s (raise ALPHA_GIT_TIMEOUT_MS if that is too short) |


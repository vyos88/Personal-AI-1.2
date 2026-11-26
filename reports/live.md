# Alpha is STANDBY BUT SERVING - DESKTOP-41HPLCN, 2026-11-26 23:45 +00:00

Written every autopilot pass (5 minutes), whether or not anything changed.

| Check | State | Detail |
|---|---|---|
| Alpha (backend, site, alpha-ai.uk) | STANDBY BUT SERVING | Alpha serves from alpha-serv-01: alpha-ai.uk 200; running HERE too: backend (two Alphas: queue alpha-standdown again, or alpha-standup to serve here) (checked by this pass) |
| Role | STANDBY | alpha-serv-01 serves Alpha; automatic cover: alpha-serv-01's Alpha answers (1 min ago) |
| Data copy | ON | sent 274 file(s) to alpha-serv-01 at 2026-11-26T23:30:43Z (15 min ago) |
| Repair agent (self-heal) | OFF (standby) | off on purpose: another machine serves Alpha |
| Decks | 1 down, 1 static, 1 no feed | not live: all decks: backend (/health) (checked 2026-11-26T23:44:42.445232+00:00 (1 min ago)) |
| Live sync | STOP | STOP: could not fetch claude/frie...(30): git fetch --filter=blob:none https://github.com/vyos88/Alpha gave up after 120s (raise ALPHA_GIT_TIMEOUT_MS if that is too short) |


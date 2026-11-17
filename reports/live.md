# Alpha is STANDBY BUT SERVING - DESKTOP-41HPLCN, 2026-11-17 17:55 +00:00

Written every autopilot pass (5 minutes), whether or not anything changed.

| Check | State | Detail |
|---|---|---|
| Alpha (backend, site, alpha-ai.uk) | STANDBY BUT SERVING | Alpha serves from alpha-serv-01: alpha-ai.uk 200; running HERE too: backend, site (two Alphas: queue alpha-standdown again, or alpha-standup to serve here) (checked by this pass) |
| Role | STANDBY | alpha-serv-01 serves Alpha; automatic cover is NOT RUNNING (last pass 8 min ago) |
| Data copy | OWED | sent 210 file(s) to alpha-serv-01 at 2026-11-17T17:00:55Z (54 min ago) (9 MB still to send) |
| Repair agent (self-heal) | OFF (standby) | off on purpose: another machine serves Alpha |
| Decks | 2 live, 2 stale, 1 down, 1 static, 1 no feed | not live: network, hardware, atlas: devices (/devices/network/topology); CrowPanel: display (LAN reads); all UI decks: site (https://127.0.0.1:4173) (checked 2026-11-17T17:40:09.329684+00:00 (15 min ago)) |
| Live sync | STOP | STOP: could not fetch claude/frie...(30): git fetch --filter=blob:none https://github.com/vyos88/Alpha gave up after 120s (raise ALPHA_GIT_TIMEOUT_MS if that is too short) |


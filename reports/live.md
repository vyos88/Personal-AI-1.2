# Alpha is STANDBY BUT SERVING - DESKTOP-41HPLCN, 2026-11-17 11:57 +00:00

Written every autopilot pass (5 minutes), whether or not anything changed.

| Check | State | Detail |
|---|---|---|
| Alpha (backend, site, alpha-ai.uk) | STANDBY BUT SERVING | Alpha serves from alpha-serv-01: alpha-ai.uk 200; running HERE too: backend, site (two Alphas: queue alpha-standdown again, or alpha-standup to serve here) (checked by this pass) |
| Role | STANDBY | alpha-serv-01 serves Alpha; automatic cover: alpha-serv-01's Alpha did not answer (1 of 3) (2 min ago) |
| Data copy | ON | sent 242 file(s) to alpha-serv-01 at 2026-11-17T11:40:49Z (16 min ago) |
| Repair agent (self-heal) | OFF (standby) | off on purpose: another machine serves Alpha |
| Decks | 3 live, 2 stale, 1 static, 1 no feed | not live: network, hardware, atlas: devices (/devices/network/topology); CrowPanel: display (LAN reads) (checked 2026-11-17T11:45:28.759447+00:00 (12 min ago)) |
| Live sync | STOP | STOP: could not fetch claude/frie...(30): git fetch --filter=blob:none https://github.com/vyos88/Alpha gave up after 120s (raise ALPHA_GIT_TIMEOUT_MS if that is too short) |


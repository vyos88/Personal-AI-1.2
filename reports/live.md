# Alpha is STANDBY BUT SERVING - DESKTOP-41HPLCN, 2026-11-17 15:55 +00:00

Written every autopilot pass (5 minutes), whether or not anything changed.

| Check | State | Detail |
|---|---|---|
| Alpha (backend, site, alpha-ai.uk) | STANDBY BUT SERVING | Alpha serves from alpha-serv-01: alpha-ai.uk 200; running HERE too: backend, site (two Alphas: queue alpha-standdown again, or alpha-standup to serve here) (checked by this pass) |
| Role | STANDBY | alpha-serv-01 serves Alpha; automatic cover: alpha-serv-01's Alpha does not answer over the tailnet, but alpha-ai.uk is served (200): not covering, that would be two Alphas (1 min ago) |
| Data copy | OWED | sent 262 file(s) to alpha-serv-01 at 2026-11-17T14:51:42Z (63 min ago) (14 MB still to send) (1 file(s) not packed yet, tried again each pass) |
| Repair agent (self-heal) | OFF (standby) | off on purpose: another machine serves Alpha |
| Decks | 3 live, 2 stale, 1 static, 1 no feed | not live: network, hardware, atlas: devices (/devices/network/topology); CrowPanel: display (LAN reads) (checked 2026-11-17T15:44:54.425747+00:00 (10 min ago)) |
| Live sync | STOP | STOP: could not fetch claude/frie...(30): git fetch --filter=blob:none https://github.com/vyos88/Alpha gave up after 120s (raise ALPHA_GIT_TIMEOUT_MS if that is too short) |


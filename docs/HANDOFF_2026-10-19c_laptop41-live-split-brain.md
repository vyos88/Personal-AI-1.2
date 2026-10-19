# Laptop41 is actually serving Alpha while standby — live split-brain, 2026-10-19

## What changed

This is not the earlier "two Alphas" condition (a stale `/health` check on
the AlphaPanelFeed backend, long since understood as benign and not counted
as a second Alpha). This is new: Laptop41's doctor pass `20261019-231109`
reports, for the first time this session, that the actual site and
connector are running on a machine whose `role.json` says standby:

```
PROBLEM: standby, but the site runs here (pid 16160 node.exe:
"C:\Program Files\nodejs\node.exe"
C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software\frontend\scripts\alpha-preview.mjs
4173 ): two Alphas. Queue alpha-standdown again, or alpha-standup to serve
here

PROBLEM: standby, but 1 cloudflared process(es) run here: alpha-ai.uk's
traffic is split between two machines
```

Both opened at `2026-10-19T22:41:29`, 3 passes (~30 min) so far. `role.json`
still says standby since `2026-10-11T01:57:18+01:00` — nobody has stood this
machine back up on purpose, as far as this repo can see — yet the frontend
preview (port 4173) and a cloudflared tunnel are both live here, alongside
`alpha-serv-01` which `https://alpha-ai.uk/` has been answering 200 from all
session. That is the split-brain condition `CLAUDE.md`'s notes on
`standby-alpha.mjs` warn about by name: "the machine cannot tell 'the host
is down' from 'I cannot reach the host'" — except here nothing reported the
host as down; someone or something appears to have started the site and
connector on Laptop41 regardless.

## Why this needs a person, not a merge

This is live production traffic for `alpha-ai.uk`, currently answered
unpredictably by whichever of two machines a request happens to hit via
Cloudflare — exactly the outcome `docs/HOST_DOWN.md` and the standby design
exist to prevent. It is a live-host action question (which machine should
serve, and why does Laptop41 have a site and connector running at all while
marked standby), squarely outside what this routine acts on itself.

## Suggested next step for whoever has access

1. Check whether Laptop41 was *meant* to take over serving (a manual
   `alpha-standup`, a test, troubleshooting) or whether this is
   accidental/leftover from something else running on the machine.
2. If accidental: stop the frontend preview (pid 16160) and the cloudflared
   process on Laptop41, i.e. `alpha-standdown` again, so only `alpha-serv-01`
   serves.
3. If intentional (Laptop41 is meant to serve now): run `alpha-standdown`
   on `alpha-serv-01` instead, so only one machine serves, and update
   `role.json` to reflect it.
4. Either way, once only one machine serves, the next doctor pass (15-20
   min) should clear both PROBLEM lines on its own — no code change needed
   here.

## No action taken

Read-only telemetry; nothing here was written to or changed, and nothing
was queued on `control/laptop41`.

## Addendum, 2026-10-19 22:35Z (Claude, cloud session) — two refinements

Both read off the same doctor branch, nothing new queued or changed.

**1. The 404 forty-five minutes earlier was NOT this.** `alpha-ai.uk` answered
404 in exactly one pass today, `20261019-215628` (`PROBLEM: https://alpha-ai.uk/
answers 404 and this machine is standby: nobody serves Alpha`), cleared by
`20261019-221131`. Reading section 0 out of the last 30 doctor passes, that
pass reports `ok: no connector here` **and** `ok: no site here`: the connector
and the site first appear in `20261019-224142`, which is 45 minutes *after*
the 404 had already cleared. So a second connector did not cause the 404, and
the two should not be linked — the 404 window is one more instance of the rate
the merged ASKS census already measured (7 of 300 passes), not a symptom of
this.

**2. There is no backend behind that site, which may make this worse than
"unpredictable".** The same pass `20261019-231109` reports, three lines above
the two PROBLEMs quoted above:

```
backend port 8001 is occupied (pid 10480 pythonw.exe: ... AlphaPanelFeed ...),
but its listener did not return a successful /health response; not counted as
a second Alpha
```

So Laptop41 is running a frontend preview and a Cloudflare connector with
**nothing answering `/health` on 8001 beneath them**. Whether that breaks the
requests Cloudflare routes to this connector depends on where the built
frontend sends its API calls — if it expects a local backend they fail, and if
it is built against another address they do not. That is not knowable from
here, and it is worth settling first, because it decides whether this is "two
machines serving" or "a share of public requests reaching a machine that
cannot serve them". The quickest check on the laptop is to fetch the site on
`127.0.0.1:4173` and watch whether its API calls resolve.

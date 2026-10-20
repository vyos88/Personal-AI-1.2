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

## Addendum 2, 2026-10-20 00:36Z — the site comes back, so step 2 above needs amending

The preview server is not a leftover process sitting still; it restarted
between passes. Reading `the site runs here (pid N` out of the doctor's last
twelve passes:

```
2026-10-19T22:41:42+01:00  pid 16160   (first appearance, with the connector)
2026-10-19T23:11:38+01:00  pid 16160
2026-10-19T23:58:04+01:00  pid 16160
2026-10-20T00:11:39+01:00  pid 16160
2026-10-20T00:42:19+01:00  pid 36852   <- new pid, same command line
2026-10-20T01:11:33+01:00  pid 36852
```

Same `alpha-preview.mjs 4173` command line both times, so it died or was
stopped somewhere between `00:11:39` and `00:42:19` and came back. Whether a
scheduled task, a wrapper, Alpha's own always-on runtime or a person restarted
it is not visible from here — but every one of those readings has the same
consequence for the remedy:

**"stop the frontend preview (pid 16160)" in step 2 will not hold, and that pid
no longer exists.** Whatever stopping is done has to disable the thing that
starts it, which is exactly what `alpha-standdown` does and a bare kill does
not (`docs/AUTOPILOT.md:71`: it "stops and disables `Alpha Backend` and
`Alpha`, stops their wrapper trees and the node/python holding 8001 and 4173").
So of the two paths that step offers, the `alpha-standdown` one is the only one
that ends this; killing the process by pid would clear a doctor pass or two and
then read as a fresh split-brain an hour later.

`CLAUDE.md`'s note on the keeper is the same rule from the other side: anything
that respawns a worker has to be asked to stand down, not killed, or the
supervisor simply starts it again.

Still read-only: nothing queued or changed here either.

## Addendum 3, 2026-10-20 02:36Z — a 502 arrived, and it is NOT evidence of harm

`alpha-ai.uk` answered 502 in the `20261020-031139` pass — the first public
failure since the connector appeared — and cleared by `20261020-032639`. The
tempting reading is that this is the split-brain biting: a request routed to
Laptop41's connector, whose local backend (8001, held by the AlphaPanelFeed
helper) cannot answer. **The rate says otherwise.**

Reading `https://alpha-ai.uk/ answers <code>` out of all 200 doctor passes on
`status/laptop41` (`2026-10-14T21:41:22+01:00` → `2026-10-20T03:26:39+01:00`),
split at `2026-10-19T22:41:29` when the site and connector first appeared:

| window | passes | non-200 | rate | codes |
|---|---|---|---|---|
| before the connector | 190 | 18 | **9.5%** | 502×7, 530×6, 404×4, no-answer×1 |
| after the connector | 10 | 1 | **10%** | 502×1 |

So 502 was already this tunnel's most common failure code, seven times over,
days before Laptop41 had a connector at all — and the post-split rate is the
same 1-in-10 to within one sample. **One 502 in ten passes is exactly what the
baseline predicts**, and treating it as proof the second connector is serving
broken responses would be reading noise as signal.

What this does and does not settle, for the question Addendum 1 left open:

- It **rules out** the quick inference. Nobody should cite this 502, or the next
  one, as evidence the split-brain is breaking public traffic.
- It does **not** clear the split-brain. At a 9.5% baseline, ten passes cannot
  detect a change; distinguishing "the second connector adds failures" from
  "the tunnel fails 1 pass in 10 anyway" needs on the order of a hundred passes
  — roughly a day — which is far longer than this should be left running.
- The direct check in Addendum 1 (fetch `127.0.0.1:4173` on the laptop and watch
  whether its API calls resolve) still answers in seconds what the public rate
  cannot answer in a day. That remains the thing to do first.

Read-only as before: nothing queued or changed.

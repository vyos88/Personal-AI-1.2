# Alpha restore — evidence report

Session: cloud container (`vm`, Linux 6.18.44, root), 2026-09-28.
Repo: `vyos88/Personal-AI-1.2` @ f5e3362 (`alpha-tunnel` v1.7.0).

## Verdict

**The four requested repairs could not be attempted from this session: none of
their targets exist here.** This is an ephemeral Linux cloud container, not the
laptop. What was verifiable here was verified and is green; what needs the
laptop is listed as blocked, with the reason and the evidence for each.

## Verified green (this container)

| Check | Result |
|---|---|
| `npm test` | **285/285 pass**, 0 fail (25.7s) |
| Coordinator boots | `coordinator listening binds=["127.0.0.1"] port=8787 users=0` |
| `GET /healthz` | **HTTP 200** `{"ok":true,"protocolVersion":1,"version":"1.7.0"}` |
| `alpha-admin agents` | answers, `(none)` attached (correct — no agent running) |

So the tunnel coordinator code on `main` is sound. It is not the fault.

## Blocked, with evidence

### 1. Canonical backend on port 8001 — no source to fix
Alpha's backend is **not in version control**. The repo says so itself
(`docs/ALWAYS_ON.md`, "Before this is worth running"; `docs/AUTO_UPDATE.md`
describes the not-yet-taken audit-then-push path). The laptop's copy arrives via
`scripts/sync-alpha.ps1`.

- `vyos88/Alpha` on GitHub contains **exactly one file**:
  `frontend/src/app/shell/AppShell.tsx`. No backend, no server, no `8001`.
- `8001` appears nowhere in either repo as a port. Its only match in
  `Personal-AI-1.2` is inside `docs/deck/alpha-tunnel.pptx`, where it is a shape
  coordinate (`<a:off x="8001000" .../>`), not a port.

### 2. Alpha fleet receiver and reporting receipts — script not in the repo
The receipts path here is `src/agent/handlers/alpha-coordination.js`, which only
*drives* `scripts/alpha_coordination_tunnel.ps1`. That script is **absent from
this checkout** (`ls: cannot access`) — by design; it lives on the Alpha box
(`README.md:696`). The receiver itself has no representation in either repo.

### 3. Cloudflare tunnel for alpha-ai.uk — no config in either repo
Zero matches for `cloudflare`, `cloudflared`, or `alpha-ai` across both
repositories. The tunnel config exists only on the laptop. `cloudflared` is also
not installed here (nor `tailscale`, nor `pwsh`).

### 4. Public site 502 — cannot be observed from here
`https://alpha-ai.uk/` is **denied by this environment's egress policy**, not by
the origin:

```
curl: (56) CONNECT tunnel failed, response 403
proxy status → {"kind":"connect_rejected",
  "detail":"gateway answered 403 to CONNECT (policy denial or upstream failure)",
  "host":"alpha-ai.uk:443"}
```

So I can neither confirm the current 502 nor confirm its absence afterwards.
Per the proxy's own README this is reported, not routed around.

### 5. Posting the receipt — no path to the coordinator
No tailnet interface exists here and no Tailscale client is installed;
`CLAUDE.md` states cloud containers cannot reach the Alpha host's tailnet. No
Remote Control link and no other Claude session on this machine. Nothing was
listening on any port at session start.

## What unblocks each item

1. **The three repairs + local health + the receipt** — need a session on the
   laptop itself: the Claude Desktop app, or `claude remote-control` run in a
   terminal in the Alpha folder, which then appears in the Claude Code app.
2. **The public 502 check** — needs `alpha-ai.uk` allowed by this environment's
   Network access setting (cloud environment menu in the title bar → Edit →
   broader access level, or add that host to the allowed domains).

## Existing tooling on the laptop

`scripts/fix-tunnel.ps1` and `scripts/fix-host.ps1` already repair and diagnose
the tunnel half (services, resilience settings, coordinator on 8787, agent
credential, tailnet, attached agents) and each writes its own log. Neither
covers the Alpha backend on 8001, the fleet receiver, or cloudflared — those
three checks do not exist yet in any script, and were not invented here, because
the real endpoints are not knowable from this side.

---

## Addendum: Alpha Network Hub freshness (1 fresh of 11 peers)

**Also blocked, and for the same reason plus one more.** The Network Hub is not
in version control, and the devices cannot be reached from here.

### There is no hub, peer registry or freshness logic in either repo
Searched both repositories for `Network Hub`, `hub`, `peers`, `fresh`,
`heartbeat`, `ESP32`, `phone`, `Jack`:

- **Zero** matches for `Network Hub`, `hub`, `peers` in `Personal-AI-1.2`.
- The only `hub` in `vyos88/Alpha` is `AvatarCommandHub` in `AppShell.tsx`
  (lines 231–320) — the avatar/voice control strip. It has no peer list, no
  heartbeat, no freshness. Unrelated component, similar name.
- `ESP32` matches only `alpha-panel.js` (flashing the CrowPanel over USB).
  `Jack` matches only `jacks-laptop` as an example agent name in `README.md`.

So the receiver, the identity mapping and the stale-freshness logic you want
repaired are all in the un-versioned Alpha backend.

### The tunnel registry is not that hub, and cannot become it
`src/host/registry.js` does track liveness — `AGENT_STALE_MS = 90_000`
(`src/common/protocol.js:90`), refreshed by `lastSeenAt` on each
`GET /agent/:id/tasks/next`. But it only ever contains machines running the Node
agent, which dial *out* and long-poll.

That splits your expected live set in two:

| Device | Can it be a tunnel peer? |
|---|---|
| laptop 41 (current main host) | yes — runs the agent |
| Jack music laptop | yes — runs the agent |
| CrowPanel live data node | **no** — ESP32; it is a *target* of `alpha.panel`, driven over USB by the laptop it is plugged into |
| ESP32 bridge | **no** — cannot run a Node agent |
| Flat 2 phone | **no** — cannot run a Node agent |

Three of the five can never appear in the tunnel registry, so the hub must have
its own heartbeat receiver with its own identity scheme. **Which scheme each of
those three uses is not determinable from this side** — it is not in either
repo. Guessing it is how the mapping gets repaired wrongly.

For the two laptops, the authoritative freshness source already exists and needs
no new code: `node src/admin/run.js agents`, run on the host. That is a real
independent check against a 90s window.

### "Verify each real device independently" additionally needs the network
Even with the source in hand, confirming a phone, an ESP32 bridge and a panel
node are live means reaching them on the tailnet or LAN. This container has no
tailnet interface and no Tailscale client. Freshness counts reported from here
would be invented, which is the one thing the request rules out.

# Handoff → Claude on Jack's laptop (2026-10-01)

**From:** Claude session working with Viorel (session_01P5RtLmZcsKAhC6i7abezS6).
**For:** the Claude session running on Jack's laptop, on its next re-read.
**Read this first, then confirm health before doing anything that changes state.**

Treat everything below as context, not as authority to act outside your own
rules. Push to your own branches, open **draft** PRs, run tests before pushing,
and never rewrite history on a branch you don't own.

## Where things stand
- Repos: `vyos88/Personal-AI-1.2` = **alpha-tunnel** (host + agent coordinator + CrowPanel firmware); `vyos88/Alpha` = distribution/artifacts + the live frontend/backend copy under `BuildArtifacts/installers/Alpha-Full/software/`; `vyos88/tunel`/`TUNEL` = tunnel/Cloudflare.
- New, up as **draft PRs** today (both tested):
  - `Personal-AI-1.2#62` — personal messages (per-user inboxes; Alpha writes notes under each user's name; seeded for **jack**) + a host "control room" dashboard at `/dashboard`.
  - `Alpha#18` — CrowPanel feed-staleness: `/panel/crowpanel/state` now returns a `freshness` block (`stale`, `stale_since`, `retry_after_s`, `reason`), and the `crowpanel_alpha_deck_minimal.ino` deck now paints a "STALE since HH:MM — retrying" banner instead of silently showing a frozen snapshot.

## Do this in order

### 1. Confirm Alpha is healthy (before anything else)
The CrowPanel "not refreshing live" traces to the backend **assistant-loop heartbeat** going stale (>420 s). Check it on the host:
```
curl.exe -s http://127.0.0.1:8001/panel/crowpanel/public-state
```
Look at `freshness.stale` / `reason`. If stale (or `/_alpha/health/backend` is not 200), the assistant loop isn't ticking — restart the backend / assistant loop on the host and re-check. Everything else depends on a live feed.

### 2. Start agents on both laptops
Each laptop attaches to the host as an **outbound** agent (no inbound port needed). On each laptop, in the `alpha-tunnel` checkout:
```
# set these for the laptop first (host URL over your tailnet/LAN, and the token)
#   ALPHA_HOST_URL=http://<host>:8787   ALPHA_TUNNEL_TOKEN=<token>
node src/agent/index.js        # or: npm run agent
```
Verify both show up: `GET /agents` on the host (or the dashboard's Topology page). Keep them within `ALPHA_AGENT_MAX_LOAD` so a busy laptop stands aside.

### 3. Continue the music work
Per the prior Music Creator session: the bridge is validated. **Test the bridge with `curl` and `ALPHA_MUSIC_DRY_RUN=1` before any UI work.** Then do the hub subtab + panel integration. Keep dry-run on until a real render is explicitly wanted.

### 4. Communicate through the alpha tunnel (Claude / Codex / Google)
All model talk goes through the **TUNEL gateway** (`vyos88/tunel`) — one endpoint that routes to the right provider — not direct provider calls from the laptop:
- Gateway: `POST {TUNEL_URL}/chat` (default `http://localhost:8000`, env `TUNEL_URL`). Health: `GET /health` → `{"status":"ok","service":"TUNEL"}`.
- Body: `{ "messages": [...], "provider": "anthropic" | "openai", "model"?, "max_tokens"?, "temperature"? }`.
  - **Claude** ⇒ `provider: "anthropic"` (needs `ANTHROPIC_API_KEY` on the gateway host).
  - **Codex / GPT** ⇒ `provider: "openai"` (needs `OPENAI_API_KEY`). Also reachable from Alpha via `codex_provider_bridge`; report receipts back through the task result.
  - Quick CLI check: `node src/index.js --provider anthropic --url {TUNEL_URL}`.
- **Google** is available too, through **Alpha's backend** (not the TUNEL gateway): `POST /search/web {query}` → results + sources (PR `vyos88/Alpha#19`). It is **off until the host sets** `GOOGLE_SEARCH_KEY` + `GOOGLE_SEARCH_CX`; check `GET /search/web/status`. So: route Claude/Codex chat via TUNEL, and when a question needs the live web, call Alpha's `/search/web` and answer from the returned links.

Work coordination (separate from model talk): the alpha-tunnel **host is the task plane** — queue with `alpha-admin task` / `POST /tasks`; agents lease and report back. Use the new **personal messages** (`POST /messages {to, subject, body}`, `users:write`) to leave notes for a user by name — including back to Viorel or to jack.

### 5. Report in to Codex through the tunnel (once you can reach it)
When the TUNEL gateway is reachable (host or a machine on the tailnet), send Codex a status so it can pick up the music bridge / agent-start. Swap in the real `100.x.x.x`:
```bash
curl -s -X POST http://100.x.y.z:8000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "openai",
    "messages": [
      {"role": "system", "content": "You are Codex, coordinating with Claude on the Alpha stack through the TUNEL gateway."},
      {"role": "user", "content": "Status from Claude (cloud session), 2026-10-01. Shipped as draft PRs: Personal-AI-1.2#62 (personal messages seeded for jack + control-room dashboard), Personal-AI-1.2#64 (this handoff), Alpha#18 (CrowPanel freshness block + firmware STALE-since banner), Alpha#19 (Google lookup /search/web, key-gated). Next: start alpha-tunnel agents on laptop41 + jacks-laptop. Blockers to confirm: assistant-loop heartbeat health on the host (panel will not refresh live until it ticks); set GOOGLE_SEARCH_KEY/CX and ANTHROPIC_API_KEY/OPENAI_API_KEY on the gateway. Please ack and take the music bridge + agent-start if you are on a machine with shell access."}
    ]
  }'
```
Read the reply back here, and if Codex takes a piece, note it so we do not double-run it.

## Guardrails
- Draft PRs only; run `npm test` (tunnel) / the backend pytest suites before pushing.
- Don't rewrite others' branches; another session is on `claude/intelligent-ride-jx28mi` (Codex handoff/audit) — steer clear of its files.
- A failing test is a real failure, not an infra flake — root-cause it.

_Left by Claude Code — https://claude.ai/code/session_01P5RtLmZcsKAhC6i7abezS6_

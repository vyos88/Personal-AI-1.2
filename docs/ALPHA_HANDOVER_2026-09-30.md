# Alpha: complete system handover and technical audit

**Date:** 2026-09-30.
**Prepared for:** another AI (ChatGPT, Codex) that will analyse Alpha on its own and propose improvements.
**Prepared by:** a Claude Code session working from cloud containers. This session read every repository it could reach and ran their test suites.

This file is the single source of truth for Alpha as it can be inspected
*right now*. It supersedes the status sections of every older doc in this
directory. Where an older doc disagrees with this one, this one records the
newer evidence.

---

## 0. How to read this document

### Status labels (used exactly as below)

| Label | Meaning |
|---|---|
| **VERIFIED WORKING** | Proven here: the code was run, or its tests were run and passed |
| **PARTIALLY WORKING** | Some of it is proven to work, and some is proven not to |
| **CONFIGURED BUT UNVERIFIED** | Code and config exist, but no run on the real host or hardware is recorded |
| **BROKEN** | Proven wrong: by running it, or by reading an exact code path that cannot work |
| **STALE** | Out of date against the current system (wrong port, dead host name, superseded) |
| **PLANNED / NOT IMPLEMENTED** | Described or stubbed, but no working implementation |
| **UNKNOWN** | Cannot be decided from anything reachable |

### What this audit could and could not see

| Source | Seen? | Notes |
|---|---|---|
| `vyos88/Personal-AI-1.2` (this repo, "alpha-tunnel") | **Yes, fully** | Code read, 422/422 tests run on Node 22 |
| `vyos88/Alpha`, branch **`alpha-full`** | **Yes** | The real app, but only as an *installer payload snapshot* built **2026-08-27** (`BuildArtifacts/installers/Alpha-Full/`). Backend tests and the frontend build were run on a copy. |
| `vyos88/Alpha`, branch `main` | Yes | Only 4 frontend files ("Alpha 9.0" shell + Music Creator). It does not build. See §6.3. |
| `vyos88/TUNEL`, `vyos88/Alpha-` | Yes | Obsolete and empty respectively. See §10. |
| **The live host (Laptop41), `alpha-ai.uk`, the tailnet** | **No** | Cloud containers cannot reach it. Every "live" statement below comes from docs or commits and carries a date. |
| Alpha's live source on the host | **No** | The host runs from a local working copy that is not pushed to GitHub as a normal tree. The `alpha-full` branch is a month-old snapshot of it. |

**The single most important caveat:** the newest *recorded* evidence of the live
system is from 2026-09-28/29. It consists mostly of failures found on Laptop41
and fixes written from cloud containers. No successful end-to-end run of the
public site has been recorded since those fixes. **The current live health of
Alpha is UNKNOWN.**

---

## 1. Executive description

### 1.1 What Alpha is

Alpha is one person's **local-first personal AI system**, run on their own
Windows laptop and published to their own devices. Its own docs describe it
as a "persistent dual-consciousness AI ecosystem": *Alpha* is the strategic,
conversational mind and *Beta* the analytical self-reviewer.

In engineering terms it is five things:

1. **A FastAPI backend** (Python, about 98k lines; `main.py` alone is 39,077
   lines). It serves **868 live HTTP routes** for:
   - chat;
   - memory and knowledge (SQLite);
   - devices and hardware (Arduino, ESP32, CrowPanel display, Elegoo robot car, GSM modem);
   - Gmail, Spotify, Google and Tapo integrations;
   - a coding workspace and a host terminal;
   - voice (Piper and ElevenLabs TTS);
   - video, image and 3D;
   - many self-assessment and "autonomy" subsystems.
2. **A React/Vite single-page app, the "Alpha Deck".** It has 16 deck modes,
   **23 hubs** and **197 routable workspaces**, with three.js/Cesium 3D views,
   a Monaco code editor and MediaPipe camera features.
3. **A local LLM layer.** Ollama serves small CPU models (1.5–3B parameters).
   An optional cascade falls back to an enrolled tailnet worker and then to the
   Anthropic, OpenAI and Google APIs. There is no vector database: retrieval
   is lexical over a 5-layer SQLite knowledge store.
4. **An operations layer of about 230 PowerShell and Python scripts on the host.**
   - Launchers, watchdogs, self-repair and scheduled tasks.
   - About 17 always-on "steward" agent windows.
   - A file-based **coordination tunnel** (`alpha_coordination_tunnel.ps1`) that AI sessions use to claim paths and post receipts.
5. **alpha-tunnel (this repository).** A zero-dependency Node coordinator plus
   workers ("agents") that let Alpha run **tasks on other machines**:
   - Blender renders and MusicGen music generation;
   - Codex CLI prompts, CrowPanel flashing and USB inventories;
   - Alpha's coordination actions and git updates.

   It also contains host-repair and self-heal tooling.

It is published at **`https://alpha-ai.uk`** as follows:
- The public entry point is a Cloudflare named tunnel, with Cloudflare Access in front of it.
- The tunnel connects to the Vite preview on `127.0.0.1:4173`.
- The Vite preview proxies API calls to uvicorn on `127.0.0.1:8001`.

### 1.2 Current maturity (blunt)

| Dimension | Assessment |
|---|---|
| Breadth | Very wide: 23 hubs, 868 routes, dozens of device integrations. |
| Depth | Uneven. A large share of the "capability" surface is **flag-flips, canned text or simulations** presented as features (§5.3). The AI core is small CPU models plus deterministic fallbacks. |
| Code health in isolation | Good test pass rates:<br>• backend **1,901 / 1,931 passed** (19 failures, mostly environment-related);<br>• frontend **326 / 326**, and `vite build` passes;<br>• tunnel **422 / 422**. |
| What the tests do not prove | 50 of the 65 frontend test files are regex checks against source text. Backend tests mount routers in isolation, which is how a **2FA bypass in the running app** went unnoticed (§9). |
| Operations | **Fragile.** The single host is a laptop. Up to **7 supervisors** can act on the same three processes. Recent repairs have never been run on the host. The coordinator machine left the tailnet. |
| Source control | **Weak for the app itself.** The live Alpha source is not on GitHub as a normal tree. The newest copy reachable here is a 2026-08-27 installer snapshot, plus a divergent 4-file "Alpha 9.0" frontend on `main`. |
| Security | **Serious findings**, including 2FA not being enforced and an owner-only remote PowerShell reachable through the public site (§9). |
| Documentation | Voluminous, but contradictory. Ports, versions, hub counts and paths all drift between docs. July docs claim "IQ 185 / L6 100% / Quantum 10/10". The newer, governing strategy doc explicitly bans such claims. |

**Overall:** a feature-rich single-operator prototype whose *code* is in
reasonable shape in isolation, but whose *deployment and source-of-truth* are
the weakest parts. Right now the fastest improvements are operational and
security work, not new features.

---

## 2. Where Alpha runs (topology)

### 2.1 Machines

| Machine | Role | Status (dated evidence) |
|---|---|---|
| **Laptop41** (Windows, hostname `DESKTOP-41HPLCN`) | The **permanent main host**. Runs:<br>• the Alpha backend (8001);<br>• the frontend (4173, and 5173 in dev);<br>• cloudflared;<br>• Ollama (11434);<br>• the coordination tunnel;<br>• the self-heal task;<br>• the agent named `alpha-host`.<br>Also the **intended new tunnel coordinator** (8787). | UNKNOWN now. On 09-29 the frontend on 4173 hung, and the desktop shortcut served an old build. |
| **Former coordinator** (tailnet node `vyos88`) | Ran the only alpha-tunnel coordinator. | **Gone:** it "left the tailnet with the only coordinator on it" (commit 5ae50b6, 09-29). Every agent is dialling a dead address. |
| **Jack's laptop** (names used: `jacks-laptop`, `jack-music`, `JACKS-LAPTOP`) | Worker. Intended music worker. Named in examples as the Codex machine. One commit says it holds the Blender generator. | UNKNOWN whether it is attached. The three names are inconsistent. |
| Other tailnet nodes | Two phones and two PCs are listed in the app's fleet doc (08-20). **Four Windows PCs are mis-enrolled** as `android_edge`. | 08-20 evidence only |
| **Planned new host** (MSI Vector 16 HX, RTX 5070 Ti) | Migration target, with a 1 TB external data root | **PLANNED.** The installer runbook says the install was not executed. |
| USB backup drive | `F:\AlphaBackup` holds a git bundle of all Alpha refs and a data tarball | Exists per docs. The restore script has never been run. |

### 2.2 Ports

| Port | Service | Bound to |
|---|---|---|
| 8001 | Alpha backend (uvicorn). Falls back to 8002–8010 and writes `memory/local/backend.port`. | loopback |
| 4173 | Vite **preview**: the public origin for cloudflared. Local TLS certificate. | loopback |
| 5173 | Vite dev server. Some agents, the launcher and the "canonical" manifest still treat it as primary. | loopback |
| 8000 | **Legacy** backend port. About 50 stale scripts, the Docker `CMD`, `config.py`'s default, and the main-branch shell's speech WebSocket all still use it. | — |
| 11434 | Ollama | loopback |
| 8787 | alpha-tunnel coordinator | loopback + tailnet |
| 8790 | Music bridge (this repo) | loopback |
| 8011 / 4183 | USB-recovered copy of Alpha (side by side) | loopback |
| 8081 | "alpha-core" service URL set by the launcher | UNKNOWN whether anything listens |

### 2.3 Scheduled tasks, services and autostart on the host

This list comes from code and docs; what is actually installed on the host is UNKNOWN.

**Services:**
- `cloudflared` (Windows service).
- `alpha-coordinator` / `alpha-host` (NSSM coordinator; the name differs between docs and host).
- `alpha-agent` or `alpha-keeper` (NSSM).

**Scheduled tasks:**
- `Alpha` (frontend, S4U).
- `Alpha Backend` (S4U).
- `Alpha Self-Heal` (SYSTEM, every 2 minutes).
- `Alpha Server - Start at Logon` and `Alpha Server - Health Guard` (every 5 minutes).
- `AlphaGalaxy Runtime` (backend; referenced only by `open-alpha.ps1`).
- `alpha-tunnel self-update` (daily at 04:30).
- `alpha-tunnel watchdog` (every 12 hours).

**Startup shortcuts:**
- `Alpha.lnk`.
- `Alpha VyoS.lnk`.
- `Alpha Governed Agents.lnk`, which launches 17 hidden PowerShell steward windows.

---

## 3. Architecture and communication

```
 Browser / phone ── HTTPS ──> Cloudflare (Access) ──> cloudflared (tunnel "AlphaGalaxy")
                                                          │
                                        Laptop41: vite preview 127.0.0.1:4173  (SPA + /_alpha/health)
                                                          │ proxy: 83 path prefixes
                                        uvicorn 127.0.0.1:8001  FastAPI "main:app"
                                          ├─ SQLite: knowledge_store, audit_store, auth_users, agent_runs,
                                          │          autonomy_runs, calibration, arduino_inventory
                                          ├─ Ollama 127.0.0.1:11434 (llama3.2:3b default) → worker/Anthropic/OpenAI/Google
                                          ├─ serial/USB: Arduino, ESP32, CrowPanel, GSM; Wi-Fi: Elegoo car, Tapo
                                          ├─ Gmail IMAP/SMTP, Spotify, Google OAuth, ElevenLabs, Wikipedia, Gutenberg
                                          └─ reads memory/local/coordination/*  ◄── alpha_coordination_tunnel.ps1
                                                                                    ▲
 alpha-tunnel (this repo):                                                          │ alpha.coordination task
   coordinator :8787 (Node, in-memory queue, auth.json) ◄── agents long-poll OUTBOUND (never listen)
     agents on Laptop41 / laptops run handlers: echo, sysinfo, grow, memory.store,
     alpha.coordination, alpha.update, alpha.render(+inventory), device.inventory,
     alpha.panel, codex.exec, alpha.music(+audio)
   music-bridge :8790 ── queues alpha.music for the (unported) Music Creator panel
```

Key communication facts:

- **Frontend to backend:** same-origin relative fetches through the Vite proxy. JWT is stored in `localStorage` and sent as a Bearer token. There are no WebSockets in the Deck UI, and one fetch-based SSE stream (terminal logs).
- **Backend to tunnel: none.** The backend never calls the coordinator. The only coupling is one-way and goes through files:
  - A tunnel `alpha.coordination` task runs Alpha's PowerShell script.
  - That script writes `memory/local/coordination/*.json(l)`.
  - The backend reads those files for status pages and chat context.
- **Tunnel internals** (all VERIFIED in code and tests):
  - Agents dial out and long-poll `GET /agent/:id/tasks/next`.
  - Tasks are *leased* (60 s by default) and requeued when a lease expires.
  - Placement is memory- and load-aware, and a task can be pinned to a machine by name.
  - Auth uses scoped API keys: effective scopes are the key's scopes intersected with the owner's, recomputed on every request.
  - The queue lives in memory; accounts are in `data/auth.json`; the receipts ledger is in `data/receipts.json`.
- **AI sessions to Alpha:** Claude and Codex sessions coordinate through
  1. commits and PRs in these repos;
  2. the coordination tunnel (claims and receipts);
  3. `codex.exec` tasks that hand a prompt to Codex CLI on a fleet machine.

---

## 4. What Alpha can do today (capability inventory)

### 4.1 The Alpha app (backend + Deck UI)

The status comes from code and tests; live behaviour is UNKNOWN.

| Capability | Status | Notes |
|---|---|---|
| Sign-in: password, agreements, invites, recovery, trial requests | CONFIGURED BUT UNVERIFIED live; logic tested | **The 2FA step is never enforced** (§9) |
| Chat (`/chat`, `/chat/quick`, Direct Line) | PARTIALLY WORKING | The call runs through the local Ollama/cloud cascade, deterministic lanes, grounding checks and a Beta self-review. **`/chat` crashes with a 500 on dictionary-definition hits** (undefined `response_sources`). |
| Memory / knowledge (5-layer SQLite, books, lessons) | PARTIALLY WORKING | Lexical retrieval only. Book ingest recorded as 2 of 22 books (08-13), with 17 quarantined chunks. |
| Voice (Piper local, ElevenLabs), avatar, lip-sync | CONFIGURED BUT UNVERIFIED | Piper models are gitignored and not in the repo |
| Devices: Arduino/ESP32/UNO Q, arduino-cli, serial | CONFIGURED BUT UNVERIFIED | Needs Windows and the hardware |
| CrowPanel display deck (in the app's own firmware) | PARTIALLY WORKING | Live reporting was reached. **Touch is a hardware fault.** |
| GSM phone / SMS (SIM800C) | **BROKEN** | Unreachable since 07-08 |
| Elegoo robot car (Wi-Fi bridge, camera) | CONFIGURED BUT UNVERIFIED | |
| Gmail, Spotify, Google Workspace, Tapo | CONFIGURED BUT UNVERIFIED | |
| Coding workspace (Monaco, `/code/run`, diagnose-fix) | CONFIGURED BUT UNVERIFIED | |
| Host terminal (`/terminal/execute`, owner-only PowerShell) | Works by design | **Security-critical** (§9) |
| Image (tiny-sd on CPU), video planning and creation | CONFIGURED BUT UNVERIFIED | |
| 3D Ops, VR/Cesium reality views | 3D Ops recorded **BROKEN** (blank, 09-13); others UNKNOWN | |
| Autonomy / auto-improve / "levels" / "consciousness" | Mostly **simulated or flag-flip** | See §5.3 |
| Monetization | **PLANNED / NOT IMPLEMENTED** | Static tables, `payment_enabled: False` |
| Android edge worker (phone as worker) | PARTIALLY WORKING | Self-declared partial. The APK was never built. |
| Distributed LLM workers over Tailscale | PARTIALLY WORKING (08-13) | Tasks pending; remote Ollama timing out |

### 4.2 alpha-tunnel task handlers ("skills" run on fleet machines)

| Task type | Loaded | Status |
|---|---|---|
| `echo`, `sysinfo` | built in | **VERIFIED WORKING** (tests) |
| `grow` (L-system skeletons) | built in | **VERIFIED WORKING** in tests. It had crashed live on every task until the 09-17 fix; that fix is unverified live. |
| `memory.store` (lend RAM as a KV store) | opt-in | **VERIFIED WORKING** (tests) |
| `alpha.coordination` | opt-in | VERIFIED on the old host (09-01). **Reports a timed-out run as `exitCode 0`** (§8). No `available()` check. |
| `alpha.update` (git Status/Fetch/Pull, ff-only) | opt-in | Tests pass. Useless for Alpha until Alpha's source is in git. |
| `alpha.render` (Blender → recipe) | opt-in | **Zero production renders ever.** Tested only with a stand-in generator. **Leaks staging directories** on kill/timeout. |
| `alpha.render.inventory` | opt-in | Tests pass; CONFIGURED BUT UNVERIFIED live |
| `device.inventory` (USB/COM) | opt-in | Failed live ("PowerShell not found"); fixed in code 09-29; unverified. Its output file blocked self-update; **fixed in this PR** (`.gitignore`). |
| `alpha.panel` (flash/provision CrowPanel) | opt-in | **Never compiled, never run on hardware.** Firmware reads the wrong `/stats` fields, so its counts always show 0. Provision timeout (15 s) is shorter than the firmware's Wi-Fi join (20 s). |
| `codex.exec` | opt-in | Verified against codex-cli 0.157.1 after the stdin fix. No fleet deployment recorded. |
| `alpha.music` + `alpha.music.audio` + music bridge | opt-in | **Dry-run only.** "Nothing has generated real audio anywhere." The frontend panel is on the wrong branch (§6.3). |

---

## 5. Components by status (consolidated)

### 5.1 Verified working (proven in this audit)

- **alpha-tunnel core.** Queue, leases, placement, auth, keys, scopes and ledger: **422/422** tests on merged `main` (Node 22). No process leaks after any suite, after the keeper fix in PR #55.
- **Backend logic in isolation.** **1,901 passed / 19 failed / 11 skipped** of 1,931, on a Linux copy with network blocked. The failures are:
  - 8: a missing gitignored runtime file;
  - 4: local serving;
  - 3: optional dependencies (faster-whisper, yt-dlp) and WordNet data;
  - 1: Windows-only test (needs Edge);
  - 1: a missing `deploy/cloudflared-alpha-ai.yml.example`;
  - 2: platform differences in a path check and a summary length.
- **Frontend.** **326/326** tests pass and `vite build` succeeds (4.3 s, 33 MB `dist`). All 71 fetched path prefixes are covered by the Vite proxy.
- **Music Creator contract.** The main-branch panel and the bridge match field for field. The genre data is identical: 13 genres, **69** subgenres.

### 5.2 Broken (proven)

| # | Component | Evidence |
|---|---|---|
| B1 | **2FA not enforced on login** | Live `/auth/login` in `main.py` never checks TOTP/face. The 2FA-aware copy is shadowed. Reproduced. |
| B2 | `/chat` dictionary path → 500 | Undefined name `response_sources` (pyflakes) |
| B3 | Repair watchdog cannot report repairs | `POST /system/repair-notify` is blocked by the owner guard (401). The scripts swallow the error. |
| B4 | Frontend: OSINT Mode and Alpha TODOs workspaces | Render the Prompt Profiles view instead |
| B5 | Frontend: all 9 KOL/KOS workspaces | Render the same `kos-status` view |
| B6 | Frontend: legacy routes `#/hub/consciousness/*`, `#/hub/recovery/{…}` | Resolve to "Workspace route not found" |
| B7 | Tunnel: a failed receipts write kills the coordinator | `ReceiptStore.record()` does not handle the rejected promise from `save()`, and there is no `unhandledRejection` handler. A full disk takes the coordinator down, contrary to the design note. |
| B8 | Tunnel: two concurrent invite redeems | Both succeed, creating 2 users with one email (reproduced) |
| B9 | Tunnel: a `users:write` holder can demote or disable an admin | Reproduced. No last-admin guard. |
| B10 | CrowPanel firmware `/stats` parsing | Reads fields the host does not send, so it always shows 0 |
| B11 | `use-latest-alpha.ps1` | Changes the task's `WorkingDirectory`, which the wrapper ignores. Reports success while doing nothing. |
| B12 | GSM/SIM800C phone | Unreachable since 07-08 |
| B13 | 3D Ops panel | Blank (09-13) |
| B14 | Former tunnel coordinator | Gone from the tailnet (09-29) |
| B15 | Main-branch "Alpha 9.0" frontend | Imports about 70 files that exist nowhere; cannot build |
| B16 | `TUNEL` CLI | Health check uses POST against a GET-only route, so it can never start |

### 5.3 Simulated, canned or flag-flip "features" (presented as capabilities)

These are **not** broken. They are not real capabilities either, and a
reviewer should not count them as such.

- `/knowledge/install-level-1..6`, `/autonomy/level-4/install`, `/personality/*`, `/virtual-reality/install` and `/assistant/modules/install-*` only set a feature flag and write a knowledge row.
- Auto-improve "language patches" carry the comment `# Install patch features (simulated)`.
- `/bios/install|boot` hard-codes its checks to `'TRUE'`.
- `/hyper-agent/plan` returns a fixed plan.
- `/ko/369-simulate` generates random voltages.
- `/integrations/arduino-labs/ingest-run-now` records "completed" without fetching anything.
- The 37 `/legacy-stubs/*` routes return canned output (they are quarantined).
- The "Brain", "Cognition", "Consciousness" and "KOS/KOL ternary" modules are deterministic Python state machines with no model inside. `consciousness_levels.py` calls itself "a measurement, not an installation".
- **The July docs' claims** ("IQ 185 / Genius", "L6 @ 100%", "Quantum 10/10") are contradicted by the newer `alpha_strategy.md`, which bans such claims.

### 5.4 Configured but unverified (the largest bucket)

The tunnel side:
- The host repair (`repair-alpha-host.ps1`) and bounded self-heal (`alpha-selfheal.mjs`). **They have never run on Laptop41.**
- `start-alpha-at-boot.ps1`: its first run stopped at "more than one runnable Alpha".
- `fix-cloudflare.ps1`: the service was created, but after a reboot the site served 502.
- `open-alpha.ps1`.
- `recover-alpha-from-usb.ps1`: never run.
- `move-coordinator-here.mjs`: stopped at its attach check, was fixed, and has not been re-run.
- `keep-agent`, `standby-alpha`, `watchdog`, `self-update`: no deployment recorded.
- The music pipeline (real MusicGen), `alpha.render` (real generator), `alpha.panel` (hardware) and `codex.exec` (fleet).

The app side:
- The governed agent fleet (17 windows): 08-20 records "restart receipt never observed".
- The watchdogs and autorepair, Gmail, Spotify and Google integrations, and most device routes.

### 5.5 Stale

- The legacy port-8000 world: about 50 scripts, the Docker/Postgres/Redis/Milvus README and `deployment.md` half, the Dockerfile, and `pulse_watchdog.py`, which would restart the wrong target.
- Agents that target 5173 instead of 4173 (the health agent and the scroll agents).
- The old tailnet name and IP in:
  - the TLS certificate generator, so its SANs miss the current host name;
  - the Alpha-Light launcher;
  - the installer builder.
- `OLLAMA_MODEL` defaults to `llama3.2:3b`, which was **parked** on 08-27. The active store holds only `deepseek-r1:1.5b`, `qwen2.5:1.5b` and `qwen3:1.7b`. Scripts expect `qwen2.5:7b` and `qwen2.5:14b`, which are parked or absent.
- `Alpha-Server` payload: an earlier cut of the same day that lacks the health routes, the proxy fixes and `loginFailure`.
- The `Alpha-Light` client URL.
- Docs in this repo:
  - README's "114 tests" (the real count is 422).
  - `ALPHA_AUDIT.md`'s "22 Devices workspaces" (Devices has 13; 22 is the total across four tabs in the main-branch shell). Its "45 panels" is really 61, and its claim that "Music Creator is in no repo" no longer holds.
  - `MUSIC_GENRES_REPORT.md`'s "60 subgenres" (the real count is 69).
  - `MUSIC_CREATOR_STATUS.md`'s merge state.
- Versions disagree:
  - manifests say 1.03;
  - `SERVER-DEPLOYMENT.txt` says 1.02;
  - the launcher says 1.10;
  - the backend reported 1.22, 1.26 and 1.29;
  - the main-branch shell says "9.0" / OS "2.0".
- The L7/L8 "KOSKOL consciousness" roadmap: its target date, 2026-09-30, is today, with no implementation.

### 5.6 Planned / not implemented

- Video Creator as a tunnel handler (`video.render`).
- Composing `grow` with Blender (deliberately deferred to the Python side).
- Monetization and payments.
- The Android APK.
- A bootable USB installer.
- The MSI Vector host migration.
- Signing the installer (no certificate exists).
- Getting the app's source into git as a normal tree (`publish-alpha-push.ps1` exists; the push is not recorded).
- The dormant agents `alpha-execution` and `opportunity-research`.
- The Music Creator inside the served UI.

---

## 6. The UI

### 6.1 What is served: the "Alpha Deck" (from branch `alpha-full`)

The entry chain is `index.html` → `src/main.jsx` → `App.jsx` → the 288-line
`AppShell.tsx` (single tab, "Alpha Deck").

**Routes:**
- `#/login`
- `#/direct`: Direct Line, a single conversation.
- `#/deck/<mode>`
- `#/hub/<hub>`
- `#/hub/<hub>/<workspace>`

**The 16 deck modes:** alpha, spatial, embodiment, command, terminal, brain,
core, reality, knowledge, automation, hardware, network, android, apps, admin,
atlas.

**The 23 hubs:** command, avatar, memory, projects, coding, extensions, devices,
automation, learning, operations, diagnostics, terminal, virtual-reality,
network, android, phone, core, dual-consciousness, kol-kos, beta-assistant,
control-center, system, admin.

**Workspaces:** the registry `src/subtabRegistry.js` declares 199 workspaces:
195 live, 2 partial and 2 planned. The two planned ones (Android BlueStacks and
Android Apps) are hidden, which leaves **197 routable**.

**Registry and code-health problems:**
- **24 orphan overrides** have no catalog row, so they are unreachable.
- Several workspaces declare API contracts that differ from what their panels actually call.
- 233 `.catch(() => null)` sites render a failed request as an empty panel rather than an error.

**Global overlays on every page:** a capability rail, owner alerts, an activity
terminal, a proactive banner, a backend-status banner, and a
"VisualContractGuardian" that runs a MutationObserver over the whole document.

**Background load after sign-in:**
- The browser fires `POST /hubs/deck-control/start-all`.
- It pre-fetches up to **198 GET endpoints** and re-warms them **every 5 minutes**.
- It runs `/validation/full-sweep`. If any check fails, the *browser* triggers
  `POST /hubs/autonomy/run-cycle` and `/assistant/autoimprove/run-now` (once per session).
- The warm effect depends on the route hash, so **every navigation restarts it**.
- On top of that, about 40 panels run their own polling intervals, from 3 s to 540 s.

**Auth storage:** the JWT lives in `localStorage` (readable by any XSS). Logout
only clears local storage. There is no server-side revoke, and the backend has
no revocation anyway.

### 6.2 Login failure diagnosis

`loginFailure.js` tells the operator *which hop* failed, based on the HTTP
status and headers. It distinguishes:
- a Cloudflare challenge;
- a 524 timeout;
- an empty 5xx (backend on 8001 down);
- a 52x or 530 (frontend on 4173 down);
- a JSON rejection.

It exists only in the Alpha-Full payload.

### 6.3 The divergent "Alpha 9.0" shell on `vyos88/Alpha` `main`

A different, older UI lineage with 7 tabs: Chat, Admin, Devices, Encrypted
Phone V3.0, Libraries, **Music**, Terminal. Its Devices tab has 13 workspaces.

The Music Creator (09-27 to 09-29) was built **here**. But this branch holds
only 4 files and imports about 70 modules that exist nowhere, so **it cannot
build and is not what `alpha-ai.uk` serves**.

To ship the Music Creator, it has to be re-implemented as a Deck hub
workspace, and a `/music` proxy entry to `127.0.0.1:8790` has to be added to
`vite.config.js`.

---

## 7. Agents, workers and services (inventory)

| Kind | What | Where | Status |
|---|---|---|---|
| **Tunnel agents** (alpha-tunnel workers) | Node processes that long-poll the coordinator and run the handlers in §4.2 | Laptop41 (`alpha-host`), Jack's laptop, others | Coordinator gone; attachment UNKNOWN |
| **Declarative agent registry** (`agents/*.json`, 16 plus 8 Codex-style skills) | Policy documents. **Not a runtime:** nothing in the backend loads them. | App repo | 2 dormant (PLANNED), 2 STALE (target 5173), the rest CONFIGURED BUT UNVERIFIED |
| **Runtime agent registry** (`/agent-api`, `agent_scheduler.py`, `agent_runs.db`) | Declarative agents that call local Ollama, with durable runs. Scheduler added 08-24, after 12 agents had been silently stale for 6 days while the console showed "LIVE". | Backend | CONFIGURED BUT UNVERIFIED |
| **Governed steward fleet** (`start_visible_alpha_codex_agents.ps1`) | **17 hidden, long-lived PowerShell windows**: a manager, workspace watcher, coding executor, design, API, chat, voice, fleet, spatial, evolution, style, Gmail-triage, package-update and surface-health stewards, plus 3 "evidence mirror" watchers | Laptop41, at login | CONFIGURED BUT UNVERIFIED. The manager **mints owner JWTs locally**. |
| **Autonomy worker** (`autonomy_runs.db`) | Durable queue of allow-listed read-only executors, every 15 s | Backend | Tested |
| **Work autoread monitor** | 60 s loop; starts with the tray | Laptop41 | INFERRED running whenever the tray runs |
| **"Long loop" family** (9h/6h/12h brain-upgrade, overnight, teach-cycle; about 12 scripts) | Opt-in, heavy, mostly target port 8000 | Laptop41 | STALE |
| **Supervisors** | See §8.2 | Laptop41 | Overlapping |
| **Codex** | Reachable via the `codex.exec` task on whichever machine has Codex CLI and `ALPHA_CODEX_ROOT`; the backend also has its own Codex provider executor | Fleet | Partially verified |

---

## 8. Operations: health, supervision, resources

### 8.1 Recorded live incidents (newest first)

| Date | Incident | State |
|---|---|---|
| 09-30 | The keeper orphaned its `self-update` on exit | **Fixed**, PR #55 (merged) |
| 09-30 | Script output files blocked self-update on every machine | **Fixed in this PR** (`.gitignore`) |
| 09-29 | Coordinator machine left the tailnet | Open. `move-coordinator-here.mjs` stopped at its attach check; fixed and not re-run. |
| 09-29 | Admin key lost during the first migration run | Open. It needs re-establishing via the login command. |
| 09-29 | `ALPHA_EXTRA_HANDLERS` set in Laptop41's machine environment silently overrides `.env.agent` | Open. The operator must clear it. |
| 09-29 | 4173 held its port and never replied while the task read "Running". The shortcut served an old build from a Downloads folder. | Open |
| 09-29 | `fix-tunnel.ps1` failed to parse on PowerShell 5.1 (em dash, no BOM) | Fixed: all `.ps1` files are now ASCII, with a test |
| 09-28 | cloudflared ran in a hand-started console; a mangled hostname in `config.yml`; a second tunnel with no connector (error 1033); a 502 after reboot | Service created; outcome unverified |
| 09-28 | `codex.exec` hung on stdin | Fixed and verified against the CLI |
| 09-15 | The host was lost when terminal windows closed | Restart-loop wrappers added |
| 09-13 | 3D Ops blank | Open |

### 8.2 Supervision: too many owners

Up to seven things can restart the same three processes: uvicorn on 8001, Vite
on 4173, and cloudflared.

1. `alpha_autorepair.ps1`. It is spawned by `start-local`, by the backend
   itself (`main.py`) and by the overnight loop.
2. `alpha_runtime_always_on.ps1`.
3. `alpha_runtime_watchdog.ps1` (every 15 s).
4. `alpha_frontend_watchdog.ps1` (4173 only, every 15 s).
5. `ensure-alpha-online.ps1` (scheduled every 5 minutes).
6. `start-alpha-app.ps1`, which also starts cloudflared.
7. This repo's `alpha-selfheal.mjs` (SYSTEM, every 2 minutes).

In addition, `open-alpha.ps1`, `use-latest-alpha.ps1`,
`start-alpha-at-boot.ps1` and `repair-alpha-host.ps1` all manage the `Alpha`
task on 4173. `open-alpha.ps1` names the backend task `AlphaGalaxy Runtime`;
everything else names it `Alpha Backend`.

The code has mutexes and deferral flags, but the docs record real bounce and
race incidents. **Recommendation:** pick one owner per process.

### 8.3 Resource consumers

**Models:**
- The active Ollama store is about 3.5 GB; the parked models are about 17.5 GB on disk.
- The host runs Ollama on **CPU only**. Generation starves `/health` (its timeout was raised from 15 s to 20 s), and agent runs time out at 120 s.

**Resident processes:** about 25 or more PowerShell and Python processes when
everything is on. The docs record hours of 100% CPU. The backend's own
governor caps its process CPU at 65%.

**Backend background tasks** (68 creation sites):
- Always on: the Ollama keep-alive (every 240 s), the autonomy worker (15 s), the workflow scheduler (60 s), and others.
- On by default in code: `ALPHA_ALWAYS_LEARNING_ENABLED` and `ALPHA_BOOK_AUTOREAD_ENABLED` (every 900 s, over the internet).
- `start-local.ps1` switches the heavy ones off unless `-AllowHeavyBackground` is passed. Any other launcher gets the aggressive defaults.

**The frontend adds** the pre-fetch storm (§6.1) and about 40 polling panels.

**Unbounded growth:**
- In the app:
  - `audit_store.db` has no DELETE.
  - The coordination `events.jsonl` is only ever appended to.
  - The in-memory rate-limit buckets are never evicted.
  - Backend logs are not rotated.
- In this repo's coordinator:
  - **finished tasks are never removed from memory** (payloads up to 1 MB each; music audio slices make this worse);
  - `auth.json` is **rewritten on every authenticated request** and never prunes expired sessions;
  - the login-failure map grows per email.

  Open PR #51 fixes most of these.

**Git weight:** the Alpha repo carries two near-identical 48 MB payloads
(Full and Server) and three copies of `Alpha.exe`. Model weights are
correctly gitignored.

---

## 9. Security and governance

The detailed findings, including exact routes, lines and file lists, are held
**outside this public repository**. The operator has them. Summary by severity:

| Severity | Finding (summary) | Where |
|---|---|---|
| **Critical** | **Second-factor authentication is not enforced by the live login route** (a shadowed route) | App backend |
| **Critical** | An owner session can run **arbitrary PowerShell on the host** through a route that is proxied to the public site. Combined with the 2FA gap, the 7-day non-revocable tokens and the rate-limit bypass, a stolen owner password becomes remote code execution. | App backend |
| **Critical** | A **hard-coded default owner password literal** appears in about 12 scripts (private repo). Treat it as compromised and **rotate**. A Spotify client secret is recorded as pasted into a chat: **rotate**. | App repo (private) |
| High | The login rate limit can be bypassed with a spoofed forwarding header | App backend |
| High | One status endpoint returns coordination claims and recent audit events (usernames, failed logins) **without authentication** | App backend |
| High | JWTs are valid for 7 days, with no revocation and no invalidation on password change. Tokens are stored in `localStorage`. | App |
| High | The owner password hash is reset from the environment on every start, which undoes a password recovery | App backend |
| Medium | The vault key sits beside the vault. A Google API key is sent in a URL query string. The steward manager mints owner tokens locally. | App |
| Medium | Tunnel: the legacy `ALPHA_TUNNEL_TOKEN` is a full admin credential. The bootstrap token stays valid after users exist. Plain HTTP (it relies on the tailnet). Any `tasks:read` key sees every payload, including the CrowPanel Wi-Fi password and Codex prompts. `users:write` can demote an admin. The invite redeem race exists. | This repo |
| Medium | Music bridge: no auth and no content-type check, so a cross-site "simple" POST can queue 10-minute tasks | This repo |
| Low | Hard-coded Wi-Fi AP defaults in firmware. Personal data (an email address, full name, a third party's device name) in the app repo. A real telecom brand's name on concept marketing pages. | App repo |

**Governance mechanisms that do exist:**
- Owner and access levels 1–10 with a creator guard on mutations.
- Signed security ledger, audit store and evidence gates.
- The data-safety router blocks secrets from reaching model input and gates cloud calls.
- The coordination-tunnel claims protocol.
- Scoped, intersected tunnel keys that are recomputed on every request.
- scrypt passwords and hashed tokens in the tunnel.
- Bounded self-heal budgets.
- An "evidence-gated" strategy doc that bans capability hype.

---

## 10. Duplicated, obsolete or conflicting

| Item | Recommendation |
|---|---|
| `vyos88/TUNEL`: a FastAPI OpenAI/Anthropic proxy with no auth, binding 0.0.0.0:8000. Its CLI can never start. Unrelated to alpha-tunnel. | Archive |
| `vyos88/Alpha-`: LICENSE only | Delete or archive |
| `vyos88/Alpha` `main` (4-file "Alpha 9.0") vs the `alpha-full` payload (the served Deck UI) | Decide which UI is canonical; port the Music Creator |
| `Alpha-Full` vs `Alpha-Server` payloads (98% identical, about 90 MB) | Keep one copy; make Server an overlay |
| Seven supervisors (§8.2) and four autostart installers | One owner per process |
| `fix-host.ps1` and `fix-tunnel.ps1` (overlap on tunnel services) | Merge into one "tunnel doctor" |
| `sync-alpha.ps1` (copy-based) vs `publish-alpha*` (git) | Retire `sync-alpha` once Alpha is in git |
| Three link fixers, two installer builders, the 9h/6h/12h loop family, the port-8000 scripts, Docker/Postgres scripts, scratch files | Delete or archive |
| 190 shadowed duplicate route handlers in `api/*.py` (the dead copies include canned "all ok" health data) | Delete the dead copies |
| `resolveExecutable` written 5 times across the tunnel handlers | Extract into a shared helper |
| Keeper ownership: three ways to keep the coordinator and agent up (NSSM, `run-*.cmd`, keeper) plus the watchdog | ALWAYS_ON's table is the reference; retire the rest |

---

## 11. What Alpha is intended to become

From the governing docs: `alpha_strategy.md` (August–December 2026), this
repo's audit and migration docs, and CLAUDE.md.

- **One runtime truth contract** (`/alpha/core/status`) and a reliable deck of about 22 hubs.
- Skills promoted only on evidence, with KO/KOS treated as a hypothesis.
- A hardened, local-first deployment on a stronger host (the MSI Vector with an RTX GPU).
- **A fleet of machines lending RAM, CPU and GPU**, with names as the routing table. Laptop41 is the host and coordinator; laptops act as workers and a failover standby.
- **A creative pipeline that returns recipes, not blobs:**
  - creatures and plants via Blender;
  - music via MusicGen;
  - later, video via ffmpeg;
  - with a ledger of what ran.
- Deck work:
  - lazy-loaded hubs with per-hub error boundaries and one health bus;
  - a Network Hub showing the fleet;
  - Crown Panel as the self-heal admin surface;
  - Command Nexus routed through the task queue so every command gets a receipt.
- Codex and Claude cooperating through `codex.exec` and the coordination tunnel.
- **Source control for the whole app**, which unblocks everything else: `alpha.update`, the standby, auditing, and rollback.

---

## 12. Open pull requests (unfinished work already written)

| PR | What | Note |
|---|---|---|
| **vyos88/Alpha#10** (draft, base `alpha-full`) | **16-job stability and resource audit:**<br>• bounded background tasks, process-tree timeouts, atomic writers, SQLite caps and busy timeouts;<br>• frontend polling pauses and bundle cuts (startup JS 562 KB → 387 KB);<br>• backend tests reported at **2015 passed / 0 failed**. | The most valuable unmerged work. It needs checks on the host. The `Alpha-Server` mirror is not updated. |
| vyos88/Alpha#2, #3 | AppShell failures; "All devices" in the Devices hub | Against the main-branch shell (§6.3) |
| **vyos88/Personal-AI-1.2#51** (draft) | Tunnel stability: bound host memory, free hung workers, prune sessions, readable 413 | **Will conflict with the merged PR #55 in `keep-agent.mjs`.** Rebase or merge carefully. |
| #50, #46, #49 | Promote the USB-recovered Alpha; Crown panel check; resume a stalled recovery | Host-only; overlapping |
| #45 | Start the backend at boot too | Possibly superseded by `repair-alpha-host.ps1` |
| #42 | What the restore could reach from a container | Docs |
| #37, #31 | `grow` logger fix | Already fixed on main (09-17); close |
| #36 | Admin recovery of a locked-out account | Open |
| #35 | `listen()` retry crash | Open |
| #33, #32, #30 | Panel/fleet with the host off; lowering priority for external programs; device-listing docs | Stale since 09-15 |

---

## 13. Recommended priorities (for whoever picks this up)

1. **Security first:**
   - enforce 2FA on the live login route;
   - stop trusting a client-supplied forwarding header;
   - require auth on the coordination status endpoint;
   - add token revocation, or shorten token lifetime;
   - rotate the owner password and the Spotify secret;
   - consider taking `/terminal/execute` off the public proxy.
2. **Get Alpha's live source into git** (`publish-alpha-push.ps1` → branch `alpha-from-host`). Then choose between the `alpha-full` Deck and the `main` "9.0" shell, and delete the other.
3. **Restore the fleet:**
   - finish `move-coordinator-here.mjs` on Laptop41;
   - re-establish the admin key;
   - clear the machine-level `ALPHA_EXTRA_HANDLERS`;
   - repoint agents;
   - run `repair-alpha-host.ps1 -ReportOnly`, then the real run.
4. **One supervisor per process**, then run the human checklist in `MASTER_HOST_REPAIR.md`: login, chat, decks, reboot test.
5. **Merge the stability work:**
   - Alpha PR #10, after the host checks it lists;
   - tunnel PR #51, reconciled with #55;
   - fix B7 (the receipts crash), B8/B9 (invite race, admin demotion) and B2 (the `/chat` crash).
6. **Reconcile models:** set `OLLAMA_MODEL` to an installed model, or un-park `llama3.2:3b`.
7. **Cut the frontend's background load:** do not restart the warm-up on every navigation, and stop triggering autonomy from the browser.
8. **Make one real run of each creative handler:** one render, one MusicGen track, one CrowPanel flash. Record them.
9. **Delete the stale layer:** the port-8000 scripts, the Docker docs, `TUNEL`, `Alpha-`, the Server payload duplicate and the 190 dead routes.

---

## 14. Evidence index

- **This repo:**
  - `CLAUDE.md` (design invariants).
  - Docs: `MASTER_HOST_REPAIR.md`, `COORDINATOR_MIGRATION.md`, `ALPHA_AUDIT.md` (partly stale, §5.5), `MUSIC_CREATOR_STATUS.md`, `CODEX_BRIDGE.md`, `ALWAYS_ON.md`, `AUTO_UPDATE.md`, `HOST_SETUP.md`, `WORK_AUDIT_2026-09-15.md`, `PANEL_HANDOFF.md`.
  - Commits 5ae50b6, 9a7ce32, 972c333, 8ffa5ea, 0f90f01, 2b4c638, 62170d0 and db88122 for the live incidents.
- **App repo (`vyos88/Alpha`, branch `alpha-full`, `BuildArtifacts/installers/Alpha-Full/`):**
  - Backend: `software/backend/main.py`, `config.py`, `auth.py`, `api/*.py`.
  - Frontend: `software/frontend/{vite.config.js,src/App.jsx,src/subtabRegistry.js,src/api.js}`.
  - Scripts: `scripts/start-local.ps1`, `ensure-alpha-online.ps1`, `alpha_runtime_watchdog.ps1`.
  - Docs: `docs/alpha_strategy.md`, `architecture.md`, `deployment.md`, `handoff_2026-08-20_claude.md`.
  - Runbook: `Installer/alpha_full_install_runbook.md`.
- **Test runs from this audit:**
  - tunnel `npm test` 422/422;
  - backend `pytest` 1,901 passed / 19 failed / 11 skipped (Linux copy, network blocked);
  - frontend `npm test` 326/326 plus `vite build`.

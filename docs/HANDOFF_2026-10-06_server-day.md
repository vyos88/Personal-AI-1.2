# Handoff — server day (written 2026-10-05, for the server arriving 2026-10-06)

The owner expects a server on 2026-10-06: **256 GB RAM, 2 × 14-core CPUs**.
Their goal is that Alpha's **chat, coding and execution** get much better, so
that coding with Alpha becomes easy. This file is the plan, in order. Each part
says where it runs. Nothing in it has been run: the server does not exist on
the tailnet yet.

**The order matters.** First give Alpha a real model (Parts 1-4). That is the
biggest gain, and it is easy to undo. Move the coordinator only after that
works (Part 5). Coding and execution build on both (Parts 6-7).

## What Alpha has today, and why it is slow

- Alpha's chat goes to Ollama at `OLLAMA_BASE_URL`, with model `OLLAMA_MODEL`
  (`software/backend/config.py`). The default is `llama3.2:3b` on Laptop41.
  Measured there on 2026-08-24: about **1.8-2.9 tokens/s**, a 20-40 s model
  load whenever memory pressure evicts the model, and calls timing out at
  120 s. The cloud relay currently reports "no chat model (Ollama)" on
  Worker1.
- **One model serves everything:** chat, the agents, and the coding helpers.
  So the server's model has to be good at both conversation and code.
- **Alpha already supports a model on another machine.** Set
  `OLLAMA_BASE_URL` in Alpha's `.env.local` (on Worker1:
  `C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\.env.local`, the folder above
  `software\`). If that machine does not answer, Alpha retries Worker1's own
  Ollama before giving up (`main.py`, "offload host"). No code change is
  needed.
- **There is no GPU on the server** (as far as is known). Models run on its
  CPUs and RAM. 256 GB fits even large models, but **speed is the limit, not
  memory**. Measure it (Part 3) rather than assume it.

## Part 1 — on the SERVER: join the fleet

Windows steps are given, because the fleet is Windows. On Linux, the same
tools exist under the same names.

1. **Tailscale**, signed in to the same account. Then `tailscale ip -4`, and
   write the address down: it is `<SERVER_IP>` below. Also note `hostname`.
2. **Node 20+, git, and Python 3.11+.**
3. **Never sleep:**
   ```powershell
   powercfg /change standby-timeout-ac 0
   powercfg /change hibernate-timeout-ac 0
   ```
4. **The tunnel, on `main`:**
   ```powershell
   git clone --branch main https://github.com/vyos88/Personal-AI-1.2 C:\services\alpha-tunnel
   ```
5. **An agent named `server`**, using a key issued on the Host. On
   **laptop-gj8dfmlk**:
   ```powershell
   cd C:\services\alpha-tunnel
   $r = node src/admin/run.js issue-key --user user_qlhd01n6waqn1a18 --scopes agent:connect --name server-agent --json | Out-String | ConvertFrom-Json
   Set-Content $env:TEMP\server-agent.key $r.token -Encoding ascii -NoNewline; "issued $($r.key.id)"; Remove-Variable r
   tailscale file cp $env:TEMP\server-agent.key <server hostname>:
   Remove-Item $env:TEMP\server-agent.key
   ```
   On the **server**:
   ```powershell
   cd C:\services\alpha-tunnel
   tailscale file get $env:TEMP
   node scripts/setup-agent.mjs --host http://100.93.104.24:8787 --name server --max-load 0.9 --concurrency 8 --memstore
   ```
   When it prompts for the key, paste the contents of
   `$env:TEMP\server-agent.key`, then delete that file. Keep it running with
   `powershell -ExecutionPolicy Bypass -File .\scripts\install-always-on.ps1`
   (fixed in #93).
6. **Check, from any machine:** `node src/admin/run.js agents` lists
   `server`, and `task --type sysinfo --agent server` comes back with 56
   logical CPUs (2 × 14 cores, two threads each).

## Part 2 — on the SERVER: Ollama, reachable over the tailnet only

1. Install Ollama from ollama.com.
2. Bind it to the tailnet address, never `0.0.0.0` (Ollama has no
   authentication):
   ```powershell
   [Environment]::SetEnvironmentVariable('OLLAMA_HOST', '<SERVER_IP>:11434', 'Machine')
   [Environment]::SetEnvironmentVariable('OLLAMA_KEEP_ALIVE', '24h', 'Machine')
   [Environment]::SetEnvironmentVariable('OLLAMA_NUM_PARALLEL', '2', 'Machine')
   ```
   Restart the Ollama app or service afterwards.
   - `KEEP_ALIVE=24h` keeps the model in RAM, so Alpha never pays the
     20-40 s load that hurts on Laptop41. There is RAM to spare.
3. Allow the port on the tailnet interface only:
   ```powershell
   New-NetFirewallRule -DisplayName 'Ollama (tailnet)' -Direction Inbound -Protocol TCP -LocalPort 11434 -RemoteAddress 100.64.0.0/10 -Action Allow
   ```
4. From **Worker1**, prove it is reachable:
   `curl.exe -s http://<SERVER_IP>:11434/api/tags`.

## Part 3 — on the SERVER: choose the model by measuring

Pull a small set of candidates. Use names from the Ollama library on the day.
Families that fit "chat and code" today:

| Size | Example | Why try it |
|---|---|---|
| ~7-8B | `qwen2.5-coder:7b`, `llama3.1:8b` | fast on CPU; the baseline |
| ~14B | `qwen2.5-coder:14b`, `qwen2.5:14b` | the likely sweet spot: much better code, still usable on CPU |
| ~32B | `qwen2.5-coder:32b` | best answers; probably too slow for chat on CPU, but fine for background coding |

Measure each with the same prompt:

```powershell
ollama run qwen2.5-coder:14b --verbose "Write a Python function that parses 'HH:MM' into minutes, with tests."
```

Read `eval rate` (generation, in tokens/s) and `prompt eval rate`. Write the
numbers into the table at the end of this file in a PR, so the choice is
evidence.

**How to choose:**
- **Chat model:** the largest one at or above about **8 tokens/s**. Answers
  should start in seconds, not minutes.
- **If the 32B model reaches 3 tokens/s or more**, it can still serve
  background coding later (Part 6), once Alpha learns to use two models. Today
  it uses one, so pick for chat first.

## Part 4 — on WORKER1: point Alpha at the server

1. **First, fix the backend's boot problem.** The cloud report says the
   `Alpha Backend` task needs the `jwt` module. In the Python that runs
   Alpha's backend:
   ```powershell
   python -m pip install PyJWT
   ```
2. **Edit `C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\.env.local`.** Back it
   up first, then add or change these lines:
   ```ini
   OLLAMA_BASE_URL=http://<SERVER_IP>:11434
   OLLAMA_MODEL=<the model chosen in Part 3>
   OLLAMA_MIN_TOKENS_PER_SECOND=<half the measured eval rate>
   OLLAMA_KEEP_ALIVE=24h
   ```
3. **Restart the backend**: `Stop-ScheduledTask 'Alpha Backend'; Start-ScheduledTask 'Alpha Backend'`.
   Then check that `http://127.0.0.1:8001/health` answers.
4. **Test in Alpha's chat:**
   - "Where does the coordinator run?" It should answer Host / gj8. This also
     proves today's knowledge file loaded.
   - "Write a function that ..." It should answer in seconds.
5. **Undo:** remove those lines from `.env.local` and restart the backend.
   Alpha goes back to the local model.

## Part 5 — the server becomes Host (after Part 4 works)

A server that never sleeps belongs in the coordinator role. Use
`HANDOFF_2026-10-05b_host-move.md` with these names:

- **From** gj8 **to** the server. Stop gj8's `alpha-coordinator` task and
  disable it, rather than leaving it to its old start trigger.
- Send `auth.json`, `receipts.json` and `tasks.json` over Taildrop
  (`tailscale file cp`), not USB.
- On the server, `.env` gets `ALPHA_HOST_BIND=127.0.0.1,<SERVER_IP>`, plus the
  `alpha-coordinator` task, as on gj8 today.
- Repoint every agent (`worker1`, `host`, `server`):
  `ALPHA_HOST_URL=http://<SERVER_IP>:8787,http://100.93.104.24:8787`. **gj8
  becomes the standby.** Apply `HANDOFF_2026-10-05c_failover.md` with gj8 in
  Worker1's place: the store goes from the server to gj8, and the standby runs
  on gj8.
- Rename in Alpha: add `Server` to `frontend/src/config/fleetNames.js`, and
  rename gj8 there (BACKLOG S6). Update the knowledge record.

## Part 6 — coding with Alpha

The aim: ask Alpha for a change, get a reviewed, tested change back, and
merge it yourself.

1. **Alpha drafts** with the server model. That is chat with the coding model
   from Part 3; nothing new to build.
2. **Codex reviews.** `codex.exec` is read-only by default
   (`CODEX_BRIDGE.md`). Alpha sends the draft and the file for a second opinion
   (BACKLOG F24).
3. **Tests are the proof.** A change counts only when the repo's own suite
   passes: backend `pytest`, frontend `npm test`, tunnel `npm test`. With 56
   threads, the server is also the best place to run these suites.
4. **A person merges.** Alpha opens or proposes; it never merges, and never
   touches keys, `auth.json` or `.env` (F23).
5. **Every step leaves a receipt** in the coordination tunnel: what was done,
   and how it was checked (F22).

## Part 7 — execution skills

These are mostly BACKLOG F20-F25, which become practical once the model is
fast:

- **Prove before claiming** (F20): Alpha answers "is X alive?" with a
  `sysinfo` or `agents` task id, not a guess.
- **Target by name** (F25): `--agent server` for heavy work, `--agent worker1`
  for anything that touches Alpha's own folder, `--agent host` for renders.
- **Hard limits** (F23): restarts and spend have budgets; credentials are
  never in reach.
- **Learn from each fix:** every repaired fault becomes a knowledge record
  (like `alpha_session_record_2026_10_05_host_move.json`), which Alpha loads
  at start.

## Do first if there is time: H2

Publishing Worker1's live Alpha source (BACKLOG H2) is what lets Alpha itself
run on, or fail over to, the server, and what lets the 16 locally-edited files
be merged with `alpha-full`. It is worth doing before or on server day.

## Measurements (fill in on the day)

| Model | eval rate (tok/s) | prompt eval rate (tok/s) | load time | chosen for |
|---|---|---|---|---|
| | | | | |

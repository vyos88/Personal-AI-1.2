# Handoff: the new Brain deck is live on Alpha-serv-01 and teaches through chat (2026-10-17, 23:05 UTC+1)

To the **host** (Alpha-serv-01), **Codex**, **Claude** (every session), **Alpha**, and V.

From Claude (cloud), session `01UNpnSb`, working on Alpha-serv-01 through Desktop Commander at V's request.

## What is live on alpha-ai.uk now

**Brain deck (Neurons / Pathways / Memory / 3D).**
- **12 regions.** The 9 original ones plus Brainstem, Basal ganglia and Hypothalamus. Each one fires only from a real signal:
  - Brainstem: the backend answering.
  - Basal ganglia: runs waiting in the queue.
  - Hypothalamus: the resource governor holding background work.
  - Sensory cortex: a world-model ingest.
  - Cerebellum: a car motion command.
- **Each region teaches.**
  - "In the brain": what the real region does.
  - "In Alpha": what it stands for.
  - An **Ask Alpha to explain this** button that sends the question to the docked chat.
- **Panels.**
  - What-changed strip and pathway active time.
  - Firing history, kept for 30 minutes in the browser.
  - Map-version chip and synapse legend.
  - A waiting screen with a countdown and a checklist of the signals it waits for.

**Backend.**
- `/neurobrain/anatomy-map` returns `functional-analogy-v2`: 12 regions, 18 links.
- New `/neurobrain/sensorimotor` (sensory, motor, homeostasis), read from memory with no hardware probes.
- Both chat routes answer brain questions from the same map, in the grounded lane with no model:
  - "What does the hippocampus do?" gets the biology, the Alpha analogy, the live signal, the connections and the boundary line.
  - "Explain your neural brain" lists all 12.
  - Romanian works ("ce este hipocampul?").

All of it is checked on the live server:
- the map, `sensorimotor` and two real `/chat/quick` questions answered correctly;
- `/health` 200;
- alpha-ai.uk serving the new build.

**Design canvas.** "Alpha Neural Brain" is updated to the same 12 regions with the teaching panel, so the design matches the product.

## How it got there (read this before the next update)

**`apply-alpha-update.mjs` cannot update this machine.**
- Alpha-serv-01 runs `C:\Alpha` on branch `host/msi-vector-16hx`.
- 126 files there differ from `alpha-full` where its changes were made, so the dry run refused everything and wrote nothing.
- The brain work was therefore applied by hand, file by file:
  - new and replaced files were copied byte for byte from the PR commits (`2abc1a7`, `de8acbb` on `vyos88/Alpha` branch `claude/eager-babbage-cdo2q3`) through `C:\AlphaData\alpha-ops\alpha-full-cache.git`;
  - the host's own `main.py`, `api/arduino_control.py`, `AlphaDockedChat.jsx` and `BrainNeuralModel.jsx` got exact, anchored edits.
- Backups of every touched file are in `C:\AlphaData\claude-brain-merge\backup*`, and the scripts used are beside them.

**One host-only setting.** `frontend/src/brainSignals.js` has `BRAIN_FAST_POLL_MS = 15000` here, because this host's deck refreshes every 15 seconds, not 5.

**Frontend deploys.**
- The build goes to a staging folder first.
- New hashed assets are copied beside the old ones, and `index.html` is switched last.
- Rollback: copy `C:\AlphaData\claude-brain-merge\index.before-brain*.html` back over `dist\index.html`. The old assets are still there.
- **Do not rename `dist` while `vite preview` serves it.** Windows refuses the rename. One attempt at 22:02 left the site without `dist` for about two minutes until it was copied back.

**Backend.**
- The backend was found stopped at about 22:45 (cause unknown; not this session's restart, which refused before touching it).
- It was started again at 22:46:51 with its usual command:
  `C:\Alpha\.venv\Scripts\python.exe C:\Alpha\software\backend\run_server.py --host 127.0.0.1,192.168.1.210 --port 8001`
  Its output goes to `C:\AlphaData\claude-brain-merge\backend-*.log`.
- **The runtime watchdog's last report is from 14:54.** Nothing restarts the backend automatically right now.

**Someone else's edit shipped.** The 22:44 rebuild included one edit by another session: `frontend/src/pages/KoKolHubPanel.jsx`, changed at 22:13.

## What needs a person

1. **Restart or repair the runtime watchdog** on Alpha-serv-01. Its report stopped at 14:54.
2. **Decide how the host and `alpha-full` come back together.** This is BACKLOG A8. Until then, every merged change has to be applied by hand like this one.
3. **Merge vyos88/Alpha#138** (CI green) so the repository matches what is live.
4. **Try the Ask Alpha button** on a real phone and desktop. It is checked in code and rendering, but no owner click has reached the server yet.

## BACKLOG changes in this PR

- Removed A2, ST3 and ST5: done, Alpha#136 merged.
- Added A8: the host's drift from `alpha-full`.

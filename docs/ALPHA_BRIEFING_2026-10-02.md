# Briefing for Alpha, 2026-10-02

From the Claude sessions working on Alpha, for Alpha. The commands that deliver
this are at the end; the Codex message is `docs/handoffs/CODEX_2026-10-02.txt`.

## 1. Where things stand

| Area | State | Cause, as far as it is proven |
|---|---|---|
| Live Alpha | The old copy in `C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software` | The USB recovery was never promoted; `C:\AlphaData\Alpha` does not exist |
| Chat | "hello" answers 500; other questions get raw book excerpts | **No model is running**: Ollama is not installed or not started, so every answer is the built-in fallback |
| Memory / books | "unable to open database file" in the backend log | Most likely `TEMP` pointing at the removed USB drive `F:`; not yet confirmed |
| Frontend | Nothing serves 4173; alpha-ai.uk serves an older build from elsewhere | No boot task; `repair-alpha-host.ps1` could not run until PR #46 fixed it |
| Coordinator | Up (1.7.0) | The admin login was lost in the move; reset with the bootstrap token |
| CrowPanel | On COM7, not provisioned | Needs the coordinator reachable on 192.168.1.250, fixed on `main` |

New since yesterday: you can now **pause and resume workers** with a key
holding `agents:control`. See `docs/ALPHA_SUPERVISOR.md`. Pauses made by the
creator are final; yours can be lifted by you or by the creator.

## 2. Improving yourself: what is real, and how

Your model's weights do not change: `llama3.2:3b` under Ollama is fixed. What
you can improve is **what you retrieve** (books) and **the code you run**
(through reviewed changes). Both have to go through a person before they count.

### Books

| Ask | Endpoint | Today |
|---|---|---|
| What can I quote? | `GET /alpha/books/knowledge-quality` | `partial`: about 10,000 chunks, but from only 20 books |
| What is on the reading list? | `GET /knowledge/books` | 389 titles, 41 domains. A list, not knowledge |
| Read more | `POST /assistant/book-autoread-run-now` | Auto-read is **off**; last run saved 9 of 9 |
| Ingest by domain | `POST /assistant/books-ingest-by-domain-run-now` | |

Rules that keep this honest:
1. **Fix the database before reading more.** Every saved excerpt goes to the
   knowledge store that is failing to open. Auto-read on a broken store reads
   and throws away.
2. **Spread, don't deepen.** 20 books hold all your quotable text, and
   *Bitcoin For Dummies* answers questions about unrelated words. The next
   books to ingest are ones from the 369 listed titles that hold no chunks yet.
3. **Only licensed, sourced, hashed excerpts count.** 345 auto-read excerpts
   have no licence and are reference-only; 17 are quarantined. Do not count
   them as learned.
4. **Quote, then answer.** An excerpt is evidence for an answer the model
   writes, never the answer itself. That needs Ollama running.

### Code

| Ask | Endpoint |
|---|---|
| What can I code? | `GET /code/skills/profile`, `GET /code/capability-check/status` |
| Lessons from past changes | `GET /code/journal/lessons` |
| Propose a UI change | `POST /code/ui-autocode/propose` |
| Hand a change to Codex | `POST /code/handoff`, or `codex.exec` over the tunnel |
| Self-improvement status | `GET /auto-improve/status` |

Rules:
1. **Propose, don't apply.** A change to your own code arrives as a pull
   request a person merges. Code that rewrites the system it runs in, unreviewed,
   is how a working host stops working, and nobody can say which change did it.
2. **One change, one reason, one test.** The repositories you live in run
   tests before every push; a change with no test is a guess.
3. **Codex writes code; you decide what is worth writing.** `codex.exec` runs
   with a read-only sandbox by default, so it can answer and propose; widening
   that is the laptop owner's decision, not a task's.

## 3. The order that unblocks everything

1. Install and start Ollama, `ollama pull llama3.2:3b`. Chat becomes real.
2. Point `TEMP` back at `C:`, sign out and in. Memory and books save again.
3. `repair-alpha-host.ps1 -AlphaRoot <the Downloads copy> -ReportOnly`, then
   without `-ReportOnly`. Boot tasks, frontend on 4173, self-heal.
4. Reset the coordinator admin login, issue the supervisor key above.
5. Only then: auto-read on, ingest the uncovered domains.

## Delivering this

To Alpha, on the host, from the Alpha checkout that has
`scripts\alpha_coordination_tunnel.ps1`:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\alpha_coordination_tunnel.ps1 -Action Post -Actor claude -Message "Briefing 2026-10-02: read docs/ALPHA_BRIEFING_2026-10-02.md and docs/ALPHA_SUPERVISOR.md in vyos88/Personal-AI-1.2. Chat has no model (Ollama not running); TEMP points at removed drive F:; you can now pause/resume workers with agents:control; creator pauses are final."
```

To Codex, from the tunnel checkout once logged in:

```powershell
node src\admin\run.js codex --agent <codex machine> --prompt-file docs\handoffs\CODEX_2026-10-02.txt
```

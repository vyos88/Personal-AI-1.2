# Talking to Codex over the tunnel

Codex is on one laptop. Alpha, and whoever is asking, is somewhere else. Until
now the only thing carrying a question between them was a person with two
keyboards.

`codex.exec` makes it a task. A prompt goes into the host's queue, the agent on
the machine that has Codex runs it non-interactively, and Codex's answer comes
back as the task result. The laptop needs no open port and no inbound firewall
rule — it dials out, like every other agent here — and nobody has to sit at it
relaying messages.

```
  you / Alpha / a Claude session
            │  POST /tasks  { type: codex.exec, payload: { prompt } }
            ▼
        the host  ──────────────────────────────────┐
            ▲                                       │ leased on the agent's
            │  result: { output, exitCode, ... }    │ own long poll
            │                                       ▼
        the laptop's agent ──► codex exec --sandbox read-only -- "<prompt>"
```

## Set up the machine that has Codex

Install Codex there and confirm it answers from a plain shell first. A handler
cannot make a CLI work that does not.

```powershell
codex exec --sandbox read-only -- "say hello"
```

Then add two lines to that machine's `.env.agent`:

```ini
ALPHA_EXTRA_HANDLERS=codex-exec
ALPHA_CODEX_ROOT=C:\Users\you\code\the-checkout
```

`ALPHA_CODEX_ROOT` is the directory Codex works in, and it must be a git
checkout — Codex refuses to run outside one. If you mean it to work somewhere
that is not a repository, say so explicitly with
`ALPHA_CODEX_SKIP_GIT_CHECK=1`; the handler would rather refuse at startup than
fail every task on a machine that looks correctly configured.

Restart that agent and check the host agrees:

```bash
npm run admin -- agents
```

`codex.exec` should be in that machine's capability list. If it is missing, the
agent logged the reason and carried on with its other handlers — that is the
handler declining to promise something it cannot do, and the log line says which
of these it was:

| Reason in the log | What to change |
|---|---|
| `ALPHA_CODEX_ROOT is not set` | set it in `.env.agent` |
| `does not exist` | the path is wrong, or has a stray quote |
| `not a git checkout` | point it at a repo, or set `ALPHA_CODEX_SKIP_GIT_CHECK=1` |
| `Codex CLI not found` | Codex is not on PATH for the *agent's* environment; set `ALPHA_CODEX` to its full path |
| `is a shell script` | see **The Windows `.cmd` corner** below |

### The Windows `.cmd` corner

Installing Codex from npm puts a `codex.cmd` shim on PATH. A `.cmd` cannot be
spawned without a shell, and a shell is the one thing that must never stand
between a prompt and this process: it is what turns a question containing `&`,
`|` or a backtick from data into syntax. So PATH resolution here tries native
executables before `.cmd`/`.bat`, and refuses a shim outright when that is all
there is.

The fix is to name the real binary:

```powershell
npm root -g          # find the package
$env:ALPHA_CODEX = "C:\...\node_modules\@openai\codex\bin\codex-x86_64-pc-windows-msvc.exe"
```

Check the exact filename in that `bin` directory — it is named for the platform.
A standalone (non-npm) install already puts `codex.exe` on PATH and needs none of
this.

## Check it end to end

```bash
node src/admin/run.js login --email <you>       # once; the session is saved until it expires
node src/admin/run.js doctor --agent jacks-laptop
```

`doctor` checks, in order: the coordinator, the sign-in, who is attached, who
offers `codex.exec` and `alpha.music`, the music bridge, and then asks Codex on
the named machine to reply. It lists every problem at once with the fix for
each, and exits 1 if there was any. A failed Codex call is reported by its code
(`timeout`, `codex_failed`, ...) with the matching row of the table below.

## Ask it something

```bash
npm run admin -- codex --agent jacks-laptop \
  --prompt "Read src/host/queue.js and tell me what happens to a task whose lease expires twice"
```

`--agent` is the machine name from `alpha-admin agents`, and it matters: without
it the task goes to whichever capable agent ranks best, and only one machine here
is capable. `codex` leases ten minutes, because Codex thinks for longer than the
60s default and a task reclaimed mid-answer is requeued forever.

The answer comes back as the result:

```json
{
  "output": "A task whose lease expires is requeued by the sweeper, and its attempt ...",
  "truncated": false,
  "stderr": "",
  "exitCode": 0,
  "durationMs": 48213,
  "promptChars": 104,
  "sandbox": "read-only",
  "model": null
}
```

Long questions are better sent as a file than fought through a shell's quoting.
These prompts are messages between agents — they run to paragraphs, and a shell
that ate a newline would change the question without telling you:

```bash
npm run admin -- codex --agent jacks-laptop --prompt-file ./question.md --no-wait
npm run admin -- tasks                  # read the answer when it lands
```

`--no-wait` and a long lease are the same pair `alpha.render` needs, for the same
reason: the CLI's own poll gives up long before a five-minute answer arrives, and
would report a task that is running perfectly well as having timed out.

## A two-way conversation

There is no session state on the far side, on purpose: each task is one question
and one answer. Continuity is the *caller's* job, and the caller is usually
another agent that has the transcript anyway. So a conversation looks like this,
with each turn carrying what the next one needs:

```bash
# Claude asks
npm run admin -- codex --agent jacks-laptop --prompt-file turn-1.md

# ... reads the answer, writes turn-2.md quoting the part it is replying to
npm run admin -- codex --agent jacks-laptop --prompt-file turn-2.md
```

Resuming a Codex session (`codex exec resume`) would make the laptop's session
state part of this contract, and would make the answer depend on which earlier
task happened to run on that machine. A prompt that carries its own context does
not, which is also what makes a conversation reproducible from the task list.
That is a deliberate choice rather than a missing feature; if it starts costing
more than it saves, it is one function to change.

## What a task may and may not ask for

The payload carries a prompt and nothing else. Not a model, not a directory, not
a sandbox mode, not a flag. A payload naming one is **refused**, not quietly
ignored:

```bash
$ npm run admin -- task --type codex.exec --agent jacks-laptop \
    --payload '{"prompt":"hi","sandbox":"danger-full-access"}'
this handler takes only "prompt"; "sandbox" would not reach Codex. The model,
directory and sandbox mode are configured on the machine that runs it, not
chosen by the task.
```

Be clear-eyed about what this handler is. Everything else in this repository
narrows a payload until what is left is data — an allowlisted action, a pinned
script, an argv array. This one hands a string to an agent that has a shell on
that laptop, which is the category `src/agent/handlers/index.js` refuses to ship
as a built-in. What keeps it honest:

- It is **opt-in**, and `available()` refuses a machine without Codex, so an
  agent started from a copied `.env.agent` never advertises it.
- The **sandbox defaults to `read-only`**. Letting Codex write is a decision made
  on the machine, in the open, by whoever owns it — never by an arriving task.
- Nothing is interpolated into a command line. `execFile` takes an argv array and
  the prompt goes last, after `--`.

What remains true: a task queued against `codex.exec` is a request to an AI agent
with filesystem access on that machine, bounded by its sandbox mode and nothing
else. Give the capability to a laptop you would let Codex work on, keep the
sandbox no wider than the work needs, and remember that `codex.exec` is
reachable by anyone holding a key scoped to queue tasks.

## When it goes wrong

| What you see | What it means |
|---|---|
| `warning: no attached agent is called "jacks-laptop"` | that machine is not attached; `agents` shows the names in use |
| `warning: "jacks-laptop" is attached but does not offer "codex.exec"` | the handler declined there — check the table above |
| task `queued`, tries flat, `DECLINED` climbing | the machine is refusing on memory; queue with a smaller `--min-memory-mb` or free some |
| `codex_failed` | Codex exited non-zero. The tail of its stderr is in the message — usually auth or rate limiting |
| `codex_silent` | Codex exited 0 and said nothing. There is no answer to hand back, so this is a failure rather than an empty success |
| `timeout` | raise `ALPHA_CODEX_TIMEOUT_MS` **and** the task's `--lease-ms`; the lease is the half people forget |
| task retried forever, each attempt ~60s | the lease is too short. Use `alpha-admin codex`, or pass `--lease-ms` |

## Where this sits

`codex.exec` is the sixth external-program handler here, and
`src/agent/handlers/alpha-coordination.js` is still the reference for the rules
they all follow. The argv is pinned in `buildArgs` and in
`test/codex-exec.test.js`: if the Codex CLI's interface changes, those two change
together. The working directory deliberately is not part of that contract — it is
passed as `cwd`, which every version honours and no version can rename.

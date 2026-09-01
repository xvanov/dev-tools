# personal-assistant

A personal agentic layer that sits between you and the coding agents. It watches where work
arrives — Outlook mail and calendar, Teams chats, GitLab, and conversations it records in the
room — turns what it finds into **typed commitments** (who asked, for what, by when, in which
repo), and dispatches the ones you approve to Claude Code sessions you can walk into at any
time.

It does not replace Claude Code, and it does not replace termhub. It is the layer that knows
*what should be worked on and why*, so the coding agents stop starting from zero.

> Built through phase 5 of [`PLAN.md`](./PLAN.md): capture, distillation, recall, dispatch and
> drafts all run. [`AGENT.md`](./AGENT.md) is the working agreement for changing any of it.

## Why this exists

Claude Code is excellent at the work and blind to the context. Every session begins with you
re-explaining who asked, which thread it came from, what was decided in the meeting, and which
repo convention applies. That re-explanation is the actual bottleneck, and a persistent store of
your own working context removes it.

The second thing it removes: work finishes and then sits there, because writing "here's what I
did" back to the person who asked is a separate act of will. `pa draft` writes that message from
the run's own diff and the original ask. You read it and send it.

## The shape of it

```
 Teams ask  ──┐
 email       ─┤                                                    ┌─► pa brief   (what's on me)
 meeting     ─┼──►  ingest ──► distill ──►  commitments  ──────────┼─► pa do 42   (dispatch)
 GitLab      ─┘                              (Postgres)            └─► pa draft 7 (reply back)
 your own                                         │
 Claude                                           ▼
 sessions                           dispatcher ──► git worktree
                                                 + BRIEF.md
                                                 + termhub session running `claude`
                                                       │
                              steer with `pa say` ─────┤
                              or attach in termhub ────┘
```

Four decisions carry most of the design:

- **Capture is append-only and keeps raw payloads.** The first extraction prompt will be wrong
  in ways only a fortnight of real mail reveals; keeping the originals means the fix is a
  re-run, not re-reading a year of email.
- **Distilled rows, not chunks.** Retrieval answers "find me passages about billing". "What did
  I promise seven people this week" needs a table with a `due` column.
- **Modes are enforced, not requested.** A `local` run's worktree has its push URL pointed at a
  dead host. The agent cannot push, whatever its brief says.
- **Nothing is sent without you.** `pa send` is interactive and is the only path outbound.

## Install (Windows)

```powershell
cd C:\repos\dev-tools\personal-assistant
.\windows\install.ps1
```

That provisions Postgres 16 + pgvector inside your WSL distro, registers the logon tasks
(keep-alive, worker, and the two capture streams), applies the schema, and writes a `.env` for
you to fill in.

Then:

```powershell
copy .env.example .env      # if install.ps1 did not
notepad .env                # see below for what each value is
node bin\pa.js login        # device code — sign in to Microsoft
node bin\pa.js projects sync
node bin\pa.js doctor       # confirms what is wired and what is missing
Start-ScheduledTask pa-worker
Start-ScheduledTask pa-capture-mic
Start-ScheduledTask pa-capture-loopback
```

`pa doctor` is the answer to "why isn't it doing anything". It reports every credential, every
source cursor, the distillation backlog, and whether termhub is reachable.

### What you need to set

| Value | Needed for | Notes |
|---|---|---|
| `PA_GRAPH_CLIENT_ID` | mail, calendar, Teams chats | An Entra app registration: single tenant, public client flows enabled, redirect `http://localhost`. Delegated `Mail.Read`, `Calendars.Read`, `Chat.Read`. |
| `ANTHROPIC_API_KEY` | distillation and drafts | Without it the store still fills and search still works; nothing gets distilled. |
| `PA_GITLAB_TOKEN` | MRs, issues, todos, opening draft MRs | `read_api` is enough unless you want `pa land` to open the MR, which needs `api`. |
| `AZURE_OPENAI_*` | semantic search | Optional. Without it search is full-text only — good on names and ids, weaker on paraphrase. |

Everything else has a working default. See [`.env.example`](./.env.example).

### The permissions wall

`Mail.Read`, `Calendars.Read` and `Chat.Read` are delegated scopes that need no admin consent
*by specification* — but a tenant switch (*User consent for applications*) can still block them,
in which case even `Mail.Read` asks for admin approval. Team **channel** messages
(`ChannelMessage.Read.All`) and Teams meeting transcripts via Graph need admin consent
regardless, which is why meetings are recorded locally instead. [`PLAN.md`](./PLAN.md) §2 has
the detail and the fallback.

## Using it

```
pa brief                        what's on you today
pa inbox                        newly distilled commitments
pa show 42                      one commitment, with the ask in the requester's words
pa show 42 --project x          correct a wrong repo — and teach it the phrase
pa search <words>               hybrid search over everything captured
pa who Sam                      identities, threads, open commitments

pa do 42 --mode mr              dispatch to a Claude Code session in its own worktree
pa runs                         what's in flight
pa say 7 "use the existing helper"
pa attach 7                     open the session in termhub
pa review 7 [--diff]            what it changed
pa land 7                       push, and open a draft MR if the mode allows
pa drop 7                       kill the session, remove the worktree

pa draft 7                      a reply written from the ask and the actual diff
pa send 12                      interactive, explicit, and the only thing that sends

pa mic status | pause 30 | on    always-on capture control
pa doctor                        what is configured, stale, or broken
```

### Dispatch modes

| Mode | May | Stops before |
|---|---|---|
| `plan` | read, write a plan | changing any file |
| `local` *(default)* | commit in its own worktree | anything touching the remote |
| `branch` | push the branch | opening an MR |
| `mr` | push, open a **draft** MR | marking it ready, notifying anyone |
| `full` | all of that, plus draft a reply into `REPLY.md` | sending |

## Always-on capture

Two streams, captured separately and never mixed: the **microphone** is you, the **system
loopback** is everyone else. That is what gives speaker attribution with no diarization model
and no misattributed quotes — and it works whether or not your tenant ever allows Teams
transcripts, because nothing joins the meeting.

Raw audio is written continuously and trimmed hourly rather than gated live by a VAD: a VAD bug
then costs a bloated file instead of the first three seconds of every sentence. Speech groups
are transcribed through voice-dictation's already-warm faster-whisper server, so there is no
second model and no GPU contention with the dictation hotkey.

`pa mic pause 30` releases the device handle outright — it stops capture, not merely
transcription. Your own Claude Code sessions are captured from their transcripts on disk rather
than from audio, because the exact text is already there.

## Wiring it into your agents

- [`integrations/claude-code/`](./integrations/claude-code/) — register the read-only MCP recall
  server so every Claude Code session on this machine reads the same brain.
- [`integrations/openclaw/SKILL.md`](./integrations/openclaw/SKILL.md) — the skill that lets
  OpenClaw drive these same commands from a chat surface.

## Layout

```
bin/pa.js            the CLI entry point
src/config.js        every knob, resolved once
src/ingest/          Graph mail/calendar/chat, GitLab, Claude sessions, audio episodes
src/distill/         the extraction prompt, identity resolution, the pass itself
src/projects/        the project ↔ repo table and the scorer that guesses
src/search/          hybrid full-text + vector retrieval
src/brief/           what `pa brief` prints
src/dispatch/        worktrees, briefs, termhub sessions, modes, landing
src/draft/           reply composition, and the one thing that sends
src/mcp/server.js    the read-only recall server
src/worker.js        the periodic passes
audio/               capture and trim/transcribe (Python)
sql/                 numbered migrations
windows/             install, and the WSL Postgres provisioner
```

## Related

- [`termhub`](../termhub/) — the session substrate. Dispatch creates termhub sessions because
  it is the only one you can attach to from a phone.
- [`voice-dictation`](../voice-dictation/) — owns the faster-whisper server the audio pass uses.
- [`disk-janitor`](../disk-janitor/) — point it at the audio spool; aged rebuildable data is
  exactly what it is for.

# personal-assistant

> **Status: planning.** No code yet. [`PLAN.md`](./PLAN.md) is the build plan;
> [`AGENT.md`](./AGENT.md) is the working agreement for whoever builds it.

A personal agentic layer that sits between you and the coding agents. It watches the places
work arrives — Outlook mail and calendar, Teams chats, GitLab, recorded meetings — turns what
it finds into **typed commitments** (who asked, for what, by when, in which repo), and
dispatches the ones you approve to Claude Code sessions you can walk into at any time.

It does not replace Claude Code, and it does not replace termhub. It is the layer that knows
*what should be worked on and why*, so the coding agents stop starting from zero.

## Why this exists

Claude Code is excellent at the work and blind to the context. Every session begins with you
re-explaining who asked, which thread it came from, what was decided in the meeting, and which
repo convention applies. That re-explanation is the actual bottleneck, and it is the thing a
persistent store of your own working context removes.

The second thing it removes: work finishes and then sits there, because writing "here's what I
did" back to the person who asked is a separate act of will. The assistant drafts that message
from the run's own diff and the original ask. You read it and send it.

## What it is made of

| Piece | Role | Build or adopt |
|---|---|---|
| Microsoft Graph + GitLab ingest | Pull mail, calendar, chats, MRs on a delta cursor | Build (thin) |
| Meeting capture | Local audio → transcript, no bot, no tenant approval | Adopt (Meetily / existing whisper) |
| Postgres + pgvector | One store: raw items, distilled rows, embeddings, jobs | Adopt |
| Distillation | LLM pass turning items into commitments / decisions / blockers | Build — this is the value |
| `pa` CLI | Everything you type: brief, inbox, do, runs, review, draft | Build |
| `pa-mcp` | Recall tools so any Claude Code session reads the same brain | Build |
| Dispatcher | Worktree + brief + a Claude Code session, via termhub's API | Build (thin, on termhub) |
| termhub | The terminal you attach to when a session gets stuck | Already yours |
| OpenClaw | The conversational front door: TUI, sessions, skills, channels | Adopt |

## How it fits a normal day

```
 Teams ask  ──┐
 email       ─┤                                                    ┌─► pa brief   (what's on me)
 meeting     ─┼──►  ingest ──► distill ──►  commitments  ──────────┼─► pa do 42   (dispatch)
 GitLab      ─┘                              (Postgres)            └─► pa draft 7 (reply back)
                                                  │
                                                  ▼
                                    dispatcher ──► git worktree
                                                 + BRIEF.md
                                                 + termhub session running `claude`
                                                       │
                              steer from OpenClaw ─────┤
                              or attach in termhub ────┘
```

You talk to it in the OpenClaw TUI. It talks back there, and pushes to your phone through
termhub's existing ntfy path when a session has been waiting on you.

## Read next

- [`PLAN.md`](./PLAN.md) — decisions taken, phases, schema, CLI surface, open questions.
- [`AGENT.md`](./AGENT.md) — invariants that must hold no matter who is editing.

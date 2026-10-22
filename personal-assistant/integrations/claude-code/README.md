# Wiring the store into Claude Code

Two things are worth connecting, and they are different in kind.

## 1. The recall server (MCP) — read-only, everywhere

This is what stops a dispatched session and an ad-hoc one from disagreeing about context.
Register it once, at user scope, so every session on this machine can reach it:

```powershell
claude mcp add personal-assistant --scope user -- node C:\repos\dev-tools\personal-assistant\src\mcp\server.js
```

It exposes:

- `recall` — the one to reach for with a question: raw items, distilled facts with their quotes,
  and people/project pages, followed up and ranked together; it says when nothing relevant exists.
- `memory_page` — a person, a project, `me` or `index`.
- `explain_claim` — why a fact is believed: quote, source, what it replaced.
- `remember` — proposes a fact; it waits in the dashboard's review queue until you approve it.
- `brief_me`, `search_context`, `get_thread`, `open_commitments`, `who_is`, `repo_state`.

**It is read-only on purpose**, except for `remember`, which only proposes. A server that could
dispatch runs, send mail or rewrite memory would put those actions one prompt-injected email
away — and this store is full of text other people wrote. Dispatching, sending, approving and
forgetting stay in the CLI and the dashboard, where a human does them.

## 2. A `/brief` command — optional, and just a shortcut

Drop this in `~/.claude/commands/brief.md` if you want the morning brief without leaving a
session:

```markdown
---
description: What's on me today, from the personal assistant's store
---

Run `node C:\repos\dev-tools\personal-assistant\bin\pa.js brief` and summarise it: what is
overdue, what is due today, and anything waiting on my review. Do not paste the raw output.
```

## Why the MCP server is not enough on its own

Recall answers "what do I know about this". It deliberately cannot answer "and now go do it" —
the dispatcher creates worktrees and starts agents, which is not something a model should be
able to trigger by reading an email that asks it to. `pa do` is a command you type.

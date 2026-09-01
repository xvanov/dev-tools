# Wiring the store into Claude Code

Two things are worth connecting, and they are different in kind.

## 1. The recall server (MCP) — read-only, everywhere

This is what stops a dispatched session and an ad-hoc one from disagreeing about context.
Register it once, at user scope, so every session on this machine can reach it:

```powershell
claude mcp add personal-assistant --scope user -- node C:\repos\dev-tools\personal-assistant\src\mcp\server.js
```

It exposes `brief_me`, `search_context`, `get_thread`, `open_commitments`, `who_is` and
`repo_state`.

**It is read-only on purpose.** A server that could dispatch runs or send mail would put those
actions one prompt-injected email away — and this store is full of text other people wrote.
Dispatching and sending stay in the CLI, where a human types them.

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

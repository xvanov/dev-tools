---
name: pa
description: The user's personal context layer. Use for anything about what they owe people, what people owe them, what was said in a meeting or thread, which repo a piece of work belongs to, or to dispatch work to a Claude Code session. Triggers - "what's on me", "what did X ask", "brief me", "take that on", "dispatch", "what did we decide about", "who is X", "draft a reply".
---

# pa — the context layer

Everything here runs through the `pa` CLI. Do not query the database directly and do not
reimplement dispatch: one implementation of every behaviour, or the chat surface and the
terminal will eventually disagree about what `pa do` means.

Run commands from the tool directory (`C:\repos\dev-tools\personal-assistant`) as
`node bin/pa.js <command>`.

## Knowing what is going on

| Ask | Command |
|---|---|
| "what's on me", "brief me", "where am I" | `pa brief` |
| "what came in", "anything new" | `pa inbox` |
| "tell me about #42" | `pa show 42` |
| "what did we decide about X", "find that thread" | `pa search <words>` |
| "who is Sam", "what does Sam want" | `pa who Sam` |
| "which repos do you know" | `pa projects` |

`pa brief` is the right answer to most open-ended status questions. Read it and summarise it in
your own words; do not paste it verbatim unless asked.

## Correcting a wrong guess

Commitments carry a repo the distiller guessed. When one is wrong — and `pa inbox` marks the
shaky ones with `?` — fix it once:

```
pa show 42 --project estimating-api
```

That both sets the repo and learns the phrase the ask actually used, so the next message worded
the same way resolves silently. Offer this whenever the user says the repo is wrong.

## Dispatching work

```
pa do 42 --mode mr          # from a commitment
pa do --task "..." --repo C:\repos\x --mode local
```

Modes, and what each one is allowed to do:

| Mode | May | Stops before |
|---|---|---|
| `plan` | read, write a plan | changing any file |
| `local` | commit in its own worktree | anything touching the remote |
| `branch` | push the branch | opening an MR |
| `mr` | push, open a **draft** MR | marking it ready, notifying anyone |
| `full` | all of that, plus draft a reply | **sending** |

**Ask which mode before dispatching** unless the user said. Do not guess `mr` for something
that sounded exploratory, and do not guess `local` for something they clearly want reviewed.
The boundary is enforced outside the session — a `local` run physically cannot push — so
picking wrong means re-dispatching, not a quiet mistake.

## While a run is going

| Ask | Command |
|---|---|
| "how's it going" | `pa runs` |
| "tell it to..." | `pa say 7 <text>` |
| "let me look at it" | `pa attach 7` (prints the termhub URL) |
| "what did it change" | `pa review 7`, `pa review 7 --diff` |
| "ship it" | `pa land 7` |
| "bin it" | `pa drop 7` |

`pa say` is how the user steers a stuck agent without leaving the conversation. Pass their
words through; do not rewrite them into your own phrasing.

## Replying to whoever asked

```
pa draft 7            # writes a reply from the ask and the actual diff
pa drafts             # what is pending
pa send 12            # interactive, and the only thing that sends
```

**You must never call `pa send`.** It exists as a deliberate human act; it prompts for
confirmation and it is not yours to confirm. Draft, show the user the draft, and stop.

## When something is not working

`pa doctor` reports what is configured, which sources are stale, and what failed. If a command
fails with "not signed in", the fix is `pa login`, which prints a device code the user has to
enter — say so rather than retrying.

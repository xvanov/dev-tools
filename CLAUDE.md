# dev-tools — working agreement

A monorepo of independent personal tools, one directory each: `termhub`, `voice-dictation`,
`claude-ctx-statusline`, `disk-janitor`, `keep-awake`, `summarize-recording`, `bootstrap`.
Tools with deeper docs carry their own `AGENT.md` (`termhub/AGENT.md`, `voice-dictation/AGENT.md`) —
read that before changing the tool.

## Ship every unit of work

**A unit of work is not done until it is committed to `main` and pushed to the remote.** Don't leave
finished work sitting in the working tree: these tools deploy by `git pull` on the machines that run
them (`termhub/windows/update.ps1` does `git pull --ff-only` and *fails on a dirty tree*), so
uncommitted work is not merely unsaved — it blocks the next update and makes the running version
untraceable.

So, at the end of each unit of work:

```bash
git add -A <the files for this unit>
git commit          # Conventional Commits; see below
git push origin main
```

- **Commit at unit boundaries, not at task boundaries.** A "unit" is one coherent change that leaves
  the tree working — a bug fixed, a feature landed, docs brought in line with code. A long task can
  be several commits; several unrelated fixes are never one commit.
- **`main` is the branch.** These are single-author tools deployed straight from `main`; no branch or
  PR ceremony unless a change is genuinely risky enough to want review.
- **Never commit a red tree.** Run the tool's tests first (`cd <tool> && npm test` where one exists)
  and say so in the report if anything fails.
- **Verify the push.** `git status -sb` should show `## main...origin/main` with no ahead/behind and
  nothing staged. A commit that only exists locally hasn't shipped.
- If something blocks the commit or push (conflict, hook failure, no network), **say so explicitly**
  rather than leaving it silently undone.

## Commit messages

Conventional Commits, scoped by tool: `feat(termhub):`, `fix(voice-dictation):`, `chore:`,
`docs:`. Subject in the imperative, ≤72 chars. Use the body for *why* — the constraint that forced
the design, the failure it prevents, the thing the next reader would otherwise re-derive. Existing
history is the style reference; match its density.

End commit messages with:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

## Docs stay with the code

If a change makes a statement in a `README.md` or `AGENT.md` false, fix it **in the same commit**.
Stale docs that describe a layout the code abandoned cost more than no docs — they get trusted.

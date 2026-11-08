# dev-tools — working agreement

A monorepo of independent personal tools, one directory each: `termhub`, `voice-dictation`,
`claude-ctx-statusline`, `disk-janitor`, `keep-awake`, `summarize-recording`, `bootstrap`,
`personal-assistant`, `ios-messages`, `software-factory`, `ptyd` (Rust; termhub's terminal host,
see `ptyd/README.md`), `desktop` (Tauri 2 desktop shell, see `desktop/README.md`).
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
- **Tests while you work:** `npm test -- --changed` runs only the tests your change can reach, and the
  pre-commit hook (after the ios-messages guard) does the same for every commit; CI runs everything.
  Details, the config keys and the emergency skip: [scripts/README.md](scripts/README.md).
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

## Architecture map

`personal-assistant/src/dashboard/architecture.json` is the living map of the whole system (Talk,
Dashboard, Factory, Sessions; the work and personal stacks), rendered at the PA dashboard's
`/architecture`. **When you add, remove or rename a component, MCP tool, `pa` verb, worker pass,
table, port, model default, persona or storage location, update that JSON in the same commit.**
`personal-assistant/test/architecture.test.js` enforces part of it (tools and their allow/ask split,
verbs, passes, tables, personas, env defaults, code paths, edges); the prose facts are on you. Mark
what is not built yet `planned`, what is half-landed `landing`, and write "unknown" rather than guess.

## Native rebuild plan

`docs/native/PLAN.md` is the tracked plan for the native rebuild (TypeScript/Bun core, Rust
`ptyd`, SQLite, zero-downtime deploys, fast parallel tests). Its decision log is binding. When a
commit finishes a plan item, tick that item's box in the same commit with the short hash.

## software-factory

Imported 2026-11-06 as a snapshot of `xvanov/software-factory` @ `39f9c26` (that repo keeps the full
history, `apps/sacrifice` and the `bench/swebench` results). It is a Python/uv tool with its own
`CLAUDE.md` and `AGENTS.md` — read those first. It runs on the Linux machine (k-911-x17), from
`/home/k/dev-tools/software-factory` once `software-factory/docs/CUTOVER.md` has been run. The work stack
runs its own factory natively on Windows (`software-factory/docs/WINDOWS.md`: `factory serve` as a
logon task instead of systemd timers). This repo is
public: only `apps/factory` and `apps/template-probe` are tracked; every other registered app's
config stays local to the factory machine (see `software-factory/.gitignore`).

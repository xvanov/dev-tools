# dev-tools — working agreement

Monorepo of independent personal tools, one directory each. The main system is **Jarvis**:
`personal-assistant` (the PA: Ask, Plan, Build), `termhub` + `ptyd` (Run: terminal sessions), `desktop`
(Tauri shell). Smaller tools: `voice-dictation`, `claude-ctx-statusline`, `disk-janitor`, `keep-awake`,
`summarize-recording`, `bootstrap`, `ios-messages`. A tool with an `AGENT.md` or `README.md` — read it
before changing that tool.

## Build is one agent per task

Coding work runs as **one Claude Code agent per task** in a termhub session
(`personal-assistant/src/build`, see `personal-assistant/AGENT.md` "Build"). That is the way: improve it.
The multi-persona `software-factory` was removed from the tree (recoverable from git at `4eee22f`).

## Ship every unit of work

Done = committed to `main`, pushed, CI green. Tools deploy by `git pull`; uncommitted work can block the
next update.

- One commit per coherent unit; unrelated fixes are separate commits. Work on `main`, no branches unless
  a change is risky enough to want review.
- Test while you work: `npm test -- --changed` (the pre-commit hook does the same; details in
  [scripts/README.md](scripts/README.md)). Never commit a red tree.
- After pushing: `git status -sb` shows `## main...origin/main`, then follow CI to the end:
  `gh run list --branch main --limit 1`, `gh run watch <id> --exit-status`, `gh run view <id> --log-failed`.
- A red run is yours to fix, even if you did not cause it. Fix it in its own commit and watch again.
  Report the run's result and URL; never call work done while CI is red or running.
- If commit or push is blocked, say so.

## Commit messages

Conventional Commits scoped by tool (`feat(termhub):`, `fix(personal-assistant):`, `docs:`, `chore:`).
Imperative subject ≤72 chars; body says *why*. End with a
`Co-Authored-By: Claude <model> <noreply@anthropic.com>` line.

## Keep these in the same commit

- **Docs:** a change that makes a `README.md` or `AGENT.md` statement false fixes it.
- **Architecture map:** `personal-assistant/src/dashboard/architecture.json` (rendered at `/architecture`).
  Adding, removing or renaming a component, MCP tool, `pa` verb, worker pass, table, port, model default
  or storage location updates it. `test/architecture.test.js` checks part of it. Mark unbuilt things
  `planned`, half-landed `landing`; write "unknown" rather than guess.
- **Plan:** `docs/native/PLAN.md` — its decision log is binding; tick an item's box with the short hash
  when a commit finishes it.

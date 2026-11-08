# claude-ctx-statusline — Claude Code Context Status

## What it does

A status line for Claude Code CLI that shows the current context window
percentage. Installed as a shell integration so every Claude Code session
displays live context usage, helping the operator avoid hitting the context
limit mid-task.

## Language / Runtime

JavaScript on Node.js (no external dependencies).

## Platforms

Windows, Linux, and macOS.

## Test command

No automated tests.

```
echo "No tests"
```

## Install / Deploy

- **Windows:** `.\install.ps1` — writes `ctx-statusline.js` to the user's home
  and adds it to the shell profile
- **Linux:** `linux/install.sh` — similar approach, writes to `~/.claude/`
- Post-install: any new `claude` session shows the context percentage in the
  prompt line
# Module: claude-ctx-statusline

**Path:** `claude-ctx-statusline/`

## Purpose

Shows context window usage in the Claude Code status bar (e.g. `Ctx: 30k/200k (15%)`).

## Key files

| File | Role |
|------|------|
| `ctx-statusline.js` | Main script — reads Claude Code context stats and updates status bar. |
| `install.ps1` | Windows installer. |
| `linux/` | Linux installer. |

## Tech

- JavaScript (Node.js)
- Integrates with Claude Code status bar API
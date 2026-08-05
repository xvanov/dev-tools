# claude-ctx-statusline

Shows context window usage in the Claude Code status line:

```
k@host:/home/k/dev-tools | Ctx: 30k/200k (15%)
```

The window size comes from the payload Claude Code sends, so a 1M-context model
reports `Ctx: 125k/1000k (12%)` rather than being pinned at 200k. Before the first
tokens are counted the readout is `Ctx: Ready` — printing `0k` there would look
like a working meter reading zero.

## Requirements

- Claude Code CLI
- Node.js (any recent version)
- `jq` (Linux/macOS installer only)

## Install

Linux / macOS:

```bash
./linux/install.sh
```

Windows:

```powershell
.\install.ps1
```

Restart Claude Code. Done.

## What it does

Both installers:
1. Copy `ctx-statusline.js` to `~/.claude/scripts/`
2. Patch the `statusLine` key in `~/.claude/settings.json`, leaving other keys alone

`linux/install.sh` also writes a dated `settings.json.bak-*` first, so a bad patch
doesn't cost you your hooks and permissions.

## Manual install

Add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/home/YOU/.claude/scripts/ctx-statusline.js\""
  }
}
```

## If the status line goes blank

Claude Code renders nothing when the `statusLine` key is missing, so check that
first — an unrelated tool rewriting `settings.json` can drop it:

```bash
jq -r 'keys[]' ~/.claude/settings.json
```

No `statusLine` in the list means re-run the installer. To see what the script
itself would print:

```bash
echo '{"context_window":{"context_window_size":200000,"used_percentage":15}}' \
  | node ~/.claude/scripts/ctx-statusline.js
```

#!/usr/bin/env bash
# claude-ctx-statusline installer (Linux/macOS) — the counterpart to install.ps1.
# Copies ctx-statusline.js to ~/.claude/scripts/ and patches ~/.claude/settings.json
# so Claude Code shows "Ctx: 30k/200k (15%)" in the status line.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$SCRIPT_DIR/.." && pwd)/ctx-statusline.js"

CLAUDE_DIR="$HOME/.claude"
SCRIPTS_DIR="$CLAUDE_DIR/scripts"
SETTINGS="$CLAUDE_DIR/settings.json"
DEST="$SCRIPTS_DIR/ctx-statusline.js"

command -v node >/dev/null 2>&1 || { echo "ERROR: node not found. Install Node.js and re-run." >&2; exit 1; }
command -v jq   >/dev/null 2>&1 || { echo "ERROR: jq not found. Install jq (e.g. 'sudo apt-get install jq') and re-run." >&2; exit 1; }

# --- copy the script -------------------------------------------------------
mkdir -p "$SCRIPTS_DIR"
cp -f "$SRC" "$DEST"
echo "Copied ctx-statusline.js -> $DEST"

# --- patch settings.json (add/overwrite the statusLine key) ----------------
[[ -f "$SETTINGS" ]] || echo '{}' > "$SETTINGS"

tmp="$(mktemp)"
jq --arg cmd "node \"$DEST\"" \
   '.statusLine = {type: "command", command: $cmd}' \
   "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
echo "Patched $SETTINGS"
echo
echo "Done. Restart Claude Code to see: Ctx: 30k/200k (15%)"

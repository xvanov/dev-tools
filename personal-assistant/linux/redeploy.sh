#!/usr/bin/env bash
# Redeploy the personal assistant (and the factory's Python deps) after the repo was
# pulled.
#
# Called by termhub's updater (termhub/linux/update.sh) BEFORE it restarts termhub, so
# one "Update" brings the whole stack to the pulled commit, not just termhub. Safe to
# run by hand:  bash personal-assistant/linux/redeploy.sh [<commit before the pull>]
#
# Never fails the caller: problems are reported and it exits 0.
FROM="${1:-}"
PA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(git -C "$PA_DIR" rev-parse --show-toplevel 2>/dev/null)"
HEAD="$(git -C "$PA_DIR" rev-parse HEAD 2>/dev/null)"
say() { echo "stack update: $*"; }

changed() {  # path prefix -> true if it changed since FROM (always true without FROM)
  [ -z "$FROM" ] && return 0
  [ -n "$(git -C "$REPO_DIR" diff --name-only "$FROM" "$HEAD" -- "$1" 2>/dev/null)" ]
}
unit() { systemctl --user cat "$1" >/dev/null 2>&1; }

# The factory runs per tick (uv run), so a pull is live on its next tick; only its
# locked dependencies need syncing.
if changed software-factory/uv.lock && [ -d "$REPO_DIR/software-factory/.venv" ]; then
  UV="$(command -v uv || echo "$HOME/.local/bin/uv")"
  if [ -x "$UV" ]; then
    say "software-factory dependencies: uv sync"
    ( cd "$REPO_DIR/software-factory" && "$UV" sync --quiet ) || say "uv sync reported a problem - continuing."
  fi
fi

if ! changed personal-assistant; then say "personal-assistant unchanged - no restart needed."; exit 0; fi

if changed personal-assistant/package.json || changed personal-assistant/package-lock.json; then
  say "personal-assistant dependencies: npm install"
  ( cd "$PA_DIR" && npm install --omit=dev --no-audit --no-fund ) || say "npm install reported a problem - continuing."
  git -C "$PA_DIR" checkout -- package-lock.json 2>/dev/null || true
fi

if unit pa-voice.service && changed personal-assistant/voice; then
  say "restarting pa-voice"
  systemctl --user restart pa-voice.service || say "pa-voice did not restart - continuing."
fi

if ! unit pa-worker.service; then say "no pa-worker unit on this machine - skipping the restart."; exit 0; fi
say "restarting pa-worker"
systemctl --user restart pa-worker.service || { say "pa-worker did not restart - check: journalctl --user -u pa-worker"; exit 0; }

PORT="$(sed -n 's/^[[:space:]]*PA_DISPATCH_PORT[[:space:]]*=[[:space:]]*\([0-9]*\).*/\1/p' "$PA_DIR/.env" 2>/dev/null | head -1)"
PORT="${PORT:-7300}"
for _ in $(seq 1 30); do
  sleep 1
  if curl -fsS "http://127.0.0.1:$PORT/api/version" 2>/dev/null | grep -q "$HEAD"; then
    say "pa-worker serving ${HEAD:0:7}."
    exit 0
  fi
done
say "pa-worker did not report ${HEAD:0:7} within 30 s - check: journalctl --user -u pa-worker"
exit 0

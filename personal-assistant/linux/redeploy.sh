#!/usr/bin/env bash
# Redeploy the personal assistant (and the factory's Python deps) after the repo was
# pulled (docs/native/PLAN.md, Z4).
#
# Called by termhub's updater (termhub/linux/update.sh) BEFORE it restarts termhub, so
# one "Update" brings the whole stack to the pulled commit, not just termhub. Safe to
# run by hand:
#   bash personal-assistant/linux/redeploy.sh [<commit before the pull>] [--pull] [--dry-run]
#
# The work is src/supervisor/deploy.js: npm install if the package files changed, then a
# zero-downtime roll through the supervisor (src/supervisor), watched for 60 s and rolled
# back if the new generation is not healthy. This script adds what is Linux-specific:
#
#   1. The pa-worker unit runs the supervisor, not the worker: the unit is re-rendered
#      from linux/pa-worker.service (linux/units.js) and, if it changed, written and
#      daemon-reloaded. Idempotent.
#   2. The restart path, kept as the fallback: when no supervisor answers (the first
#      deploy after step 1 — the bootstrap), the unit file changed, or the supervisor's
#      own code changed (it cannot roll itself): `systemctl --user restart pa-worker`.
#      That restart has the old gap; every deploy after it rolls.
#
# Never fails the caller: problems are reported and it exits 0 (2 for a bad argument).
FROM=""
PULL=0
DRY=0
for arg in "$@"; do
  case "$arg" in
    --pull) PULL=1 ;;
    --dry-run) DRY=1 ;;
    -*) echo "redeploy.sh: unknown option $arg" >&2; exit 2 ;;
    *) FROM="$arg" ;;
  esac
done
PA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(git -C "$PA_DIR" rev-parse --show-toplevel 2>/dev/null)"
say() { echo "stack update: $*"; }

changed() {  # path prefix -> true if it changed since FROM (always true without FROM)
  [ -z "$FROM" ] && return 0
  [ -n "$(git -C "$REPO_DIR" diff --name-only "$FROM" HEAD -- "$1" 2>/dev/null)" ]
}
unit() { systemctl --user cat "$1" >/dev/null 2>&1; }
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { say "node not on PATH - cannot redeploy the assistant."; exit 0; }

# --pull first, so everything below sees the pulled tree.
if [ "$PULL" = 1 ]; then
  FROM="$(git -C "$PA_DIR" rev-parse HEAD)"
  if [ "$DRY" = 1 ]; then say "would run: git pull --ff-only"
  else git -C "$PA_DIR" pull --ff-only || { say "git pull --ff-only failed - nothing changed."; exit 0; }
  fi
fi
HEAD_SHA="$(git -C "$PA_DIR" rev-parse HEAD 2>/dev/null)"

# The factory runs per tick (uv run), so a pull is live on its next tick; only its
# locked dependencies need syncing.
if changed software-factory/uv.lock && [ -d "$REPO_DIR/software-factory/.venv" ]; then
  UV="$(command -v uv || echo "$HOME/.local/bin/uv")"
  if [ -x "$UV" ]; then
    if [ "$DRY" = 1 ]; then say "would run: uv sync (software-factory)"
    else
      say "software-factory dependencies: uv sync"
      ( cd "$REPO_DIR/software-factory" && "$UV" sync --quiet ) || say "uv sync reported a problem - continuing."
    fi
  fi
fi

if unit pa-voice.service && changed personal-assistant/voice; then
  if [ "$DRY" = 1 ]; then say "would restart pa-voice"
  else
    say "restarting pa-voice"
    systemctl --user restart pa-voice.service || say "pa-voice did not restart - continuing."
  fi
fi

# 1. The unit names the supervisor.
HAS_UNIT=0
UNIT_CHANGED=0
if unit pa-worker.service; then
  HAS_UNIT=1
  CUR="$(systemctl --user show pa-worker.service -p FragmentPath --value 2>/dev/null)"
  TMP="$(mktemp -d)"
  if ( cd "$PA_DIR" && "$NODE" linux/units.js --worker --dir "$TMP" >/dev/null ); then
    if [ -n "$CUR" ] && ! cmp -s "$TMP/pa-worker.service" "$CUR"; then
      UNIT_CHANGED=1
      if [ "$DRY" = 1 ]; then say "would rewrite $CUR (now: $(grep '^ExecStart=' "$CUR" | head -1))"
      else
        cp "$TMP/pa-worker.service" "$CUR" && systemctl --user daemon-reload
        say "pa-worker unit now runs the supervisor ($CUR)."
      fi
    fi
  else
    say "could not render the pa-worker unit - leaving it as it is."
  fi
  rm -rf "$TMP"
fi

# 2. deploy.js: 0 done, 1 failed (previous generation serving), 3 no supervisor, 4 supervisor changed.
ARGS=(src/supervisor/deploy.js)
[ -n "$FROM" ] && ARGS+=(--from "$FROM")
[ "$DRY" = 1 ] && ARGS+=(--dry-run)
( cd "$PA_DIR" && "$NODE" "${ARGS[@]}" )
CODE=$?

if [ "$CODE" = 0 ] && [ "$UNIT_CHANGED" = 0 ]; then exit 0; fi
if [ "$CODE" = 1 ]; then say "the deploy did not take; the lines above say which generation serves."; exit 0; fi
if [ "$HAS_UNIT" = 0 ]; then say "no pa-worker unit on this machine - skipping the restart."; exit 0; fi
if [ "$DRY" = 1 ]; then say "would restart pa-worker and wait for ${HEAD_SHA:0:7}"; exit 0; fi

say "restarting pa-worker"
systemctl --user restart pa-worker.service || { say "pa-worker did not restart - check: journalctl --user -u pa-worker"; exit 0; }
PORT="$(sed -n 's/^[[:space:]]*PA_DISPATCH_PORT[[:space:]]*=[[:space:]]*\([0-9]*\).*/\1/p' "$PA_DIR/.env" 2>/dev/null | head -1)"
PORT="${PA_DISPATCH_PORT:-${PORT:-7300}}"
for _ in $(seq 1 120); do
  sleep 1
  if curl -fsS "http://127.0.0.1:$PORT/api/version" 2>/dev/null | grep -q "$HEAD_SHA"; then
    say "pa-worker serving ${HEAD_SHA:0:7}."
    exit 0
  fi
done
say "pa-worker did not report ${HEAD_SHA:0:7} within 120 s - check: journalctl --user -u pa-worker"
exit 0

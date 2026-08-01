#!/usr/bin/env bash
# termhub safe update (Linux) — the script the ⟳ Update button runs.
#
#     termhub/linux/update.sh
#
# THE CONSTRAINT THAT SHAPES THIS WHOLE SCRIPT
#
# On Linux termhub is ONE process (`server.js`) under a systemd --user unit, and the
# Update button runs this script inside a termhub PTY. So
# `systemctl --user restart termhub` kills the terminal this script is running in,
# mid-line. Anything sequenced after the restart never happens.
#
# That is why the restart is LAST, why everything else (pull, deps, CLI, watchdog)
# happens before it, and why the restart itself is handed to a DETACHED re-exec of
# this script (`--finish`) that survives the PTY dying and can therefore verify the
# new build and roll back if it never comes up. The old inline update command had the
# same ordering constraint and no way to verify anything, because there was nothing
# left alive to do the verifying.
#
# Windows does not have this problem: there the front is a separate process, so
# windows/update.ps1 swaps it while sessiond keeps every PTY alive.
#
# WHY THIS IS A SCRIPT AND NOT AN INLINE COMMAND
#
# lib/update.js used to compose the Linux update as a one-liner string. That string is
# built by the RUNNING front, so it always describes the OLD version's idea of how to
# update — which means no change to the update procedure could ever apply itself. Every
# new step (like installing the watchdog) needed a manual first run on every machine.
# Delegating to a script in the repo makes the pull bring the new procedure with it,
# which is what windows/update.ps1 has always done.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE="${TERMHUB_SERVICE:-termhub}"
DATA_DIR="${TERMHUB_DATA_DIR:-$HOME/.local/termhub}"
LOG_DIR="$DATA_DIR/logs"
UPDATE_LOG="$LOG_DIR/update.log"
mkdir -p "$LOG_DIR"

say()  { echo "termhub update: $*"; }
fail() { echo "termhub update FAILED: $*" >&2; exit 1; }

# Which addresses could termhub be serving on?
#
# NOT just loopback. With no TERMHUB_BIND, server.js binds the TAILNET IP and uses
# loopback only as a last-resort fallback — so a loopback-only health check fails on a
# perfectly healthy default install. In --finish that is not a cosmetic bug: it would
# conclude the restart failed and ROLL BACK a good update.
# Sets HEALTH_PORT and HEALTH_ADDRS. Assigns globals directly rather than printing,
# because `x="$(f)"` runs f in a SUBSHELL and any global it set is lost with it.
resolve_health() {
  local envline bind ts
  HEALTH_PORT="${TERMHUB_PORT:-7000}"
  bind="${TERMHUB_BIND:-}"
  envline="$(systemctl --user show "$SERVICE" -p Environment --value 2>/dev/null || true)"
  case "$envline" in
    *TERMHUB_PORT=*) HEALTH_PORT="$(printf '%s\n' "$envline" | tr ' ' '\n' | sed -n 's/^TERMHUB_PORT=//p' | tail -1)" ;;
  esac
  case "$envline" in
    *TERMHUB_BIND=*) bind="$(printf '%s\n' "$envline" | tr ' ' '\n' | sed -n 's/^TERMHUB_BIND=//p' | tail -1)" ;;
  esac
  case "$bind" in 0.0.0.0|'*'|'::') bind="127.0.0.1" ;; esac
  HEALTH_ADDRS=""
  [ -n "$bind" ] && HEALTH_ADDRS="$bind"
  HEALTH_ADDRS="$HEALTH_ADDRS 127.0.0.1"
  ts="$(tailscale ip -4 2>/dev/null | head -1 | tr -d '[:space:]' || true)"
  [ -n "$ts" ] && HEALTH_ADDRS="$HEALTH_ADDRS $ts"
  HEALTH_ADDRS="$(printf '%s\n' "$HEALTH_ADDRS" | tr ' ' '\n' | awk 'NF && !seen[$0]++' | tr '\n' ' ')"
}

wait_healthy() {   # seconds — true if ANY candidate address serves ok:true
  local deadline body a
  resolve_health
  deadline=$(( $(date +%s) + ${1:-60} ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    for a in $HEALTH_ADDRS; do
      body="$(curl -sS -m 3 "http://$a:$HEALTH_PORT/api/health" 2>/dev/null || true)"
      case "$body" in *'"ok":true'*) return 0 ;; esac
    done
    sleep 2
  done
  echo "health check failed on all of: $HEALTH_ADDRS (port $HEALTH_PORT)"
  return 1
}

deps_changed() {   # from-ref to-ref
  git -C "$PROJECT_DIR" diff --name-only "$1" "$2" 2>/dev/null \
    | grep -qE '(^|/)termhub/package(-lock)?\.json$'
}

install_deps() {
  say "package files changed - installing dependencies"
  ( cd "$PROJECT_DIR" && npm install --omit=dev --no-audit --no-fund ) \
    || say "npm install reported a problem - continuing (the previous node_modules is still in place)"
}

# ---------------------------------------------------------------------------
# --finish: the detached half. Runs with no terminal, so everything it says goes
# to $UPDATE_LOG. This is the only part that can verify the restart, because it is
# the only part still alive after it.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--finish" ]; then
  ROLLBACK="${2:-}"
  exec >>"$UPDATE_LOG" 2>&1
  echo
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') restart phase (rollback ref: ${ROLLBACK:-none}) ==="

  if ! systemctl --user restart "$SERVICE" 2>&1; then
    echo "restart of '$SERVICE' failed outright"
    systemctl --user status "$SERVICE" --no-pager -n 20 2>&1 || true
  fi

  if wait_healthy 60; then
    echo "OK: termhub is healthy on the new build ($(git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null))"
    # Cheap belt-and-braces: if the pull introduced or changed the watchdog units,
    # make sure they are in place now that the new code is on disk.
    bash "$PROJECT_DIR/watchdog/install-watchdog.sh" --ensure 2>&1 || true
    exit 0
  fi

  echo "termhub did not become healthy within 60s of the restart."
  if [ -z "$ROLLBACK" ]; then
    echo "No rollback ref was passed, so nothing is being reverted. The watchdog will"
    echo "try to repair this and escalate if it cannot."
    exit 1
  fi

  echo "Rolling back to $ROLLBACK and restarting."
  if git -C "$PROJECT_DIR" reset --hard "$ROLLBACK" 2>&1; then
    if deps_changed "$ROLLBACK" HEAD; then install_deps; fi
    systemctl --user restart "$SERVICE" 2>&1 || true
    if wait_healthy 60; then
      echo "Rolled back and healthy again on $ROLLBACK. The update did NOT take."
      exit 1
    fi
    echo "STILL DOWN after rolling back. This needs a human, or the watchdog's escalation."
    systemctl --user status "$SERVICE" --no-pager -n 20 2>&1 || true
    journalctl --user -u "$SERVICE" -n 40 --no-pager 2>&1 || true
    exit 1
  fi
  echo "git reset --hard failed; the tree is left as it is."
  exit 1
fi

# ---------------------------------------------------------------------------
# The interactive half: everything that must happen while a terminal still exists.
# ---------------------------------------------------------------------------
command -v git >/dev/null 2>&1 || fail "git not found on PATH."
command -v systemctl >/dev/null 2>&1 || fail "no systemctl - this is the Linux updater; on Windows use windows\\update.ps1."

if ! systemctl --user cat "$SERVICE" >/dev/null 2>&1; then
  fail "there is no '$SERVICE' systemd --user unit. Install termhub first: bash linux/install.sh"
fi

ROLLBACK="$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null)" || fail "could not read HEAD."
say "current HEAD $ROLLBACK"

if [ -n "$(git -C "$PROJECT_DIR" status --porcelain 2>/dev/null)" ]; then
  say "NOTE - the working tree has local changes. git will refuse the pull if they"
  say "conflict with what is incoming; commit or stash them if that happens."
fi

# 1) Pull.
if ! git -C "$PROJECT_DIR" pull --ff-only 2>&1; then
  fail "git pull --ff-only failed (not a fast-forward, or local changes are in the way). Nothing was changed."
fi
NEWHEAD="$(git -C "$PROJECT_DIR" rev-parse HEAD)"
if [ "$NEWHEAD" = "$ROLLBACK" ]; then
  say "already up to date - redeploying anyway to pick up local changes."
else
  say "updated to $NEWHEAD"
  git -C "$PROJECT_DIR" --no-pager log --oneline "$ROLLBACK..$NEWHEAD" 2>/dev/null | head -20 || true
fi

# 2) Dependencies, only when they actually changed.
if deps_changed "$ROLLBACK" "$NEWHEAD"; then install_deps; fi

# 3) The Claude Code CLI. termhub's Claude integration is version-coupled
# (lib/claudeCli.js), so a machine that updates only termhub drifts away from the CLI
# termhub was tested against. Non-fatal: an offline or rate-limited update must not
# abort a termhub update.
if command -v claude >/dev/null 2>&1; then
  say "updating the Claude Code CLI (currently $(claude --version 2>/dev/null | head -1))"
  claude update 2>&1 || say "claude update reported a problem - continuing."
else
  say "claude CLI not on PATH - skipping the CLI update."
fi

# 4) The watchdog. BEFORE the restart, because the restart kills this terminal.
#
# This is the step that makes a machine self-supervising without a second manual
# install: whatever the pull brought, the timer and unit are reconciled with it here.
say "confirming the watchdog installation"
bash "$PROJECT_DIR/watchdog/install-watchdog.sh" --ensure 2>&1 || \
  say "the watchdog could not be installed - termhub will still update; it just won't be watched."

# 5) Restart, detached, so the verify/rollback logic outlives this PTY.
say ""
say "restarting '$SERVICE' now. THIS TERMINAL WILL DIE - that is expected: on Linux"
say "termhub is one process, so every terminal (including this one) ends with the"
say "restart. Reopen termhub in a moment; the result is logged to:"
say "  $UPDATE_LOG"
say ""

if command -v setsid >/dev/null 2>&1; then
  setsid bash "$SCRIPT_DIR/update.sh" --finish "$ROLLBACK" </dev/null >/dev/null 2>&1 &
else
  # No setsid: nohup still detaches from the terminal well enough that SIGHUP on PTY
  # teardown won't take it with us.
  nohup bash "$SCRIPT_DIR/update.sh" --finish "$ROLLBACK" </dev/null >/dev/null 2>&1 &
fi
disown 2>/dev/null || true

# Give the detached child a moment to be scheduled before this shell (and its PTY)
# goes away with the restart it just triggered.
sleep 2
say "handed off to the restart phase - see $UPDATE_LOG"
exit 0

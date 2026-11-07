#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
# Move the LIVE factory from /home/k/software-factory (a checkout of
# xvanov/software-factory) to /home/k/dev-tools/software-factory (this
# monorepo). See docs/CUTOVER.md for the why, the order and the rollback.
#
# USAGE
#   cutover-to-dev-tools.sh --dry-run          # print every action, change nothing
#   cutover-to-dev-tools.sh                    # do it
#   cutover-to-dev-tools.sh --rollback <dir>   # undo, using the backup dir it printed
#
# ENV (defaults are the k-911-x17 layout)
#   OLD_ROOT   /home/k/software-factory
#   NEW_ROOT   /home/k/dev-tools/software-factory
#   UNIT_DIR   ~/.config/systemd/user
#   DRAIN_TIMEOUT_S  600   how long to wait for a running tick to finish
#   ALLOW_IN_PROGRESS=1    skip the "no job in_progress" refusal (not advised)
# ──────────────────────────────────────────────────────────────────
set -euo pipefail

OLD_ROOT="${OLD_ROOT:-/home/k/software-factory}"
NEW_ROOT="${NEW_ROOT:-/home/k/dev-tools/software-factory}"
UNIT_DIR="${UNIT_DIR:-$HOME/.config/systemd/user}"
DRAIN_TIMEOUT_S="${DRAIN_TIMEOUT_S:-600}"
SELF_DEPLOY_UNITS=(factory-self-deploy.timer factory-self-deploy.service factory-self-deploy.service.d)

DRY_RUN=0
MODE=cutover
BACKUP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --rollback) MODE=rollback; BACKUP="${2:-}"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

log()  { echo "[cutover] $*"; }
die()  { echo "[cutover] ERROR: $*" >&2; exit 1; }
# Every change goes through run(): printed under --dry-run, executed otherwise.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] %s\n' "$*"
  else
    log "+ $*"
    "$@"
  fi
}
run_sh() {  # a shell snippet (pipes/redirects), same dry-run rule
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] sh: %s\n' "$1"
  else
    log "+ sh: $1"
    bash -c "$1"
  fi
}
sc() { systemctl --user "$@"; }

factory_timers() {  # enabled/active factory tick timers, one per line
  sc list-units 'factory-tick@*.timer' --all --no-legend --no-pager 2>/dev/null \
    | awk '{print $1}' | grep -E '^factory-tick@.+\.timer$' || true
}

stop_timers_and_drain() {
  local timers="$1"
  for t in $timers; do run sc stop "$t"; done
  run sc stop factory-self-deploy.timer || true
  if [ "$DRY_RUN" = 1 ]; then log "(dry-run) would wait for running factory-tick@*.service to finish"; return 0; fi
  local waited=0
  while sc list-units 'factory-tick@*.service' --state=active --no-legend --no-pager | grep -q .; do
    if [ "$waited" -ge "$DRAIN_TIMEOUT_S" ]; then
      log "a tick is still running after ${DRAIN_TIMEOUT_S}s; restarting the timers and giving up"
      for t in $timers; do sc start "$t" || true; done
      die "tick did not drain; nothing else was changed"
    fi
    sleep 5; waited=$((waited + 5))
  done
  log "no tick running"
}

move_state() {  # move every entry of $1/state into $2/state (except .gitignore)
  local from="$1/state" to="$2/state"
  [ -d "$from" ] || die "$from does not exist"
  run mkdir -p "$to"
  shopt -s dotglob nullglob
  for entry in "$from"/*; do
    local name; name="$(basename "$entry")"
    [ "$name" = ".gitignore" ] && continue
    if [ -e "$to/$name" ]; then
      die "$to/$name already exists; refusing to overwrite (move it aside first)"
    fi
    run mv "$entry" "$to/$name"
  done
  shopt -u dotglob nullglob
}

repair_worktrees() {  # re-point each story worktree's app repo at its new path
  local dir="$1/state/worktrees"
  [ -d "$dir" ] || { log "no state/worktrees"; return 0; }
  for wt in "$dir"/*/; do
    [ -e "$wt/.git" ] || continue
    run git -C "$wt" worktree repair || log "WARN: worktree repair failed for $wt"
  done
}

# ──────────────────────────────────────────────────────────────────
# Rollback
# ──────────────────────────────────────────────────────────────────
if [ "$MODE" = rollback ]; then
  [ -n "$BACKUP" ] && [ -d "$BACKUP" ] || die "--rollback needs the backup dir the cutover printed"
  timers="$(cat "$BACKUP/timers.txt" 2>/dev/null || true)"
  log "rollback from $BACKUP; timers to restore: ${timers:-none}"
  stop_timers_and_drain "$(factory_timers)"
  move_state "$NEW_ROOT" "$OLD_ROOT"
  repair_worktrees "$OLD_ROOT"
  run cp -a "$BACKUP/units/." "$UNIT_DIR/"
  run sc daemon-reload
  run sc enable factory-self-deploy.timer
  run rm -f "$OLD_ROOT/MOVED-TO-DEV-TOOLS.txt"
  for t in $timers; do run sc start "$t"; done
  run sc start factory-self-deploy.timer
  log "rolled back: the live factory runs from $OLD_ROOT again (with the state the new tree wrote)."
  exit 0
fi

# ──────────────────────────────────────────────────────────────────
# Cutover — preflight (read-only)
# ──────────────────────────────────────────────────────────────────
log "OLD_ROOT=$OLD_ROOT"
log "NEW_ROOT=$NEW_ROOT"
[ -d "$OLD_ROOT/factory" ] || die "$OLD_ROOT is not a factory tree"
[ -f "$NEW_ROOT/factory/jobs/tasks.py" ] || die "$NEW_ROOT lacks the v1.2 code: git pull --ff-only in $(dirname "$NEW_ROOT") first"
[ -f "$OLD_ROOT/state/factory.db" ] || die "no $OLD_ROOT/state/factory.db (already moved?)"
[ ! -f "$NEW_ROOT/state/factory.db" ] || die "$NEW_ROOT/state/factory.db already exists (already cut over?)"
if [ -n "$(git -C "$NEW_ROOT" status --porcelain -- . 2>/dev/null)" ]; then
  die "$NEW_ROOT has local changes; the new tree must equal the pulled main"
fi
grep -Eq '^self_tick_enabled:[[:space:]]*false' "$NEW_ROOT/apps/factory/config.yaml" \
  || die "apps/factory/config.yaml in the new tree must have self_tick_enabled: false (see CUTOVER.md)"
command -v rsync >/dev/null || die "rsync is required"
[ -x "$(command -v uv)" ] || die "uv is not on PATH"

log "checking for jobs in progress (old tree, local view)…"
jobs_json="$(cd "$OLD_ROOT" && uv run factory job list --json --active --no-github 2>/dev/null || true)"
busy="$(printf '%s' "$jobs_json" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("UNREADABLE"); sys.exit(0)
print(" ".join(j["job_id"] for j in d.get("jobs", []) if j.get("state") == "in_progress"))
')"
if [ "$busy" = "UNREADABLE" ]; then
  die "could not read 'factory job list' in the old tree"
elif [ -n "$busy" ] && [ "${ALLOW_IN_PROGRESS:-0}" != 1 ]; then
  die "jobs in progress: $busy — wait for them (or cancel them) and re-run"
fi

log "checking for live stories of the factory's self-edit app…"
live_factory_stories() {
  cd "$OLD_ROOT" && uv run python - 2>/dev/null <<'PY'
import sqlite3
from factory.chain.state_machine import StoryState, is_terminal
con = sqlite3.connect("file:state/factory.db?mode=ro", uri=True)
live = []
for sid, state in con.execute("SELECT id, state FROM stories WHERE app = 'factory'"):
    try:
        if not is_terminal(StoryState(state)) or state == "ci_pending":
            live.append(f"{sid}:{state}")
    except ValueError:
        live.append(f"{sid}:{state}")
print(" ".join(live))
PY
}
live_factory="$(live_factory_stories)" || live_factory="UNREADABLE"
[ "$live_factory" = "UNREADABLE" ] && die "could not read the stories table"
[ -z "$live_factory" ] || die "apps/factory has live stories ($live_factory); they would open PRs against xvanov/software-factory — cancel or finish them first"

timers="$(factory_timers)"
log "factory timers to restart afterwards: ${timers:-none}"
other_units="$(grep -l "$OLD_ROOT" "$UNIT_DIR"/* "$UNIT_DIR"/*/* 2>/dev/null | grep -v -E 'factory-tick@\.service$|factory-self-deploy' || true)"
[ -z "$other_units" ] || log "WARN: other units mention $OLD_ROOT and are NOT changed: $other_units"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="$HOME/.factory-cutover-backup-$STAMP"
log "backup dir: $BACKUP"

# ──────────────────────────────────────────────────────────────────
# Cutover — act
# ──────────────────────────────────────────────────────────────────
# 1. Stop the timers and let a running tick finish.
stop_timers_and_drain "$timers"

# 2. Back up the unit files we change or remove, and the timer list.
run mkdir -p "$BACKUP/units"
run_sh "printf '%s\n' $(printf '%q ' $timers) > '$BACKUP/timers.txt'"
for u in factory-tick@.service factory-tick@.service.d "${SELF_DEPLOY_UNITS[@]}"; do
  if [ -e "$UNIT_DIR/$u" ]; then run cp -a "$UNIT_DIR/$u" "$BACKUP/units/"; fi
done

# 3. Self-deploy is retired: it synced from xvanov/software-factory origin/main,
#    which is no longer the source of truth. Remove its units so `factory on`
#    (which starts every INSTALLED factory unit) cannot bring it back.
run sc disable --now factory-self-deploy.timer || true
for u in "${SELF_DEPLOY_UNITS[@]}"; do
  if [ -e "$UNIT_DIR/$u" ]; then run rm -rf "$UNIT_DIR/$u"; fi
done

# 4. Move the runtime state (db, events, logs, locks, worktrees, …).
move_state "$OLD_ROOT" "$NEW_ROOT"
repair_worktrees "$NEW_ROOT"

# 5. Carry over untracked app dirs/files (other apps' configs, untracked
#    directions, state.yaml, story files). Tracked files in the new tree win.
run rsync -a --ignore-existing "$OLD_ROOT/apps/" "$NEW_ROOT/apps/"

# 6. Pin every app's repo path to an absolute path resolved against the OLD
#    root: the default/relative "../<name>" would otherwise resolve to
#    /home/k/dev-tools/<name>. apps/factory keeps "." (it is paused).
for cfg in "$NEW_ROOT"/apps/*/config.yaml; do
  app="$(basename "$(dirname "$cfg")")"
  [ "$app" = factory ] && continue
  raw="$(sed -n -E 's/^app_repo_path:[[:space:]]*"?([^"#]*[^"#[:space:]])"?.*/\1/p' "$cfg" | head -1)"
  [ -n "$raw" ] || raw="../$app"
  case "$raw" in
    /*) continue ;;
  esac
  abs="$(cd "$OLD_ROOT" && realpath -m "$raw")"
  if grep -qE '^app_repo_path:' "$cfg"; then
    run sed -i -E "s#^app_repo_path:.*#app_repo_path: $abs  \# pinned by cutover-to-dev-tools.sh (was $raw)#" "$cfg"
  else
    run_sh "printf '\napp_repo_path: %s  # pinned by cutover-to-dev-tools.sh (was the ../%s default)\n' '$abs' '$app' >> '$cfg'"
  fi
done

# 7. .env (provider keys) — never overwrite one that exists.
if [ -f "$NEW_ROOT/.env" ]; then
  log "WARN: $NEW_ROOT/.env exists; left as is (compare it with $OLD_ROOT/.env)"
else
  run cp -p "$OLD_ROOT/.env" "$NEW_ROOT/.env"
  run chmod 600 "$NEW_ROOT/.env"
fi
# The termhub link a human opens for a claude_session run.
if ! grep -q '^FACTORY_TERMHUB_PUBLIC_URL=' "$OLD_ROOT/.env" 2>/dev/null; then
  ts_ip="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  secure=""
  [ -n "$ts_ip" ] && secure="$(curl -s --max-time 5 "http://$ts_ip:7000/api/secure-url" \
    | python3 -c 'import json,sys; print((json.load(sys.stdin) or {}).get("secureUrl") or "")' 2>/dev/null || true)"
  if [ -n "$secure" ]; then
    run_sh "printf '\n# claude_session runs: the termhub origin a human opens (cutover %s)\nFACTORY_TERMHUB_PUBLIC_URL=%s\n' '$STAMP' '${secure%/}' >> '$NEW_ROOT/.env'"
  else
    log "WARN: could not find termhub's secure URL; set FACTORY_TERMHUB_PUBLIC_URL in $NEW_ROOT/.env"
  fi
fi

# 8. Agent memory for loop-3 sessions (keyed on the working directory).
OLD_MEM="$HOME/.claude/projects/-home-k-software-factory/memory"
NEW_MEM="$HOME/.claude/projects/$(echo "$NEW_ROOT" | tr '/' '-')/memory"
if [ -d "$OLD_MEM" ] && [ ! -e "$NEW_MEM" ]; then
  run mkdir -p "$(dirname "$NEW_MEM")"
  run cp -a "$OLD_MEM" "$NEW_MEM"
fi

# 9. Environment + smoke test of the new tree.
run_sh "cd '$NEW_ROOT' && uv sync -q --all-extras"
run_sh "cd '$NEW_ROOT' && uv run factory job list --json --no-github | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d[\"jobs\"]), \"jobs visible from the new tree\")'"

# 10. Repoint the tick units and restart.
run sed -i -E "s#^WorkingDirectory=.*#WorkingDirectory=$NEW_ROOT#" "$UNIT_DIR/factory-tick@.service"
run sc daemon-reload
for t in $timers; do run sc start "$t"; done
run_sh "printf 'The live factory moved to %s on %s.\nRollback: %s/scripts/cutover-to-dev-tools.sh --rollback %s\n' '$NEW_ROOT' '$STAMP' '$NEW_ROOT' '$BACKUP' > '$OLD_ROOT/MOVED-TO-DEV-TOOLS.txt'"

log "done. Backup: $BACKUP"
log "rollback: $NEW_ROOT/scripts/cutover-to-dev-tools.sh --rollback $BACKUP"
log "next: point the personal assistant's PA_FACTORY_PATH at $NEW_ROOT (see docs/CUTOVER.md)"

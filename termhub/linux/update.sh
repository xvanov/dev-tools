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
# "Detached" here means detached from the CGROUP, not just from the terminal — see
# the launch of `--finish` near the bottom of this file. `setsid` is not enough, and
# the difference is invisible until the day the update is the one that needed
# rolling back.
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
  discard_lock_churn
}

# `npm install` rewrites package-lock.json into whatever shape the LOCAL npm
# prefers, even when nothing about the installed tree changed: npm 11.6.2 records
# `"peer": true` on @xterm/xterm, 11.12.1 does not. Machines on different npm
# versions therefore dirty the file back and forth forever, and a dirty tree is
# exactly what the next `git pull --ff-only` refuses to run against - so the update
# that installed the deps is the one that blocks the update after it.
#
# The lockfile is authoritative and node_modules is derived from it, so the rewrite
# carries no information worth keeping. Throw it away.
discard_lock_churn() {
  git -C "$PROJECT_DIR" checkout -- package-lock.json 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Self-healing a diverged branch.
#
# A `git pull --ff-only` that refuses is one of two very different situations, and
# only one of them is a human's problem.
#
# THE ONE THAT ISN'T: upstream history was rewritten and force-pushed from another
# machine — a rebase, an amend, a corrected author email. Every commit this machine
# already pulled now has a patch-identical twin upstream under a different sha, git
# reports "diverged", and --ff-only refuses, on a machine that has contributed
# nothing of its own. Nothing here is salvage-worthy and nothing is at risk, but the
# refusal is permanent: the machine can never update again, and since it is wedged
# it never becomes a machine anyone force-pushes FROM either, so the wedge is silent
# until someone opens a terminal on it. That is the case worth healing automatically,
# because the alternative is a fleet that quietly stops taking updates.
#
# THE ONE THAT IS: there are local commits with no upstream equivalent (real work
# that was never pushed), or the tree is dirty. Both would be destroyed by the reset,
# so both stop here and say exactly what was found.
#
# `git log --cherry-pick --right-only <upstream>...HEAD` is precisely the question to
# ask: list local commits whose patch does NOT appear upstream. Empty means the local
# lineage is a duplicate under different shas, and resetting onto upstream loses
# nothing. It compares patch-ids, so it sees through the rewritten shas, dates and
# author lines that made the histories look unrelated in the first place.
# ---------------------------------------------------------------------------

# What is this branch tracking? Falls back to origin/<branch> when no upstream is
# configured — an install made by `git clone` always has one, but a checkout that
# lost its config should still be able to heal rather than being told it can't.
upstream_ref() {
  local u branch
  u="$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  if [ -n "$u" ]; then printf '%s\n' "$u"; return 0; fi
  branch="$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  [ -n "$branch" ] && [ "$branch" != "HEAD" ] && printf 'origin/%s\n' "$branch"
}

# 0 = healed, HEAD now equals upstream and the caller should carry on updating.
# 1 = not healed, and the reason has already been printed. Never destroys anything
#     it has not first proven to be a duplicate.
heal_diverged_history() {
  local up counts behind ahead unique before

  up="$(upstream_ref)"
  if [ -z "$up" ]; then
    say "no upstream branch is configured, so there is nothing to reset onto."
    return 1
  fi

  # Dirty first: it needs no network, and a dirty tree disqualifies the heal outright.
  if [ -n "$(git -C "$PROJECT_DIR" status --porcelain 2>/dev/null)" ]; then
    say "the working tree has local changes, which is enough on its own to make the"
    say "pull fail. Commit or stash them, then update again."
    return 1
  fi

  # The pull's own fetch may be what failed. Redo it explicitly so that an offline or
  # unauthenticated machine is diagnosed as offline instead of being compared against
  # a stale upstream ref and told a story about its history.
  if ! git -C "$PROJECT_DIR" fetch --quiet 2>&1; then
    say "could not fetch from the remote - the pull probably failed for that reason"
    say "(no network, or credentials), not because of anything in this checkout."
    return 1
  fi

  # left = upstream-only (behind), right = HEAD-only (ahead). Only a genuine
  # divergence (both non-zero) is in scope; anything else reaching here means the
  # pull failed for a reason this function cannot see, and guessing would be worse
  # than reporting.
  counts="$(git -C "$PROJECT_DIR" rev-list --left-right --count "$up...HEAD" 2>/dev/null || true)"
  behind="$(printf '%s' "$counts" | awk '{print $1+0}')"
  ahead="$(printf '%s' "$counts" | awk '{print $2+0}')"
  if [ -z "$counts" ] || [ "$ahead" -eq 0 ] || [ "$behind" -eq 0 ]; then
    say "HEAD is not diverged from $up (behind ${behind:-?}, ahead ${ahead:-?}), so the"
    say "pull failed for some other reason - check its output above."
    return 1
  fi

  unique="$(git -C "$PROJECT_DIR" log --cherry-pick --right-only --oneline "$up...HEAD" 2>/dev/null || true)"
  if [ -n "$unique" ]; then
    say "history diverged from $up AND these local commits exist nowhere upstream:"
    printf '%s\n' "$unique" | sed 's/^/termhub update:     /'
    say "resetting would destroy them, so nothing was changed. Push them (or drop"
    say "them deliberately), then update again."
    return 1
  fi

  before="$(git -C "$PROJECT_DIR" rev-parse --short HEAD)"
  say "history diverged from $up ($behind upstream, $ahead local), but every local"
  say "commit already exists upstream as an equivalent patch - upstream was rewritten"
  say "and force-pushed from elsewhere. Resetting onto $up; no local work is lost."

  # Keep the pre-reset lineage reachable, for two reasons and the second is
  # load-bearing: a human can still inspect exactly what was here, AND $ROLLBACK -
  # the commit the restart phase would roll back to - stays a referenced object
  # instead of becoming unreachable and collectable partway through the update that
  # might need it. Force, so these do not accumulate one per heal.
  git -C "$PROJECT_DIR" branch --force termhub-pre-reset HEAD >/dev/null 2>&1 || true

  if ! git -C "$PROJECT_DIR" reset --hard "$up" 2>&1; then
    say "the reset onto $up failed; the checkout is exactly as it was."
    return 1
  fi
  say "was $before, now $(git -C "$PROJECT_DIR" rev-parse --short HEAD) - the previous lineage is kept on"
  say "branch 'termhub-pre-reset' if you want to look at it."
  return 0
}

# --heal: the divergence check and nothing else. Exists so the logic is reachable
# without triggering an update (a human on a wedged machine, and the tests), and it
# deliberately needs no systemd unit.
if [ "${1:-}" = "--heal" ]; then
  command -v git >/dev/null 2>&1 || fail "git not found on PATH."
  heal_diverged_history || exit 1
  exit 0
fi

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
  say "git pull --ff-only refused - working out whether that is safe to fix here."
  heal_diverged_history \
    || fail "git pull --ff-only failed and could not be safely resolved. Nothing was changed."
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

# The detach has to escape the CGROUP, not just the terminal — and `setsid` does
# not do that.
#
# termhub is a systemd --user service with the default `KillMode=control-group`,
# so `systemctl --user restart termhub` SIGTERMs *every process in the unit's
# cgroup*. This script runs in a termhub PTY, which is a child of `server.js`
# and therefore inside that cgroup; a forked child inherits it. `setsid` gives
# the child a new session and process group and leaves its cgroup exactly where
# it was — so the old `setsid`/`nohup` detach put the verify-and-rollback phase
# in the very cgroup it was about to tell systemd to kill, and it died on its own
# `systemctl restart` line. systemd still completed the restart (it is the
# manager doing the work, not the killed client), so an update that WORKED looked
# fine — and an update that broke the build silently lost its rollback, its
# health check and its log output. The safety net only failed when it was needed.
#
# Measured with an isolated transient unit: the setsid child got its own session
# (sid == pid) and stayed in `/user.slice/…/<unit>.service`, and was killed with
# the cgroup on `systemctl --user stop`.
#
# `systemd-run --user` places the phase in a transient unit *of its own*, which
# is out of termhub's cgroup and so out of reach of the kill. `--collect` cleans
# the unit up afterwards so these don't accumulate one per update.
FINISH_UNIT="termhub-update-$(date +%Y%m%d-%H%M%S)-$$"
if command -v systemd-run >/dev/null 2>&1 \
   && systemd-run --user --unit="$FINISH_UNIT" --collect --quiet \
        --description="termhub update: verify and roll back" \
        bash "$SCRIPT_DIR/update.sh" --finish "$ROLLBACK" 2>/dev/null; then
  say "restart phase running as user unit $FINISH_UNIT"
else
  # No systemd-run, or it refused. Fall back to the old behaviour rather than
  # abandoning the update: on a machine whose termhub is NOT under a systemd unit
  # with control-group kill (a hand-started server.js, a container), setsid is
  # genuinely enough, and where it isn't, this is no worse than what it replaced.
  say "systemd-run unavailable - falling back to setsid (the verify phase may not"
  say "survive the restart; check '$UPDATE_LOG' and 'systemctl --user status $SERVICE')"
  if command -v setsid >/dev/null 2>&1; then
    setsid bash "$SCRIPT_DIR/update.sh" --finish "$ROLLBACK" </dev/null >/dev/null 2>&1 &
  else
    nohup bash "$SCRIPT_DIR/update.sh" --finish "$ROLLBACK" </dev/null >/dev/null 2>&1 &
  fi
  disown 2>/dev/null || true
fi

# Give the detached child a moment to be scheduled before this shell (and its PTY)
# goes away with the restart it just triggered.
sleep 2
say "handed off to the restart phase - see $UPDATE_LOG"
exit 0

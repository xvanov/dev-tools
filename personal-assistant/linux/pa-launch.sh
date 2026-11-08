#!/bin/sh
# Starts the personal assistant's supervisor: what the pa-worker user unit runs.
#
# PA_RUNTIME (environment, else personal-assistant/.env, else the repo's .env) picks it:
#   node (default), bun   node src/supervisor (bun: its generations run under Bun)
#   jarvisd               the compiled jarvisd: <jarvisd/dist/current>, else jarvisd/dist/jarvisd,
#                         run as `supervise` - no Node involved (plan 4.4)
# A jarvisd setting with no executable built falls back to Node, saying so, so the dashboard
# still comes up. Switching, or rolling a switch back, is: change PA_RUNTIME, restart the unit
# (linux/redeploy.sh does that when the running supervisor's runtime differs from the setting).
#
# Read on every start, and `exec`ed, so systemd supervises the supervisor itself and a restart
# after a deploy that built a new jarvisd runs the new one. --dry-run prints the command.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PA_DIR="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$PA_DIR/.." && pwd)"
if [ -n "${PA_LAUNCH_ROOT:-}" ]; then REPO="$PA_LAUNCH_ROOT"; PA_DIR="$REPO/personal-assistant"; fi

setting() {  # name -> value from the environment, else the .env files
  eval "v=\${$1:-}"
  if [ -n "$v" ]; then printf '%s' "$v"; return; fi
  for f in "$PA_DIR/.env" "$REPO/.env"; do
    [ -f "$f" ] || continue
    v="$(sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*[\"']\{0,1\}\([^\"'#]*\).*/\1/p" "$f" | head -1 | tr -d '[:space:]')"
    if [ -n "$v" ]; then printf '%s' "$v"; return; fi
  done
}

# The unit passes the node it was installed with (PA_NODE): systemd's PATH may not have it.
NODE="${PA_NODE:-$(command -v node || echo node)}"
RUNTIME="$(setting PA_RUNTIME)"
CMD=""
if [ "$RUNTIME" = jarvisd ]; then
  DIST="$REPO/jarvisd/dist"
  if [ -f "$DIST/current" ]; then
    NAME="$(head -1 "$DIST/current" | tr -d '[:space:]')"
    [ -n "$NAME" ] && [ -x "$DIST/$NAME" ] && CMD="$DIST/$NAME"
  fi
  [ -z "$CMD" ] && [ -x "$DIST/jarvisd" ] && CMD="$DIST/jarvisd"
  if [ -z "$CMD" ]; then
    echo "pa-launch: PA_RUNTIME=jarvisd but no jarvisd executable in $DIST (node scripts/build.js --only jarvisd) - starting the Node supervisor instead" >&2
  fi
fi

if [ "${1:-}" = --dry-run ]; then
  if [ -n "$CMD" ]; then echo "runtime=jarvisd cwd=$PA_DIR command=$CMD supervise"
  else echo "runtime=${RUNTIME:-node} cwd=$PA_DIR command=$NODE src/supervisor"; fi
  exit 0
fi
cd "$PA_DIR" || exit 1
if [ -n "$CMD" ]; then exec "$CMD" supervise; fi
exec "$NODE" src/supervisor

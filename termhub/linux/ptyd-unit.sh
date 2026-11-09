#!/usr/bin/env bash
# ptyd as a systemd --user unit (plan 5.1 / Exit 5). Called by install.sh and
# update.sh; safe to run any time.
#
#   bash linux/ptyd-unit.sh --ensure   install + start the unit. ptyd is the only
#                                      PTY host (lib/ptyHost.js). TERMHUB_PTYD=0 or
#                                      ptyHost=node-pty is an error.
#   bash linux/ptyd-unit.sh --remove   stop, disable and delete it. ENDS its
#                                      terminals. Not a rollback: node-pty is gone.
#   bash linux/ptyd-unit.sh --restart  restart ptyd onto the installed copy. ENDS
#                                      EVERY TERMINAL IN IT; only on purpose.
#   --dry-run (after the action)       print what would happen; change nothing
#
# --ensure also builds ptyd when its sources are newer than the build (cargo
# on PATH) and installs the build for ptyd's next start (node lib/ptyHost.js
# install: <dataDir>/bin/ptyd-<hash>, so a build never writes over the running
# binary, which Linux refuses with ETXTBSY). The unit runs the installed copy.
#
# It never restarts a running ptyd: that would end every terminal in it.
# termhub.service gets a drop-in (Wants/After) so at boot ptyd is up before
# termhub looks for it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO="$(cd "$DIR/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT=termhub-ptyd.service
DROPIN_DIR="$UNIT_DIR/termhub.service.d"
PORT="${TERMHUB_PTYD_PORT:-7020}"
ACTION="${1:---ensure}"
DRY=""
[[ "${2:-}" == --dry-run || "${1:-}" == --dry-run ]] && DRY=1
[[ "$ACTION" == --dry-run ]] && ACTION=--ensure

case "$ACTION" in
  --remove)
    if [[ -n "$DRY" ]]; then echo "ptyd --remove --dry-run: would stop, disable and delete $UNIT (its terminals end)"; exit 0; fi
    systemctl --user disable --now "$UNIT" >/dev/null 2>&1 || true
    rm -f "$UNIT_DIR/$UNIT" "$DROPIN_DIR/ptyd.conf"
    systemctl --user daemon-reload
    echo "ptyd: unit removed"
    exit 0
    ;;
  --restart)
    if [[ -n "$DRY" ]]; then echo "ptyd --restart --dry-run: would restart $UNIT onto $(sed -n 's/^ExecStart=\([^ ]*\).*/\1/p' "$UNIT_DIR/$UNIT" 2>/dev/null || echo '?') (its terminals end)"; exit 0; fi
    systemctl --user restart "$UNIT"
    echo "ptyd: $UNIT restarted"
    exit 0
    ;;
  --ensure) ;;
  *) echo "usage: $0 [--ensure|--restart|--remove] [--dry-run]" >&2; exit 2 ;;
esac

# Ask termhub's own resolver, so this script and sessiond can never disagree.
plan() {
  (cd "$DIR" && node -e "
    const h = require('./lib/ptyHost');
    const r = h.plan();
    if (r.error) { console.error(r.error); process.exit(2); }
    process.stdout.write(['ptyd', r.bin || '', r.reason, h.buildBinary() || ''].join('\t'));
  ")
}
if ! decision="$(plan)"; then
  echo "ptyd: required, but the host setting was refused (node-pty was retired)" >&2
  exit 1
fi
host="$(printf '%s' "$decision" | cut -f1)"
reason="$(printf '%s' "$decision" | cut -f3)"
build="$(printf '%s' "$decision" | cut -f4)"

if [[ "$host" != ptyd ]]; then
  echo "ptyd: required ($reason). node-pty was retired; there is no other host." >&2
  exit 1
fi

# Build when a ptyd source is newer than the build (or there is none).
stale=1
if [[ -n "$build" ]] && [[ -z "$(find "$REPO/ptyd/src" "$REPO/ptyd/Cargo.toml" "$REPO/ptyd/Cargo.lock" -newer "$build" -print -quit 2>/dev/null)" ]]; then stale=""; fi
if [[ -n "$stale" ]]; then
  if ! command -v cargo >/dev/null 2>&1; then
    echo "ptyd: the build is missing or older than its sources, and cargo is not on PATH; using what is there"
  elif [[ -n "$DRY" ]]; then
    echo "ptyd: would build it (node scripts/build.js --only ptyd)"
  else
    echo "ptyd: building (node scripts/build.js --only ptyd) ..."
    node "$REPO/scripts/build.js" --only ptyd || { echo "ptyd: the build failed; the installed copy is unchanged" >&2; exit 1; }
  fi
fi
if [[ -n "$DRY" ]]; then
  [[ -n "$build" ]] && (cd "$DIR" && node lib/ptyHost.js install --dry-run)
else
  (cd "$DIR" && node lib/ptyHost.js install) || { echo "ptyd: install failed" >&2; exit 1; }
fi
bin="$(plan | cut -f2)"
if [[ -z "$DRY" && ( -z "$bin" || ! -x "$bin" ) ]]; then
  echo "ptyd: ptyd is wanted but no release binary found; build it: node scripts/build.js --only ptyd" >&2
  exit 1
fi
if [[ -n "$DRY" ]]; then
  echo "ptyd: would point $UNIT at the installed copy and enable it (a running ptyd is not restarted; $reason)"
  exit 0
fi

mkdir -p "$UNIT_DIR" "$DROPIN_DIR"
sed -e "s#__PTYD__#$bin#g" -e "s#__PORT__#$PORT#g" "$SCRIPT_DIR/$UNIT" > "$UNIT_DIR/$UNIT.new"
if ! cmp -s "$UNIT_DIR/$UNIT.new" "$UNIT_DIR/$UNIT" 2>/dev/null; then
  mv "$UNIT_DIR/$UNIT.new" "$UNIT_DIR/$UNIT"
  echo "ptyd: wrote $UNIT_DIR/$UNIT ($bin)"
else
  rm -f "$UNIT_DIR/$UNIT.new"
fi
printf '[Unit]\nWants=%s\nAfter=%s\n' "$UNIT" "$UNIT" > "$DROPIN_DIR/ptyd.conf"
systemctl --user daemon-reload
# enable --now starts a stopped unit and leaves a running one alone.
systemctl --user enable --now "$UNIT" >/dev/null
echo "ptyd: $UNIT enabled and running on 127.0.0.1:$PORT ($reason)"

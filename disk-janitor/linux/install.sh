#!/usr/bin/env bash
# disk-janitor installer (Ubuntu / Debian) — installs a systemd *user* timer
# that runs disk_janitor.py once a day. Run from anywhere:  ./linux/install.sh
#
#   ./linux/install.sh            # active cleanup
#   ./linux/install.sh --dry-run  # report-only (deletes nothing)
#   ./linux/install.sh --uninstall
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="$(cd "$SCRIPT_DIR/.." && pwd)"            # disk-janitor project root
UNIT_DIR="$HOME/.config/systemd/user"

ARGS=""
UNINSTALL=0
for a in "$@"; do
  case "$a" in
    --dry-run|--report) ARGS="--dry-run" ;;
    --uninstall)        UNINSTALL=1 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

if [[ "$UNINSTALL" == "1" ]]; then
  systemctl --user disable --now disk-janitor.timer >/dev/null 2>&1 || true
  rm -f "$UNIT_DIR/disk-janitor.timer" "$UNIT_DIR/disk-janitor.service"
  systemctl --user daemon-reload
  echo "disk-janitor uninstalled (log kept at ~/.disk-janitor/janitor.log)."
  exit 0
fi

PYTHON="$(command -v python3 || true)"
[[ -n "$PYTHON" ]] || { echo "ERROR: python3 not found. Install it first." >&2; exit 1; }
echo "disk-janitor: python = $PYTHON ($("$PYTHON" --version 2>&1))"
echo "disk-janitor: dir    = $DIR"

mkdir -p "$UNIT_DIR"

sed -e "s#__PYTHON__#$PYTHON#g" -e "s#__DIR__#$DIR#g" -e "s#__ARGS__#$ARGS#g" \
  "$SCRIPT_DIR/disk-janitor.service" > "$UNIT_DIR/disk-janitor.service"
cp "$SCRIPT_DIR/disk-janitor.timer" "$UNIT_DIR/disk-janitor.timer"
echo "disk-janitor: wrote unit files to $UNIT_DIR"

systemctl --user daemon-reload
systemctl --user enable --now disk-janitor.timer

# Keep the timer firing even when the user is logged out.
loginctl enable-linger "$USER" >/dev/null 2>&1 || \
  echo "NOTE: run 'sudo loginctl enable-linger $USER' so it runs while logged out."

MODE="active cleanup"; [[ -n "$ARGS" ]] && MODE="DRY-RUN (report only)"
echo
echo "Done - $MODE. Next runs:"
systemctl --user list-timers disk-janitor.timer --no-pager 2>/dev/null || true
echo
echo "Run once now:  $PYTHON $DIR/disk_janitor.py $ARGS"
echo "Log:           ~/.disk-janitor/janitor.log"
echo "Remove:        ./linux/install.sh --uninstall"

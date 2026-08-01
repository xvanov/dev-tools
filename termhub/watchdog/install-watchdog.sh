#!/usr/bin/env bash
# Install / ensure / remove the termhub watchdog systemd --user timer (Linux).
#
#   watchdog/install-watchdog.sh                  # install or update, every 2 min
#   watchdog/install-watchdog.sh --interval 5min
#   watchdog/install-watchdog.sh --ensure         # idempotent, quiet unless it changed something
#   watchdog/install-watchdog.sh --uninstall
#
# --ensure is what linux/update.sh and termhub's own startup call. It is the Linux
# half of Confirm-WatchdogTask in watchdog/lib/task.ps1 and behaves the same way:
# the healthy path prints nothing, and it repairs the three ways the *installation*
# (as opposed to the watchdog's code) can be wrong — missing, disabled, or pointing at
# a checkout that has moved.
#
# It never needs to "restart the watchdog" to pick up new code: the timer runs
# `bash watchdog/watchdog.sh` fresh every tick, reading the script off disk, so a git
# pull is live on the next tick. Only the UNIT FILES can go stale, which is why they
# are compared by content below.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
TEMPLATE_DIR="$PROJECT_DIR/linux"

INTERVAL="2min"
ENSURE=0
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --interval)  INTERVAL="$2"; shift ;;
    --ensure)    ENSURE=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "install-watchdog: unknown argument '$1'" >&2; exit 2 ;;
  esac
  shift
done

say()  { echo "watchdog: $*"; }
# Under --ensure, only speak when something actually changed or is wrong. A message
# on every update and every service start is how a real warning gets ignored.
note() { [ "$ENSURE" -eq 1 ] || echo "watchdog: $*"; }

if ! command -v systemctl >/dev/null 2>&1; then
  [ "$ENSURE" -eq 1 ] && exit 0
  echo "watchdog: no systemctl on this machine - nothing to install." >&2
  exit 1
fi

if [ "$UNINSTALL" -eq 1 ]; then
  systemctl --user disable --now termhub-watchdog.timer 2>/dev/null || true
  rm -f "$UNIT_DIR/termhub-watchdog.timer" "$UNIT_DIR/termhub-watchdog.service"
  systemctl --user daemon-reload 2>/dev/null || true
  say "removed the watchdog timer. termhub itself keeps running."
  exit 0
fi

if [ ! -f "$SCRIPT_DIR/watchdog.sh" ]; then
  [ "$ENSURE" -eq 1 ] && exit 0
  echo "watchdog: watchdog.sh not found in $SCRIPT_DIR" >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"

# Render the templates. __DIR__ is baked in absolutely: a --user unit has no useful
# cwd, and a relative path breaks the moment the checkout moves.
render() {   # template -> stdout
  sed -e "s|__DIR__|$PROJECT_DIR|g" -e "s|__INTERVAL__|$INTERVAL|g" "$1"
}

changed=0
for unit in termhub-watchdog.service termhub-watchdog.timer; do
  src="$TEMPLATE_DIR/$unit"
  dst="$UNIT_DIR/$unit"
  if [ ! -f "$src" ]; then
    echo "watchdog: missing template $src" >&2
    exit 1
  fi
  new="$(render "$src")"
  # Compare content, not timestamps: this runs on every update, and rewriting
  # identical files would churn systemd's state for nothing. Content differing is
  # also how a moved checkout is detected — __DIR__ no longer matches.
  if [ -f "$dst" ] && [ "$new" = "$(cat "$dst")" ]; then
    continue
  fi
  printf '%s\n' "$new" >"$dst"
  changed=1
  say "wrote $dst"
done

if [ "$changed" -eq 1 ]; then
  systemctl --user daemon-reload 2>/dev/null || true
fi

# Enable if not enabled; start if not active. Both are separately possible: a timer
# can be enabled-but-not-running after a daemon-reload, and running-but-not-enabled
# after somebody started it by hand, which then does not survive a reboot.
enabled_state="$(systemctl --user is-enabled termhub-watchdog.timer 2>/dev/null || true)"
active_state="$(systemctl --user is-active termhub-watchdog.timer 2>/dev/null || true)"

if [ "$enabled_state" != "enabled" ] || [ "$active_state" != "active" ]; then
  if systemctl --user enable --now termhub-watchdog.timer 2>&1; then
    say "enabled and started termhub-watchdog.timer (every $INTERVAL, and 1min after boot)"
    changed=1
  else
    echo "watchdog: could not enable the timer. termhub is unaffected; it just isn't watched." >&2
    echo "watchdog: try:  systemctl --user enable --now termhub-watchdog.timer" >&2
    exit 1
  fi
elif [ "$changed" -eq 1 ]; then
  systemctl --user restart termhub-watchdog.timer 2>/dev/null || true
  say "timer updated and reloaded"
fi

# A --user timer dies with the user's session unless lingering is on, which is the
# difference between a headless box being watched after a reboot and not. Worth
# saying every time it is missing, because the failure is invisible until a reboot.
if command -v loginctl >/dev/null 2>&1; then
  if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
    echo "watchdog: NOTE - lingering is OFF for $USER, so --user units (termhub AND this" >&2
    echo "watchdog: watchdog) stop when you log out and do not come back until you log in:" >&2
    echo "watchdog:   sudo loginctl enable-linger $USER" >&2
  fi
fi

# The kill switch is a deliberate act, so never remove it here - but a machine that
# has been silently unwatched since somebody debugged something should say so.
DATA_DIR="${TERMHUB_DATA_DIR:-$HOME/.local/termhub}"
if [ -f "$DATA_DIR/watchdog/DISABLED" ]; then
  echo "watchdog: NOTE - the kill switch is present, so the watchdog does nothing:" >&2
  echo "watchdog:   $DATA_DIR/watchdog/DISABLED  (delete it to resume watching)" >&2
fi

if [ "$ENSURE" -eq 1 ]; then
  [ "$changed" -eq 1 ] && say "watchdog installation confirmed"
  exit 0
fi

echo
say "installed. Next tick runs: bash $SCRIPT_DIR/watchdog.sh"
say "log:   ${DATA_DIR}/watchdog/watchdog.log"
echo
echo "  systemctl --user list-timers termhub-watchdog.timer"
echo "  systemctl --user start termhub-watchdog.service     # run a cycle now"
echo "  $SCRIPT_DIR/watchdog.sh --probe                     # report, change nothing"
echo "  $SCRIPT_DIR/watchdog.sh --test-claude               # is escalation armed?"
echo "  touch ${DATA_DIR}/watchdog/DISABLED                 # kill switch"
echo

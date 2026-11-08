#!/usr/bin/env bash
# ptyd as a systemd --user unit (plan 5.1 / Exit 5). Called by install.sh and
# update.sh; safe to run any time.
#
#   bash linux/ptyd-unit.sh --ensure   install + start the unit when termhub will
#                                      use ptyd (lib/ptyHost.js says so: a release
#                                      ptyHost=ptyd, or opt-in ptyHost=auto with a
#                                      release binary; the default node-pty never);
#                                      otherwise leave everything as it is
#   bash linux/ptyd-unit.sh --remove   stop, disable and delete it (after a
#                                      rollback to node-pty; ends ptyd's terminals)
#
# It never restarts a running ptyd: that would end every terminal in it.
# termhub.service gets a drop-in (Wants/After) so at boot ptyd is up before
# termhub looks for it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT=termhub-ptyd.service
DROPIN_DIR="$UNIT_DIR/termhub.service.d"
PORT="${TERMHUB_PTYD_PORT:-7020}"

case "${1:---ensure}" in
  --remove)
    systemctl --user disable --now "$UNIT" >/dev/null 2>&1 || true
    rm -f "$UNIT_DIR/$UNIT" "$DROPIN_DIR/ptyd.conf"
    systemctl --user daemon-reload
    echo "ptyd: unit removed"
    exit 0
    ;;
  --ensure) ;;
  *) echo "usage: $0 [--ensure|--remove]" >&2; exit 2 ;;
esac

# Ask termhub's own resolver, so this script and sessiond can never disagree.
decision="$(cd "$DIR" && node -e "
  const h = require('./lib/ptyHost');
  const r = h.resolve({ envValue: process.env.TERMHUB_PTYD, mode: h.readMode(), bin: h.releaseBinary() });
  process.stdout.write((r.ptyd ? 'ptyd' : 'node-pty') + '\t' + (r.bin || '') + '\t' + r.reason);
")"
host="$(printf '%s' "$decision" | cut -f1)"
bin="$(printf '%s' "$decision" | cut -f2)"
reason="$(printf '%s' "$decision" | cut -f3)"

if [[ "$host" != ptyd ]]; then
  echo "ptyd: not used here ($reason); nothing to install"
  exit 0
fi
if [[ -z "$bin" || ! -x "$bin" ]]; then
  echo "ptyd: ptyHost=ptyd but no release binary found; build it: node scripts/build.js --only ptyd --release" >&2
  exit 1
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

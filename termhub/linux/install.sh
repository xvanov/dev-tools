#!/usr/bin/env bash
# termhub installer (Linux) — installs the single termhub server as a systemd
# *user* service. Run from anywhere:  ./linux/install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="$(cd "$SCRIPT_DIR/.." && pwd)"            # termhub project root
UNIT_DIR="$HOME/.config/systemd/user"

echo "termhub: project dir = $DIR"

# --- prerequisites ---------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found. Install Node.js 18+ first (e.g. via nvm or your package manager)." >&2
  exit 1
fi
NODE="$(command -v node)"
echo "termhub: node = $NODE ($("$NODE" --version))"

if ! command -v tailscale >/dev/null 2>&1; then
  echo "WARNING: tailscale CLI not found. termhub will fall back to loopback unless you set TERMHUB_BIND." >&2
fi

# --- dependencies (builds node-pty native module) --------------------------
echo "termhub: installing npm dependencies (this compiles node-pty)…"
( cd "$DIR" && npm install --omit=dev --no-audit --no-fund )

# --- systemd unit ----------------------------------------------------------
mkdir -p "$UNIT_DIR"

# Clean up units from the older two-process (agent + hub) layout, if present.
for old in termhub-agent.service termhub-hub.service; do
  if [[ -f "$UNIT_DIR/$old" ]]; then
    systemctl --user disable --now "$old" >/dev/null 2>&1 || true
    rm -f "$UNIT_DIR/$old"
    echo "termhub: removed obsolete $old"
  fi
done

sed -e "s#__DIR__#$DIR#g" -e "s#__NODE__#$NODE#g" \
  "$SCRIPT_DIR/termhub.service" > "$UNIT_DIR/termhub.service"
echo "termhub: wrote $UNIT_DIR/termhub.service"

systemctl --user daemon-reload
systemctl --user enable --now termhub.service
echo "termhub: service enabled and started."

# Keep the service running after logout (handy for headless machines).
loginctl enable-linger "$USER" >/dev/null 2>&1 || \
  echo "NOTE: run 'sudo loginctl enable-linger $USER' so termhub survives logout."

echo
echo "Done. Status:  systemctl --user status termhub"
if command -v tailscale >/dev/null 2>&1; then
  TSIP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
  [[ -n "$TSIP" ]] && echo "Open in a browser:  http://$TSIP:${TERMHUB_PORT:-7000}"
fi

#!/usr/bin/env bash
# REPAIRS: service-inactive  (Linux)
#
# The termhub systemd --user unit exists but is not running: stopped by hand, never
# started after a boot where lingering isn't enabled, or — the interesting case —
# systemd gave up on it. Restart=on-failure stops retrying once StartLimitBurst
# restarts happen inside StartLimitIntervalSec, and the unit is then left alone
# indefinitely. That is a machine that looks supervised and isn't.
#
# THE FIX: clear the start-limit counter, then start it. `reset-failed` is the part
# that matters and the part that is easy to miss — without it `start` on a
# rate-limited unit fails immediately with "start request repeated too quickly" and
# the remedy looks like it ran and did nothing.
#
# Safe by construction: this signature means nothing is being served, so there are no
# live PTYs to destroy. That is exactly why restarting is allowed here and not for
# http-unhealthy, where the same command would kill the user's terminals.

set -uo pipefail

UNIT="termhub"
PORT="7000"
BIND=""

while [ $# -gt 0 ]; do
  case "$1" in
    --unit)       UNIT="$2"; shift ;;
    --port)       PORT="$2"; shift ;;
    --bind)       BIND="$2"; shift ;;
    --signature|--tailnet-ip) shift ;;
    *) ;;
  esac
  shift
done

echo "remedy: clearing any start-limit block on '$UNIT' and starting it"
systemctl --user reset-failed "$UNIT" 2>&1 || true
if ! systemctl --user start "$UNIT" 2>&1; then
  echo "remedy: systemctl start failed"
  systemctl --user status "$UNIT" --no-pager -n 15 2>&1 || true
  exit 1
fi

# A unit that is 'active' is not the same as termhub serving: node can be up and
# still be failing to bind. Verify what the user actually cares about.
#
# Check EVERY address it could be on, not just loopback: with no TERMHUB_BIND,
# server.js binds the TAILNET IP and falls back to loopback only if there isn't one.
# A loopback-only check therefore fails on a healthy default install, and this remedy
# would report failure for a start that worked — sending a fixed machine to the model.
case "$BIND" in 0.0.0.0|'*'|'::') BIND="127.0.0.1" ;; esac
ADDRS="$BIND 127.0.0.1 $(tailscale ip -4 2>/dev/null | head -1 | tr -d '[:space:]' || true)"
ADDRS="$(printf '%s\n' "$ADDRS" | tr ' ' '\n' | awk 'NF && !seen[$0]++' | tr '\n' ' ')"

deadline=$(( $(date +%s) + 30 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  for addr in $ADDRS; do
    body="$(curl -sS -m 3 "http://$addr:$PORT/api/health" 2>/dev/null || true)"
    case "$body" in
      *'"ok":true'*)
        echo "remedy: verified healthy at http://$addr:$PORT"
        exit 0 ;;
    esac
  done
  sleep 2
done

echo "remedy: '$UNIT' was started but /api/health never returned ok:true on any of: $ADDRS (port $PORT)"
systemctl --user status "$UNIT" --no-pager -n 15 2>&1 || true
journalctl --user -u "$UNIT" -n 25 --no-pager 2>&1 || true
exit 1

#!/usr/bin/env bash
# REPAIRS: service-failed  (Linux)
#
# systemd holds the termhub unit in the `failed` state: it exited non-zero and
# Restart=on-failure either ran out of attempts or the failure was of a kind it will
# not retry. Nothing is being served, so — as with service-inactive — there are no
# live PTYs to lose and a restart is safe.
#
# Deliberately the same repair as service-inactive rather than something cleverer:
# `reset-failed` + `start` is what clears the failed state, and if the underlying
# cause is still there the unit fails again, this remedy reports it, and the watchdog
# escalates with the journal in the bundle. That is the right division of labour — a
# script should not be trying to interpret a stack trace.
#
# Kept as its own file rather than shared with service-inactive because the
# signature-to-filename mapping is the contract the LLM escalation writes against;
# indirection there would cost more than the six duplicated lines.

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

echo "remedy: '$UNIT' is failed - $(systemctl --user show "$UNIT" -p Result --value 2>/dev/null)"
echo "remedy: last journal lines before the repair attempt:"
journalctl --user -u "$UNIT" -n 15 --no-pager 2>&1 || true

systemctl --user reset-failed "$UNIT" 2>&1 || true
if ! systemctl --user start "$UNIT" 2>&1; then
  echo "remedy: systemctl start failed"
  systemctl --user status "$UNIT" --no-pager -n 15 2>&1 || true
  exit 1
fi

# Every candidate address, not just loopback — a default install binds the tailnet IP
# (see service-inactive.sh for the full reasoning).
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

echo "remedy: '$UNIT' still not serving after a reset-failed + start; the cause is not"
echo "remedy: something this script can fix. Escalating with the journal is correct here."
journalctl --user -u "$UNIT" -n 30 --no-pager 2>&1 || true
exit 1

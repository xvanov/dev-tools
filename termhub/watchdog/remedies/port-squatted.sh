#!/usr/bin/env bash
# REPAIRS: port-squatted  (Linux)
#
# What the watchdog sees: the unit is active, /api/health answers on no candidate address,
# and the port is held by a pid that is not the unit's MainPID.
#
# What it actually was (first seen 2026-11-26 on k-911-X17): NOT a stranger. With
# TERMHUB_FRONT=jarvisd, server.js (the MainPID, which is sessiond) runs the front as a CHILD
# — `bun jarvisd/src/main.ts front --port <port> --sessiond-port <n>` — and respawns it
# whenever it exits (server.ts superviseFront). The front resolves its bind address once, at
# startup (lib/bind.ts: TERMHUB_BIND, else `tailscale ip -4`). The tailnet IP changed
# (100.64.38.18 -> 100.82.97.40) under a front that had been up 5 days; its listening socket
# survived on the vanished address, so the port looked held and nothing could reach it.
#
# THE FIX: prove the holder is termhub's own supervised front, then SIGTERM it. server.js
# respawns it within ~1s and the new front resolves the CURRENT address. The front holds no
# terminals (PTYs live in ptyd, a separate unit; sessiond is the untouched MainPID), so this
# costs browsers a reconnect and nothing else. Never `systemctl restart` for this.
#
# What counts as "identified" — ALL of these, or we exit 1 and let it escalate:
#   1. the holder's parent pid is the unit's MainPID,
#   2. the holder is in the unit's own cgroup,
#   3. its command line is a front for this port (`... front ... --port <port>`).
# Anything else really is an unidentified squatter, and killing it blind is still forbidden
# (remedies/README.md rule 6).
#
# It will NOT fix: an explicit TERMHUB_BIND naming an address the machine no longer has — the
# respawned front binds the same dead address, health still fails, and this exits 1. That one
# is a configuration decision for a human or the escalation.

set -uo pipefail

UNIT="termhub"
PORT="7000"
BIND=""
TAILNET_IP=""

while [ $# -gt 0 ]; do
  case "$1" in
    --unit)       UNIT="${2:-}"; shift ;;
    --port)       PORT="${2:-}"; shift ;;
    --bind)       BIND="${2:-}"; shift ;;
    --tailnet-ip) TAILNET_IP="${2:-}"; shift ;;
    --signature)  shift ;;
    *) ;;
  esac
  shift
done
UNIT="${UNIT%.service}"

# Every address termhub could legitimately be serving on (see remedies/README.md: an empty
# --bind means "tailnet IP, else loopback", never just loopback).
candidates() {
  local b="$BIND"
  case "$b" in 0.0.0.0|'*'|'::') b="127.0.0.1" ;; esac
  printf '%s\n' "$b" 127.0.0.1 "$TAILNET_IP" \
    "$(tailscale ip -4 2>/dev/null | head -1 | tr -d '[:space:]' || true)" \
    | awk 'NF && !seen[$0]++' | tr '\n' ' '
}

healthy_at() {   # -> prints the address with a healthy front, rc 0 if any
  local addr body
  for addr in $(candidates); do
    body="$(curl -sS -m 3 "http://$addr:$PORT/api/health" 2>/dev/null || true)"
    case "$body" in
      *'"ok":true'*'"entry":"front"'*|*'"entry":"front"'*'"ok":true'*) echo "$addr"; return 0 ;;
    esac
  done
  return 1
}

listener() {     # -> "addr pid" of the first listener on PORT, empty if none
  ss -ltnpH "sport = :$PORT" 2>/dev/null | awk '{
    addr=$4; sub(/:[0-9]+$/, "", addr); gsub(/[\[\]]/, "", addr)
    if (match($0, /pid=[0-9]+/)) { print addr, substr($0, RSTART+4, RLENGTH-4); exit }
  }'
}

# Idempotent: a machine that is already fine is left alone.
if a="$(healthy_at)"; then
  echo "remedy: already healthy at http://$a:$PORT - nothing to do"
  exit 0
fi

read -r HOLD_ADDR HOLD_PID <<<"$(listener)"
if [ -z "${HOLD_PID:-}" ]; then
  echo "remedy: nothing holds port $PORT any more; not a port-squat (let the watchdog reclassify)"
  exit 1
fi

MAINPID="$(systemctl --user show "$UNIT" -p MainPID --value 2>/dev/null || true)"
CGROUP="$(systemctl --user show "$UNIT" -p ControlGroup --value 2>/dev/null || true)"
PPID_OF="$(awk '{print $4}' "/proc/$HOLD_PID/stat" 2>/dev/null || true)"
HOLD_CG="$(sed -n 's/^0:://p' "/proc/$HOLD_PID/cgroup" 2>/dev/null || true)"
HOLD_CMD="$(tr '\0' ' ' <"/proc/$HOLD_PID/cmdline" 2>/dev/null || true)"

echo "remedy: $HOLD_ADDR:$PORT held by pid $HOLD_PID (ppid $PPID_OF, cgroup $HOLD_CG): $HOLD_CMD"
echo "remedy: unit '$UNIT' MainPID $MAINPID, cgroup $CGROUP; candidate addresses: $(candidates)"

why_not=""
if [ -z "$MAINPID" ] || [ "$MAINPID" = "0" ]; then why_not="unit has no MainPID"
elif [ "$PPID_OF" != "$MAINPID" ]; then why_not="its parent ($PPID_OF) is not the unit's MainPID ($MAINPID)"
elif [ -z "$CGROUP" ] || [ "$HOLD_CG" != "$CGROUP" ]; then why_not="it is not in the unit's cgroup"
elif ! printf '%s' "$HOLD_CMD" | grep -Eq "(^| )front( .*)? --port $PORT( |$)"; then why_not="its command line is not a termhub front for port $PORT"
fi
if [ -n "$why_not" ]; then
  echo "remedy: REFUSING - pid $HOLD_PID is not identified as termhub's own front: $why_not. Not killing an unidentified process; escalating."
  exit 1
fi

echo "remedy: pid $HOLD_PID is termhub's supervised front, unreachable on $HOLD_ADDR; SIGTERM so server.js respawns it on the current address"
kill -TERM "$HOLD_PID" 2>/dev/null || true

deadline=$(( $(date +%s) + 40 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if a="$(healthy_at)"; then
    read -r NEW_ADDR NEW_PID <<<"$(listener)"
    echo "remedy: verified healthy at http://$a:$PORT (front now pid ${NEW_PID:-?} on ${NEW_ADDR:-?})"
    exit 0
  fi
  sleep 1
done

read -r NEW_ADDR NEW_PID <<<"$(listener)"
echo "remedy: front was replaced (now pid ${NEW_PID:-none} on ${NEW_ADDR:-nothing}) but /api/health never returned ok on: $(candidates)"
echo "remedy: if it re-bound the same dead address, TERMHUB_BIND names an address this machine no longer has"
journalctl --user -u "$UNIT" -n 15 --no-pager 2>&1 || true
exit 1

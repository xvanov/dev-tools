#!/usr/bin/env bash
# drive_chain.sh — drive ``factory tick`` for an app until the queue drains
# or daily-cap pressure forces a stop. Generic: works for any app under
# ``apps/<name>/``; the factory itself is stack- and app-agnostic.
#
# Usage:
#   scripts/drive_chain.sh <app>
#   DAILY_LIMIT_USD=80 scripts/drive_chain.sh <app>
#
# Exits 0 when story_created queue is empty, 2 when spend guard trips,
# and propagates errors from ``factory tick`` invocations.

set -euo pipefail

if [ "$#" -lt 1 ] || [ -z "${1:-}" ]; then
  echo "usage: $0 <app>" >&2
  echo "  (positional <app> required — drive the chain for that app's queue)" >&2
  exit 64
fi

APP="$1"
cd "$(dirname "$0")/.."

DAILY_LIMIT_USD="${DAILY_LIMIT_USD:-180}"  # default guard: 90% of $200 cap

emit() { printf '[drive %s app=%s] %s\n' "$(date -u +%H:%M:%S)" "$APP" "$*"; }

while :; do
  # Phase 7: halt check — read state/factory_mode.json before each iteration.
  # The L3 Diagnostician may write this file between ticks; if it's present
  # and mode=="halted" we exit cleanly without burning any more LLM calls.
  if [ -f "state/factory_mode.json" ]; then
    halt_mode=$(python3 -c "
import json, sys
try:
    d = json.load(open('state/factory_mode.json'))
    sys.exit(0 if d.get('mode') == 'halted' else 1)
except Exception:
    sys.exit(1)
" 2>/dev/null && echo "halted" || echo "normal")
    if [ "$halt_mode" = "halted" ]; then
      halt_reason=$(python3 -c "
import json
try:
    d = json.load(open('state/factory_mode.json'))
    print(d.get('reason', 'no reason provided'))
except Exception:
    print('could not read halt reason')
" 2>/dev/null)
      emit "halted: ${halt_reason}" >&2
      exit 0
    fi
  fi

  budget_out=$(uv run factory budget 2>/dev/null)
  spend=$(printf '%s\n' "$budget_out" | awk -F'│' '/today_spend_usd/ {gsub(/[^0-9.]/,"",$3); print $3}')
  hour=$(printf '%s\n' "$budget_out" | awk -F'│' '/hour_spend_usd/ {gsub(/[^0-9.]/,"",$3); print $3}')
  hour_cap=$(printf '%s\n' "$budget_out" | awk -F'│' '/hourly_cap_usd/ {gsub(/[^0-9.]/,"",$3); print $3}')
  emit "spend today=\$${spend} hour=\$${hour} hour_cap=\$${hour_cap}"

  if awk "BEGIN{exit !(${spend:-0} >= ${DAILY_LIMIT_USD})}"; then
    emit "STOP: daily spend \$${spend} >= guard \$${DAILY_LIMIT_USD}"
    exit 2
  fi

  # Count any non-terminal, dispatchable story — not just story_created.
  # Stories reset out of a blocked state by an operator (e.g. after a
  # harness fix) land back in tests_red or test_design_done, both of
  # which the orchestrator can advance on the next tick. The previous
  # gate ("story_created remaining=0 → DONE") exited too early when the
  # only remaining work was in flight elsewhere in the state machine.
  remaining=$(uv run python -c "
import sqlite3, sys
c = sqlite3.connect('state/factory.db')
n = c.execute(\"SELECT COUNT(*) FROM stories WHERE app=? AND state NOT IN ('deployed','blocked_tests_need_clarification','blocked_deployment_skipped','blocked_deploy_failed','blocked_review_nonconvergent')\", (sys.argv[1],)).fetchone()[0]
print(n)
" "$APP" 2>/dev/null || echo 0)
  emit "dispatchable remaining=${remaining}"
  if [ "${remaining}" -eq 0 ]; then
    emit "DONE: no dispatchable rows left"
    break
  fi

  # Pause within 5% of the configured hourly cap; reads the cap live so
  # a factory_settings.yaml change takes effect on the next iteration.
  threshold=$(awk "BEGIN{printf \"%.4f\", ${hour_cap:-2} * 0.95}")
  if awk "BEGIN{exit !(${hour:-0} >= ${threshold})}"; then
    emit "hourly cap near/over (\$${hour} / cap \$${hour_cap}); sleeping 120s"
    sleep 120
    continue
  fi

  emit "ticking…"
  uv run factory tick --app "$APP" 2>&1 | tail -25 || emit "tick errored (non-fatal, will retry)"
  emit "tick complete; brief pause before next iteration"
  sleep 30
done

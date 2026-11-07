#!/usr/bin/env bash
# loop3_audit.sh — one-shot health/progress audit for the deadline push.
# Prints a compact status block: progress, blocked, collisions, spend, loops.
cd "$(dirname "$0")/.."

now=$(date -u '+%H:%M:%S')
deadline_utc="08:00:00"

uv run python - <<'PY' 2>/dev/null
import sqlite3
from collections import Counter
c = sqlite3.connect('state/factory.db')
rows = [r[0] for r in c.execute("SELECT state FROM stories WHERE app='sacrifice'").fetchall()]
ct = Counter(rows)
total = len(rows); dep = ct.get('deployed', 0)
blocked = sum(v for k, v in ct.items() if k.startswith('blocked'))
print(f"PROGRESS deployed={dep}/{total} blocked={blocked} remaining={total-dep}")
print("STATES " + " ".join(f"{k}={v}" for k, v in ct.most_common()))
if blocked:
    bl = c.execute("SELECT id,state,substr(error,1,70) FROM stories WHERE app='sacrifice' AND state LIKE 'blocked%'").fetchall()
    for b in bl:
        print(f"  BLOCKED story={b[0]} {b[1]} :: {b[2]}")
# live handlers + collisions
live = c.execute("SELECT story_id,persona,pid FROM live_handlers").fetchall()
ids = [r[0] for r in live]
dup = [s for s, n in Counter(ids).items() if n > 1]
print(f"LIVE {len(live)} handlers: " + ", ".join(f"{r[0]}:{r[1]}" for r in live))
if dup:
    print(f"  !!! COLLISION same story in 2 handlers: {dup}")
PY

# spend
uv run factory budget 2>/dev/null | awk -F'│' '/today_spend_usd|hour_spend_usd|hourly_cap/ {gsub(/ /,"",$2);gsub(/ /,"",$3); printf "SPEND %s=%s\n",$2,$3}'

# loops alive
n=$(ps -eo pid,args | grep '[d]rive_chain\.sh sacrifice' | wc -l)
echo "LOOPS drive_chain=$n"
echo "TIME now=${now}Z deadline=${deadline_utc}Z"

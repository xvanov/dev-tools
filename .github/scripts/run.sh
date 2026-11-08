#!/usr/bin/env bash
# Run a command, tee its output, and on failure publish the failing lines plus
# the tail as one error annotation (readable via the check-runs API even where
# raw job logs are not downloadable).
set -u
log="$(mktemp)"
"$@" 2>&1 | tee "$log"
rc=${PIPESTATUS[0]}
if [ "$rc" -ne 0 ]; then
  {
    grep -E '^(FAILED|ERROR) |^\s*FAIL |^Error|AssertionError|^[0-9]+ (failed|passed)|(failed|passed).* in [0-9.]+s' "$log" | sed -E 's/ - .*//' | cut -c1-160 | head -n 150
    echo '--- tail ---'
    grep -vE '^\s*$' "$log" | tail -n 25 | cut -c1-300
  } > "$log.msg"
  msg="$(sed -e 's/%/%25/g' "$log.msg" | awk 'BEGIN{ORS="%0A"}{print}')"
  echo "::error title=command failed ($rc): $*::${msg}"
fi
exit "$rc"
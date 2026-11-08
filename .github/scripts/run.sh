#!/usr/bin/env bash
# Run a command, tee its output, and on failure publish the tail as an error
# annotation (readable via the check-runs API even where raw job logs are not).
set -u
log="$(mktemp)"
"$@" 2>&1 | tee "$log"
rc=${PIPESTATUS[0]}
if [ "$rc" -ne 0 ]; then
  msg="$(grep -vE '^\s*$' "$log" | tail -n 40 | cut -c1-300 | sed -e 's/%/%25/g' | awk 'BEGIN{ORS="%0A"}{print}')"
  echo "::error title=command failed ($rc): $*::${msg}"
fi
exit "$rc"
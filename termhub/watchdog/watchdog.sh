#!/usr/bin/env bash
# termhub watchdog (Linux) — keep termhub up, and get smarter every time it isn't.
#
#   watchdog/watchdog.sh              # one cycle (what the systemd timer runs)
#   watchdog/watchdog.sh --probe      # report and exit; change nothing
#   watchdog/watchdog.sh --no-escalate
#   watchdog/watchdog.sh --test-claude
#
# The counterpart of watchdog.ps1, and the same design: an outage is reduced to a
# coarse SIGNATURE, and that slug is the filename of its remedy
# (remedies/<signature>.sh). Known signature -> a script fixes it with no model in
# the loop. Novel one -> `claude -p` fixes it AND writes that remedy, so the next
# occurrence never reaches a model.
#
# WHY THIS IS NOT A PORT OF THE POWERSHELL ONE
#
# Linux termhub is a *different deployment*: one process (`server.js`, both tiers in
# one) under a systemd --user unit with Restart=on-failure. So the Windows signatures
# do not apply — there is no separate front to replace — and systemd already handles
# the plain "it crashed" case. What is left for a watchdog here is everything systemd
# cannot fix by restarting: a unit that is stopped or disabled, one that hit its start
# limit and was given up on, a port held by something else, a process that is running
# but not listening or not healthy, and a machine with no unit at all.
#
# THE ONE RULE THAT MATTERS MOST HERE
#
# Restarting termhub on Linux DESTROYS EVERY LIVE TERMINAL — PTYs live in the same
# process. On Windows the watchdog can swap the front and keep them; here it cannot.
# So a restart is only ever allowed when nothing is being served anyway (the service
# is down), and a merely *unhealthy* service escalates instead of being restarted.
# Killing somebody's running work to fix a health blip is not a repair.
#
# Kill switch: create <data dir>/watchdog/DISABLED, or set TERMHUB_WATCHDOG_DISABLED=1.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE="${TERMHUB_WATCHDOG_SERVICE:-termhub}"

DATA_DIR="${TERMHUB_DATA_DIR:-$HOME/.local/termhub}"
WD_DIR="$DATA_DIR/watchdog"
LOG="$WD_DIR/watchdog.log"
LEDGER="$WD_DIR/escalations.json"
DISABLED="$WD_DIR/DISABLED"
mkdir -p "$WD_DIR"

# Escalation budget. Generous enough to fix a real outage, tight enough that a
# failure a model cannot fix does not become a model running every two minutes
# forever.
MIN_GAP_MIN=10
MAX_PER_HOUR=3
MAX_PER_DAY=8

CONFIRMATIONS=3
CONFIRM_DELAY=5
REMEDY_TIMEOUT=120
ESCALATE_TIMEOUT=900

PROBE_ONLY=0
NO_ESCALATE=0
NO_REMEDY=0
TEST_CLAUDE=0
QUIET=0

while [ $# -gt 0 ]; do
  case "$1" in
    --probe)        PROBE_ONLY=1 ;;
    --no-escalate)  NO_ESCALATE=1 ;;
    --no-remedy)    NO_REMEDY=1 ;;
    --test-claude)  TEST_CLAUDE=1 ;;
    --quiet)        QUIET=1 ;;
    *) echo "watchdog: unknown argument '$1'" >&2; exit 2 ;;
  esac
  shift
done

log() {
  local level="$1"; shift
  local line
  line="$(date '+%Y-%m-%d %H:%M:%S') [$level] $*"
  printf '%s\n' "$line" >>"$LOG" 2>/dev/null || true
  # Cap the log rather than let it grow unbounded on a machine that flaps.
  if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 4194304 ]; then
    mv -f "$LOG" "$LOG.prev" 2>/dev/null || true
  fi
  [ "$QUIET" -eq 1 ] || printf '%s\n' "$line"
}

# ---- topology ---------------------------------------------------------------

# Where should termhub be listening? Linux has no state.json port dance: the unit
# reads TERMHUB_PORT/TERMHUB_BIND from its environment, and server.js binds the
# tailnet IP by default (falling back to loopback, never a public interface).
resolve_topology() {
  PORT="${TERMHUB_PORT:-7000}"
  # Ask systemd what the unit is actually configured with; the timer's environment
  # is not the service's, so guessing from our own env is how you end up probing
  # the wrong port on a machine that overrode it with `systemctl --user edit`.
  local envline
  envline="$(systemctl --user show "$SERVICE" -p Environment --value 2>/dev/null || true)"
  case "$envline" in
    *TERMHUB_PORT=*) PORT="$(printf '%s\n' "$envline" | tr ' ' '\n' | sed -n 's/^TERMHUB_PORT=//p' | tail -1)" ;;
  esac
  BIND="${TERMHUB_BIND:-}"
  case "$envline" in
    *TERMHUB_BIND=*) BIND="$(printf '%s\n' "$envline" | tr ' ' '\n' | sed -n 's/^TERMHUB_BIND=//p' | tail -1)" ;;
  esac
  TAILNET_IP="$(tailscale ip -4 2>/dev/null | head -1 | tr -d '[:space:]' || true)"

  # Candidate addresses to probe, most-likely first.
  #
  # Probing ONE guessed address is a false-outage generator, and the default Linux
  # install is exactly the case that breaks: with no TERMHUB_BIND, server.js binds the
  # TAILNET IP (loopback is only its last-resort fallback). A loopback-only probe
  # therefore finds nothing on a perfectly healthy machine, classifies it
  # `not-listening`, and — since that signature has no remedy — escalates to a model.
  # A watchdog that invents outages is worse than no watchdog.
  PROBE_ADDRS=()
  local b="$BIND"
  case "$b" in 0.0.0.0|'*'|'::') b="127.0.0.1" ;; esac
  [ -n "$b" ] && PROBE_ADDRS+=("$b")
  PROBE_ADDRS+=("127.0.0.1")
  [ -n "$TAILNET_IP" ] && PROBE_ADDRS+=("$TAILNET_IP")
  # Plus whatever is genuinely listening, in case the bind is something not guessed
  # above (a LAN address, a second tailnet address).
  local a
  while read -r a; do [ -n "$a" ] && PROBE_ADDRS+=("$a"); done <<<"$(listen_addrs "$PORT")"

  local seen=" " out=() x
  for x in "${PROBE_ADDRS[@]}"; do
    case "$seen" in *" $x "*) continue ;; esac
    seen="$seen$x "
    out+=("$x")
  done
  PROBE_ADDRS=("${out[@]}")
  PROBE_ADDR="${PROBE_ADDRS[0]}"
  BASE_URL="http://$PROBE_ADDR:$PORT"
}

# Addresses actually listening on a port, normalised so they can be probed.
listen_addrs() {
  command -v ss >/dev/null 2>&1 || return 0
  ss -ltnH "sport = :$1" 2>/dev/null | awk '{print $4}' \
    | sed -e 's/:[0-9]*$//' -e 's/^\[//' -e 's/\]$//' \
    | sed -e 's/^\*$/127.0.0.1/' -e 's/^0\.0\.0\.0$/127.0.0.1/' -e 's/^::$/127.0.0.1/' \
    | sort -u
}

unit_exists() {
  systemctl --user cat "$SERVICE" >/dev/null 2>&1
}

unit_active_state() {   # active | inactive | failed | activating | unknown
  systemctl --user is-active "$SERVICE" 2>/dev/null || true
}

# ---- probing ----------------------------------------------------------------

# Body and status of a GET, distinguishing "nothing listening" from "a server
# answered with an error" — those are two completely different outages, and a
# health endpoint returning 503 is the case where restarting is exactly wrong.
http_probe() {   # sets HTTP_CODE, HTTP_BODY
  local url="$1"
  HTTP_BODY=""
  HTTP_CODE=0
  local out
  out="$(curl -sS -m 4 -w '\n%{http_code}' "$url" 2>/dev/null)" || { HTTP_CODE=0; return 1; }
  HTTP_CODE="$(printf '%s' "$out" | tail -1)"
  HTTP_BODY="$(printf '%s' "$out" | sed '$d')"
  return 0
}

port_holder() {   # prints "pid/name" of whatever listens on $1, or nothing
  if command -v ss >/dev/null 2>&1; then
    ss -ltnpH "sport = :$1" 2>/dev/null | sed -n 's/.*users:(("\([^"]*\)",pid=\([0-9]*\).*/\2\/\1/p' | head -1
  fi
}

service_main_pid() {
  systemctl --user show "$SERVICE" -p MainPID --value 2>/dev/null | tr -d '[:space:]'
}

# Is termhub serving on ANY address it could plausibly be on? Sets HEALTH_OK,
# RESPONDED (something answered, even an error) and, on success, repoints
# BASE_URL/PROBE_ADDR at the address that actually worked so every later message and
# the bundle name the real one.
probe_health() {
  HEALTH_OK=0
  RESPONDED=0
  local a url
  for a in "${PROBE_ADDRS[@]}"; do
    url="http://$a:$PORT/api/health"
    if http_probe "$url"; then
      RESPONDED=1
      PROBE_ADDR="$a"
      BASE_URL="http://$a:$PORT"
      case "$HTTP_BODY" in
        *'"ok":true'*) HEALTH_OK=1; return 0 ;;
      esac
    fi
  done
  return 0
}

# Classify. Order matters: the most consequential causes are tested first, because
# the difference between them is the difference between the right and wrong repair.
diagnose() {   # sets SIGNATURE, DETAIL
  resolve_topology
  SIGNATURE="unknown"
  DETAIL=""

  if ! unit_exists; then
    SIGNATURE="service-missing"
    DETAIL="there is no '$SERVICE' systemd --user unit on this machine, so nothing starts termhub at all. Run linux/install.sh."
    return
  fi

  local state; state="$(unit_active_state)"
  probe_health
  local health_ok="$HEALTH_OK" responded="$RESPONDED"

  if [ "$state" = "active" ] && [ "$health_ok" -eq 1 ]; then
    SIGNATURE="healthy"
    return
  fi

  if [ "$state" = "failed" ]; then
    SIGNATURE="service-failed"
    DETAIL="systemd reports '$SERVICE' as failed: $(systemctl --user show "$SERVICE" -p Result --value 2>/dev/null). Nothing is being served, so a restart costs no live terminals."
    return
  fi

  if [ "$state" != "active" ] && [ "$state" != "activating" ]; then
    SIGNATURE="service-inactive"
    DETAIL="'$SERVICE' is '$state' - stopped, disabled, or given up on after hitting its start limit. Nothing is being served, so a restart costs no live terminals."
    return
  fi

  # From here the unit IS active. Every remaining case has LIVE PTYs in it, so a
  # restart would destroy the user's running terminals — see the header. These
  # escalate by default rather than self-healing.
  if [ "$responded" -eq 0 ]; then
    local holder; holder="$(port_holder "$PORT")"
    local mainpid; mainpid="$(service_main_pid)"
    if [ -n "$holder" ] && [ -n "$mainpid" ] && [ "${holder%%/*}" != "$mainpid" ]; then
      SIGNATURE="port-squatted"
      DETAIL="$PROBE_ADDR:$PORT is held by $holder, which is not termhub's main process ($mainpid). Killing an unidentified process is worse than the outage, so this is not self-healed."
      return
    fi
    if [ -z "$holder" ]; then
      SIGNATURE="not-listening"
      DETAIL="'$SERVICE' is active (pid $mainpid) but nothing is listening on $PROBE_ADDR:$PORT. Usually TERMHUB_BIND names an address this machine no longer has (a changed tailnet IP), so the process is alive and unreachable."
      return
    fi
    SIGNATURE="not-listening"
    DETAIL="'$SERVICE' is active and $holder holds $PORT, but $BASE_URL/api/health did not answer."
    return
  fi

  SIGNATURE="http-unhealthy"
  DETAIL="'$SERVICE' is active and answers $BASE_URL/api/health with HTTP $HTTP_CODE but not ok:true. LIVE TERMINALS EXIST in this process, so restarting is destructive and is not done automatically. Body: $HTTP_BODY"
}

# ---- the diagnostic bundle --------------------------------------------------

bundle() {
  echo "machine:        $(hostname)"
  echo "time:           $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "platform:       linux (single-process server.js under systemd --user)"
  echo "signature:      $SIGNATURE"
  echo "detail:         $DETAIL"
  echo
  echo "--- topology ---"
  echo "unit:           $SERVICE"
  echo "port:           $PORT"
  echo "bind:           ${BIND:-(unset - server.js chooses: tailnet IP, else loopback)}"
  echo "tailnet IP:     ${TAILNET_IP:-(none)}"
  echo "probe order:    ${PROBE_ADDRS[*]}  (port $PORT)"
  echo
  echo "--- systemctl status ---"
  systemctl --user status "$SERVICE" --no-pager -n 0 2>&1 | head -20 || true
  echo
  echo "--- unit properties ---"
  systemctl --user show "$SERVICE" \
    -p LoadState -p ActiveState -p SubState -p Result -p MainPID -p NRestarts \
    -p ExecMainStatus -p UnitFileState -p Environment -p FragmentPath 2>&1 || true
  echo
  # Every candidate, not just the one that was chosen: "loopback refused but the
  # tailnet address served fine" is the difference between a bind problem and an
  # outage, and it is invisible if only one address is reported.
  echo "--- probes (every candidate address) ---"
  local a
  for a in "${PROBE_ADDRS[@]}"; do
    if http_probe "http://$a:$PORT/api/health"; then
      echo "GET http://$a:$PORT/api/health -> HTTP $HTTP_CODE"
      echo "  $HTTP_BODY"
    else
      echo "GET http://$a:$PORT/api/health -> no answer (refused or timed out)"
    fi
  done
  echo
  echo "--- listeners on $PORT ---"
  if command -v ss >/dev/null 2>&1; then ss -ltnp "sport = :$PORT" 2>&1 || true; else echo "(ss not available)"; fi
  echo
  echo "--- node processes ---"
  ps -eo pid,etime,cmd 2>/dev/null | grep -E 'server\.js|sessiond\.js|front\.js' | grep -v grep || echo "(none)"
  echo
  echo "--- last 40 journal lines ---"
  journalctl --user -u "$SERVICE" -n 40 --no-pager 2>&1 || echo "(journal unavailable)"
  echo
  echo "--- tailscale ---"
  tailscale status 2>&1 | head -5 || echo "(tailscale unavailable)"
  echo
  echo "--- git HEAD (the tree the service runs from) ---"
  git -C "$PROJECT_DIR" log -1 --format='%h %ci %s' 2>&1 || true
  if [ -n "$(git -C "$PROJECT_DIR" status --porcelain 2>/dev/null)" ]; then
    echo "DIRTY TREE:"
    git -C "$PROJECT_DIR" status --porcelain 2>&1 | head -20
  else
    echo "tree clean"
  fi
  echo
  echo "--- watchdog timer ---"
  systemctl --user status termhub-watchdog.timer --no-pager -n 0 2>&1 | head -8 || echo "(timer not installed)"
  echo
  echo "--- update log tail (if the last update left one) ---"
  if [ -f "$DATA_DIR/logs/update.log" ]; then tail -30 "$DATA_DIR/logs/update.log"; else echo "(none)"; fi
}

# ---- escalation ledger ------------------------------------------------------

now_epoch() { date +%s; }

ledger_add() {   # signature outcome note
  local entry
  entry="$(printf '{"at":"%s","epoch":%s,"signature":"%s","outcome":"%s","note":"%s","machine":"%s"}' \
    "$(date -Is)" "$(now_epoch)" "$1" "$2" "$(printf '%s' "$3" | tr -d '"' | cut -c1-200)" "$(hostname)")"
  # Line-delimited JSON: append-only, needs no parser to write and no rewrite to
  # trim, which matters in a script that may be killed at any moment.
  printf '%s\n' "$entry" >>"$LEDGER" 2>/dev/null || true
  # Keep the tail only.
  if [ "$(wc -l <"$LEDGER" 2>/dev/null || echo 0)" -gt 200 ]; then
    tail -200 "$LEDGER" >"$LEDGER.tmp" 2>/dev/null && mv -f "$LEDGER.tmp" "$LEDGER"
  fi
}

# Prints the reason escalation is blocked, or nothing when it is allowed.
escalation_blocked() {
  [ -f "$LEDGER" ] || return 0
  local now last gap in_hour in_day
  now="$(now_epoch)"
  # Only real escalations count against the budget; a remedy fixing something is
  # free and must never ration the model.
  last="$(grep -v '"outcome":"remedy-fixed"' "$LEDGER" 2>/dev/null | sed -n 's/.*"epoch":\([0-9]*\).*/\1/p' | tail -1)"
  [ -n "$last" ] || return 0
  gap=$(( (now - last) / 60 ))
  if [ "$gap" -lt "$MIN_GAP_MIN" ]; then
    echo "last escalation was ${gap}min ago; minimum gap is ${MIN_GAP_MIN}min"; return 0
  fi
  in_hour=0; in_day=0
  while read -r e; do
    [ -n "$e" ] || continue
    [ $(( now - e )) -lt 3600 ] && in_hour=$(( in_hour + 1 ))
    [ $(( now - e )) -lt 86400 ] && in_day=$(( in_day + 1 ))
  done <<<"$(grep -v '"outcome":"remedy-fixed"' "$LEDGER" 2>/dev/null | sed -n 's/.*"epoch":\([0-9]*\).*/\1/p')"
  if [ "$in_hour" -ge "$MAX_PER_HOUR" ]; then echo "$in_hour escalations in the last hour (max $MAX_PER_HOUR)"; return 0; fi
  if [ "$in_day" -ge "$MAX_PER_DAY" ]; then echo "$in_day escalations in the last 24h (max $MAX_PER_DAY)"; return 0; fi
}

# ---- verification -----------------------------------------------------------

wait_healthy() {   # seconds -> 0 if healthy
  local deadline=$(( $(now_epoch) + ${1:-30} ))
  while [ "$(now_epoch)" -lt "$deadline" ]; do
    diagnose
    [ "$SIGNATURE" = "healthy" ] && return 0
    sleep 2
  done
  return 1
}

# ---- remedies ---------------------------------------------------------------

remedy_path() { echo "$SCRIPT_DIR/remedies/$1.sh"; }

run_remedy() {   # path -> exit code in REMEDY_RC, output in REMEDY_OUT
  local path="$1"
  REMEDY_OUT="$(timeout "$REMEDY_TIMEOUT" bash "$path" \
    --signature "$SIGNATURE" --unit "$SERVICE" --port "$PORT" \
    --bind "${BIND:-}" --tailnet-ip "${TAILNET_IP:-}" 2>&1)"
  REMEDY_RC=$?
}

# ---- the LLM escalation -----------------------------------------------------

find_claude() {
  if [ -n "${TERMHUB_CLAUDE_BIN:-}" ] && [ -x "${TERMHUB_CLAUDE_BIN}" ]; then echo "$TERMHUB_CLAUDE_BIN"; return; fi
  # A systemd --user unit's PATH is the systemd default and does NOT include
  # ~/.local/bin, which is exactly where the native installer puts the launcher —
  # so a bare `command -v claude` reports "not installed" on a machine that has it.
  local c
  for c in "$(command -v claude 2>/dev/null || true)" "$HOME/.local/bin/claude" /usr/local/bin/claude "$HOME/.claude/local/claude"; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return; }
  done
}

escalation_prompt() {   # remedy_note
  local remedy_note="$1"
  local sessiond_rule
  case "$SIGNATURE" in
    service-missing|service-inactive|service-failed)
      sessiond_rule="This signature means termhub is NOT currently serving, so starting or restarting the service is in scope and costs nothing: there are no live PTYs to lose." ;;
    *)
      sessiond_rule="The service is ACTIVE and its PTYs are the user's live terminals — on Linux termhub is ONE process, so \`systemctl --user restart $SERVICE\` DESTROYS every running terminal. Do not restart it to fix a health or binding problem unless you have established there is no other way, and say plainly in your summary that you did and why." ;;
  esac

  cat <<PROMPT
You are the termhub watchdog's escalation path, running UNATTENDED on $(hostname) (Linux).
No human is watching. Nobody will answer a question. Finish the job or fail loudly.

termhub is DOWN or degraded. $remedy_note

FAILURE SIGNATURE: $SIGNATURE
$DETAIL

=========================== DIAGNOSTIC BUNDLE ===========================
$(bundle)
=========================================================================

Your working directory is the dev-tools repo. termhub's own docs are the map: read
termhub/AGENT.md and termhub/watchdog/README.md before acting. Note that LINUX termhub
is the single-process layout — one \`server.js\` under a systemd --user unit — not the
two-tier sessiond/front split that AGENT.md describes for Windows.

DO THESE FOUR THINGS, IN ORDER.

1) FIX IT.
   $sessiond_rule
   - Prefer the existing scripts: termhub/linux/install.sh (installs/repairs the unit),
     termhub/linux/update.sh, termhub/watchdog/install-watchdog.sh.
   - Never kill a process you have not identified.
   - VERIFY: GET $BASE_URL/api/health must return ok:true. Do not declare success on a
     port merely answering, and do not declare success because systemctl says active.

2) WRITE THE REMEDY: termhub/watchdog/remedies/$SIGNATURE.sh
   This is the point of the exercise: next time this signature occurs that script runs
   INSTEAD of you. Read termhub/watchdog/remedies/README.md and follow the contract
   exactly (arguments, exit codes, idempotence, no prompts, finish inside 60s).
   - If it ALREADY EXISTS it ran and did not fix this: improve it in place and comment
     what it missed. Do not create a variant filename.
   - Generalise: re-derive the unit, port and bind from the arguments passed in, never
     hardcode today's values.
   - If the honest remedy is "a human must decide", do NOT write a script that guesses.
     Say so in your summary and add the reasoning to the signature table in that README.

3) LEAVE THE TREE CLEAN. Commit and push to main.
   termhub deploys by 'git pull --ff-only', which fails on a dirty tree, so uncommitted
   work here blocks every future update on every machine. Follow CLAUDE.md: Conventional
   Commits scoped 'fix(termhub):', a body explaining the failure this prevents, and the
   Co-Authored-By trailer. Say explicitly in your summary if the push failed.

4) REPORT: root cause (say "unknown" if the evidence does not support one — do not
   invent it), what you changed, the remedy you wrote, whether commit and push worked,
   and whether you had to destroy any live terminals.

CONSTRAINTS
   - Change nothing unrelated to this outage. No refactors.
   - Do not install timers or units beyond repairing termhub's own.
   - If you cannot fix it, still do 2-4 so the next escalation starts ahead of you.
PROMPT
}

escalate() {   # remedy_note -> ESCALATE_RC
  local claude; claude="$(find_claude)"
  if [ -z "$claude" ]; then
    log error "cannot escalate: the Claude CLI was not found (set TERMHUB_CLAUDE_BIN)."
    ESCALATE_RC=127
    return
  fi
  local stamp; stamp="$(date '+%Y%m%d-%H%M%S')"
  local pf="$WD_DIR/escalation-$stamp.prompt.txt"
  local of="$WD_DIR/escalation-$stamp.out.txt"
  if [ "${1:-}" = "--selftest" ]; then
    printf 'Reply with exactly the word READY and nothing else. Do not use any tools.\n' >"$pf"
    log warn "launcher self-test ($claude); prompt: $pf"
  else
    escalation_prompt "$1" >"$pf"
    log warn "escalating to Claude Code ($claude); prompt: $pf"
  fi

  # Claude Code writes no transcript when it thinks it is a child of another Claude
  # session, and an escalation with no transcript cannot be audited afterwards.
  ( cd "$(dirname "$PROJECT_DIR")" \
      && env -u CLAUDECODE -u CLAUDE_CODE_SSE_PORT -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID \
         TERMHUB_WATCHDOG_ESCALATION=1 \
         timeout "$ESCALATE_TIMEOUT" "$claude" -p --dangerously-skip-permissions <"$pf" >"$of" 2>&1 )
  ESCALATE_RC=$?
  ESCALATE_OUT="$of"
}

# ---- one cycle --------------------------------------------------------------

cycle() {
  if [ -f "$DISABLED" ] || [ "${TERMHUB_WATCHDOG_DISABLED:-}" = "1" ]; then
    log warn "disabled (remove $DISABLED to re-enable); no action taken."
    return 0
  fi

  diagnose
  if [ "$SIGNATURE" = "healthy" ]; then
    [ "$QUIET" -eq 1 ] || log ok "healthy: $BASE_URL ($SERVICE active)"
    return 0
  fi

  # An update restarts the service, which is a real gap. Stand down rather than
  # race it for the same port.
  if pgrep -f 'linux/update\.sh' >/dev/null 2>&1; then
    log warn "standing down: linux/update.sh is running and owns the restart right now."
    return 0
  fi

  log warn "probe failed: $SIGNATURE - $DETAIL"

  local i
  for i in $(seq 2 "$CONFIRMATIONS"); do
    sleep "$CONFIRM_DELAY"
    diagnose
    if [ "$SIGNATURE" = "healthy" ]; then
      log ok "recovered on its own (probe $i/$CONFIRMATIONS) - a transient gap, not an outage."
      return 0
    fi
    log warn "confirmation $i/$CONFIRMATIONS: still $SIGNATURE"
  done

  local b; b="$(bundle)"
  log info "confirmed outage. signature=$SIGNATURE
$b"

  local remedy_note="No remedy script exists for this signature yet, so you are the first responder."
  if [ "$NO_REMEDY" -eq 0 ]; then
    local rp; rp="$(remedy_path "$SIGNATURE")"
    if [ -f "$rp" ]; then
      log warn "running remedy $rp"
      run_remedy "$rp"
      local tail_out; tail_out="$(printf '%s' "$REMEDY_OUT" | tail -20 | tr '\n' ';')"
      log info "remedy exited $REMEDY_RC: $tail_out"
      if wait_healthy 30; then
        log ok "RECOVERED by remedy $(basename "$rp") - no LLM needed."
        ledger_add "$SIGNATURE" "remedy-fixed" "exit $REMEDY_RC"
        return 0
      fi
      log error "the remedy did not restore service (now: $SIGNATURE)."
      remedy_note="The existing remedy remedies/$SIGNATURE.sh ran and FAILED to restore service (exit $REMEDY_RC). Its output was: $tail_out"
      b="$(bundle)"
    fi
  fi

  if [ "$NO_ESCALATE" -eq 1 ]; then
    log error "escalation suppressed (--no-escalate). termhub is still down: $SIGNATURE"
    ledger_add "$SIGNATURE" "not-escalated" "no-escalate"
    return 1
  fi
  local blocked; blocked="$(escalation_blocked)"
  if [ -n "$blocked" ]; then
    log error "NOT escalating: $blocked. termhub is still down ($SIGNATURE) and needs a human."
    ledger_add "$SIGNATURE" "budget-blocked" "$blocked"
    return 1
  fi

  escalate "$remedy_note"
  local summary; summary="$(tail -25 "$ESCALATE_OUT" 2>/dev/null || true)"
  [ -n "$summary" ] && log info "Claude Code said:
$summary"

  if wait_healthy 30; then
    log ok "RECOVERED after escalation (claude exit $ESCALATE_RC)."
    ledger_add "$SIGNATURE" "llm-fixed" "claude exit $ESCALATE_RC"
    if [ -f "$(remedy_path "$SIGNATURE")" ]; then
      log ok "a remedy now exists for '$SIGNATURE' - the next occurrence self-heals."
    else
      log warn "service is back but NO remedy was written for '$SIGNATURE'; the next occurrence will escalate again."
    fi
    return 0
  fi
  log error "STILL DOWN after escalation: $SIGNATURE. claude exit $ESCALATE_RC; transcript: $ESCALATE_OUT"
  ledger_add "$SIGNATURE" "llm-failed" "claude exit $ESCALATE_RC"
  return 1
}

# ---- entrypoint -------------------------------------------------------------

if [ "$TEST_CLAUDE" -eq 1 ]; then
  c="$(find_claude)"
  if [ -z "$c" ]; then
    echo "claude NOT found - escalation would be impossible. Set TERMHUB_CLAUDE_BIN." >&2
    exit 1
  fi
  echo "launcher: $c"
  resolve_topology
  escalate --selftest
  echo "exit code: $ESCALATE_RC"
  echo "stdout:    $(cat "$ESCALATE_OUT" 2>/dev/null)"
  if grep -q READY "$ESCALATE_OUT" 2>/dev/null; then
    echo "escalation path is ARMED."
  else
    echo "the CLI did not answer as expected - escalation may not work." >&2
    exit 1
  fi
  exit 0
fi

if [ "$PROBE_ONLY" -eq 1 ]; then
  diagnose
  echo "signature: $SIGNATURE"
  [ -n "$DETAIL" ] && echo "detail:    $DETAIL"
  echo
  bundle
  if [ "$SIGNATURE" != "healthy" ]; then
    rp="$(remedy_path "$SIGNATURE")"
    echo
    if [ -f "$rp" ]; then echo "remedy for this signature: $rp"
    else echo "remedy for this signature: (none - this one would escalate to Claude Code)"; fi
  fi
  exit 0
fi

cycle

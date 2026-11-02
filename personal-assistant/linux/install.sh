#!/usr/bin/env bash
# personal-assistant — Linux install. The counterpart of windows/install.ps1.
#
#   linux/install.sh [--docker | --native | --skip-db] [--no-worker] [--no-audio]
#                    [--teams-cache] [--start]
#
# What it does, in order:
#   1. npm ci
#   2. the store: Postgres + pgvector on 127.0.0.1:5433, either
#        --docker  the docker-compose.yml container (Linux Docker runs Linux
#                  images — the right answer here; no root, no apt), or
#        --native  a dedicated `pa` cluster via linux/setup-postgres.sh (sudo;
#                  Debian/Ubuntu), which needs no Docker daemon.
#      Default: --docker when a Docker daemon answers, else --native.
#      Records which in .env as PA_PG_TOOLS, so backups reach the right pg_dump.
#   3. the schema (src/db/migrate.js)
#   4. the capture venv (audio/requirements.txt) — unless --no-audio
#   5. systemd *user* units: pa-worker, pa-capture@mic, pa-capture@loopback,
#      enabled for your login. Not started unless --start: like the Windows
#      tasks, the worker should start once .env is filled in, and recording is
#      your call, and reversible.
#
# It asks for nothing secret: credentials go through the dashboard or
# `pa secret set` (the Secret Service keyring), and `pa doctor` names what is
# missing. Idempotent; safe to re-run (a re-run after editing .env moves the
# capture units to the new paths).
#
# The Teams cache reader is not installed by default: there is no new Teams
# desktop client on Linux (README, "Teams in seconds"). --teams-cache installs
# its venv for the experimental Teams-web-cache route.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

DB=auto
WORKER=1
AUDIO=1
TEAMS=0
START=0
for arg in "$@"; do
  case "$arg" in
    --docker) DB=docker ;;
    --native) DB=native ;;
    --skip-db) DB=skip ;;
    --no-worker) WORKER=0 ;;
    --no-audio) AUDIO=0 ;;
    --teams-cache) TEAMS=1 ;;
    --start) START=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

say() { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }

echo "personal-assistant install (Linux)"
echo "  root: $ROOT"

# --- prerequisites -------------------------------------------------------------

command -v node >/dev/null 2>&1 || { echo "node not found — install Node.js 20+ first" >&2; exit 1; }
NODE="$(command -v node)"
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node $NODE_MAJOR is too old — need 20+" >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || warn "no systemctl — units are written but nothing is enabled; run the worker by hand (node src/worker.js)"

# --- dependencies --------------------------------------------------------------

say "npm ci"
( cd "$ROOT" && npm ci --no-audit --no-fund )

# --- .env ------------------------------------------------------------------------

ENV_FILE="$ROOT/.env"
if [ ! -f "$ENV_FILE" ]; then
  cp "$ROOT/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  say "wrote .env from .env.example — fill it in"
fi

# Sets KEY=value in .env, replacing an existing uncommented line.
set_env() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i -E "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

# --- the store -------------------------------------------------------------------

if [ "$DB" = auto ]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then DB=docker; else DB=native; fi
  say "store: $DB (pass --docker or --native to choose)"
fi

case "$DB" in
  docker)
    command -v docker >/dev/null 2>&1 || { echo "docker not found — install it, or use --native" >&2; exit 1; }
    say "starting the store container (docker compose, 127.0.0.1:5433)"
    ( cd "$ROOT" && docker compose up -d db )
    say "waiting for it to accept connections"
    for _ in $(seq 1 60); do
      docker exec pa-postgres pg_isready -U pa -d pa >/dev/null 2>&1 && break
      sleep 1
    done
    docker exec pa-postgres pg_isready -U pa -d pa >/dev/null || { echo "the container did not come up — docker logs pa-postgres" >&2; exit 1; }
    # `pa` is the container's superuser, so the first migration creates the
    # extensions itself. Backups use the container's own pg_dump, which always
    # matches the server.
    set_env PA_PG_TOOLS docker:pa-postgres
    ;;
  native)
    say "provisioning a native cluster (sudo)"
    sudo sh "$HERE/setup-postgres.sh"
    set_env PA_PG_TOOLS native
    ;;
  skip) say "store: skipped (--skip-db)" ;;
esac

# --- schema ----------------------------------------------------------------------

if [ "$DB" != skip ]; then
  say "applying migrations"
  ( cd "$ROOT" && "$NODE" src/db/migrate.js )
fi

# Where the worker keeps its files — the same resolution it uses, .env included.
DATA_DIR="$(cd "$ROOT" && "$NODE" -p 'require("./src/config").config.dataDir')"

venv() {  # venv <dir>: creates it, returns its python
  local dir="$1"
  if [ ! -x "$dir/bin/python" ]; then
    python3 -m venv "$dir" || { echo "python3 -m venv failed — install python3-venv" >&2; exit 1; }
  fi
  printf '%s' "$dir/bin/python"
}

# --- capture ---------------------------------------------------------------------

if [ "$AUDIO" = 1 ]; then
  command -v python3 >/dev/null 2>&1 || { echo "python3 not found — install it, or pass --no-audio" >&2; exit 1; }
  say "creating the capture venv"
  PY="$(venv "$DATA_DIR/venv")"
  say "installing capture dependencies"
  "$PY" -m pip install -q --disable-pip-version-check -r "$ROOT/audio/requirements.txt"
  # soundcard talks to the sound server through libpulse; the gate and the
  # mic choice ask pactl. PipeWire serves both through pipewire-pulse.
  command -v pactl >/dev/null 2>&1 || warn "pactl not found (pulseaudio-utils): no unplanned-call detection — pa doctor will say DEGRADED"
  if ! { ldconfig -p 2>/dev/null || /sbin/ldconfig -p 2>/dev/null; } | grep 'libpulse\.so' >/dev/null; then
    warn "libpulse not found (libpulse0): capture cannot open a device"
  fi
else
  set_env PA_AUDIO_ENABLED 0
fi

if [ "$TEAMS" = 1 ]; then
  say "installing the Teams cache reader (experimental on Linux)"
  TPY="$(venv "$DATA_DIR/teams-venv")"
  "$TPY" -I -m pip install -q --disable-pip-version-check \
    'https://github.com/cclgroupltd/ccl_simplesnappy/archive/3d085230baa8c46cf2090ebba29bf6e8eab31087.zip'
  "$TPY" -I -m pip install -q --disable-pip-version-check \
    'https://github.com/cclgroupltd/ccl_chromium_reader/archive/ef840de30221c4d65bc96d2f4d9057e9ef2f526d.zip'
  echo "    set PA_TEAMS_CACHE_DIR to a Teams web cache (pa doctor suggests one) to turn it on"
fi

# --- systemd user units ------------------------------------------------------------

UNITS=()
if [ "$WORKER" = 1 ]; then UNITS+=(--worker); fi
if [ "$AUDIO" = 1 ]; then UNITS+=(--capture); fi
if [ "${#UNITS[@]}" -gt 0 ]; then
  say "writing systemd user units"
  ( cd "$ROOT" && "$NODE" "$HERE/units.js" "${UNITS[@]}" )
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload
    if [ "$WORKER" = 1 ]; then
      systemctl --user enable pa-worker.service >/dev/null
      if [ "$START" = 1 ]; then systemctl --user restart pa-worker.service; fi
    fi
    if [ "$AUDIO" = 1 ]; then
      systemctl --user enable pa-capture@mic.service pa-capture@loopback.service >/dev/null
      if [ "$START" = 1 ]; then systemctl --user restart pa-capture@mic.service pa-capture@loopback.service; fi
    fi
    echo "    enabled for your login$([ "$START" = 1 ] && echo ' and started' || echo ' (not started — see Next)')"
  fi
fi

echo
echo "Next:"
echo "  1. Fill in $ENV_FILE  (see .env.example; secrets go in with \`node bin/pa.js secret set NAME\`)"
echo "  2. node bin/pa.js login          check the Microsoft 365 connector, record who you are"
echo "  3. node bin/pa.js projects sync   seed the project table"
echo "  4. node bin/pa.js doctor          every line ok, or DEGRADED with a reason"
if [ "$WORKER" = 1 ]; then echo "  5. systemctl --user start pa-worker"; fi
if [ "$AUDIO" = 1 ]; then echo "  6. systemctl --user start pa-capture@mic pa-capture@loopback   (recording — your call)"; fi
echo
echo "Headless box? \`sudo loginctl enable-linger $USER\` keeps the worker running with nobody logged in."

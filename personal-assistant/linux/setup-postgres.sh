#!/bin/sh
# Provisions the store natively on Debian or Ubuntu. Run as root:
#
#   sudo sh linux/setup-postgres.sh
#
# A *dedicated cluster* named `pa` on port 5433 (Debian's postgresql-common:
# pg_createcluster), not the distro's main cluster with its port changed. A
# machine that already runs Postgres on 5432 keeps it untouched, and this
# store — which holds your mail — is never confused with it. It listens on
# localhost only: unlike WSL (windows/setup-wsl-postgres.sh) there is no NAT to
# reach across, so nothing here is reachable from the network.
#
# The other Linux route is the compose container (`linux/install.sh --docker`),
# which needs no root and no apt; this one needs no Docker daemon and survives
# without one. Either way: Postgres + pgvector on 127.0.0.1:5433, role/db `pa`.
#
# Idempotent. Safe to re-run. Other distributions: use --docker, or install
# Postgres 16 + pgvector yourself and create the role, database and the
# `vector` and `pg_trgm` extensions as below.

set -e

PGVER="${PGVER:-16}"
PORT=5433
CLUSTER=pa

if ! command -v apt-get >/dev/null 2>&1; then
  echo "setup-postgres: this script provisions Debian/Ubuntu (apt). Use linux/install.sh --docker instead." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

# 16 where the distro has it (Ubuntu 24.04, Debian 13); otherwise the newest
# major the distro packages *with* pgvector.
if ! apt-cache show "postgresql-${PGVER}-pgvector" >/dev/null 2>&1; then
  ALT="$(apt-cache search --names-only '^postgresql-[0-9]+-pgvector$' | sed -E 's/^postgresql-([0-9]+)-pgvector.*/\1/' | sort -n | tail -1)"
  if [ -z "$ALT" ]; then
    echo "setup-postgres: no postgresql-NN-pgvector package here — add the PGDG apt repo, or use --docker." >&2
    exit 1
  fi
  echo "==> postgresql-${PGVER}-pgvector is not packaged here; using ${ALT}"
  PGVER="$ALT"
fi

echo "==> installing postgresql-${PGVER} and pgvector"
apt-get install -y -qq "postgresql-${PGVER}" "postgresql-${PGVER}-pgvector" postgresql-client-common

if ! pg_lsclusters -h | awk '{print $1" "$2}' | grep -qx "${PGVER} ${CLUSTER}"; then
  echo "==> creating cluster ${PGVER}/${CLUSTER} on port ${PORT}"
  # C collation, as the compose store uses: full-text ranking must not shift
  # under a libc upgrade.
  pg_createcluster "${PGVER}" "${CLUSTER}" --port "${PORT}" --locale C --encoding UTF8 >/dev/null
fi
# Loopback only. Debian's default pg_hba already allows scram-sha-256 from
# 127.0.0.1/::1 and nothing from elsewhere.
pg_conftool "${PGVER}" "${CLUSTER}" set listen_addresses localhost

echo "==> starting postgresql@${PGVER}-${CLUSTER}"
systemctl enable "postgresql@${PGVER}-${CLUSTER}" >/dev/null 2>&1 || true
systemctl restart "postgresql@${PGVER}-${CLUSTER}"
sleep 2

echo "==> role, database, extensions"
su - postgres -c "psql -p ${PORT} -tAc \"select 1 from pg_roles where rolname='pa'\"" | grep -q 1 \
  || su - postgres -c "psql -p ${PORT} -c \"create role pa login password 'pa'\""
su - postgres -c "psql -p ${PORT} -tAc \"select 1 from pg_database where datname='pa'\"" | grep -q 1 \
  || su - postgres -c "createdb -p ${PORT} -O pa pa"
su - postgres -c "psql -p ${PORT} -d pa -c 'create extension if not exists vector' -c 'create extension if not exists pg_trgm'"

echo
echo "ready: postgres://pa:pa@127.0.0.1:${PORT}/pa  (cluster ${PGVER}/${CLUSTER})"

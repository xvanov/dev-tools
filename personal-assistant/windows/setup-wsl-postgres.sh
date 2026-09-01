#!/bin/sh
# Provisions the store inside WSL. Run as root in the distro:
#
#   wsl -d Ubuntu -u root -e sh /mnt/c/repos/dev-tools/personal-assistant/windows/setup-wsl-postgres.sh
#
# Why WSL and not Docker: Docker Desktop on this machine runs the Windows
# container engine, and there is no Windows image for Postgres, let alone one
# with pgvector. Switching Docker's engine is a machine-wide change with its own
# consequences, so the store lives in the WSL distro that already exists. The
# docker-compose.yml in this directory remains the right answer on a box whose
# Docker runs Linux containers.
#
# Port 5433, not 5432: this is a personal store holding your mail, and it must
# never be confused with — or collide with — another Postgres on the machine.
#
# Idempotent. Safe to re-run.

set -e

PGVER=16
PORT=5433
CONF="/etc/postgresql/${PGVER}/main/postgresql.conf"
HBA="/etc/postgresql/${PGVER}/main/pg_hba.conf"

echo "==> installing postgresql-${PGVER} and pgvector"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq "postgresql-${PGVER}" "postgresql-${PGVER}-pgvector"

echo "==> configuring port ${PORT} and the WSL NAT"
sed -i "s/^#*port *=.*/port = ${PORT}/" "$CONF"
# Listening on all interfaces is what makes WSL's localhost forwarding reach it
# from Windows. The distro is not itself reachable from the network, and pg_hba
# still gates who may authenticate.
sed -i "s/^#*listen_addresses *=.*/listen_addresses = '*'/" "$CONF"

if ! grep -q 'personal-assistant' "$HBA"; then
  cat >> "$HBA" <<'HBAEOF'

# personal-assistant: the Windows host, over the WSL NAT (address varies per boot)
host    pa    pa    127.0.0.1/32    scram-sha-256
host    pa    pa    10.0.0.0/8      scram-sha-256
host    pa    pa    172.16.0.0/12   scram-sha-256
host    pa    pa    192.168.0.0/16  scram-sha-256
HBAEOF
fi

echo "==> starting postgres"
systemctl enable postgresql >/dev/null 2>&1 || true
systemctl restart postgresql
sleep 2

echo "==> role, database, extensions"
su - postgres -c "psql -p ${PORT} -tAc \"select 1 from pg_roles where rolname='pa'\"" | grep -q 1 \
  || su - postgres -c "psql -p ${PORT} -c \"create role pa login password 'pa'\""
su - postgres -c "psql -p ${PORT} -tAc \"select 1 from pg_database where datname='pa'\"" | grep -q 1 \
  || su - postgres -c "createdb -p ${PORT} -O pa pa"
su - postgres -c "psql -p ${PORT} -d pa -c 'create extension if not exists vector' -c 'create extension if not exists pg_trgm'"

echo
echo "ready: postgres://pa:pa@127.0.0.1:${PORT}/pa"
echo
echo "NOTE: WSL terminates a distro once the last wsl.exe client exits, taking"
echo "      Postgres with it — even though systemd is running it. install.ps1"
echo "      registers a logon task that holds the distro open. Without that,"
echo "      connections from Windows fail with ECONNREFUSED at random."

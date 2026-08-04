#!/bin/sh
set -eu
target=/restore-drill
mkdir -p "$target"
find "$target" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
restic --retry-lock 10m restore latest --host scry-production --tag postgres-base --target "$target" --include /staging/postgres-base
restic --retry-lock 10m restore latest --host scry-production --tag postgres-wal --target "$target" --include /wal-archive
data="$target/staging/postgres-base"
wal="$target/wal-archive"
test -f "$data/PG_VERSION"
chown -R postgres:postgres "$target"
chmod 0700 "$data"
touch "$data/recovery.signal"
{
  echo "restore_command = 'cp ${wal}/%f %p'"
  echo "recovery_target_action = 'promote'"
  echo "listen_addresses = '127.0.0.1'"
  echo "port = 55432"
} >> "$data/postgresql.auto.conf"
gosu postgres pg_ctl -D "$data" -w -t "${RESTORE_DRILL_RTO_SECONDS:-3600}" start
gosu postgres psql -p 55432 -U "${PGUSER:-scry}" -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_is_in_recovery(), current_timestamp" >/dev/null
gosu postgres pg_ctl -D "$data" -m fast -w stop
find "$target" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +

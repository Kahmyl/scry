#!/bin/sh
set -eu
: "${PGHOST:=postgres}" "${PGPORT:=5432}" "${PGUSER:=scry}" "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
export PGPASSWORD="$POSTGRES_PASSWORD"
pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER"
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_switch_wal()" >/dev/null
attempt=0
while ! find /wal-archive -maxdepth 1 -type f -name '[0-9A-F]*' | grep -q .; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { echo "no completed WAL segment reached the archive" >&2; exit 1; }
  sleep 1
done
restic --retry-lock 10m backup /wal-archive --host scry-production --tag postgres-wal --tag pitr
listing=/tmp/postgres-wal-snapshot.txt
restic --retry-lock 10m ls latest --host scry-production --tag postgres-wal > "$listing"
grep -Eq '/wal-archive/[0-9A-F]{24}$' "$listing"
rm -f "$listing"

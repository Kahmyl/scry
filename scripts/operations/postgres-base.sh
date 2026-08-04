#!/bin/sh
set -eu
: "${PGHOST:=postgres}" "${PGPORT:=5432}" "${PGUSER:=scry}" "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
export PGPASSWORD="$POSTGRES_PASSWORD"
staging=/staging/postgres-base
rm -rf "$staging"
mkdir -p "$staging"
pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER"
pg_basebackup -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -D "$staging" --format=plain --wal-method=stream --checkpoint=fast --manifest-checksums=SHA256
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_switch_wal()" >/dev/null
restic --retry-lock 10m backup "$staging" --host scry-production --tag postgres-base --tag pitr
listing=/tmp/postgres-base-snapshot.txt
restic --retry-lock 10m ls latest --host scry-production --tag postgres-base > "$listing"
grep -q "/staging/postgres-base/PG_VERSION$" "$listing"
grep -q "/staging/postgres-base/backup_manifest$" "$listing"
rm -f "$listing"
rm -rf "$staging"

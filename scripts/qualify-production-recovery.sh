#!/bin/sh
set -eu

suffix="$(date +%s)-$$"
network="scry-recovery-${suffix}"
postgres_container="scry-recovery-postgres-${suffix}"
data_volume="scry-recovery-data-${suffix}"
wal_volume="scry-recovery-wal-${suffix}"
staging_volume="scry-recovery-staging-${suffix}"
repository_volume="scry-recovery-repository-${suffix}"
drill_volume="scry-recovery-drill-${suffix}"
backup_image="scry-backup:production-qualification"
password="scry-production-recovery-qualification"
repository_password="scry-production-recovery-encryption-qualification"
started="$(date +%s)"

cleanup() {
  docker rm -f "$postgres_container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  for volume in "$data_volume" "$wal_volume" "$staging_volume" "$repository_volume" "$drill_volume"; do
    docker volume rm "$volume" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT INT TERM

docker build -q -f docker/Dockerfile.backup -t "$backup_image" . >/dev/null
docker network create "$network" >/dev/null
for volume in "$data_volume" "$wal_volume" "$staging_volume" "$repository_volume" "$drill_volume"; do
  docker volume create "$volume" >/dev/null
done
docker run --rm --user root -v "${wal_volume}:/wal-archive" postgres:17-alpine \
  sh -c 'chown -R postgres:postgres /wal-archive && chmod 0700 /wal-archive'
docker run -d --name "$postgres_container" --network "$network" \
  -e POSTGRES_DB=scry -e POSTGRES_USER=scry -e "POSTGRES_PASSWORD=${password}" \
  -v "${data_volume}:/var/lib/postgresql/data" -v "${wal_volume}:/wal-archive" \
  -v "$(pwd)/ops/postgres/pg_hba.conf:/etc/postgresql/pg_hba.conf:ro" \
  postgres:17-alpine postgres -c wal_level=replica -c archive_mode=on -c archive_timeout=5s \
  -c hba_file=/etc/postgresql/pg_hba.conf \
  -c "archive_command=test -f /wal-archive/%f || (cp %p /wal-archive/.%f.tmp && chmod 0600 /wal-archive/.%f.tmp && mv /wal-archive/.%f.tmp /wal-archive/%f)" >/dev/null

attempt=0
until docker exec "$postgres_container" pg_isready -U scry -d scry >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { docker logs "$postgres_container"; exit 1; }
  sleep 1
done
docker exec "$postgres_container" psql -U scry -d scry -v ON_ERROR_STOP=1 \
  -c "CREATE TABLE recovery_probe(id integer PRIMARY KEY, value text NOT NULL); INSERT INTO recovery_probe VALUES(1,'qualified');" >/dev/null

docker run --rm -e RESTIC_REPOSITORY=/repository -e "RESTIC_PASSWORD=${repository_password}" \
  -v "${repository_volume}:/repository" "$backup_image" init >/dev/null
common="--rm --network ${network} -e RESTIC_REPOSITORY=/repository -e RESTIC_PASSWORD=${repository_password} -e PGHOST=${postgres_container} -e PGUSER=scry -e POSTGRES_PASSWORD=${password} -v ${repository_volume}:/repository"
# shellcheck disable=SC2086
docker run $common -v "${staging_volume}:/staging" --entrypoint /usr/local/lib/scry/operations/postgres-base.sh "$backup_image"
# shellcheck disable=SC2086
docker run $common -v "${wal_volume}:/wal-archive:ro" --entrypoint /usr/local/lib/scry/operations/postgres-wal.sh "$backup_image"

drill_started="$(date +%s)"
docker run --rm -e RESTIC_REPOSITORY=/repository -e "RESTIC_PASSWORD=${repository_password}" \
  -e PGUSER=scry -e RESTORE_DRILL_RTO_SECONDS=3600 \
  -v "${repository_volume}:/repository" -v "${drill_volume}:/restore-drill" \
  --entrypoint /usr/local/lib/scry/operations/restore-drill.sh "$backup_image"
drill_seconds=$(($(date +%s) - drill_started))
[ "$drill_seconds" -le 3600 ]

completed="$(date +%s)"
printf '{"campaign":"production-recovery-qualification","status":"passed","postgres":"17","encryptedSnapshots":true,"baseBackup":true,"walArchive":true,"restoreAndPromotion":true,"integrityQuery":true,"restoreDrillSeconds":%s,"durationSeconds":%s}\n' \
  "$drill_seconds" "$((completed - started))"

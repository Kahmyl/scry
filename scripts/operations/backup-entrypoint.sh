#!/bin/sh
set -eu

mode="${1:-}"
case "$mode" in
  init|postgres-base|postgres-wal|artifacts|maintenance|restore-drill) ;;
  *) echo "unsupported backup mode: $mode" >&2; exit 64 ;;
esac

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD is required}"
: "${BACKUP_METRICS_DIR:=/metrics}"
mkdir -p "$BACKUP_METRICS_DIR"

if [ "$mode" = init ]; then
  restic snapshots >/dev/null 2>&1 || restic init
  restic snapshots >/dev/null
  exit 0
fi

restic snapshots >/dev/null

interval_for() {
  case "$mode" in
    postgres-base) echo "${POSTGRES_BASE_BACKUP_INTERVAL_SECONDS:-86400}" ;;
    postgres-wal) echo "${POSTGRES_WAL_BACKUP_INTERVAL_SECONDS:-300}" ;;
    artifacts) echo "${ARTIFACT_BACKUP_INTERVAL_SECONDS:-900}" ;;
    maintenance) echo "${BACKUP_MAINTENANCE_INTERVAL_SECONDS:-86400}" ;;
    restore-drill) echo "${RESTORE_DRILL_INTERVAL_SECONDS:-604800}" ;;
  esac
}

while true; do
  started="$(date +%s)"
  if "/usr/local/lib/scry/operations/${mode}.sh"; then
    status=1
  else
    status=0
  fi
  completed="$(date +%s)"
  if [ "$mode" = restore-drill ] && [ "$status" -eq 1 ] && [ "$((completed - started))" -gt "${RESTORE_DRILL_RTO_SECONDS:-3600}" ]; then
    status=0
    echo "restore drill exceeded RTO" >&2
  fi
  temporary="${BACKUP_METRICS_DIR}/.${mode}.prom.tmp"
  {
    echo "scry_backup_last_success_unixtime{job=\"${mode}\"} $([ "$status" -eq 1 ] && echo "$completed" || echo 0)"
    echo "scry_backup_last_run_status{job=\"${mode}\"} ${status}"
    echo "scry_backup_last_duration_seconds{job=\"${mode}\"} $((completed - started))"
  } > "$temporary"
  mv "$temporary" "${BACKUP_METRICS_DIR}/${mode}.prom"
  [ "$status" -eq 1 ] || echo "backup operation failed: ${mode}" >&2
  if [ "$status" -eq 1 ]; then
    sleep "$(interval_for)"
  else
    sleep "${BACKUP_RETRY_SECONDS:-60}"
  fi
done

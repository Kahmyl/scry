#!/usr/bin/env bash
set -euo pipefail

action="${1:-}"
snapshot="${2:-}"
compose_file="${SCRY_COMPOSE_FILE:-compose.deploy.yml}"
if [[ "$snapshot" != /* || "$snapshot" == "/" || -z "$action" ]]; then
  echo "usage: $0 snapshot|restore /absolute/snapshot.dump" >&2
  exit 64
fi

case "$action" in
  snapshot)
    temporary="${snapshot}.partial"
    rm -f "$temporary"
    docker compose -f "$compose_file" exec -T postgres pg_dump -U scry -d scry -Fc > "$temporary"
    test -s "$temporary"
    mv "$temporary" "$snapshot"
    ;;
  restore)
    if [[ "${SCRY_WRITERS_STOPPED:-false}" != "true" ]]; then
      echo "VEIL_RESTORE_WRITERS_ACTIVE" >&2
      exit 65
    fi
    test -s "$snapshot"
    docker compose -f "$compose_file" exec -T postgres psql -U scry -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='scry' AND pid<>pg_backend_pid()"
    docker compose -f "$compose_file" exec -T postgres dropdb -U scry --if-exists scry
    docker compose -f "$compose_file" exec -T postgres createdb -U scry scry
    docker compose -f "$compose_file" exec -T postgres pg_restore -U scry -d scry --exit-on-error < "$snapshot"
    ;;
  *) echo "VEIL_SNAPSHOT_ACTION_INVALID" >&2; exit 64 ;;
esac

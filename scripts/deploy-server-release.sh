#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

log() {
  printf '[scry-deploy] %s\n' "$*"
}

fail() {
  printf '[scry-deploy] ERROR: %s\n' "$*" >&2
  return 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

deploy_dir=${1:-}
release_id=${2:-}
image_ref=${3:-}
schema_fingerprint=${4:-}
incoming_compose=${5:-}

[[ "$deploy_dir" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "deployment directory must be an absolute simple path"
[[ "$release_id" =~ ^[0-9a-f]{40}$ ]] || fail "release ID must be an exact lowercase commit SHA"
[[ "$image_ref" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] ||
  fail "application image must be pinned by sha256 digest"
[[ "$schema_fingerprint" =~ ^[0-9a-f]{64}$ ]] || fail "schema fingerprint must be sha256"
[[ -f "$incoming_compose" ]] || fail "candidate Compose file does not exist"

for command_name in docker flock awk sed stat; do
  require_command "$command_name"
done

state_root="$deploy_dir/.scry-deploy"
release_dir="$state_root/releases/$release_id"
current_state="$state_root/current.env"
env_file=${SCRY_DEPLOY_ENV_FILE:-$deploy_dir/.env}
health_timeout=${SCRY_DEPLOY_HEALTH_TIMEOUT_SECONDS:-180}

[[ "$health_timeout" =~ ^[1-9][0-9]{0,3}$ ]] || fail "health timeout must be 1-9999 seconds"
[[ -f "$env_file" ]] || fail "deployment environment file is missing: $env_file"

mkdir -p "$release_dir"
exec 9>"$state_root/deploy.lock"
flock -n 9 || fail "another Scry deployment is already running"

env_mode=$(stat -c '%a' "$env_file")
if (( (8#$env_mode & 077) != 0 )); then
  fail "deployment environment must not be readable by group or other users (current mode: $env_mode)"
fi

compose_version=$(docker compose version --short)
compose_version=${compose_version#v}
minimum_compose_version=2.34.0
version_at_least() {
  local actual=$1
  local required=$2
  local actual_major actual_minor actual_patch required_major required_minor required_patch
  IFS=. read -r actual_major actual_minor actual_patch <<<"${actual%%[-+]*}"
  IFS=. read -r required_major required_minor required_patch <<<"$required"
  [[ "$actual_major" =~ ^[0-9]+$ && "$actual_minor" =~ ^[0-9]+$ && "$actual_patch" =~ ^[0-9]+$ ]] ||
    return 1
  (( actual_major > required_major )) ||
    (( actual_major == required_major && actual_minor > required_minor )) ||
    (( actual_major == required_major && actual_minor == required_minor && actual_patch >= required_patch ))
}
if ! version_at_least "$compose_version" "$minimum_compose_version"; then
  fail "Docker Compose $minimum_compose_version or later is required; found $compose_version"
fi

candidate_compose="$release_dir/compose.yml"
install -m 0600 "$incoming_compose" "$candidate_compose"

run_compose() {
  local compose_files=$1
  local selected_image=$2
  local selected_release=$3
  local selected_schema=$4
  local compose_file
  local -a compose_arguments=()
  local -a selected_compose_files=()
  shift 4
  IFS=',' read -r -a selected_compose_files <<<"$compose_files"
  ((${#selected_compose_files[@]} > 0)) || fail "no Compose files were selected"
  for compose_file in "${selected_compose_files[@]}"; do
    [[ "$compose_file" =~ ^/[A-Za-z0-9._/-]+$ && -f "$compose_file" ]] ||
      fail "selected Compose file is invalid or missing: $compose_file"
    compose_arguments+=(-f "$compose_file")
  done
  SCRY_IMAGE_REF="$selected_image" \
    SCRY_RELEASE_ID="$selected_release" \
    SCRY_SCHEMA_FINGERPRINT="$selected_schema" \
    docker compose \
      --project-name scry \
      --env-file "$env_file" \
      "${compose_arguments[@]}" \
      "$@"
}

run_candidate() {
  run_compose "$candidate_compose" "$image_ref" "$release_id" "$schema_fingerprint" "$@"
}

container_env_value() {
  local container_id=$1
  local variable_name=$2
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" |
    awk -v prefix="$variable_name=" 'index($0,prefix)==1 { print substr($0,length(prefix)+1); exit }'
}

write_current_state() {
  local selected_release=$1
  local selected_image=$2
  local selected_schema=$3
  local selected_compose_files=$4
  local temporary_state="$current_state.tmp"
  {
    printf 'CURRENT_RELEASE_ID=%s\n' "$selected_release"
    printf 'CURRENT_IMAGE_REF=%s\n' "$selected_image"
    printf 'CURRENT_SCHEMA_FINGERPRINT=%s\n' "$selected_schema"
    printf 'CURRENT_COMPOSE_FILES=%s\n' "$selected_compose_files"
  } >"$temporary_state"
  mv "$temporary_state" "$current_state"
}

validate_compose_files() {
  local compose_files=$1
  local compose_file
  local -a selected_compose_files
  IFS=',' read -r -a selected_compose_files <<<"$compose_files"
  ((${#selected_compose_files[@]} > 0)) || return 1
  for compose_file in "${selected_compose_files[@]}"; do
    [[ "$compose_file" =~ ^/[A-Za-z0-9._/-]+$ && -f "$compose_file" ]] || return 1
  done
}

discover_running_compose_files() {
  local container_id=$1
  local configured_files working_directory configured_file resolved_file
  local -a candidates resolved=()
  configured_files=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$container_id")
  working_directory=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$container_id")

  if [[ -n "$configured_files" ]]; then
    IFS=',' read -r -a candidates <<<"$configured_files"
    for configured_file in "${candidates[@]}"; do
      resolved_file=$configured_file
      if [[ "$resolved_file" != /* ]]; then
        resolved_file="$working_directory/$resolved_file"
      fi
      if [[ "$resolved_file" =~ ^/[A-Za-z0-9._/-]+$ && -f "$resolved_file" ]]; then
        resolved+=("$resolved_file")
      else
        resolved=()
        break
      fi
    done
    if ((${#resolved[@]} > 0)); then
      local IFS=,
      printf '%s' "${resolved[*]}"
      return 0
    fi
  fi

  for configured_file in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
    resolved_file="$deploy_dir/$configured_file"
    if [[ -f "$resolved_file" ]]; then
      printf '%s' "$resolved_file"
      return 0
    fi
  done
  return 1
}

previous_available=false
previous_release=''
previous_image=''
previous_schema=''
previous_compose=''

if [[ -f "$current_state" ]]; then
  state_value() {
    local key=$1
    awk -v prefix="$key=" 'index($0,prefix)==1 { print substr($0,length(prefix)+1); exit }' "$current_state"
  }
  previous_release=$(state_value CURRENT_RELEASE_ID)
  previous_image=$(state_value CURRENT_IMAGE_REF)
  previous_schema=$(state_value CURRENT_SCHEMA_FINGERPRINT)
  previous_compose=$(state_value CURRENT_COMPOSE_FILES)
  previous_compose=${previous_compose:-$(state_value CURRENT_COMPOSE_FILE)}
  [[ "$previous_release" =~ ^[0-9a-f]{40}$ ]] || fail "saved current release ID is invalid"
  [[ "$previous_image" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] ||
    fail "saved current image is not immutable"
  [[ "$previous_schema" =~ ^[0-9a-f]{64}$ ]] || fail "saved current schema is invalid"
  validate_compose_files "$previous_compose" || fail "saved current Compose files are invalid"
  previous_available=true
else
  existing_api=$(docker ps -q \
    --filter label=com.docker.compose.project=scry \
    --filter label=com.docker.compose.service=api | head -n 1)
  if [[ -n "$existing_api" ]]; then
    previous_release=$(container_env_value "$existing_api" SCRY_RELEASE_ID)
    previous_schema=$(container_env_value "$existing_api" SCRY_SCHEMA_FINGERPRINT)
    previous_image=$(docker inspect --format '{{.Config.Image}}' "$existing_api")
    previous_compose=$(discover_running_compose_files "$existing_api") ||
      fail "a running release exists but its recorded Compose files are unavailable"
    [[ "$previous_release" =~ ^[0-9a-f]{40}$ ]] ||
      fail "running API does not expose an immutable release ID"
    [[ "$previous_image" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] ||
      fail "running API image is not pinned by digest"
    [[ "$previous_schema" =~ ^[0-9a-f]{64}$ ]] ||
      fail "running API does not expose a schema fingerprint"
    write_current_state "$previous_release" "$previous_image" "$previous_schema" "$previous_compose"
    previous_available=true
    log "Bootstrapped rollback metadata from running release $previous_release."
  fi
fi

log "Pulling immutable candidate image $image_ref."
docker pull "$image_ref" >/dev/null
resolved_image=$(docker image inspect --format '{{index .RepoDigests 0}}' "$image_ref")
[[ "${resolved_image##*@}" == "${image_ref##*@}" ]] ||
  fail "pulled image digest does not match the requested digest"
image_release=$(docker image inspect --format '{{index .Config.Labels "org.scry.release-id"}}' "$image_ref")
image_schema=$(docker image inspect --format '{{index .Config.Labels "org.scry.schema-fingerprint"}}' "$image_ref")
[[ "$image_release" == "$release_id" ]] ||
  fail "image release label does not match requested release"
[[ "$image_schema" == "$schema_fingerprint" ]] ||
  fail "image schema label does not match requested schema"

log "Validating candidate configuration before touching running services."
run_candidate config --quiet
docker run --rm \
  --env-file "$env_file" \
  -e SCRY_IMAGE_REF="$image_ref" \
  -e SCRY_RELEASE_ID="$release_id" \
  -e SCRY_SCHEMA_FINGERPRINT="$schema_fingerprint" \
  "$image_ref" node scripts/verify-deployment-preflight.mjs
run_candidate pull --quiet

deployment_env_value() {
  local key=$1
  local value
  value=$(awk -v prefix="$key=" 'index($0,prefix)==1 { print substr($0,length(prefix)+1); exit }' "$env_file")
  if [[ ( "${value:0:1}" == '"' && "${value: -1}" == '"' ) ||
    ( "${value:0:1}" == "'" && "${value: -1}" == "'" ) ]]; then
    value=${value:1:${#value}-2}
  fi
  printf '%s' "$value"
}

database_name=$(deployment_env_value SCRY_DATABASE_NAME)
database_name=${database_name:-scry_browser_v2}
[[ "$database_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail "SCRY_DATABASE_NAME is invalid"

health_check() {
  local compose_file=$1
  local selected_image=$2
  local selected_release=$3
  local selected_schema=$4
  run_compose "$compose_file" "$selected_image" "$selected_release" "$selected_schema" \
    exec -T api wget -qO- http://127.0.0.1:4000/api/v2/health >/dev/null
  run_compose "$compose_file" "$selected_image" "$selected_release" "$selected_schema" \
    exec -T mcp wget -qO- http://127.0.0.1:4100/health >/dev/null
  run_compose "$compose_file" "$selected_image" "$selected_release" "$selected_schema" \
    exec -T web wget -qO- http://127.0.0.1:3000/ >/dev/null
  for service in api worker mcp web; do
    actual_release=$(run_compose "$compose_file" "$selected_image" "$selected_release" "$selected_schema" \
      exec -T "$service" printenv SCRY_RELEASE_ID)
    [[ "$actual_release" == "$selected_release" ]] ||
      fail "$service is running release $actual_release instead of $selected_release"
  done
}

if [[ "$previous_available" == true &&
  "$previous_release" == "$release_id" &&
  "$previous_image" == "$image_ref" &&
  "$previous_schema" == "$schema_fingerprint" ]]; then
  if health_check "$previous_compose" "$previous_image" "$previous_release" "$previous_schema"; then
    write_current_state "$release_id" "$image_ref" "$schema_fingerprint" "$candidate_compose"
    log "Release $release_id is already healthy; deployment replay completed without interruption."
    exit 0
  fi
  log "The selected release is recorded but unhealthy; proceeding with a controlled repair."
fi

backup_file="$release_dir/pre-deploy.dump"
database_touched=false
phase=preflight

rollback() {
  local original_status=$1
  local recovery_failed=false
  trap - ERR
  set +e
  printf '[scry-deploy] Candidate failed during %s; beginning recovery.\n' "$phase" >&2
  rm -f "$current_state.pending"
  run_candidate stop -t 30 caddy web mcp worker api migrate >/dev/null 2>&1 ||
    recovery_failed=true

  if [[ "$database_touched" == true && -s "$backup_file" ]]; then
    log "Restoring the fenced pre-deployment database snapshot."
    if ! run_candidate exec -T postgres dropdb -U scry --maintenance-db=postgres --if-exists --force "$database_name"; then
      recovery_failed=true
    elif ! run_candidate exec -T postgres createdb -U scry --maintenance-db=postgres "$database_name"; then
      recovery_failed=true
    elif ! run_candidate exec -T postgres pg_restore -U scry -d "$database_name" --exit-on-error <"$backup_file"; then
      recovery_failed=true
    fi
  fi

  if [[ "$previous_available" == true && "$recovery_failed" == false ]]; then
    log "Restarting previous release $previous_release."
    if ! run_compose "$previous_compose" "$previous_image" "$previous_release" "$previous_schema" \
      up -d --no-deps --force-recreate --wait --wait-timeout "$health_timeout" api worker mcp web caddy; then
      recovery_failed=true
    elif ! health_check "$previous_compose" "$previous_image" "$previous_release" "$previous_schema"; then
      recovery_failed=true
    fi
  fi

  if [[ "$recovery_failed" == true ]]; then
    run_candidate stop -t 30 caddy >/dev/null 2>&1 || true
    printf '[scry-deploy] CRITICAL: automatic recovery did not complete; public traffic remains fenced.\n' >&2
    exit 90
  elif [[ "$previous_available" == true ]]; then
    printf '[scry-deploy] Previous release restored after candidate failure.\n' >&2
  else
    printf '[scry-deploy] No previous release exists; candidate services remain stopped.\n' >&2
  fi
  exit "$original_status"
}

trap 'rollback $?' ERR

if [[ "$previous_available" == true ]]; then
  phase=traffic_fence
  run_compose "$previous_compose" "$previous_image" "$previous_release" "$previous_schema" stop -t 30 caddy
  active_work=$(run_compose "$previous_compose" "$previous_image" "$previous_release" "$previous_schema" \
    exec -T postgres psql -U scry -d "$database_name" -Atqc \
    "SELECT (SELECT count(*) FROM browser_execution_sessions WHERE state IN ('starting','active','finalizing')) + (SELECT count(*) FROM browser_commands WHERE state IN ('queued','running'))")
  if [[ "$active_work" != 0 ]]; then
    run_compose "$previous_compose" "$previous_image" "$previous_release" "$previous_schema" start caddy
    fail "deployment refused because $active_work browser work item(s) are nonterminal"
  fi
  run_compose "$previous_compose" "$previous_image" "$previous_release" "$previous_schema" \
    stop -t 30 web mcp worker api

  phase=database_backup
  log "Capturing a fenced PostgreSQL snapshot."
  run_compose "$previous_compose" "$previous_image" "$previous_release" "$previous_schema" \
    exec -T postgres pg_dump -U scry -d "$database_name" -Fc >"$backup_file"
  [[ -s "$backup_file" ]] || fail "pre-deployment database snapshot is empty"
fi

phase=infrastructure
run_candidate up -d --wait --wait-timeout "$health_timeout" postgres redis
database_exists=$(run_candidate exec -T postgres psql -U scry -d postgres -Atqc \
  "SELECT 1 FROM pg_database WHERE datname='$database_name'")
[[ "$database_exists" == 1 ]] ||
  fail "target database $database_name is missing; complete an explicit installation or cutover first"

if [[ "$previous_available" == false ]]; then
  phase=database_backup
  log "Capturing the initial PostgreSQL snapshot."
  run_candidate exec -T postgres pg_dump -U scry -d "$database_name" -Fc >"$backup_file"
  [[ -s "$backup_file" ]] || fail "pre-deployment database snapshot is empty"
fi

phase=migration
database_touched=true
log "Running the candidate migration as a separate release gate."
run_candidate run --rm --no-deps migrate

phase=candidate_startup
run_candidate up -d --no-deps --force-recreate --wait --wait-timeout "$health_timeout" api worker
run_candidate up -d --no-deps --force-recreate --wait --wait-timeout "$health_timeout" mcp web

phase=health_verification
health_check "$candidate_compose" "$image_ref" "$release_id" "$schema_fingerprint"
run_candidate run --rm --no-deps caddy validate --config /etc/caddy/Caddyfile

phase=activation
{
  printf 'CURRENT_RELEASE_ID=%s\n' "$release_id"
  printf 'CURRENT_IMAGE_REF=%s\n' "$image_ref"
  printf 'CURRENT_SCHEMA_FINGERPRINT=%s\n' "$schema_fingerprint"
  printf 'CURRENT_COMPOSE_FILE=%s\n' "$candidate_compose"
} >"$current_state.pending"
run_candidate up -d --no-deps --force-recreate --wait --wait-timeout "$health_timeout" caddy
trap - ERR
mv "$current_state.pending" "$current_state"
deployed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat >"$release_dir/receipt.json" <<EOF
{
  "releaseId": "$release_id",
  "imageRef": "$image_ref",
  "schemaFingerprint": "$schema_fingerprint",
  "deployedAt": "$deployed_at",
  "databaseBackup": "pre-deploy.dump",
  "verdict": "pass"
}
EOF
log "Release $release_id is healthy and active."

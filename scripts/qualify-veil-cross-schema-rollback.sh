#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
project="scry-veil-rollback-$(printf '%s' "$run_id" | tr '[:upper:]' '[:lower:]')"
work="$(mktemp -d)"
report="$repo_root/docs/architecture/evidence/veil-cross-schema-rollback.json"
schema_a="$(node scripts/schema-fingerprint.mjs)"
schema_b="$(node -e "process.stdout.write(require('crypto').createHash('sha256').update(process.argv[1]+':rollback-qualification-v1').digest('hex'))" "$schema_a")"
release_a="rollback-prior-$run_id"
release_b="rollback-current-$run_id"
image_a="scry-rollback-prior:$run_id"
image_b="scry-rollback-current:$run_id"
snapshot_a="$work/schema-a.dump"
snapshot_b="$work/schema-b.dump"

export COMPOSE_PROJECT_NAME="$project" SCRY_COMPOSE_FILE=compose.deploy.yml
export SCRY_DOMAIN=scry.example.com POSTGRES_PASSWORD=rollback-integration-password
export SCRY_SERVICE_TOKEN=rollback-integration-token
export SCRY_CREDENTIAL_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
export VEIL_ADMISSION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
export SUPABASE_URL=https://example.supabase.co SUPABASE_PUBLISHABLE_KEY=rollback-placeholder

cleanup() {
  docker compose -p "$project" -f compose.deploy.yml down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm -f "$image_b" "$image_a" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

compose() { docker compose -p "$project" -f compose.deploy.yml "$@"; }
set_release() { export SCRY_IMAGE_REF="$1" SCRY_RELEASE_ID="$2" SCRY_SCHEMA_FINGERPRINT="$3"; }
wait_release() {
  local release="$1" schema="$2" attempt ready
  for attempt in $(seq 1 60); do
    if compose exec -T api wget -qO /tmp/rollback-ready.json http://127.0.0.1:4000/api/ready && compose exec -T mcp wget -qO- http://127.0.0.1:4100/health >/dev/null; then
      ready="$(compose exec -T api cat /tmp/rollback-ready.json)"
      READY_JSON="$ready" EXPECTED_RELEASE="$release" EXPECTED_SCHEMA="$schema" node -e 'const v=JSON.parse(process.env.READY_JSON);if(v.ready!==true||v.releaseId!==process.env.EXPECTED_RELEASE||v.schemaFingerprint!==process.env.EXPECTED_SCHEMA||v.compatibleWorkerCount<1||v.praxisReady!==true)process.exit(1)'
      test "$(compose exec -T postgres psql -U scry -d scry -Atc "SELECT count(*) FROM worker_heartbeats WHERE release_id='$release' AND schema_fingerprint='$schema' AND heartbeat_at>now()-interval '30 seconds'")" -ge 1
      return 0
    fi
    sleep 2
  done
  return 1
}
verify_images() {
  local image="$1" release="$2" schema="$3" expected container service
  expected="$(docker image inspect "$image" --format '{{.Id}}')"
  for service in api worker mcp; do
    container="$(compose ps -q "$service")"; test -n "$container"
    test "$(docker inspect "$container" --format '{{.Image}}')" = "$expected"
    test "$(docker inspect "$container" --format '{{index .Config.Labels "org.scry.release-id"}}')" = "$release"
    test "$(docker inspect "$container" --format '{{index .Config.Labels "org.scry.schema-fingerprint"}}')" = "$schema"
    test "$(docker inspect "$container" --format '{{index .Config.Labels "org.scry.privacy-authority"}}')" = veil-only
  done
}

mkdir -p "$(dirname "$report")"
docker build -f Dockerfile -t "$image_a" \
  --label "org.scry.release-id=$release_a" --label "org.scry.schema-fingerprint=$schema_a" --label org.scry.privacy-authority=veil-only .
docker build -f scripts/rollback-qualification-label.Dockerfile -t "$image_b" \
  --build-arg "BASE_IMAGE=$image_a" --build-arg "RELEASE_ID=$release_b" --build-arg "SCHEMA_FINGERPRINT=$schema_b" .
image_a_digest="$(docker image inspect "$image_a" --format '{{.Id}}')"
image_b_digest="$(docker image inspect "$image_b" --format '{{.Id}}')"

set_release "$image_a" "$release_a" "$schema_a"
compose up -d --wait postgres redis migrate api worker mcp
wait_release "$release_a" "$schema_a"
verify_images "$image_a" "$release_a" "$schema_a"
compose exec -T postgres psql -U scry -d scry -v ON_ERROR_STOP=1 -c "CREATE TABLE veil_rollback_qualification(id text PRIMARY KEY,privacy_authority text NOT NULL CHECK(privacy_authority='veil-only'),pre_value text NOT NULL); INSERT INTO veil_rollback_qualification VALUES('representative','veil-only','pre-release-data')"
compose stop api worker mcp migrate
bash scripts/veil-db-snapshot-restore.sh snapshot "$snapshot_a"

compose exec -T postgres psql -U scry -d scry -v ON_ERROR_STOP=1 -c "ALTER TABLE veil_rollback_qualification ADD COLUMN post_value text; CREATE TABLE veil_rollback_schema_b(marker text PRIMARY KEY); INSERT INTO veil_rollback_schema_b VALUES('schema-b'); UPDATE veil_rollback_qualification SET post_value='post-upgrade-data'; UPDATE schema_baseline SET schema_fingerprint='$schema_b',applied_at=now() WHERE singleton=true"
set_release "$image_b" "$release_b" "$schema_b"
compose up -d --no-deps api worker mcp
wait_release "$release_b" "$schema_b"
verify_images "$image_b" "$release_b" "$schema_b"
test "$(compose exec -T postgres psql -U scry -d scry -Atc "SELECT pre_value||':'||post_value||':'||privacy_authority FROM veil_rollback_qualification")" = "pre-release-data:post-upgrade-data:veil-only"
compose stop api worker mcp
bash scripts/veil-db-snapshot-restore.sh snapshot "$snapshot_b"

set_release "$image_a" "$release_a" "$schema_a"
compose up -d --no-deps api
sleep 8
mixed_refused=true
if compose exec -T api wget -qO- http://127.0.0.1:4000/api/ready >/dev/null 2>&1; then mixed_refused=false; fi
test "$mixed_refused" = true
compose stop api

SCRY_WRITERS_STOPPED=true bash scripts/veil-db-snapshot-restore.sh restore "$snapshot_a"
set_release "$image_a" "$release_a" "$schema_a"
compose up -d --no-deps api worker mcp
wait_release "$release_a" "$schema_a"
verify_images "$image_a" "$release_a" "$schema_a"
test "$(compose exec -T postgres psql -U scry -d scry -Atc "SELECT pre_value||':'||privacy_authority FROM veil_rollback_qualification")" = "pre-release-data:veil-only"

compose stop api worker mcp
SCRY_WRITERS_STOPPED=true bash scripts/veil-db-snapshot-restore.sh restore "$snapshot_b"
set_release "$image_b" "$release_b" "$schema_b"
compose up -d --no-deps api worker mcp
wait_release "$release_b" "$schema_b"
verify_images "$image_b" "$release_b" "$schema_b"
test "$(compose exec -T postgres psql -U scry -d scry -Atc "SELECT pre_value||':'||post_value||':'||privacy_authority FROM veil_rollback_qualification")" = "pre-release-data:post-upgrade-data:veil-only"

REPORT_PATH="$report" RUN_ID="$run_id" STARTED_AT="$started_at" SCHEMA_A="$schema_a" SCHEMA_B="$schema_b" RELEASE_A="$release_a" RELEASE_B="$release_b" IMAGE_A="$image_a_digest" IMAGE_B="$image_b_digest" node - <<'NODE'
const { writeFileSync } = require("node:fs");
const report = {
  schemaVersion: 1, qualification: "veil-cross-schema-rollback", status: "passed",
  startedAt: process.env.STARTED_AT, completedAt: new Date().toISOString(), runId: process.env.RUN_ID,
  prior: { releaseId: process.env.RELEASE_A, schemaFingerprint: process.env.SCHEMA_A, imageDigest: process.env.IMAGE_A, privacyAuthority: "veil-only" },
  current: { releaseId: process.env.RELEASE_B, schemaFingerprint: process.env.SCHEMA_B, imageDigest: process.env.IMAGE_B, privacyAuthority: "veil-only" },
  proofs: { priorFreshBoot: true, priorSnapshotNonempty: true, forwardMigrationApplied: true, preAndPostDataVerified: true, mixedSchemaPriorRefused: true, writersStoppedBeforeRestore: true, priorSnapshotRestored: true, exactPriorComponentsReady: true, priorWorkerHeartbeatVerified: true, priorImageLabelsVerified: true, currentSnapshotRestored: true, exactCurrentComponentsReady: true, veilOnlyAuthorityPreserved: true },
  commands: ["docker build prior/current labeled images", "compose boot API/worker/MCP", "pg_dump custom snapshot", "controlled schema-B migration", "mixed-schema readiness refusal", "writer-fenced pg_restore schema A", "writer-fenced pg_restore schema B"],
  safety: { isolatedComposeProject: true, disposableVolumes: true, secretsRecorded: false, cleanup: "trap removes project volumes, images, and temporary snapshots" }
};
writeFileSync(process.env.REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });
NODE
test -s "$report"
printf 'Veil rollback qualification passed: %s\n' "$report"

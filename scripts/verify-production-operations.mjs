import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const requiredServices = [
  "postgres-base-backup",
  "postgres-wal-backup",
  "postgres-storage-init",
  "artifact-backup",
  "backup-maintenance",
  "restore-drill",
  "backup-init",
  "prometheus",
  "alertmanager",
  "blackbox-exporter",
  "postgres-exporter",
  "redis-exporter",
  "backup-metrics",
];
const environment = {
  ...process.env,
  SCRY_IMAGE_REF: "registry.invalid/scry@sha256:" + "1".repeat(64),
  SCRY_BACKUP_IMAGE_REF: "registry.invalid/scry-backup@sha256:" + "2".repeat(64),
  SCRY_DOMAIN: "scry.invalid",
  SCRY_RELEASE_ID: "verification",
  SCRY_SCHEMA_FINGERPRINT: "3".repeat(64),
  POSTGRES_PASSWORD: "verification",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "verification",
  SCRY_SERVICE_TOKEN: "verification",
  SCRY_CREDENTIAL_ENCRYPTION_KEY: "verification",
  VEIL_ADMISSION_KEY: "v".repeat(32),
  RESTIC_REPOSITORY: "s3:https://backup.invalid/scry",
  RESTIC_PASSWORD: "verification",
  SCRY_ALERT_WEBHOOK_URL: "https://alerts.invalid/scry",
  COMPOSE_PROFILES: "operations",
  SCRY_DEPLOYMENT_TIER: "production",
  POSTGRES_ARCHIVE_MODE: "on",
};
const rendered = execFileSync(
  "docker",
  ["compose", "-f", "compose.deploy.yml", "config", "--format", "json"],
  { encoding: "utf8", env: environment },
);
const compose = JSON.parse(rendered);
for (const service of requiredServices)
  if (!compose.services?.[service])
    throw new Error(`Missing production operations service: ${service}`);
for (const service of requiredServices.filter((service) => service !== "postgres-storage-init"))
  if (!compose.services[service].profiles?.includes("operations"))
    throw new Error(`Production operations service lacks operations profile: ${service}`);
const postgresCommand = compose.services.postgres.command.join(" ");
for (const setting of [
  "archive_mode=on",
  "archive_timeout=300s",
  "hba_file=/etc/postgresql/pg_hba.conf",
  "archive_command=",
])
  if (!postgresCommand.includes(setting))
    throw new Error(`PostgreSQL PITR setting missing: ${setting}`);
const walInterval = Number(
  compose.services["postgres-wal-backup"].environment.POSTGRES_WAL_BACKUP_INTERVAL_SECONDS,
);
const artifactInterval = Number(
  compose.services["artifact-backup"].environment.ARTIFACT_BACKUP_INTERVAL_SECONDS,
);
const drillInterval = Number(
  compose.services["restore-drill"].environment.RESTORE_DRILL_INTERVAL_SECONDS,
);
const drillRto = Number(compose.services["restore-drill"].environment.RESTORE_DRILL_RTO_SECONDS);
if (walInterval > 300 || artifactInterval > 900 || drillInterval > 604800 || drillRto > 3600)
  throw new Error("Deployment exceeds declared RPO, restore-drill, or RTO thresholds");
const rules = readFileSync("ops/observability/rules.yml", "utf8");
const hba = readFileSync("ops/postgres/pg_hba.conf", "utf8");
if (!/^host\s+replication\s+all\s+0\.0\.0\.0\/0\s+scram-sha-256$/m.test(hba))
  throw new Error("Authenticated PostgreSQL replication access is missing");
for (const alert of [
  "BackupJobFailed",
  "PostgreSQLWalBackupStale",
  "ArtifactBackupStale",
  "RestoreDrillStale",
  "ScryEndpointUnavailable",
])
  if (!rules.includes(`alert: ${alert}`)) throw new Error(`Operational alert missing: ${alert}`);
for (const script of [
  "backup-entrypoint.sh",
  "postgres-base.sh",
  "postgres-wal.sh",
  "artifacts.sh",
  "maintenance.sh",
  "restore-drill.sh",
])
  execFileSync("sh", ["-n", `scripts/operations/${script}`]);
process.stdout.write(
  `Production operations verified: ${requiredServices.length} services, PITR settings, backup schedules, restore drill, and alert rules.\n`,
);

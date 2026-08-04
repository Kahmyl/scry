# Scry production operations

## Deployment tiers and optional operations

Scry separates application readiness from optional early-stage operational infrastructure. `SCRY_DEPLOYMENT_TIER` declares the intended environment, while Docker Compose's native `operations` profile controls backup and monitoring services.

| Tier         | Operations profile | Intended use                                                                     |
| ------------ | ------------------ | -------------------------------------------------------------------------------- |
| `staging`    | Optional           | Friend testing, feature development, disposable or recoverable test data         |
| `beta`       | Optional           | Closed beta; enable operations when retained tester data becomes important       |
| `production` | Required           | Customer-facing deployment with mandatory recovery and operational observability |

For the current staging phase, use:

```env
SCRY_DEPLOYMENT_TIER=staging
COMPOSE_PROFILES=
POSTGRES_ARCHIVE_MODE=off
```

Then run `pnpm verify:deployment-preflight` before deployment. Backup and observability containers are not created, and PostgreSQL does not accumulate archived WAL.

To exercise the complete operational topology in staging or beta, set:

```env
COMPOSE_PROFILES=operations
POSTGRES_ARCHIVE_MODE=on
```

and configure the backup image, restic repository, and alert webhook. `SCRY_DEPLOYMENT_TIER=production` fails preflight unless that profile and its required configuration are present. Do not use placeholder secrets to bypass preflight.

## Availability and recovery objectives

The production deployment declares these maximum objectives:

| Data or service                |                RPO |                                RTO | Enforcement                                                                               |
| ------------------------------ | -----------------: | ---------------------------------: | ----------------------------------------------------------------------------------------- |
| PostgreSQL committed state     |          5 minutes |                         60 minutes | WAL switch and encrypted off-host snapshot every 300 seconds; automated PITR drill weekly |
| Artifact evidence              |         15 minutes |                         60 minutes | encrypted off-host snapshot every 900 seconds plus application retention                  |
| API, MCP, and web availability | 2-minute detection | release rollback within 30 minutes | black-box probes and critical alerts                                                      |

An objective is a maximum tolerated loss or recovery duration, not a promise independent of infrastructure capacity. A release is not operationally ready until a restore drill on production-shaped data completes within the RTO.

## Backup architecture

Before PostgreSQL starts, a one-shot initializer gives its unprivileged runtime identity exclusive ownership of the WAL archive volume. PostgreSQL then runs with `wal_level=replica`, continuous archiving, and a five-minute `archive_timeout`. Its production host rules explicitly permit password-authenticated replication connections for the backup identity while retaining SCRAM authentication for every network client. Completed WAL segments are copied atomically into a non-overwriting archive volume. `pg_basebackup` produces a daily physical base backup; WAL snapshots run every five minutes. Both are encrypted by restic and written to `RESTIC_REPOSITORY`, which must be off-host and use credentials independent from the primary application account.

Restic maintains 48 hourly, 30 daily, 12 weekly, and 12 monthly recovery points by default. Daily maintenance prunes expired snapshots and verifies repository data. A weekly isolated restore drill restores the latest base backup and WAL archive, starts PostgreSQL on an isolated port, executes a database query, records duration, and destroys the drill volume.

PostgreSQL PITR requires a physical base backup and the uninterrupted WAL sequence beginning with that backup. Logical `pg_dump` output is useful for selective recovery but is not a substitute for this mechanism.

## Artifact storage

Local artifact storage is versioned through encrypted restic snapshots. Remote S3, Cloudinary, or GCS deployments must enable provider-side object versioning or immutable recovery retention and set `ARTIFACT_STORE_VERSIONING_CONFIRMED=true`; otherwise API and worker startup fail. Provider lifecycle expiration must be no shorter than Scry's `ARTIFACT_RETENTION_MS` plus the backup recovery window.

Changing `ARTIFACT_STORAGE_PROVIDER` requires a separately verified object migration. Do not switch providers while retained database rows still reference objects available only in the old provider.

## Observability and alerts

Prometheus retains 30 days of operational metrics and monitors:

- API readiness, MCP health, and web health through real HTTP probes;
- PostgreSQL and Redis connectivity;
- success, duration, and freshness of every backup and restore-drill job.

Alertmanager sends grouped alerts to `SCRY_ALERT_WEBHOOK_URL`. Critical alerts fire for unavailable public components, database dependencies, failed backup operations, WAL backup age over ten minutes, and a missing weekly restore drill. The alert webhook must route to a continuously staffed operational channel.

## Deployment procedure

1. Build the application image and [backup image](../../docker/Dockerfile.backup) and publish both by immutable digest.
2. Copy [deploy.env.example](../../deploy.env.example) into the secret deployment system; never commit populated values.
3. Provision an off-host restic repository with independent credentials and retention protection.
4. For remote artifact storage, enable provider versioning and lifecycle controls before confirming them.
5. Run `pnpm verify:deployment-preflight`, `pnpm verify:production-operations`, `pnpm verify:production-recovery`, and render `docker compose --env-file <secret-file> -f compose.deploy.yml config`.
6. Deploy, confirm all health checks, and confirm Prometheus has every declared target.
7. Require successful base, WAL, artifact, maintenance, and restore-drill metrics before release acceptance.

## Restore and incident procedure

For recovery, fence API and workers before modifying data. Preserve the failed cluster and latest local WAL, select the required restic snapshots, and restore into a new volume. Configure `restore_command` against the restored archive and, when required, set `recovery_target_time` to the last known safe instant. Promote only after integrity queries, schema fingerprint checks, Veil/Praxis authority checks, and artifact-reference checks pass.

Never test a restore over the production data directory. If the drill exceeds `RESTORE_DRILL_RTO_SECONDS`, loses more data than the declared RPO, lacks required WAL, or cannot resolve retained artifacts, the release is not operationally ready.

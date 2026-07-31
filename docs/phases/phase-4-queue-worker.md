# Phase 4: Queue and worker lifecycle

## Goal

Execute durable runs reliably in a separate BullMQ worker while preserving every
attempt and preventing stale workers from writing after ownership changes.

## Deliverables

- [x] Redis and BullMQ.
- [x] Deterministic run job IDs.
- [x] Separate worker process with concurrency one by default.
- [x] Fenced attempt claims.
- [x] Heartbeats and stale-attempt recovery.
- [x] Retries create new attempts.
- [x] Cancellation for queued and active runs.
- [x] Executor events, assertions, and artifacts persisted to PostgreSQL.
- [x] Queue start and cancellation API endpoints.
- [x] End-to-end API → queue → Chrome → report verification.

## Lifecycle

```text
draft → queued → preparing → running → finalizing
                                 └──→ passed | failed | cancelled | timed_out
infrastructure failure + retry → queued → new attempt
final infrastructure failure  → infrastructure_error
```

## Local services

```bash
docker compose up -d postgres redis
pnpm db:migrate
pnpm dev:api
pnpm --filter @scry/api worker
```

## Fencing invariant

Every worker mutation includes the attempt's random claim token. Heartbeats,
events, assertions, artifact records, and terminal transitions from an old
worker are rejected after ownership changes.

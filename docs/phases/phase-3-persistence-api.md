# Phase 3: Persistence and API

## Goal

Make Scry's projects, environments, specifications, plans, runs, attempts,
events, assertions, and artifact metadata durable without introducing queue
semantics.

## Deliverables

- [x] NestJS/Fastify API.
- [x] PostgreSQL schema and migration runner.
- [x] Shared Zod request contracts.
- [x] Projects and environments.
- [x] Immutable specification and plan versions.
- [x] Runs with immutable plan, policy, environment, and viewport snapshots.
- [x] Attempts, append-only events, assertion results, and artifacts.
- [x] Run report projection.
- [x] `ArtifactStore` interface and local filesystem implementation.
- [x] API health endpoint.
- [x] PostgreSQL repository integration test.

## State boundary

Runs are created in `draft`. Phase 4 owns `draft → queued`, worker claims,
heartbeats, retries, cancellation propagation, and stale-attempt recovery.

## Local database

```bash
docker compose up -d postgres
pnpm db:migrate
pnpm dev:api
```

## Exit gate

1. Migrations apply to a clean PostgreSQL database.
2. A project, environment, specification version, and plan version can be persisted.
3. A run preserves immutable execution snapshots.
4. Attempts and events are appended, never overwritten.
5. A report is reconstructed from stored run facts.
6. Artifact metadata is separate from artifact bytes.
7. Tests and strict type-checking pass.

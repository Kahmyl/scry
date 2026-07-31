# Phase 5: Dashboard and durable reports

## Goal

Provide a durable product interface for creating test contracts, monitoring
runs, diagnosing failures, inspecting evidence, and requesting exact reruns.

## Delivered surfaces

- [x] Project switcher and first-project onboarding.
- [x] Command center with run, coverage, environment, and pass-rate signals.
- [x] Project environment and policy setup.
- [x] Specification library.
- [x] Structured requirements plus validated protocol-plan editor.
- [x] Live run list with status filters.
- [x] Durable report summary.
- [x] Step-by-step execution timeline.
- [x] Assertion outcomes.
- [x] Screenshot, DOM, network, and trace artifact links.
- [x] Console, page-error, and request-failure diagnostics.
- [x] Immutable run context.
- [x] Active-run cancellation.
- [x] Exact-plan rerun.
- [x] Responsive desktop and mobile layout.

## API additions

```text
GET  /v1/projects/:projectId/environments
GET  /v1/projects/:projectId/specifications
GET  /v1/projects/:projectId/runs
POST /v1/runs/:runId/rerun
GET  /v1/artifacts/:artifactId
```

Run reports now include ordered events in addition to attempts, assertions, and
artifact metadata.

## Local use

```bash
docker compose up -d postgres redis
pnpm db:migrate
pnpm dev:api
pnpm --filter @scry/api worker
pnpm --filter @scry/web dev
```

Open `http://127.0.0.1:5173`.

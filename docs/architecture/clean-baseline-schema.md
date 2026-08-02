# Clean baseline persistence model

This is the target of the pre-production reset. It is a schema contract, not an
executable reset migration. Phase 0 does not delete or mutate data.

## Core aggregate

```text
projects
└── flows
    ├── latest_revision_id (NOT NULL, deferred FK)
    └── flow_revisions
        ├── revision (positive, unique per flow)
        ├── specification
        ├── plan
        ├── validation_result
        └── created_at

runs
├── flow_revision_id (NOT NULL)
├── environment_snapshot
├── policy_snapshot
└── execution_snapshot
```

Required constraints:

- `flows.latest_revision_id` references a revision belonging to that same Flow.
- `(flow_id, revision)` is unique and revision numbers are monotonic.
- revisions are immutable after insertion.
- Flow creation inserts the Flow and first revision in one transaction using
  preallocated identifiers and a deferred integrity check.
- revision creation locks the Flow and compares `expectedRevisionId`.
- runs always reference an immutable Flow revision.
- command idempotency keys are unique within project and operation scope.

## Evidence model

```text
attempts
├── run_phase
├── step_results
├── privacy_intervals
├── artifact_timeline
└── artifacts
```

Privacy intervals contain timestamps, mode, terminal state, safe-boundary kind,
and non-sensitive failure codes. The artifact timeline identifies recorded,
omitted, degraded, withheld, and unavailable spans. It never stores captured
values or secret-bearing selector text.

## Guarded cutoff sequence

1. Stop API, MCP, worker, and web writers.
2. Verify the environment is explicitly marked pre-production.
3. Export a manifest of record counts and artifact object keys for audit only.
4. Drop application tables and queues inside the explicitly selected database.
5. Apply one squashed baseline migration.
6. Verify all constraints using transaction-failure and concurrent-revision
   probes.
7. Clear test artifact storage and queue state.
8. Start all components from the same immutable release.
9. Require readiness and Privacy Gauntlet success before accepting work.

The eventual reset command must refuse remote or production-looking targets by
default and require both an environment sentinel and an exact typed confirmation.


# Adaptive Execution M0-M1 Operations

Status: superseded on 2026-08-09 by [Scry Mission-First Live Execution Convergence](./mission-first-live-convergence-prd.md); retained as historical M0-M1 operational evidence only
Scope: execution kernel, bounded authoring turn, and adaptive campaign authority

Do not use this file as the current product or implementation authority. Mission-first ownership and live acceptance requirements are defined by the canonical convergence runbook.

## Environment

Set values through the deployment secret/configuration system. Do not place values in campaign reports or committed files.

| Variable                                 | Required for                                               | Default                                        |
| ---------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------- |
| `DATABASE_URL`                           | API, worker, migration, production-shaped campaign         | Repository development default where supported |
| `SCRY_AUTHORING_TEST_DATABASE_URL`       | Destructive integration tests and campaign isolation       | None; must identify an isolated test database  |
| `REDIS_URL`                              | Worker and production-shaped campaign                      | Repository development default where supported |
| `SCRY_API_BASE_URL`                      | Production-shaped API health check                         | Local API URL                                  |
| `VEIL_ADMISSION_KEY`                     | Kernel, Probe, calibration, and campaign privacy authority | None                                           |
| `SCRY_BROWSER_CHANNEL`                   | Browser-backed tests and campaigns                         | `chrome` in campaigns                          |
| `SCRY_RELEASE_ID`                        | Retained campaign binding                                  | `development`                                  |
| `SCRY_SCHEMA_FINGERPRINT`                | Retained campaign binding                                  | `development-baseline`                         |
| `SCRY_GIT_COMMIT`                        | Retained campaign binding                                  | `working-tree`                                 |
| `SCRY_AUTHORING_TURN_ENABLED`            | Grouped authoring command                                  | `false`                                        |
| `SCRY_REQUIRE_VITRACT_REPORT`            | Require a passing Vitract report in milestone verification | `false`                                        |

Vitract credentials and protected values are intentionally absent from this interface. The executable Vitract campaign accepts only protected references and authorization supplied at execution time by the verification owner.

## Migration

The migration is forward-only and backward-readable. It adds kernel journal, event, mutation, checkpoint, encrypted captured-value, public-value, and context-provenance tables. It extends the authoring command type constraint with `advance_turn`. Existing Flow revisions and Run records are not rewritten.

Run-scoped kernel secret values are encrypted. Secret and public values receive a 24-hour crash-recovery expiry, are deleted transactionally when their owning operation reaches a kernel terminal state, and are swept by worker stale-state recovery if terminal cleanup never ran. One operation never destroys another operation's values. The generic session factory rejects project-scoped secret or public-value persistence; project scope must use an explicitly supplied project-owned persistence authority such as the existing Run protected-state repository.

1. Confirm API and worker release fingerprints are compatible and take the normal database backup.
2. Stop admission of new work or drain writers according to the deployment runbook.
3. Load the deployment environment without printing it.
4. Run `pnpm db:migrate` once against the intended database.
5. Verify `schema_baseline.schema_fingerprint` matches `pnpm schema:fingerprint`.
6. Start API and workers from the same release and confirm a fresh compatible worker heartbeat.
7. Run kernel repository integration tests against `SCRY_AUTHORING_TEST_DATABASE_URL`, never a shared database.
8. Run M0 and M1 production-shaped campaigns independently and retain both append-only reports.

The migration uses an advisory transaction lock. Terminal kernel operations cannot be updated or deleted. Mutation identity rows are fenced by `(session_id, operation_id)`, immutable operation digests, and a fencing token. The mutation identity is stable for the logical Run, Probe, calibration, or authoring command and is deliberately independent of worker attempt IDs.

## Enable Sequence

The execution kernel is a runtime invariant and has no fallback flag. The grouped authoring surface remains opt-in and defaults to `false`.

1. Apply the additive migration and verify every supported historical fingerprint test.
2. Run typechecks, focused pure suites, the static boundary gate, and the isolated database integration suite.
3. Run the production-shaped M0 and M1 campaigns. A report with `MEASUREMENT_UNAVAILABLE`, a missing deployed-component source, or a synthetic zero phase is a failure.
4. Run the scoped Vitract verification under the verification owner. Do not substitute placeholder evidence.
5. Re-run mutation crash recovery, protected Probe/calibration, privacy/evidence mapping, and deterministic Run regressions.
6. Enable `SCRY_AUTHORING_TURN_ENABLED=true` for an internal project cohort.
7. Expand cohorts while monitoring admission rejection, reconciliation-required mutation, stale-command recovery, privacy sealing, evidence failures, and latency measurements.

## Rollback

Rollback does not remove tables or journal records and does not dual-execute mutations.

1. Set `SCRY_AUTHORING_TURN_ENABLED=false` to reject new grouped turns while preserving fine-grained commands through the same kernel.
2. Restart API and workers with one release/fingerprint pair. Keep workers required by already-admitted queued Runs until those Runs terminate or are safely cancelled.
3. Do not delete `execution_kernel_*` rows. They remain audit and reconciliation evidence.
4. Reconcile every mutation in `dispatching`, `dispatched`, or `outcome_unknown` before retrying. Unknown outcomes are terminal and must not be automatically retried.
5. Deploy a previous compatible release only if it preserves kernel authority and its schema fingerprint is admitted. The additive schema remains in place.

## Verification

Code-only gates:

```text
pnpm verify:execution-kernel-boundary
pnpm --filter @scry/contracts test
pnpm --filter @scry/assurance test
pnpm --filter @scry/executor typecheck
pnpm --filter @scry/api typecheck
pnpm --filter @scry/mcp typecheck
```

Infrastructure-backed gates:

```text
set -a
source .env
set +a
pnpm --filter @scry/api test
pnpm campaign:adaptive:m0:core
pnpm campaign:adaptive:m1:core
pnpm verify:adaptive:m0
pnpm verify:adaptive:m1
```

The integration test process must report that the `SCRY_AUTHORING_TEST_DATABASE_URL` suite ran. A skipped suite is not acceptance. The Vitract commands are separate, require the verification owner, and must not be treated as passing while their report status is `awaiting_codex_verification`.

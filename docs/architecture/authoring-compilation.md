# Authoring, calibration, and execution

Scry separates learning how an application works from measuring whether the application works.

```text
Mutable Flow draft
  -> Probe Session
  -> Compilation
  -> Published immutable Flow revision
  -> Candidate Run
```

A Run executes validated knowledge. A Probe Session creates that knowledge. Probe failures and compilation blockers are authoring results and do not count as application failures or reliability metrics.

## Drafts and probes

Drafts are mutable and use optimistic versioning. Each edit and state transition is recorded as an append-only draft event. Publication freezes the exact draft version used by its compilation.

Probe levels are:

- `inspection`: observes targets, readiness, and runtime health without mutation.
- `reversible`: permits disposable, reversible interaction.
- `calibration_transaction`: permits authentication or approved disposable mutation only with Mission authorization and explicit disposable-data confirmation.

Probe workers use a queue, lease, idempotency, cancellation, and recovery lifecycle separate from Run workers. A probe evaluates every unresolved target and readiness transition together and returns one consolidated correction set.

## Compilation

Compilation binds the draft to an environment, runtime hash, capability-manifest hash, approved calibration and authorization state, target contracts, readiness contracts, expected effects, and interaction adapters. It returns all blockers together.

Only `execution_ready` compilations may be published and admitted for execution. A compilation becomes stale when any authoritative input changes. Required browser-runtime failure produces `runtime_unhealthy` and blocks release readiness as well as compilation.

## Authentication

Authentication contracts are environment-specific and versioned. They compile username and password targets, ordered submission methods, failure signals, and a durable authenticated-state predicate. Readiness uses independent state signals and a stability window; fixed sleeps are not accepted as the primary success rule.

Reusable browser state is opt-in. It is encrypted as credential-grade material, bound to the project, environment, origin, Authentication Contract revision, runtime fingerprint, expiration, and lease. Cookies and storage values never enter agent-visible results, ordinary evidence, diagnostics, or reports.

## Run admission and outcomes

The Mission/Flow service is the only Run-admission authority. Admission verifies the published revision, exact current compilation, execution-plan binding, runtime health, calibration, authorization, target/readiness previews, and Authentication Contract. Every Run snapshot stores the compiled-contract ID and digest.

Only one unresolved authoring candidate may exist per objective and compiled contract. Structural drift invalidates compilation and opens an inspection probe; it cannot be retried as another Run until recompilation.

Results are classified independently as application pass/failure, calibration required, Scry infrastructure failure, environment failure, policy/authorization refusal, or cancellation. Only validated application failures affect product reliability metrics. Historical discovery attempts remain auditable as `legacy_authoring_attempt` records and are collapsed in normal views.

# Phase 0 Authoring Baseline

## Purpose

This document records the current Probe-to-compilation path before adaptive authoring changes are introduced.

The goal of Phase 0 is to freeze current behavior, identify the real implementation boundaries, and establish a baseline for later changes.

## Current Probe execution path

```text
AuthoringService.startProbeSession(...)
→ probe_sessions row created
→ Probe job queued
→ createProbeProcessor(...)
→ ProbeRuntimeRepository.claim(...)
→ probeFlowPlan(...)
→ ProbeRuntimeRepository.complete(...)
→ probe_sessions.result persisted
→ AuthoringService.compile(...)
→ flow_compilations row created
```

## Relevant files

### Authoring and compilation

```text
apps/api/src/authoring/authoring.service.ts
```

Responsibilities:

- Creates Probe Sessions
- Cancels Probe Sessions
- Loads completed Probe results
- Builds compilation diagnostics
- Decides compilation status
- Persists `flow_compilations`
- Moves the draft to `publishable` or back to `editing`
- Publishes immutable Flow revisions

### Probe worker

```text
apps/api/src/workers/processors/probe-calibration.processor.ts
```

Responsibilities:

- Claims queued Probe Sessions
- Starts Probe Attempts
- Maintains worker heartbeat
- Executes `probeFlowPlan(...)`
- Stores authenticated browser state after successful resolution
- Completes or fails the Probe Session

### Probe persistence

```text
apps/api/src/calibration/repositories/probe-runtime.repository.ts
```

Responsibilities:

- Claims Probe Sessions
- Creates Probe Attempts
- Tracks running state and heartbeat
- Persists the final Probe result
- Restores the Flow draft to `editing`
- Records Probe completion events
- Stores authenticated browser state where allowed

### Probe runtime

```text
packages/executor/src/probe.ts
```

Responsibilities:

- Checks browser observation runtime health
- Executes reversible and calibration-level Probe plans
- Runs inspection-level Praxis target resolution
- Produces target and readiness records
- Produces generic Probe diagnostics
- Calculates page and authentication fingerprints

## Current compilation gate

Compilation currently collects diagnostics from:

- Browser observation runtime health
- Missing Probe Session
- Incomplete Probe Session
- `probe_sessions.result.diagnostics`

The current status decision is:

```ts
const status = !runtime.healthy
  ? "runtime_unhealthy"
  : diagnostics.length
    ? "calibration_required"
    : "execution_ready";
```

Therefore, any non-empty diagnostic list produces:

```text
calibration_required
```

There is currently no distinction between:

- Blocking failures
- Warnings
- Accessibility findings
- Semantic-quality findings
- Ambiguous target resolution
- Runtime failures

## Current Probe result shape

```ts
type ProbeExecutionResult = {
  allResolved: boolean;
  runtimeHealthy: boolean;
  targets: Array<Record<string, unknown>>;
  readiness: Array<Record<string, unknown>>;
  diagnostics: Array<Record<string, unknown>>;
  pageFingerprint: string;
  authenticationFingerprint?: string;
  execution?: Record<string, unknown>;
};
```

Inspection-level Probe completion currently uses:

```ts
allResolved: diagnostics.length === 0
```

An unresolved Praxis interaction is appended directly to the generic diagnostics array.

## Characterization tests added

### Authoring compilation gate

```text
apps/api/test/authoring.integration.test.ts
```

The test now proves:

```text
Completed Probe with no diagnostics
→ execution_ready
→ draft publishable

Completed Probe with one diagnostic
→ calibration_required
→ draft remains editing
```

### Probe diagnostic production

```text
packages/executor/test/probe-veil-boundary.test.ts
```

The test now proves:

```text
Unresolved Praxis target
→ Probe allResolved = false
→ generic Probe diagnostic emitted
```

## Current guarantees preserved

The existing test suites already cover significant related behavior, including:

- Veil admission on Probe pages
- Privacy context across reversible Probe execution
- Protected transaction at-most-once behavior
- No replay after dispatch authorization
- Protected clipboard destruction
- Safe continuation after protected operations
- Target capability validation
- Hidden and disabled duplicate rejection
- Authentication readiness from independent signals
- Malformed control grounding

## Phase 0 conclusion

The current architecture already has the correct major subsystem boundaries:

```text
Authoring
Probe worker
Praxis
Veil
Compilation
Deterministic execution
```

The primary baseline issue is not missing infrastructure.

It is the current Probe result model:

```text
all outcomes
→ diagnostics[]
→ calibration_required
```

The later implementation should replace this with a structured result such as:

```ts
{
  blockers: [],
  warnings: [],
  qualityFindings: [],
  learnedContracts: []
}
```

Only blockers should prevent compilation.
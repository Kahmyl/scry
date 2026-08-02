# Agent-driven calibration

Calibration proves the exact protected operation Scry will execute. It is not selector training or after-the-fact redaction.

## Agent workflow

1. Create or revise a Flow containing the protected operation. The API returns `CALIBRATION_REQUIRED` until an effective attestation is bound.
2. Obtain explicit user authorization and confirmation that the calibration uses disposable data.
3. Call `ensure_calibration` with an idempotency key. Scry derives the operation digest; the agent never submits structure or fingerprints.
4. Poll `get_calibration` and follow only its `safeActions`.
5. Scry executes the Flow to the boundary, arms the Privacy Gate, performs the disposable mutation at most once, tests extraction and safe exit, destroys all calibration artifacts, and produces an immutable attestation.
6. If the MCP identity is an owner or admin and the user explicitly authorized the action, call `approve_calibration` for the exact attestation ID.
7. Call `bind_calibration`. The API atomically recomputes the operation digest and creates a Flow revision containing `calibrationAttestationId`.
8. Validate and run the new immutable Flow revision.

No dashboard visit is required. Members may create and inspect sessions but cannot approve attestations.

## Safety rules

- Calibration structure is always worker-derived.
- A changed reveal, extraction, storage scope, reconciliation, continuation, adapter, or origin produces a different operation digest.
- A newer attestation does not silently invalidate an older pinned attestation.
- Revocation is explicit and blocks new runs only.
- A retry after mutation uncertainty is prohibited.
- Raw browser errors, observed text, values, response bodies, and parameterized URLs are never returned as diagnostics.

## Failure codes

- `CALIBRATION_PREFLIGHT_STEP_FAILED`: inspect the returned safe step ID and phase.
- `CALIBRATION_PROTECTED_OPERATION_FAILED`: capsule preparation, extraction, persistence, destruction, reconciliation, or continuation verification failed.
- `CALIBRATION_CANARY_DETECTED`: protected data reached a forbidden channel; approval is prohibited.
- `CALIBRATION_REQUIRED`: no exact approved and non-revoked attestation matches the operation digest and environment.
- `CALIBRATION_RETRY_UNAVAILABLE`: mutation may have started, the session expired, or the session is not safely retryable.

---
name: verify-change
description: Prove that a software change, defect repair, refactor, mitigation, migration, or feature satisfies its intended guarantees and is operationally ready. Use for test planning, acceptance verification, regression checks, release gates, production-shaped smoke tests, failure injection, and completion audits. Build a risk-based verification matrix across behavior, failure paths, state, concurrency, security, privacy, observability, migration, and component compatibility, and route newly discovered defects back to investigate-defect or architectural-diagnosis.
---

# Verify Change

Verification must test the guarantee that matters, not only the happy path.

## Build the matrix

1. Translate requirements and invariants into observable checks.
2. Include the original reproduction for defect repairs.
3. Cover valid, invalid, boundary, sibling, and compatibility scenarios.
4. Add retries, concurrency, cancellation, timeout, crash, partial persistence, and recovery where relevant.
5. Check authorization, secret handling, privacy suppression, artifact admission, and diagnostic safety where relevant.
6. Verify migrations, rollout, rollback, release/schema agreement, and production-shaped topology when components interact.
7. Confirm observability distinguishes product, plan, infrastructure, policy, and evidence failures.

## Evidence rules

- Record commands, environments, outcomes, and safe identifiers.
- Do not treat compilation or unit tests alone as end-to-end proof.
- Do not silently skip unavailable gates; state what remains unverified.
- Route unexplained failures to `investigate-defect`.
- Invoke `architectural-diagnosis` if verification exposes repeated or systemic invariant failure.

## Completion

Return passed and failed gates, residual risk, environmental limitations, and a clear ready/not-ready conclusion. Do not implement unrelated fixes unless the user authorizes a change request.

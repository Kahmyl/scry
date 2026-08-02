---
name: implement-feature
description: Design and deliver intentional new or changed product behavior as a complete vertical capability. Use for feature requests, new APIs, workflows, actions, storage models, integrations, UI capabilities, and supported behavior changes. Clarify outcomes and constraints, map the full lifecycle, decide whether architectural-diagnosis is required, define contracts and failure semantics before coding, implement every participating component coherently, and invoke verify-change for acceptance, failure, migration, and deployment proof.
---

# Implement Feature

Build the smallest complete capability, not disconnected component patches.

## Workflow

1. Define user outcome, non-goals, acceptance criteria, safety constraints, and operational expectations.
2. Trace the vertical lifecycle: contract, validation, authorization, state, persistence, queue/worker, runtime, evidence, API/MCP/UI, deployment, and recovery as applicable.
3. Identify authoritative owners and invariants before selecting files.
4. Invoke `architectural-diagnosis` when the feature introduces a new subsystem, crosses several stateful boundaries, modifies privacy/security guarantees, or would otherwise extend an unsound foundation.
5. Present materially different implementation scopes and recommend one when the user has not already chosen.
6. Define typed success, failure, retry, cancellation, idempotency, concurrency, and observability behavior.
7. Implement a coherent vertical slice and remove temporary bypasses.
8. Address data migration, rollout, compatibility, and rollback explicitly.
9. Use `verify-change` against acceptance criteria and production-shaped topology.

## Completion

Report the delivered behavior, enforced invariants, client-visible contract, migration/rollout state, verification evidence, and remaining non-goals.

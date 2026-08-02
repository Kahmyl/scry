---
name: fix-defect
description: Repair a confirmed software defect at the smallest complete boundary that prevents recurrence. Use after a bug, regression, failure mode, or causal defect has been reproduced or otherwise proven and the user wants implementation. Require sufficient diagnosis, preserve a failing characterization, choose contained versus systemic scope honestly, implement the repair without unrelated behavior change, and invoke verify-change for regression and failure-path proof. Route unresolved causes to investigate-defect and systemic invariant failures to architectural-diagnosis.
---

# Fix Defect

Require a causal explanation strong enough to choose a repair boundary. If it is missing, use `investigate-defect` first.

## Workflow

1. Restate the root cause and violated contract or invariant.
2. Preserve the reproduction as a failing test or characterization check when practical.
3. Search for sibling implementations and bypass paths.
4. Choose the smallest complete repair scope.
5. Invoke `architectural-diagnosis` if authority is duplicated, invalid state is representable, failures recur, or the patch would preserve the broken abstraction.
6. Implement the selected boundary, including contracts, persistence, execution, clients, and observability that participate in correctness.
7. Remove obsolete bypasses introduced by the repaired path.
8. Use `verify-change` to prove the original reproduction, sibling cases, and relevant failure modes.

## Constraints

- Do not hide a feature change inside a defect fix; route intentional behavior changes through `implement-feature`.
- Do not call a broad restructuring a refactor unless behavior remains unchanged.
- Do not weaken validation, privacy, security, typing, or error classification merely to make a test pass.
- Keep unrelated user changes intact.
- Report containment as containment when urgency prevents durable remediation.

## Completion

State what caused the defect, what now enforces the guarantee, which regression proves it, what adjacent paths were checked, and any residual risk.

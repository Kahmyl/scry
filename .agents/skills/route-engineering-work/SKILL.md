---
name: route-engineering-work
description: Classify software-engineering requests and select the correct investigation, delivery, review, and verification workflows before editing. Use for bug reports, regressions, urgent failures, hotfix requests, refactors, rewrites, feature work, code reviews, and ambiguous change requests. Route among investigate-defect, fix-defect, stabilize-incident, refactor-safely, implement-feature, review-change, verify-change, and architectural-diagnosis, combining them in the required order without treating every problem as architectural.
---

# Route Engineering Work

Classify intent, evidence, urgency, and blast radius before choosing a workflow.

## Routing sequence

1. Determine whether the user wants investigation, implementation, review, verification, or active-incident response.
2. Record whether the failure is reproduced, merely reported, statically proven, or still hypothetical.
3. Determine whether production impact is currently active and needs mitigation before diagnosis.
4. Determine whether observable behavior should change.
5. Check whether the work crosses ownership, lifecycle, persistence, security, privacy, concurrency, deployment, or recovery boundaries.

## Select workflows

- Use `investigate-defect` when a failure is reported but its cause and boundary are not proven.
- Use `fix-defect` after the defect and root cause are sufficiently established.
- Use `stabilize-incident` first when impact is active and time-sensitive. Follow with investigation and durable remediation.
- Use `refactor-safely` only when observable behavior must remain unchanged.
- Use `implement-feature` when behavior, contracts, or supported capabilities intentionally change.
- Use `review-change` for read-only assessment of a diff, PR, patch, or proposed design.
- Use `verify-change` to design or execute risk-based proof after implementation or remediation.
- Use `architectural-diagnosis` when evidence indicates systemic ownership, lifecycle, invariant, or repeated-patch failure.

Combine workflows when needed. A typical defect sequence is investigation → architectural diagnosis if escalated → fix → verification. A production incident is stabilization → investigation → fix → verification.

## Architectural escalation decision

Escalate when the defect recurs, sibling paths diverge, invalid states are representable, multiple components own the same rule, safety depends on cleanup or client discipline, or a contained fix would add another bypass. Do not escalate solely because the code is large or unfamiliar.

## Scope communication

If viable approaches materially differ in time, risk, compatibility, or data handling, present contained, subsystem, and foundational options with one recommendation before editing. If the user has already selected the scope, proceed while reporting any newly discovered evidence that invalidates it.

Return the selected workflow sequence, why it applies, what evidence is missing, and whether implementation may begin.

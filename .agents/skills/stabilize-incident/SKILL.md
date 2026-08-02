---
name: stabilize-incident
description: Mitigate active production or pre-production incidents where user impact, data risk, security exposure, or service unavailability requires urgent containment. Use for outages, ongoing corruption, runaway jobs, credential exposure, unsafe deployments, severe regressions, and explicit hotfix requests. Prioritize reversible impact reduction and evidence preservation, distinguish mitigation from root-cause remediation, define rollback and monitoring, then route follow-up to investigate-defect, fix-defect, architectural-diagnosis, and verify-change.
---

# Stabilize Incident

Mitigation restores safety or service; it does not prove root cause.

## Response order

1. Confirm impact, scope, start time, affected users/data, and current change activity.
2. Establish a safe communication and decision record.
3. Preserve essential evidence without delaying urgent safety actions.
4. Choose the most reversible mitigation: disable, isolate, rate-limit, roll back, fail closed, or stop writers as appropriate.
5. Define success signals, abort conditions, and rollback before applying the mitigation.
6. Monitor until impact is stable and no new unsafe state is accumulating.
7. Label the result as mitigated, restored, unresolved, or escalated.
8. After stabilization, use `investigate-defect`; use `architectural-diagnosis` if the incident exposes systemic invariant failure.

## Guardrails

- Do not perform destructive recovery without explicit authority and validated targets.
- Prefer fail-closed behavior for privacy, security, credential, and integrity incidents.
- Keep mitigation changes small, reversible, observable, and time-bounded.
- Never convert an emergency bypass into the permanent design silently.
- Record ownership and removal criteria for temporary controls.

## Handoff

Return impact, mitigation applied, evidence preserved, current health, residual exposure, rollback status, and mandatory durable follow-up. Invoke `verify-change` before declaring the permanent repair complete.

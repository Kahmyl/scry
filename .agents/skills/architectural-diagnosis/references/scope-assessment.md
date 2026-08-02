# Repair scope assessment

Use this matrix to make the scope decision explicit and repeatable.

| Dimension | Contained repair | Subsystem correction | Foundational rebuild |
|---|---|---|---|
| Appropriate when | One implementation violates an otherwise enforced invariant | Authority or lifecycle is duplicated across a bounded subsystem | The current model cannot represent or enforce the required guarantees |
| Coverage | One failure site and close variants | End-to-end affected lifecycle | New authoritative model plus removal of obsolete paths |
| Delivery | Fastest | Moderate | Longest initial delivery |
| Recurrence risk | Medium unless invariant already exists | Low within corrected subsystem | Lowest when cutoff and deletion are complete |
| Migration | Usually none | Additive or localized | Explicit migration, snapshot/reset, or coordinated cutoff |
| Verification | Regression and sibling cases | Cross-component and failure-path suite | Characterization, migration/cutoff, gauntlet, and production-shaped readiness |
| Choose only if | Root cause is genuinely local | Boundary is sound but fragmented | Evidence shows the abstraction itself is unsound |

## Scoring prompts

For each option, answer:

1. Which invariant does it enforce mechanically?
2. Which execution paths remain capable of bypassing it?
3. What state can remain partially committed after failure?
4. How are retries, concurrency, cancellation, and crashes handled?
5. Does it preserve one authoritative domain owner?
6. What legacy code remains active afterward?
7. Which tests would fail if the guarantee regressed?
8. Can deployment create mixed-contract operation?
9. What data migration or recovery path is required?
10. What is the honest residual recurrence risk?

## Decision guidance

- Prefer a contained repair when the invariant already exists and one implementation demonstrably bypasses it.
- Prefer subsystem correction when multiple components independently implement the same rule.
- Prefer foundational rebuild when invalid states are representable, safety depends on client behavior, or repeated repairs have accumulated around the same abstraction.
- Do not choose the largest option for appearance. Choose the smallest option that makes the required invariants enforceable and removes known bypasses.
- When urgency forces a narrower choice, label it as containment, define expiry/removal criteria, and retain the recommended durable follow-up.

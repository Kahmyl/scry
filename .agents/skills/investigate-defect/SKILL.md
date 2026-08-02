---
name: investigate-defect
description: Reproduce, characterize, isolate, and explain software defects before repair. Use for bug reports, regressions, flaky behavior, failing tests, unexplained errors, inconsistent environments, performance failures, and suspected product or infrastructure defects where the causal boundary is not yet proven. Build safe reproductions, compare working and failing paths, maintain an evidence ledger, distinguish local defects from systemic architecture problems, and route confirmed work to fix-defect or architectural-diagnosis.
---

# Investigate Defect

Do not edit production behavior while the cause is still a guess.

## Evidence loop

1. State expected behavior, actual behavior, impact, environment, and known timeline.
2. Separate facts, user reports, inferences, and unknowns.
3. Reproduce at the narrowest boundary that distinguishes plausible causes.
4. If reproduction is unsafe, destructive, expensive, or externally blocked, use the strongest non-mutating evidence and state the limitation.
5. Capture the failing phase, last successful phase, typed error, correlation identifiers, and relevant state without exposing protected data.
6. Create competing hypotheses and design checks that can falsify them.
7. Compare a successful sibling path against the failing path step by step.
8. Reduce to a deterministic test or characterization fixture when practical.

## Diagnosis levels

- **Local diagnosis:** one implementation violates an otherwise enforced contract.
- **Integration diagnosis:** components disagree on inputs, capabilities, ordering, state, or version.
- **Operational diagnosis:** environment, deployment, capacity, dependency, or configuration causes the failure.
- **Architectural diagnosis:** ownership or invariants are duplicated, absent, or unenforceable.

Invoke `architectural-diagnosis` only for the last category or when repeated evidence shows systemic risk. Do not force every bug into an architectural explanation.

## Reproduction requirements

Prefer a reproduction before repair. It may be skipped when static proof is conclusive, the failure is already captured by a deterministic test, reproduction would create unacceptable real-world impact, or access is unavailable. Document why and compensate with targeted verification.

## Output

Return reproduction status, evidence, eliminated hypotheses, root cause or remaining uncertainty, affected boundary, classification, and recommended next workflow. Do not claim root cause from temporal correlation alone.

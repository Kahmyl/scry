# Scry agent governance

## Engineering workflow routing

For bug reports, regressions, hotfixes, refactors, rewrites, feature work, code reviews, and verification requests, begin with the `route-engineering-work` skill in `.agents/skills/route-engineering-work/`. Select and combine the specialist workflows that match the actual work:

- unproven defect: `investigate-defect`;
- confirmed defect repair: `fix-defect`;
- active urgent impact: `stabilize-incident`, followed by durable investigation and repair;
- behavior-preserving restructuring: `refactor-safely`;
- new or intentionally changed behavior: `implement-feature`;
- read-only assessment: `review-change`;
- acceptance, regression, and release proof: `verify-change`.

Use `architectural-diagnosis` only when evidence indicates systemic ownership, lifecycle, state-model, or invariant failure. Signals include recurring defects, divergent sibling paths, duplicated authority, representable invalid states, cleanup-dependent privacy or security, and repairs that would add another bypass. Do not force ordinary local, integration, or operational defects into an architectural diagnosis.

Investigate before editing when the causal boundary is unproven. Reproduce failures where practical, separate facts from inference, compare working and failing paths, and preserve the reproduction as regression evidence. An urgent incident may require reversible containment first, but mitigation is not a permanent repair.

When viable scopes materially differ in delivery time, data handling, compatibility, or residual risk, present contained, subsystem, and foundational options with a recommendation before implementation unless the user has already selected the scope. Never present symptom containment as a durable fix when systemic risk remains.

Implementation is complete only after `verify-change` has tested the original outcome, relevant sibling paths, failure modes, and production-shaped compatibility in proportion to risk.

---
name: review-change
description: Review proposed software changes, diffs, pull requests, patches, migrations, and designs for correctness, regressions, security, privacy, maintainability, and architectural fit without implementing changes unless separately requested. Use for code review, PR review, design review, pre-merge assessment, and audit requests. Reconstruct intent, inspect the complete affected lifecycle, validate tests and failure paths, produce evidence-backed prioritized findings, and invoke architectural-diagnosis when the change exposes systemic ownership or invariant problems.
---

# Review Change

Review the change against its intended outcome, not style preferences alone.

## Workflow

1. Read the request, linked context, and repository instructions.
2. Establish the change boundary and inspect the full diff plus affected callers and consumers.
3. Trace altered contracts, state transitions, data, authorization, concurrency, errors, observability, and rollout.
4. Check whether tests prove the important guarantees rather than merely execute lines.
5. Reproduce suspicious behavior with read-only or isolated checks when useful.
6. Invoke `architectural-diagnosis` for systemic findings; keep ordinary local defects as local findings.
7. Report only actionable findings, prioritized by impact and likelihood, with precise evidence.

## Finding quality

For each finding state the failure condition, impact, evidence location, and required correction. Distinguish blockers from suggestions. Do not claim a defect without a plausible execution path.

If no actionable findings exist, say so and identify remaining test or environment uncertainty. Do not edit files during a review-only request.

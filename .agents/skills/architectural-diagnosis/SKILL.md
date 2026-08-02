---
name: architectural-diagnosis
description: Diagnose systemic software problems where ownership, lifecycle, state models, invariants, or repeated repairs may be structurally unsound. Use when defects recur, sibling paths diverge, invalid states are representable, multiple components own the same rule, privacy or security depends on cleanup, or a change crosses major stateful boundaries and may require subsystem correction or foundational rebuilding. Do not use for every ordinary bug; first use route-engineering-work or investigate-defect to establish whether architectural escalation is warranted.
---

# Architectural Diagnosis

Treat the reported symptom as evidence, not as the problem definition.

Use this specialist workflow after evidence identifies a systemic boundary. Keep ordinary local, integration, and operational diagnosis in `investigate-defect`.

## Operating rules

1. Investigate before editing. Do not begin with a guessed code change.
2. Trace the complete affected lifecycle: entry point, validation, state, persistence, queues, execution, evidence, clients, deployment, and recovery where relevant.
3. Reproduce at the narrowest boundary that can distinguish competing causes. Preserve raw diagnostics and safe identifiers.
4. Search for sibling paths implementing the same responsibility. A defect in one path often signals duplicated authority or divergent lifecycle behavior.
5. Identify the invariant that should have prevented the failure. If no enforceable invariant exists, treat that as the foundational defect.
6. Separate product failure, plan failure, infrastructure failure, and evidence failure. Never let one classification conceal another.
7. Prefer one authoritative owner for each rule or state transition. Flag adapters, compatibility branches, copied validation, and client-side authority that can drift.
8. Do not preserve a weak abstraction merely because replacing it is larger work.
9. Do not broaden into a rewrite without evidence. Rebuild the smallest complete subsystem boundary that restores enforceable invariants.
10. Verify failure paths, cancellation, retries, concurrency, partial persistence, observability, and upgrade/deployment behavior—not only the happy path.

## Required workflow

### 1. Frame the system problem

- Restate the observed behavior and impact.
- List what is proven, inferred, and unknown.
- Define the affected user journey and safety boundary.
- Locate prior related fixes or recurring symptoms.

### 2. Map ownership and divergence

- Trace the request across every participating component.
- Find all implementations of the relevant rule or lifecycle.
- Compare successful and failing paths step by step.
- Record where inputs, state, credentials, policies, context construction, or finalization diverge.

### 3. Reproduce and characterize

- Build a deterministic reproduction before changing production code when practical.
- Add observability that identifies the failing phase without exposing protected data.
- Exercise at least one sibling scenario to determine whether the defect is local or systemic.
- Use failure injection for transactional, privacy, concurrency, or recovery-sensitive systems.

### 4. State root cause and violated invariants

Write a causal statement, not a symptom description:

> Because `<authority or lifecycle defect>`, when `<condition>` occurs, `<invalid state or divergence>` becomes possible, producing `<observed impact>`. The missing or unenforced invariant is `<invariant>`.

If evidence is insufficient, continue investigating. Do not disguise uncertainty as a solution.

### 5. Compare repair scopes

Read [scope-assessment.md](references/scope-assessment.md). Present viable options when their tradeoffs are material:

- **Contained repair:** fastest safe correction inside an otherwise sound boundary.
- **Subsystem correction:** consolidate duplicated authority and repair the complete affected lifecycle.
- **Foundational rebuild:** replace the abstraction or subsystem when its model cannot enforce the required invariants.

For each option, state coverage, residual risk, migration cost, verification burden, reversibility, and expected recurrence risk. Recommend one explicitly.

If the user has not already chosen a scope and the options materially change cost, data, compatibility, or delivery time, pause before implementation. If the user explicitly prioritizes speed, implement the smallest safe option while documenting the residual architectural debt.

### 6. Implement the selected complete boundary

- Establish characterization tests before replacement where useful.
- Centralize authority before deleting divergent paths.
- Make state transitions atomic, idempotent, typed, and observable as applicable.
- Preserve or deliberately migrate user data; never silently discard it.
- Delete bypasses and obsolete paths once the replacement is proven.
- Update contracts, persistence, workers, clients, documentation, and deployment together when they participate in the invariant.

### 7. Prove the repair

Verify:

- the original reproduction;
- sibling variants and boundary cases;
- retries, cancellation, timeouts, partial failure, and concurrency;
- classifications and diagnostics;
- repository-wide absence of forbidden legacy paths when a cutoff was selected;
- production-shaped component compatibility and readiness.

Report what was proven, what remains unverified, and any explicitly accepted residual risk.

## Escalation signals

Recommend subsystem correction or foundational rebuild when any of these are present:

- the same class of defect has recurred;
- two paths that should be identical behave differently;
- validation and execution use different repositories or rules;
- failure can leave an impossible or unsafe state;
- correctness depends on step ordering, naming tricks, or client discipline;
- infrastructure errors are classified as product outcomes;
- security or privacy relies on cleanup after exposure;
- compatibility layers outnumber current behavior;
- the proposed patch adds another boolean, branch, adapter, or retry without restoring an invariant;
- tests can prove the symptom but cannot express the intended system guarantee.

## Output contract

Before implementation, communicate:

1. Evidence and reproduction status.
2. Root cause or the next investigation needed.
3. The violated invariant.
4. Repair options and coverage.
5. Recommended scope and why.
6. Risks, migration implications, and verification gates.

Lead with the recommendation. Avoid calling a surface patch complete when systemic risk remains.

# Scry R0 Roadmap

This roadmap defines the remaining re-architecture sequence.

The numbering is now explicit because the architecture and first foundations are sufficiently clear.

The goal is not maximum theoretical hardening. The goal is to reach a coherent agent-first architecture quickly, with factual qualification at each boundary.

---

# R0.1 — Assurance reset

Status: COMPLETE.

No further work unless a real slice needs new qualification support.

---

# R0.2 — Chronicle reset

Status: COMPLETE.

No further work unless a real producer/consumer migration requires it.

---

# R0.3 — Praxis / Executor consolidation

Status: IN PROGRESS.

## Objective

Praxis becomes the single authoritative browser substrate.

By the end of R0.3:

- browser/context/page/frame lifecycle belongs to Praxis;
- browser interaction mechanics belong to Praxis;
- pinned references and mechanical stale protection are shared across interactions;
- Executor no longer contains an independent Playwright action/runtime layer;
- product/application orchestration is not moved into Praxis;
- Veil remains a narrow trust boundary;
- no semantic confidence/admission authority is reintroduced.

## Ordered slices

The exact implementation may adapt to repository evidence, but preserve this order unless there is a concrete dependency reason not to.

### R0.3.1 — pinned reference + click

Status: COMPLETE.

Checkpoint:

```text
1103dc3
```

Fully green Praxis baseline restored by:

```text
326a6ec
```

### R0.3.2 — public native fill

Status: COMPLETE.

Checkpoint:

```text
861d543
```

Scope:

```text
public input
public textarea
exact pinned handle
replacement/stale protection
truthful mutation uncertainty
independent Assurance oracle
Executor public-fill cutover
```

Do not mix protected fill into the first slice.

### R0.3.3 — remaining public text entry

Status: NEXT.

Only where current contracts/call sites still require it.

Examples:

```text
contenteditable
focus + keyboard insertion
non-native ARIA textbox
```

Prove exact-entity focus/typing and post-input uncertainty.

Do not keep a second Locator-based text-entry path after migration.

### R0.3.4 — protected fill cutover

Reuse the same mechanical pinned text-entry primitive.

Veil retains only:

```text
protected value resolution/authorization
recording/capture suppression
redaction
safe-boundary confirmation
persistence/disclosure rules
```

Praxis owns the browser mechanics.

The protected path must not create a separate semantic targeting system.

Privacy behavior must remain at least as strong as the current implementation.

### R0.3.5 — remaining interaction primitives

Migrate one small family at a time, using existing contracts and actual usage:

```text
select option
check/uncheck/toggle
press key
scroll
hover
drag/drop
upload/download/dialog/page switching
```

Do not invent support that the product does not currently need.

For each mutating action:

```text
pin entity
mechanical revalidation
no semantic retry
truthful mutation boundary
targeted regression
```

### R0.3.6 — browser lifecycle consolidation

Move remaining authoritative Playwright ownership into `Praxis/runtime`:

```text
browser
context
page
frame
tab
popup
navigation lifecycle
```

Application adapters may request/compose runtime behavior, but must not maintain a second authoritative lifecycle model.

### R0.3.7 — Executor retirement

Once low-level capabilities are migrated:

- remove or collapse duplicate Executor browser/action machinery;
- move true product orchestration to application/product composition;
- preserve only temporary adapters required for compatibility;
- then remove those adapters as call sites migrate.

Closure condition:

> There is one authoritative browser substrate: Praxis.

No direct low-level browser action path may bypass it except explicit test/fixture infrastructure and narrowly classified application composition roots.

---

# R0.4 — Veil narrowing

## Objective

Reduce Veil to a narrow trust/privacy boundary.

## Remove from Veil

Anything that effectively performs:

```text
browser action selection
semantic targeting
strategy ranking
task progression
browser lifecycle orchestration
general execution coordination
semantic correctness adjudication
```

## Keep in Veil

Only trust-boundary behavior:

```text
may disclose?
may use protected handle?
must redact?
must suppress capture?
must not persist?
safe boundary reached?
```

## Method

Do not rewrite Veil wholesale.

Trace actual active call sites after R0.3, classify each responsibility, and migrate only the responsibilities that violate the target boundary.

Preserve existing privacy invariants with focused regression and Assurance evidence.

Closure condition:

> Veil can deny or constrain protected data use, but cannot decide what browser action should be taken or what the user's intent means.

---

# R0.5 — Product/Application simplification

## Objective

Keep Project/Mission/Flow/Run as durable work representation without turning them into internal intelligence.

## Keep

```text
Project
Mission
Flow
Run
Flow revision where actually useful
durable action/observation/outcome/evidence history
```

## Remove or demote from the hot path

Legacy ceremony that makes Scry internally adjudicate before allowing browser work, including where present:

```text
compile/certify admission
semantic confidence admission
mandatory authoring ceremony for ordinary execution
internal progression authority
duplicated expected-effect adjudication
```

Do not delete historical data models merely because they exist. Remove their authority from execution first.

Closure condition:

> The external agent can reason and adapt directly while Scry faithfully executes and records.

---

# R0.6 — API/MCP composition and legacy retirement

## Objective

Expose the agent-first architecture coherently through application/MCP/API surfaces.

Tasks:

- ensure external agent can inspect factual browser state;
- expose stable references and interaction capabilities;
- return bounded factual observations and uncertainty;
- keep Project/Mission/Flow/Run as useful durable context;
- remove dead compatibility bridges and retired commands;
- remove old release/certification gates that no longer represent the architecture;
- enforce dependency boundaries and no cycles.

Fresh agents must be able to learn how to use Scry from the MCP/runtime surface and repository context rather than hidden historical knowledge.

Closure condition:

> Public application surfaces express the new authority split rather than the old internal planner/admission model.

---

# R0.7 — Integration and closure

## Objective

Prove the architecture on controlled fixtures and real surfaces.

Required qualification:

### Controlled

- all active Assurance truth tests green;
- independent oracles for high-risk mutation/reference behavior;
- negative controls where practical;
- full relevant package tests and typechecks green;
- subsystem boundaries green.

### Live

Use at least:

```text
Vitract Create → Retrieve
one additional independent browser surface/journey
```

The live agent prompt should remain intention-level and use `scrytest`.

A live success is task-level completion, not merely tool-call success.

Any app-specific failure must be generalized:

```text
real incident
→ causal class
→ controlled reproduction
→ general fix
→ regression/corpus
→ return to live surface
```

Closure condition:

> A fresh repository-blind external agent can complete representative work through Scry without relying on hidden implementation knowledge, while Scry remains mechanically safe, privacy-safe, and factually honest.

---

# Fast-track sequencing

When time is constrained, prioritize structural authority transfer over cosmetic cleanup.

Preferred order:

```text
finish current R0.3 slice
→ migrate remaining active browser mechanics
→ retire duplicate Executor ownership
→ narrow Veil
→ simplify product/application authority
→ cut over MCP/API
→ live qualification
```

Do not spend the critical path on:

- comment polishing;
- broad renames;
- historical test cleanup unrelated to active behavior;
- speculative performance gates;
- arbitrary corpus-size targets;
- theoretical certification matrices.

Commit after each coherent closed slice so work remains recoverable.

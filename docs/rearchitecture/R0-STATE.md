# Scry R0 Current State

This file is a checkpoint, not a substitute for `git status`, `git log`, or tests.

## Branch safety

Active branch:

```text
rearchitecture/agent-first-scry
```

Never modify or rewrite `main` as part of R0.

Historical frozen baseline:

```text
f84391bca38c69ce59e8bfc60ed952ef43aa0ede
```

Archived unfinished pre-reset WIP:

```text
328e5c54406484a524b2ed9be53df3a978a693fe
```

---

# Completed reset work

## R0.1 — Assurance reset — COMPLETE

Assurance was rebuilt around positive proof rather than absence of observed failure.

Key properties now established:

- explicit PASS/FAIL/INCONCLUSIVE/SKIPPED/NOT_RUN;
- required-result aggregation;
- independent browser fixture ground truth;
- positive and negative controls;
- legacy campaign machinery quarantined;
- old Praxis/Veil certification gates retired;
- real reference-replacement fixture provides external truth.

Important checkpoint:

```text
ed4e1fb test: establish assurance browser fixture ground truth
```

Current active Assurance truth suite at the last clean checkpoint:

```text
21/21 GREEN
```

---

## R0.2 — Chronicle reset — COMPLETE

Old `packages/artifact` identity was replaced with:

```text
packages/chronicle
@scry/chronicle
```

Clean Chronicle root exports factual events/artifact contracts only.

Legacy proof/admission/storage behavior is quarantined behind:

```text
@scry/chronicle/legacy
```

Existing:

```text
scry://artifact/...
```

resource naming remains intentionally unchanged.

Checkpoint:

```text
f01b525 refactor: establish clean chronicle boundary
```

Do not continue polishing Chronicle unless a concrete migration requires it.

---

## R0.3 — Praxis / Executor consolidation — IN PROGRESS

Goal:

> Praxis becomes the single authoritative browser substrate. Executor loses low-level browser ownership and is eventually removed or reduced to a temporary compatibility layer that can be retired.

### Closed pinned-reference / click slice

Commits:

```text
638ebf3 refactor: establish praxis reference interaction boundary
9a252a0 test: qualify praxis stale reference dispatch
4dcfd2f refactor: route executor click through praxis
1103dc3 fix: harden praxis pinned click dispatch
326a6ec test: correct praxis scope characterization
```

Proven properties:

- actual observed `ElementHandle` is pinned;
- page/frame/document identity is mechanical;
- no semantic re-resolution after pinning;
- main-frame click works;
- descendant hit works;
- same-origin iframe works;
- nested iframe works;
- cross-origin iframe works;
- ancestor overlay appearing during pointer movement refuses with zero button input;
- pre-existing ancestor overlay refuses;
- moved target refuses wrong-target dispatch;
- positioned click honors requested point;
- requested-point occlusion refuses even when center is clear;
- post-mousedown uncertainty is `unknown / unsafe / do_not_retry`;
- independent Assurance safe path PASSes;
- deliberately unsafe semantic re-resolution FAILs through the same oracle.

At checkpoint `326a6ec`:

```text
Praxis: 151/151 GREEN
Assurance truth: 21/21 GREEN
repo typecheck: GREEN
subsystem boundaries: GREEN
worktree: CLEAN
```

### Public native fill slice — COMPLETE

Checkpoint:

```text
861d543 refactor: establish praxis pinned public fill
```

Established:

```text
public native input/textarea
→ exact pinned browser entity
→ no semantic replacement
→ public Executor fill routes through Praxis
→ independent Assurance replacement oracle
→ unsafe semantic re-resolution negative control
→ conservative unknown/unsafe/do_not_retry after possible dispatch
```

Protected fill remained intentionally unchanged during this slice.

Qualification at closure:

```text
pinned-fill target/reference tests: GREEN, repeated
Praxis runtime dispatch-truth tests: GREEN
Assurance truth suite: GREEN, repeated
Executor affected runtime regression: GREEN
full Praxis suite: GREEN
Praxis/Executor/API typechecks: GREEN
repository typecheck: GREEN
subsystem boundaries: GREEN
```

Full commit:

```text
861d5439d202313dc29a29f5945915e97a2807fd
```

### Remaining public text-entry slice — COMPLETE

Checkpoint:

```text
7dfe2e2 refactor: pin remaining public text entry
```

Established:

```text
public contenteditable/focus-keyboard entry
→ exact pinned browser entity
→ exact-handle focus and bounded actionability
→ no locator fallback when reference capture fails
→ replacement during focus refuses before keyboard input
→ replacement during contenteditable select-all refuses without retargeting
→ keyboard-phase failures remain unknown/unsafe/do_not_retry
```

Qualification at closure:

```text
Praxis targeted text-entry/runtime tests: 42/42 GREEN
full Praxis suite: 161/161 GREEN
Assurance truth: 23/23 GREEN
affected Executor runtime: 14/14 GREEN
Praxis/Executor/API/repository typechecks: GREEN
subsystem boundaries: GREEN
```

### Protected fill cutover — COMPLETE

Checkpoint:

```text
1bb3696 refactor: route protected fill through praxis
```

Established:

```text
protected input/textarea/contenteditable/focus-keyboard entry
→ one Praxis-owned pinned text-entry path
→ no Executor native-control dispatch
→ no Locator-based protected text-entry fallback
→ Veil remains the protected-value/privacy/safe-boundary authority
→ pre-dispatch target failure does not enter privacy or dispatch
→ successful protected dispatch enters and verifies the Veil boundary
→ protected values are not serialized in Praxis or Executor results
```

Qualification at closure:

```text
Praxis targeted runtime/reference tests: 43/43 GREEN
Executor protected action/coordinator tests: 37/37 GREEN
isolated persistence-failure system journey: GREEN with one dispatch and no redispatch
Praxis/Executor/repository typechecks: GREEN
subsystem, execution-kernel, and direct-browser boundaries: GREEN
```

The full four-worker Executor browser suite remains resource-sensitive: 413/425
passed in the closure run, while 11 protected-acquisition/journey assertions
timed out or inherited shared fixture state after a 90-second timeout. The changed
persistence-failure journey passes in isolation, and the deterministic changed-path
suites above are green. Treat these broad-suite timing failures as an explicit
verification debt; do not reinterpret them as proof of a protected-fill redispatch.

### Select/check interaction family — COMPLETE

Checkpoint:

```text
7fc66a5 refactor: pin select and check interactions
```

Established:

```text
select option and check/set-checked
→ exact PraxisTargetReference captured during grounding
→ ElementHandle-owned browser mutation in Praxis
→ no Executor/application native-control bypass
→ mechanical pre-dispatch replacement/document refusal
→ exact pinned-entity post-dispatch verification
→ semantically identical replacement cannot satisfy verification
→ post-dispatch uncertainty remains truthful and non-retriable as a fresh mutation
```

Qualification at closure:

```text
Praxis targeted reference/runtime tests: 46/46 GREEN
full Praxis suite: 165/165 GREEN
Executor select/check ownership regression: 15/15 GREEN
protected Create Order check preparation: 5/5 GREEN
Assurance truth: 23/23 GREEN
repository typecheck: GREEN
subsystem, execution-kernel, and direct-browser boundaries: GREEN
```

### Current active slice

Continue the R0.3.5 inventory with press/keyboard as the next distinct active
mechanic. Keep hover, scroll, drag/drop, upload/download, dialog, and page
switching separate and migrate only proven active usage.

Before doing anything:

```bash
git status --short
git log -5 --oneline --decorate
```

Do not reset work left by another agent.

---

# Important current architectural facts

## Executor

Executor still owns or participates in substantial legacy browser/runtime behavior.

Do not delete it before capabilities are deliberately migrated.

Target end-state:

```text
browser lifecycle and browser mechanics → Praxis
product orchestration → application/product layer
trust/privacy → Veil
facts/artifacts → Chronicle
qualification → Assurance
```

Then retire the obsolete Executor surface.

## Praxis

Praxis already contains much perception/reference machinery from the previous architecture.

Reuse factual/mechanical primitives where sound.

Do not preserve old semantic-admission authority merely because code exists.

## Vitract

Vitract is one live qualification surface.

It is not the architecture.

The old live blocker involved popup origin expectation versus actual allowed origin. That incident should be generalized into reusable browser/runtime behavior, not encoded as Vitract-specific policy.

---

# Known operating rule

When a new slice begins:

1. inspect exact current git state;
2. read only the directly relevant path;
3. prove the failure/ownership gap;
4. implement the smallest general migration;
5. add independent proof where feasible;
6. run targeted tests;
7. run relevant package/full regression;
8. commit and push a coherent checkpoint;
9. update this state file;
10. continue to the next ordered slice without waiting unless genuinely blocked.

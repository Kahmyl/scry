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

### Targeted press/keyboard — COMPLETE

Checkpoint:

```text
9c96034 refactor: pin targeted key dispatch
```

Established:

```text
targeted approved-key dispatch
→ exact PraxisTargetReference captured during grounding
→ ElementHandle.press owned by Praxis
→ no Executor native-control fast path
→ replacement/document refusal before keyboard input
→ any Playwright failure after press begins is dispatch-uncertain
```

Qualification at closure:

```text
Praxis targeted reference/runtime tests: 47/47 GREEN
full Praxis suite: 166/166 GREEN
Executor affected ownership regression: 15/15 GREEN
Assurance truth: 23/23 GREEN
repository typecheck and boundary gates: GREEN
```

Targetless page-level key dispatch remains a distinct active mechanic and is
not represented by the current target-required Praxis request contract. Do not
hide it inside the targeted primitive.

### Target-scoped scroll — COMPLETE

Checkpoint:

```text
1cfbd79 refactor: pin targeted scroll dispatch
```

Established:

```text
target-scoped into-view and directional container scroll
→ exact PraxisTargetReference and ElementHandle mechanics
→ no Executor native target-scroll bypass
→ replacement/document refusal
→ pinned-reference post-scroll verification
```

Qualification at closure:

```text
Praxis targeted reference/runtime tests: 49/49 GREEN
full Praxis suite: 168/168 GREEN
Executor affected ownership regression: 15/15 GREEN
Assurance truth: 23/23 GREEN
repository typecheck and boundary gates: GREEN
```

Page-level wheel scrolling remains a separate targetless mechanic.

### Targetless keyboard/wheel mechanics — COMPLETE

Checkpoint:

```text
db9f9e8 refactor: move page input mechanics to praxis
```

Established:

```text
page-level key and wheel input
→ explicit Praxis browser-mechanics functions
→ no fabricated semantic element target
→ Executor retains dispatch composition/truth callbacks only
→ no direct page.keyboard/page.mouse ownership in action-runtime
```

Qualification at closure:

```text
Praxis targetless mechanics: 29/29 targeted reference suite GREEN
full Praxis suite: 169/169 GREEN
Executor kernel regression: 33/33 GREEN
Assurance truth: 23/23 GREEN
repository typecheck and boundary gates: GREEN
```

Remaining usage inventory:

```text
hover: no authored product action; pointer hover exists only inside pinned click actionability
drag/drop: no authored product action
upload: no authored product action; direct usage is Veil qualification infrastructure only
download: active protected acquisition adapter and browser-policy handling
dialog/page switching: active lifecycle/effect ownership, reserved for R0.3.6
protected copy experience: active acquisition adapter with direct keyboard mechanics
```

### Protected copy/download acquisition mechanics — COMPLETE

Checkpoint:

```text
29f7925 refactor: pin protected copy and download mechanics
```

Established:

```text
copy-control activation → pinned Praxis click
keyboard-copy focus → pinned Praxis reference
keyboard-copy page input → Praxis-owned page key mechanics
download activation → pinned Praxis click with armed download observation
Veil clipboard ownership/redaction policy → unchanged
bounded acquisition fallback/deadline behavior → preserved
```

Qualification at closure:

```text
protected acquisition adapter/extractor/deadline tests: 22/22 GREEN
Praxis exact-reference/download tests: 30/30 GREEN
full Praxis suite: 170/170 GREEN
Assurance truth: 23/23 GREEN
repository typecheck and boundary gates: GREEN
```

### R0.3.5 — remaining interaction primitives — COMPLETE

All actively authored interaction mechanics are now Praxis-owned. Hover remains
an internal pinned-click actionability phase; drag/drop and upload have no
authored product action; qualification-only upload code is not runtime
ownership. Dialog and page switching are lifecycle concerns carried into
R0.3.6.

### Praxis browser session lifecycle foundation — COMPLETE

Checkpoint:

```text
990afc6 refactor: establish praxis browser session lifecycle
```

Established:

```text
ordinary Executor browser/context/page creation → Praxis lifecycle
Executor compatibility session creation → Praxis lifecycle
bounded context/browser teardown mechanics → Praxis lifecycle
Executor retains policy, recording, evidence, and product composition
direct-browser boundary now admits Praxis as the ordinary launch owner
```

Qualification at closure:

```text
Praxis lifecycle creation/teardown/timeout tests: 2/2 GREEN
focused Executor executePlan lifecycle regressions: 2/2 GREEN
full Praxis suite: 172/172 GREEN
Assurance truth: 23/23 GREEN
repository typecheck and boundary gates: GREEN
```

The API browser-server driver and protected capsule factory remain explicit
sibling lifecycle owners pending migration; popup adoption remains with the
authoring session until the shared page-adoption lifecycle is established.

### API browser-server lifecycle — COMPLETE

Checkpoint:

```text
c0b1980 refactor: move browser server lifecycle to praxis
```

Established:

```text
launchServer/connect/context/page mechanics → Praxis lifecycle
ownership timeline and identifiers → Praxis lifecycle
graceful close with server fallback → Praxis lifecycle
force-kill fallback and process identifier → preserved
API NativeBrowserDriver → application adapter, not launch owner
```

Qualification at closure:

```text
Praxis lifecycle tests: 3/3 GREEN
full Praxis suite: 173/173 GREEN
Assurance truth: 23/23 GREEN
repository typecheck and boundary gates: GREEN
direct-browser boundary admits only Praxis browser creation
```

### Protected capsule destruction lifecycle — COMPLETE

Checkpoint:

```text
081b78f refactor: move capsule destruction to praxis
```

Established:

```text
isolated context/browser bounded destruction → Praxis lifecycle
force-close fallback → Praxis lifecycle
destroyed versus force_terminated outcome → preserved
Executor capsule factory → privacy/provenance composition only
preparation failure still destroys the capsule before propagation
```

Qualification at closure:

```text
Praxis lifecycle tests: 4/4 GREEN
protected transaction coordinator: 23/23 GREEN
full Praxis suite: 174/174 GREEN
Assurance truth: 23/23 GREEN
repository typecheck and boundary gates: GREEN
```

### Popup/page ownership lifecycle — COMPLETE

Checkpoint:

```text
44194a5 refactor: move popup ownership to praxis
```

Established:

```text
expected-page candidate capture/cardinality → Praxis lifecycle
unarmed popup closure → Praxis lifecycle
candidate settle and load readiness → Praxis lifecycle
candidate adoption/disposal and old-page closure → Praxis lifecycle
allowed-origin decision and expected-origin policy → application composition
Veil authority registration on adopted page → preserved
```

Qualification at closure:

```text
authoring popup/page lifecycle regressions: 4/4 GREEN
full Praxis suite: 174/174 GREEN
Assurance truth: 23/23 GREEN
repository typecheck and boundary gates: GREEN
```

### Current active slice

Finish the R0.3.6 audit for navigation, frame/tab, dialog, download policy, and
teardown call sites. Move remaining mechanical ownership to Praxis, keep
application policy decisions outside, and close R0.3.6 only when no duplicate
production lifecycle model remains.

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

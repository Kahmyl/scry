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

## R0.3 — Praxis / Executor consolidation — COMPLETE

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

### Navigation and teardown lifecycle consolidation — COMPLETE

Checkpoint:

```text
47b5cc5 refactor: consolidate browser navigation lifecycle
```

Established:

```text
navigation, reload, URL/load waiting → Praxis lifecycle
context/page/browser close mechanics → Praxis lifecycle
checkpoint and protected continuation navigation → Praxis lifecycle
CDP session creation → Praxis lifecycle
Executor native-browser-navigation → compatibility re-export only
application origin/popup/download policy listeners → retained as policy composition
```

Qualification at closure:

```text
navigation compatibility: 3/3 GREEN
navigation/protected lifecycle cohort: 26/26 GREEN
authoring/executePlan lifecycle cohort: 6/6 GREEN
full Praxis suite: 174/174 GREEN
Assurance truth: 23/23 GREEN
repository typecheck and boundary gates: GREEN
```

The direct-browser boundary now rejects production browser creation,
context/page/CDP creation, navigation/load operations, and direct lifecycle
close calls outside Praxis. Frame mechanics already live in Praxis grounding
and references; dialog/download admission remains application policy rather
than a second lifecycle model.

## R0.3.6 — browser lifecycle consolidation — COMPLETE

### Current active slice

Begin R0.4 Veil narrowing from the closed R0.3 browser-ownership checkpoint.
Trace actual active Veil call sites, classify narrow trust/privacy authority
versus semantic/action/lifecycle/orchestration authority, and migrate only the
violating responsibility. Preserve disclosure, redaction, capture suppression,
protected-handle, persistence, and safe-boundary invariants.

### Executor semantic-control path — COMPLETE

Checkpoint:

```text
8eb21e7 refactor: retire executor semantic control path
```

Established:

```text
click/wait and protected preparation controls → Praxis only
legacy public-text activation → explicit Praxis interaction intent
Executor executeNativeControl capability and native-only policy → removed
API production composition → no semantic-control or native-effect callback
NativeBrowserDriver duplicate locator/control engine → removed
remaining driver semantic methods → qualification-only Praxis delegates
native-first regression corpus → retired or converted to Praxis expectations
```

Qualification at checkpoint:

```text
repository typecheck: GREEN
direct browser ownership boundary: GREEN
diff integrity: GREEN
full Praxis suite: 174/174 GREEN
full Assurance suite: 34/34 GREEN
Executor R0.3.7 browser cohort: 66/66 GREEN
action-deadline closure: 2/2 GREEN
```

Environment diagnosis and qualification repair:

```text
eb3b890 fix: preserve praxis mutation dispatch lifecycle
```

The apparent Chrome 151 blocker was a restricted process-sandbox denial, not
a browser-version or repository-runtime defect. Both Playwright-managed
Chromium 151.0.7922.34 and system Chrome 151.0.7922.138 launched, rendered,
and closed reliably with the required process permission. No machine-specific
or repository browser workaround was committed.

Restored browser execution exposed one real checkpoint regression:
`executePlan` omitted its Praxis `beforeMutation` hook after native-control
retirement. The repair restores mutation-lifecycle notification immediately
before Praxis dispatch and retains the independent readiness characterization.
The bounded resolved-target proof now observes an actual Praxis-resolved
control rather than the retired native synthesis path.

Next: retire the now-dead native-resolution/effect telemetry surface and the
qualification-only NativeBrowserDriver semantic delegates, migrating active
qualification scripts to direct Praxis composition before deleting those
compatibility methods.

### Native-resolution telemetry retirement — COMPLETE

Checkpoint:

```text
c5ee614 refactor: retire native resolution telemetry
```

Established:

```text
Executor native resolution callback and synthesized target evidence → removed
API native.resolution event adapter → removed
adaptive resolveMs → sourced from Praxis grounding timing
expected-effect timing → unchanged
```

Qualification:

```text
adaptive Praxis-grounding timing characterization: GREEN
Executor semantic evidence regression: 31/31 GREEN
repository typecheck and direct-browser boundary: GREEN
```

Next: migrate active qualification scripts from the qualification-only
NativeBrowserDriver semantic delegates to direct Praxis composition, then
delete those delegates and their retired native-driver regression corpus.

### Native semantic compatibility retirement — COMPLETE

Checkpoint:

```text
83ddd49 refactor: retire native semantic compatibility
```

Established:

```text
active qualification semantic grounding → direct Praxis composition
protected certification control dispatch → Praxis transaction
NativeBrowserDriver semantic resolution/control/effect delegates → removed
NativeBrowserDriver retained surface → browser ownership, navigation, typed same-origin request
obsolete native semantic regression corpus → replaced by focused adapter proofs
```

Qualification:

```text
NativeBrowserDriver adapter cohort: 3/3 GREEN
repository typecheck and direct-browser boundary: GREEN
no executeSemanticControl/resolveSemanticTarget call sites remain
```

Next: continue the R0.3.7 Executor responsibility inventory from this clean
checkpoint, preserving product orchestration and Veil/Chronicle ownership.

### Browser evidence mechanics — COMPLETE

Checkpoint:

```text
0e00179 refactor: move browser evidence mechanics to praxis
```

Ownership classification and result:

```text
screenshot/init-script/document-measurement/DOM extraction mechanics → Praxis
evidence request/privacy orchestration → temporarily Executor application composition
artifact persistence/factual record target owner → Chronicle (remaining retirement path)
Veil visual permit and suppression boundary → unchanged
```

Qualification:

```text
Executor evidence/visual cohort: 4/4 GREEN
full Praxis suite: 174/174 GREEN
repository typecheck and direct-browser boundary: GREEN
```

Next: migrate the remaining recording/tracing browser mechanics to Praxis,
leaving evidence policy and persistence ownership explicit rather than moving
product orchestration into Praxis.

### Recording and tracing mechanics — COMPLETE

Checkpoint:

```text
dd74391 refactor: move recording mechanics to praxis
```

Ownership classification and result:

```text
screencast and Playwright trace start/stop mechanics → Praxis
segment/timeline/artifact orchestration → temporary Executor application composition
privacy suspension/sealing authority → Veil unchanged
artifact record target owner → Chronicle (remaining retirement path)
```

Qualification:

```text
recording/trace/protected-recording cohort: 12/12 GREEN
full Praxis suite: 174/174 GREEN
repository typecheck and direct-browser boundary: GREEN
```

Next: classify and migrate remaining protected extraction/clipboard browser
mechanics without moving protected workflow orchestration or Veil trust policy
into Praxis.

### Protected read and clipboard mechanics — COMPLETE

Checkpoint:

```text
3816222 refactor: move protected read mechanics to praxis
```

Ownership classification and result:

```text
element value/selection and clipboard/copy-event browser mechanics → Praxis
protected acquisition method admission and workflow → temporary Executor application composition
clipboard lifecycle disclosure/suppression authority → Veil unchanged
protected value persistence → application repositories pending Chronicle consolidation
```

Qualification:

```text
protected extraction/acquisition cohort: 17/17 GREEN
full Praxis suite: 174/174 GREEN
repository typecheck and direct-browser boundary: GREEN
```

Next: inventory remaining direct Executor browser runtime calls (checkpoint
state capture, diagnostics, policy listeners, and response observation),
separating factual observation from product orchestration before migration.

### Session/checkpoint state mechanics — COMPLETE

Checkpoint:

```text
52d2e11 refactor: move session state mechanics to praxis
```

Ownership classification and result:

```text
Playwright storage/session state capture and restoration mechanics → Praxis
checkpoint binding/admission/recovery orchestration → temporary Executor application composition
durable checkpoint persistence → application repository pending Chronicle consolidation
protected capsule trust boundary → Veil unchanged
```

Qualification:

```text
checkpoint/capsule/authoring session cohort: 32/32 GREEN
full Praxis suite: 174/174 GREEN
repository typecheck and direct-browser boundary: GREEN
```

Next: classify diagnostics, request/response observation, and browser policy
listeners as factual observation versus application policy, then move only the
remaining low-level mechanics.

### Executor browser-ownership closure — COMPLETE

Checkpoint:

```text
3e58906 refactor: close executor browser ownership
```

Final inventory classification:

```text
browser actions, pinned references, browser/session lifecycle, navigation,
evidence capture, recording/tracing, clipboard reads, and session-state mechanics
→ Praxis

readiness/calibration composition, request/response policy listeners,
popup/download admission, protected-response correlation, checkpoint workflow,
and artifact/evidence request orchestration
→ temporary Executor application composition with retirement through R0.5

privacy admission, disclosure, redaction, capture suppression, clipboard
lifecycle, and protected safe-boundary authority
→ Veil

durable factual events/artifact and checkpoint persistence
→ Chronicle target ownership; remaining application repositories retire through R0.5

browser fixtures, candidate matrices, negative controls, and ownership gates
→ Assurance/qualification only
```

Closure repair and proof:

```text
activate pins the exact target during grounding and carries that entity through dispatch
post-dispatch quality analysis reads the pinned entity, never a semantic replacement
late acquisition retry timeout cannot overwrite stronger observed validation evidence
direct-browser boundary rejects production action mechanics outside Praxis
whole-system candidate qualification is independently deadline-owned per journey
```

R0.3 closure review:

```text
one authoritative browser substrate = Praxis: YES
direct semantic/native browser-action bypass in Executor: NONE
remaining Executor browser code: application composition only, retirement path R0.5
browser lifecycle duplication: NONE
semantic admission authority reintroduced: NO
Veil protected trust boundaries preserved: YES
Praxis: 174/174 GREEN
Assurance: 34/34 GREEN
Executor: 423/423 GREEN, 1 intentionally skipped
repository typecheck: GREEN
subsystem, execution-kernel, and direct-browser boundaries: GREEN
```

R0.3 is closed. Continue directly with R0.4 Veil narrowing by tracing active
Veil call sites and migrating only semantic, action-selection, task-progression,
browser-lifecycle, or general execution authority that violates the narrow
trust/privacy boundary.

## R0.4 — Veil narrowing — COMPLETE

### Semantic safe-boundary payload removal — COMPLETE

Checkpoint:

```text
bbaa3a8 refactor: remove semantic intent from veil boundary
```

Established:

```text
protected-surface verification → application/Praxis responsibility
Veil safe-boundary input → factual protected_surface_closed claim only
InteractionTargetIntent in Veil safe-boundary contracts → rejected
Veil privacy transition and fail-closed collector lifecycle → unchanged
```

Qualification:

```text
focused Contracts/Veil safe-boundary cohort: 16/16 GREEN
full Contracts + Veil suites: 121/121 GREEN
repository typecheck: GREEN
subsystem and direct-browser boundaries: GREEN
```

Next: continue the active Veil call-site inventory. Classify capability leases,
capture decisions, safe-boundary lifecycle, clipboard cleanup, and collector
coordination; migrate only any remaining semantic/action/lifecycle authority
that exceeds Veil's trust/privacy role.

### Clipboard browser-mechanics removal — COMPLETE

Checkpoint:

```text
5802aef refactor: remove browser mechanics from veil clipboard
```

Established:

```text
clipboard clear/read verification mechanics → Praxis
page-to-collector association → Executor application composition
cleanup required/retry/fail-closed finalization truth → Veil
Veil clipboard collector Playwright/Page dependency → removed
```

Qualification:

```text
Veil + protected clipboard/acquisition cohort: 65/65 GREEN
repository typecheck: GREEN
subsystem and direct-browser boundaries: GREEN
```

Next: inspect Veil visual-capture and video-segment Page dependencies. Preserve
mask/disclosure/permit authority in Veil while moving any screenshot, geometry,
DOM, or browser-session mechanics to Praxis/application composition.

### General execution-admission removal — COMPLETE

Checkpoint:

```text
684171b refactor: narrow veil to privacy admission
```

Established:

```text
ordinary scheduling and browser interaction admission → Praxis/application policy
Veil schedule/interact operation contracts → removed and rejected
observation-channel disclosure → Veil
protected-transaction trust boundary → Veil
evidence capture/admission disposition → Veil
```

Qualification:

```text
focused trust-boundary cohort: 55/55 GREEN
full Praxis + Veil suites: 209/209 GREEN
focused Executor regression: 31/31 GREEN
repository typecheck: GREEN
subsystem, execution-kernel, and direct-browser boundaries: GREEN
```

The next queued slice was visual-capture and video-segment browser mechanics,
completed below.

### Visual-capture and video-segment browser-mechanics removal — COMPLETE

Checkpoint:

```text
e20eed1 refactor: remove browser mechanics from veil capture
```

Established:

```text
DOM discovery, mask application/observation, geometry, and document identity → Praxis
screenshot and browser screencast mechanics → Praxis
Veil visual boundary input → narrow factual mask observation plus browser binding facts
capture permits, mask-policy proof, TTL/context/replay checks, and admission binding → Veil
video checkpoint chain and tamper-evident finalization admission → Veil
Veil Playwright dependency → removed
Executor → composition only: Veil decision → Praxis observation/capture → Veil validation
```

Qualification:

```text
focused visual/video/evidence/recording cohort: 19/19 GREEN
full Praxis + Veil and affected Executor browser-backed cohort: 226/226 GREEN
repository typecheck: GREEN
subsystem, execution-kernel, and direct-browser boundaries: GREEN
Veil browser-mechanics ownership scan: CLEAN
```

R0.4 closure audit:

```text
Playwright Page/Browser/Context/ElementHandle in active Veil code: NONE
DOM query, geometry, screenshot, or browser-recording mechanics in Veil: NONE
required trust/privacy authority retained by Veil: YES
semantic target/action/strategy/scheduling/task-progression authority in Veil: NONE
protected disclosure, persistence, redaction, permit, and safe-boundary invariants: PRESERVED
browser-backed qualification: GREEN
```

R0.4 is closed. Stop at this checkpoint; do not begin R0.5 in this slice.

## R0.5 — external reasoning authority — IMPLEMENTATION IN PROGRESS (current)

### Current checkpoint (batch 1)

Completed this batch:

- Slice 1 (ownership/static gates) characterization has been completed for the
  explicit run path: createRun no longer requires compiled-certification status,
  mission-plan readiness, or candidate budget to enter ordinary execution, and the
  mechanical/quality validation split in `apps/api/src/flows/flow.service.ts:validateWith`
  remains authoritative for mechanical refusal.
- Slice 2 (separate mechanical validation from quality findings) repairs are in place in `apps/api/src/flows/flow.service.ts:validateWith`.
- Slice 3 (open direct flow-revision → run creation) removal of compile/certification and objective-ready prerequisites is in place in `apps/api/src/flows/flow.service.ts` and `packages/contracts/src/flow.ts`.

Validation completed:

- `pnpm verify:subsystem-boundaries`
- `pnpm verify:direct-browser-boundary`
- `pnpm verify:execution-kernel-boundary`
- `pnpm verify:production-operations`
- `pnpm --filter @scry/contracts typecheck`
- `pnpm --filter @scry/api typecheck`
- `pnpm --filter @scry/api exec vitest run test/flow-contract-version-reader.test.ts --maxWorkers=1`
- `pnpm --filter @scry/api exec vitest run test/execution-capability-factory.test.ts --maxWorkers=1`
- `pnpm --filter @scry/api exec vitest run test/flow-contract-version-reader.test.ts test/execution-capability-factory.test.ts test/release-admission.service.test.ts test/worker-processors.test.ts --maxWorkers=1`
- `pnpm --filter @scry/contracts exec vitest run --maxWorkers=1`
- `pnpm --filter @scry/api exec vitest run test/orchestration.service.test.ts --maxWorkers=1`

Note:

- `pnpm verify:repository-topology` is currently failing on pre-existing topology
  classification findings unrelated to this batch.

Open before next checkpoint:

- Slice 4 direct Flow representation is implemented: `createFlow` and
  `reviseFlow` now create immutable published revisions directly with mission
  scope, release admission, idempotency, mechanical validation, and optimistic
  revision checks. The mutable draft lifecycle remains available but is no
  longer mandatory for ordinary Flow creation/revision.
- Slice 5+ compatibility migration and wider authority transfer remain outstanding.

Slice 4 focused qualification:

```text
API release-admission and Flow contract tests: 8/8 GREEN
API typecheck: GREEN
git diff --check: GREEN
```

Objective:

```text
Keep Project / Mission / Flow / Run as durable work representation, while the
external intelligent agent owns semantic reasoning, target choice, and task
progression. Scry continues to enforce mechanical validity, current-reference
validity, privacy/trust, mutation truth, persistence integrity, and durable
domain invariants.
```

This inventory traces active API, MCP, worker, Executor, Praxis, contract, and
persistence paths. Names such as `admission`, `checkpoint`, and `UNKNOWN` were
classified by exercised authority, not by name. No production code was changed.

### Active ownership map

| Active path / call site                                                                                                                                                                                                | Authority exercised now                                                                                                                                             | Class                                                                                                                              | Replacement / retained owner                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/mission.ts`, `flow.ts`, `run.ts`; `apps/api/src/missions/mission.service.ts`, `flows/flow-read.repository.ts`, `runs/run-observation.service.ts`                                               | Durable identity, revision, linkage, status, observations, accepted evidence, and idempotency                                                                       | **A — KEEP**                                                                                                                       | Domain/application representation; factual persistence trends to Chronicle                                                                               |
| `packages/contracts/src/plan.ts` and mechanical portions of `validatePlanAgainstPolicy`; `apps/api/src/flows/flow.service.ts:validateWith`                                                                             | Schema bounds, allowed-origin/policy checks, capability existence, secret-reference validity, budgets                                                               | **A — KEEP**                                                                                                                       | Contracts/application policy; browser capability facts from Praxis                                                                                       |
| `packages/executor/src/execution-kernel.ts:admit` capability digest/binding, required physical capabilities, mutation identity and journal-settlement checks                                                           | Mechanical request/capability/fencing validity                                                                                                                      | **A — KEEP**, but rename after authority removal                                                                                   | Application composition plus Chronicle mutation journal; not semantic admission                                                                          |
| `packages/executor/src/execution-kernel.ts:beginMutationFence`; `apps/api/src/runtime/repositories/execution-kernel.repository.ts`; `unknown-mutation-administration.service.ts`                                       | Prevents duplicate dispatch and requires reconciliation after UNKNOWN mutation truth                                                                                | **A — KEEP**                                                                                                                       | Chronicle factual ledger/application safety. UNKNOWN fencing is not task reasoning                                                                       |
| `packages/executor/src/checkpoint-coordinator.ts`; checkpoint portions of `executor.ts`; run successor-checkpoint repositories                                                                                         | Current document/environment binding, sealed restore, claim/fencing, crash-safe handoff                                                                             | **A — KEEP**                                                                                                                       | Praxis browser state + Chronicle facts + application composition                                                                                         |
| `packages/veil/src/**` protected permits, disclosure, redaction, safe-boundary and artifact admission                                                                                                                  | Trust/privacy authority                                                                                                                                             | **A — KEEP**                                                                                                                       | Veil; excluded from R0.5 semantic-admission removal                                                                                                      |
| `apps/api/src/runtime/services/release-admission.service.ts` and `assertAcceptingWork` callers                                                                                                                         | Deployment/schema health gate, not semantic execution judgment                                                                                                      | **A — KEEP**                                                                                                                       | Application operations/readiness; rename only if clarity is needed                                                                                       |
| `apps/api/src/flows/flow.service.ts:createRun` compilation lookup/status/hash checks, `EXECUTION_READY_COMPILATION_REQUIRED`, `COMPILED_CONTRACT_STALE`, candidate-run budget, and authoritative objective-ready check | Makes compile/certify/orchestration ceremony a prerequisite for ordinary Run execution                                                                              | **B — REMOVE AUTHORITY**                                                                                                           | Direct agent-requested Run composition validates Flow revision + environment + mechanical policy only                                                    |
| `apps/api/src/orchestration/orchestration.service.ts:createPlan/activate/bindingBlockers` compiled-contract prerequisites                                                                                              | Refuses an execution binding unless internal compilation/certification declared it ready                                                                            | **B — REMOVE AUTHORITY**                                                                                                           | Keep durable bindings and revision/scope consistency; external agent chooses when to execute                                                             |
| `apps/api/src/authoring/authoring.service.ts:compile`, `publish`, `compileAndCertify`, `waitForCertificationTerminal`; `flow_compilations` publication gate                                                            | Derives an execution-ready contract from probe transcripts and certifies it through a candidate Run before publication                                              | **B — REMOVE AUTHORITY** for compilation-as-admission; **C — DELETE** certification gate/candidate machinery after callers migrate | Flow publication stores immutable representation; Assurance may consume probes/candidate evidence without production admission power                     |
| `apps/api/src/flows/flow.service.ts:createFlow/reviseFlow` hard failures `AUTHORING_DRAFT_REQUIRED`                                                                                                                    | Makes the authoring lifecycle mandatory for ordinary Flow representation changes                                                                                    | **B — REMOVE AUTHORITY**                                                                                                           | Application authoring remains optional representation UX; direct revision APIs may enforce revision/idempotency invariants                               |
| `packages/contracts/src/authoring.ts` certification statuses/results and compiled-contract inputs; `packages/contracts/src/flow.ts` required `compiledContractId`; MCP `compile_and_certify_flow`                      | Public compatibility contract for mandatory certification ceremony                                                                                                  | **C — DELETE** after replacement Run/publication contracts ship                                                                    | Remove through API/MCP/schema compatibility slice, with persisted-record migration                                                                       |
| `apps/api/src/workers/processors/run.processor.ts` `certificationCandidate` → `mode: certify`; Executor capability requirement `mode === certify` → calibration                                                        | Gives certification Runs a distinct execution-admission mode                                                                                                        | **C — DELETE**                                                                                                                     | Normal Runs remain factual executions; Assurance owns qualification campaigns                                                                            |
| `apps/api/src/calibration/**`, protected-transaction calibration checks in `flow.service.ts:validateWith`, `orchestration.service.ts:authorizationBlocker`, and `ExecutionCapabilityFactory.createRun`                 | Mixes factual rehearsal evidence with a mandatory approval gate for protected mutations                                                                             | **B — REMOVE AUTHORITY** from runtime; **D — MOVE** evidence                                                                       | Assurance evaluates calibration evidence; Chronicle stores facts. Explicit user authorization + Veil permits remain the protected-operation trust gate   |
| `packages/praxis/src/risk-policy.ts` confidence/minimum-margin/family thresholds and active grounding callers                                                                                                          | Heuristic confidence can admit/refuse a target choice                                                                                                               | **B — REMOVE AUTHORITY**; factual scores remain useful                                                                             | Praxis returns candidate facts, exact-reference validity, and mechanical ambiguity; external agent owns choice                                           |
| `packages/contracts/src/praxis/**` and InteractionTargetIntent confidence fields                                                                                                                                       | Carries heuristic target-choice admission policy in action contracts                                                                                                | **B — REMOVE AUTHORITY**                                                                                                           | Replace with agent-selected exact reference or an explicitly requested mechanical resolution mode                                                        |
| `packages/praxis/src/observation.ts` expected-effect compatibility; `packages/executor/src/execution-kernel.ts:interact`; `action-runtime.ts`; `authoring-browser-session.ts`; `probe.ts`                              | Arms/verifies declared effects, sometimes adopts a popup and emits internal next-decision guidance; compilation treats verified effect as semantic success evidence | **B — REMOVE AUTHORITY** from action choice/progression; **A — KEEP** narrow factual post-dispatch observation                     | Praxis may report observed navigation/popup/state facts; external agent interprets them. Mechanical popup identity/origin safety remains Praxis/policy   |
| `packages/contracts/src/current.ts`, `grounding.ts`, `execution-kernel.ts` expected-effect schemas                                                                                                                     | Useful optional representation is coupled to required semantic verification and decision-boundary results                                                           | **B — REMOVE AUTHORITY**                                                                                                           | Preserve optional asserted/observed facts only; eliminate requirement that expected-effect agreement authorizes progression                              |
| `packages/executor/src/executor.ts` ordered step loop, `after` readiness, `onFailure`, assertions, checkpoint continuation; `readiness-runtime.ts`                                                                     | Executes and progresses a whole Flow according to Scry-owned readiness/failure semantics                                                                            | **B — REMOVE AUTHORITY** from the ordinary interaction hot path                                                                    | External agent submits/authorizes the next bounded operation; Flow may durably represent suggested/declared sequence. Application records progress facts |
| `packages/executor/src/probe.ts` resolution/allResolved result used by compilation                                                                                                                                     | Probe qualification becomes production semantic admission                                                                                                           | **D — MOVE**                                                                                                                       | Assurance owns qualification; Praxis owns only browser observation mechanics; Chronicle stores factual probe evidence                                    |
| `apps/api/src/adaptive-sessions/mission-flow-authoring.service.ts`, `adaptive-session-kernel.runner.ts`, repository decision-boundary/safe-action state, and `workers/authoring-runtime-owner.ts`                      | Iterates intents, derives operations/effects, decides continuation/retry/budget boundaries, and tells the agent what to do next                                     | **B — REMOVE AUTHORITY**; delete obsolete derived-decision compatibility after clients migrate                                     | Application accepts explicit agent operations and returns facts; external agent owns retry, next action, and completion reasoning                        |
| `packages/contracts/src/execution-kernel.ts` `AgentDecisionBoundary`, `safeActions`, `objectiveDelta`, turn budgets and authoring-turn progression result                                                              | Product contract encodes Scry-owned next-step adjudication                                                                                                          | **C — DELETE** after a factual operation-result contract replaces it                                                               | External agent protocol/application composition                                                                                                          |
| `apps/api/src/orchestration/orchestration.service.ts:onModuleInit/tick/scheduleProject/reconcileMission` and mission-objective orchestration state                                                                     | Timer infers readiness from dependency/evidence state, starts automatic Runs, marks progression, blocks dependents, and writes recommended resume actions           | **B — REMOVE AUTHORITY**                                                                                                           | Keep observable statuses and concurrency/lease facts; external agent explicitly requests each Run and objective decision                                 |
| MCP orchestration tools under `apps/mcp/src/tools/missions/`                                                                                                                                                           | Status/pause/cancel are useful, while activate/start-ready/resume trigger internal progression                                                                      | **B — REMOVE AUTHORITY** for progression commands; **A — KEEP** observation/cancel and explicit run request                        | MCP/application protocol driven by external agent                                                                                                        |
| `apps/api/src/missions/mission.service.ts` accepted-evidence persistence, explicit `finalize-agent-work`, user authorization, cancellation                                                                             | Explicit external decisions and durable domain transitions                                                                                                          | **A — KEEP**                                                                                                                       | Application/domain; Chronicle for evidence facts, Veil for protected trust                                                                               |
| `apps/api/src/missions/mission.service.ts` and orchestration-generated `resume_pointer.recommendedAction`; web/MCP `safeActions`                                                                                       | Scry recommends/determines next task progression                                                                                                                    | **B — REMOVE AUTHORITY**                                                                                                           | Return blocker/current-state facts only; external agent chooses next action                                                                              |
| `packages/assurance/**`, qualification campaigns and certification-named test scripts                                                                                                                                  | Independent qualification, fixtures, and release evidence                                                                                                           | **D — MOVE/KEEP IN ASSURANCE**                                                                                                     | Assurance. Rename “certification” where it could be confused with production admission                                                                   |
| `apps/api/src/runtime/repositories/**`, authoring/adaptive repositories that persist operation outcomes, revisions, events, artifacts, and checkpoints                                                                 | Factual persistence currently lives in application repositories                                                                                                     | **D — MOVE** incrementally                                                                                                         | Chronicle, without moving execution policy into persistence                                                                                              |

### Resolved architectural decisions

#### Decision 1 — target selection uses an agent-selected opaque pinned reference

**Current active behavior and callers.** `InteractionTargetIntent` in
`packages/contracts/src/grounding.ts` carries semantic evidence plus caller- or
risk-derived confidence thresholds. `packages/praxis/src/grounding.ts` ranks
candidates and refuses below minimum confidence, family count, margin, or drift
thresholds. Praxis runtime, Executor actions/probes/protected extraction, API
adaptive authoring derivation, authentication authoring, and MCP authoring turns
all exercise or construct that contract. `PraxisTargetReference` already proves
the correct invariant once an entity is observed: exact page/frame/document/
epoch/entity identity with no semantic re-resolution.

**Authority retained.** Praxis may observe candidate facts, pin an exact entity,
verify reference authenticity/current-document/entity attachment/actionability,
enforce required mechanical capability, and refuse replacement/substitution.
It may report scores/evidence families as non-authoritative diagnostics.

**Authority removed.** Neither Praxis nor application code may choose an action
target, broaden matching, or grant/refuse action permission because a heuristic
score, confidence margin, evidence-family count, semantic similarity, history,
or calibration threshold is high/low. Semantic descriptions may request an
observation/candidate set, never authorize an action.

**Final owner.** The external intelligent agent owns candidate interpretation
and target choice. Praxis owns observation, the server-side pinned-reference
registry, and mechanical dispatch validation. Application composition transports
the opaque reference without interpreting it.

**Final contract.** Split observation from action:

```text
ObserveTargetsRequest = { sessionId, pageId, query?: semantic observation hint }
ObservedTarget = {
  targetReference: opaque server-issued ID,
  pageId, frameId, documentEpoch, documentIdentity,
  capabilities, observableFacts, diagnostics?
}

AgentOperation.target = {
  targetReference: opaque server-issued ID,
  requiredCapability: one mechanical capability
}
```

The registry entry holds the non-serializable `PraxisTargetReference`, is scoped
to the browser session/page/frame/document epoch, is bounded and disposable,
and is invalidated on navigation, document replacement, entity detachment,
session close, or explicit release. Every target-bearing browser action requires
the opaque reference. `inspect/observe` alone may accept semantic hints and
return zero/many candidates. There is no action-side semantic fallback,
`authoritativeReference`, `matching: non_exact`, confidence minimum, or silent
re-resolution. If an observation intentionally yields multiple candidates, all
receive separate references and the agent chooses one.

**Persistence/compatibility.** Persisted Flow target intents and historic scores
remain readable representation/diagnostics, but cannot be converted directly
into executable references. At execution time they are hints for a fresh
observation returned to the agent. Opaque references are ephemeral and must
never be persisted as reusable Flow identity. Old action requests containing
only semantic targets fail with a typed `TARGET_REFERENCE_REQUIRED` after the
cutover; no compatibility resolver may act on their behalf.

**Dependent slices.** 1, 2, 7, 8, 9, 10, and 12.

**Spark implementation instruction.** Establish an observation endpoint/result
that registers one `PraxisTargetReference` per returned candidate; require the
opaque registry ID in every target-bearing action contract; mechanically validate
scope/currentness/capability immediately before dispatch; migrate callers to
observe → external selection → dispatch; retain scores only in observations;
then delete confidence/matching admission branches and prove semantic-only action
requests cannot dispatch, while stale/replaced/cross-document references fail.

#### Decision 2 — expected effects are optional assertions over factual observations

**Current active behavior and callers.** Expected effects are embedded in Flow,
Praxis, adaptive-session, and execution-kernel contracts. Praxis arms network/
page observations and verifies navigation, popup, visibility, value, state, and
network outcomes. Executor kernel/action runtime, authoring browser sessions,
protected extraction, probes, adaptive reconciliation, compilation, and worker
paths use agreement to classify success, adopt pages, derive decision boundaries,
or certify learned interactions.

**Authority retained.** Praxis must observe browser lifecycle and post-dispatch
facts, attach exact popup/page identities, enforce allowed-origin and browser
safety, and preserve conservative mutation truth. An external agent may supply
optional, mechanically testable assertions for evidence. Chronicle stores the
assertion, observation, and evaluation as facts.

**Authority removed.** Scry may not infer what effect should occur, use expected
effect agreement to choose/advance/retry an action, certify semantic correctness,
or reinterpret an assertion mismatch as `not_applied`. Assertion success cannot
be an execution prerequisite. Semantic target resolution inside an effect is
removed.

**Final owner.** Praxis owns unconditional browser-event observation and narrow
mechanical assertion evaluation. Chronicle owns the factual record. The external
agent owns assertion choice, interpretation, and subsequent action/progression.

**Final contract.** Replace `expectedEffect` authority with two separate shapes:

```text
AgentOperation.assertions?: MechanicalAssertion[]
MechanicalAssertion =
  url_equals | url_path_equals | page_opened_from_dispatch |
  referenced_target_visible | referenced_target_value_equals |
  referenced_target_checked | network_response_observed

OperationOutcome.observations = BrowserObservation[]
OperationOutcome.assertionResults = {
  assertionId, status: passed | failed | unavailable, observedFactRefs[]
}[]
```

All target assertions use opaque pinned references from decision 1. Praxis arms
page/network/lifecycle observation for every potentially relevant dispatch, not
only when an expected effect predicts it. A single newly opened page is reported
with exact opener/page identity; multiple pages are reported separately and not
semantically selected. Origin policy refusal remains mechanical. Assertion
failure changes only assertion/evidence status. Functional dispatch outcome and
mutation outcome remain independently factual and conservatively `unknown` once
dispatch may have begun.

**Persistence/compatibility.** Keep historic `expected_effect` JSON and
`expectedEffectVerified` fields readable. Project them into legacy report views,
but never consult them for new dispatch/progression/admission. New records store
versioned assertions, observations, and results. During API transition, accept
legacy expected-effect input only by lossless translation when it is one of the
mechanical assertion shapes; otherwise store it as an unevaluated legacy hint.
Never synthesize a semantic target reference.

**Dependent slices.** 1, 2, 4, 5, 8, 9, 10, and 12. Slice 8 follows slice 7 so
all target assertions can use pinned references.

**Spark implementation instruction.** Add versioned assertion/observation result
contracts; make Praxis lifecycle observation unconditional around dispatch;
evaluate only the listed mechanical assertions; separate assertion status from
functional/mutation outcome; migrate Executor/API/worker/persistence callers;
stop compilation, adaptive turns, and progression from consuming verification;
retain read-only legacy projections; delete semantic effect-target resolution
and expected-effect admission only after repository-wide caller migration.

#### Decision 3 — calibration is qualification evidence, never runtime authority

**Current active behavior and callers.** Calibration services/runners create
contracts, revisions, attestations, decisions, and revocations. Flow validation
requires an approved attestation for protected transactions; orchestration marks
missing calibration as an authorization blocker; run capability composition
verifies the attestation; `certify` mode requires calibration; authoring
compilation digests calibration state. Separate mission authorizations and Veil
protected permits already carry genuine user/trust authority.

**Authority retained.** Explicit user authorization remains required for live or
protected operations under application access rules. Veil retains protected
permit, disclosure, redaction, persistence, and safe-boundary authority. Praxis
retains mechanical protected-transaction execution truth. Calibration runs and
attestations remain useful factual qualification evidence.

**Authority removed.** Calibration status, approval, revision, digest, freshness,
or revocation may not gate Flow publication, Run creation, capability manifests,
protected dispatch, orchestration readiness, or ordinary execution. Calibration
does not become a Veil policy surrogate.

**Final owner.** Assurance owns calibration evaluation/campaigns. Chronicle owns
immutable calibration inputs, observations, outcomes, and provenance. The
application may display/link those facts. Veil and the application authorization
service remain the only protected trust decision owners.

**Final contract.** `CalibrationRecordV1` is evidence only:

```text
{
  id, subject: { flowRevisionId?, operationKind?, environmentId? },
  procedureVersion, observations[], outcome, findings[],
  provenance, recordedAt, supersedesId?
}
```

It has no `approved` execution meaning and is absent from execution requests,
capability manifests, mutation claims, and Veil permits. Protected operation
requests instead carry explicit user `authorizationId` where policy requires it;
application composition verifies authorization identity/scope/expiry, Veil
issues the privacy/trust permit, and Praxis executes mechanically.

**Persistence/compatibility.** Existing calibration tables and API responses
remain readable as historical evidence. Map `approved/revoked` to legacy
evaluation facts, not current permission. Stop writing calibration digests into
new compiled/run contracts. Do not delete records or rewrite history. After all
hot-path references are absent, database columns/FKs may be deprecated by an
additive migration and removed only with explicit retention/export proof.

**Dependent slices.** 1, 2, 3, 4, 5, 6, and 12.

**Spark implementation instruction.** Characterize explicit authorization and
Veil permit refusal first; remove calibration checks from Flow validation,
orchestration blockers, execution capabilities, certification mode, and compiled
digests; route calibration production/evaluation to Assurance and factual writes
to Chronicle; preserve read-only legacy APIs/rows; add a static gate forbidding
runtime imports/queries of calibration authority; prove protected execution
still refuses missing/expired/wrong-scope user authorization and Veil permits.

#### Decision 4 — Run is an externally directed operation ledger

**Current active behavior and callers.** A Run snapshots a whole compiled Flow
plan. The run worker calls `ExecutionKernel.execute`, which calls `executePlan`;
Executor loops through steps, evaluates `after`, assertions, `onFailure`, and
checkpoints, then chooses whether to continue. Adaptive authoring similarly
executes intent batches and emits decision boundaries. Mission orchestration
derives ready objectives and creates Runs automatically.

**Authority retained.** Project/Mission/Flow/Run identities, Flow revisions and
ordered step representation, Run lifecycle, immutable snapshots, operation
sequence, idempotency, concurrency/leases, cancellation, checkpoints, factual
outcomes, evidence links, and explicit agent/user conclusions remain durable.
Scry may reject invalid state transitions and mechanically unsafe operations.

**Authority removed.** Scry may not select a Flow step, infer the next operation,
automatically continue after readiness/effect/assertion results, apply `onFailure`
as progression policy, retry semantically, mark an objective complete from its
own interpretation, or schedule the next objective/Run. A Flow step is a durable
template/reference, not executable authority.

**Final owner.** The external agent owns operation selection, ordering intent,
retry, continuation, and completion reasoning. Application composition owns
atomic command handling and durable lifecycle invariants. Praxis owns each
browser operation's mechanics/truth. Chronicle owns the operation/evidence log.

**Final contract.** Introduce an additive agent-directed Run protocol:

```text
CreateRunV2 = {
  projectId, missionId, objectiveId, agentSessionId,
  flowRevisionId, environmentId, idempotencyKey
}
Run.executionModel = agent_directed_v1

DispatchRunOperation = {
  runId, operationId, idempotencyKey,
  expectedPredecessorOperationId?: string,
  flowStepId?: string, action,
  target?: { targetReference, requiredCapability },
  assertions?: MechanicalAssertion[], evidenceRequests?: [],
  mutationIdentity?: string, checkpointIntent?: establish | restore | none
}

DispatchRunOperationResult = {
  runId, operationSequence, operationOutcome,
  observations, assertionResults, evidenceRefs, checkpointFacts?
}

FinalizeRun = {
  runId, expectedLastOperationId?, disposition:
    completed | stopped | awaiting_external_input | cancelled,
  agentConclusion?: factual/semantic external-agent payload,
  idempotencyKey
}
```

The server assigns a monotonic operation sequence and atomically enforces the
optional predecessor/CAS, idempotency, one active dispatch per Run, mutation
fence, and terminal-state rules. `flowStepId` links representation/provenance but
does not cause Scry to load or execute the next step. The agent may dispatch no
operation, one operation, or many explicit operations during a Run. A protected
transaction remains one bounded atomic operation. Checkpoint restore establishes
mechanical browser state only; it never advances a Flow cursor.

**Persistence/compatibility.** Add `execution_model` and an append-only Run
operation table/Chronicle stream. Keep historic `plan_snapshot`, step reports,
compiled-contract links, and legacy Run reads. Cut over new Run creation to
`agent_directed_v1`; never execute a new legacy batch Run. Before deployment,
drain already-running legacy workers. Mark still-queued legacy Runs as
`awaiting_external_input` with a factual migration reason and require an agent
to create/resume through V2; do not silently replay them. Mixed-version workers
must be prevented by release/schema fingerprint gating. Remove the legacy batch
executor only after no active legacy Run remains.

**Dependent slices.** 1, 2, 3, 4, 5, 8, 9, 10, 11, and 12.

**Spark implementation instruction.** Add V2 contracts/storage and factual read
projection; implement create/dispatch/finalize with transactionally enforced
idempotency, predecessor CAS, leases, mutation fence, cancellation, and terminal
states; route each dispatch to the single-operation kernel/Praxis path; migrate
API/MCP/workers; cut new creation to V2 and drain/fence legacy workers; then
remove `executePlan` progression, readiness/onFailure continuation, automatic
Run creation, and legacy writes while preserving historic reads.

No architectural judgment remains open for these four decisions. Any discovered
requirement to weaken exact-reference identity, conservative mutation truth,
explicit protected authorization, or external progression ownership is a blocker
and must not be locally re-decided during implementation.

### Ordered smallest-first migration sequence

Each slice must remain green and be checkpointed independently. Do not combine
later contract/database cleanup with the authority cut that makes it safe.

1. **Characterize and install R0.5 ownership gates.** Add static inventory gates
   for new production certification prerequisites, confidence-based permission,
   decision-boundary generation, and automatic progression. Add characterization
   tests separating mechanical policy/mutation/privacy refusal from semantic
   admission. Production behavior is unchanged. **Closure:** gates identify all
   current allowlisted legacy sites and reject a new non-allowlisted instance;
   characterization proves schema/origin/reference/mutation/authorization/Veil
   refusals independently. **Verify:** focused contracts/Praxis/Veil/Executor/API
   tests, gate self-tests, typecheck, and all ownership boundaries. **Execution:
   Spark-ready.**
2. **Separate factual validation from semantic readiness.** Split
   `validatePlanAgainstPolicy`/`validateWith` diagnostics into mechanical-policy
   errors versus authoring/quality findings. Only the former may block an
   explicitly agent-requested operation. Preserve schema, origin, budget,
   reference, authorization, and mutation invariants. **Closure:** one typed
   mechanical validation result is the only blocking validation consumed by
   Run/operation paths; quality/authoring findings are returned and persisted
   but never gate execution. **Verify:** valid/invalid policy matrices, protected
   authorization negatives, regression tests for diagnostics persistence, API
   integration, typecheck, schema and ownership gates. **Execution: Spark-ready.**
3. **Open direct Flow-revision → Run execution.** Remove `compiledContractId`,
   execution-ready compilation, certification candidate, candidate-run budget,
   and authoritative objective-ready prerequisites from the explicit Run path.
   Retain project/mission/objective/revision/environment scope, idempotency,
   concurrency, trust authorization, and UNKNOWN fencing. This establishes the
   replacement before legacy deletion. Implement `CreateRunV2` with
   `executionModel=agent_directed_v1`; do not dispatch a plan yet. **Closure:** a
   mechanically valid explicit request creates a durable V2 Run without any
   compilation/calibration/orchestration readiness row, while every retained
   scope/idempotency/concurrency/UNKNOWN/trust negative still refuses. **Verify:**
   API/database integration including replay/concurrency, migration compatibility,
   protected negatives, typecheck, schema fingerprint and boundary gates.
   **Execution: Spark-ready.**
4. **Make Flow publication representation-only.** Publish immutable revisions
   from validated draft/content without probe transcript compilation or a
   certification Run. Restore direct create/revise capability (or one equivalent
   revision command) with revision and idempotency invariants. Probes become
   optional factual evidence. **Closure:** create/revise/publish produces an
   immutable Flow revision from mechanically valid representation with no probe,
   compilation, certification, or calibration prerequisite; optional findings
   are linked as evidence only. **Verify:** revision conflict/idempotency/scope
   tests, old revision reads, optional evidence linkage, API/MCP integration,
   typecheck and schema/ownership gates. **Execution: Spark-ready.**
5. **Delete production compilation/certification admission.** Migrate API/MCP/web
   callers, then remove `compileAndCertify`, publication gates, certification
   worker mode/capability, compiled-contract request requirements, and obsolete
   compatibility responses. Preserve old database rows read-only until an
   explicit migration proves they are no longer referenced. **Closure:** no new
   runtime request, worker, route, MCP tool, UI action, or capability uses
   compilation/certification; legacy rows remain readable and no active run
   references a certification candidate. **Verify:** repository-wide zero-use
   scans, legacy read fixtures, API/MCP/web build, worker tests, typecheck,
   migration/fingerprint and ownership gates. **Execution: Spark-ready.**
6. **Resolve and narrow protected calibration.** Apply decision 3. Remove all
   non-trust calibration prerequisites from Run/Flow admission; move qualifying
   evidence to Assurance and facts to Chronicle. Keep protected authorization
   only under its explicit trust owner. **Closure:** runtime source has no
   calibration-based allow/refuse branch or capability requirement; explicit
   user authorization and Veil permit remain independently mandatory; historical
   calibration is readable as evidence. **Verify:** protected-operation browser
   positives and missing/expired/wrong-scope authorization/permit negatives,
   Assurance calibration tests, Chronicle persistence tests, static import/query
   gate, typecheck and boundaries. **Execution: Spark-ready.**
7. **Remove heuristic target-choice authority.** Apply decision 1 across Praxis,
   contracts, Executor, authoring session, probes, and callers. Add independent
   substitution/stale-document tests before deleting confidence thresholds.
   **Closure:** every target-bearing action requires an opaque pinned reference;
   semantic hints are observation-only; no confidence/margin/family/drift score
   gates dispatch; no post-pin re-resolution exists. **Verify:** browser-backed
   exact-entity, replacement, stale-document, cross-frame/page/session, detached,
   capability mismatch, ambiguous-candidate/agent-selection, and semantic-only
   refusal tests; full Praxis/affected Executor/API; typecheck and ownership
   scans. **Execution: Spark-ready.**
8. **Remove expected-effect progression authority.** Apply decision 2. Keep
   browser facts and exact popup/document mechanics; stop using effect agreement
   to certify learned interactions, advance a turn, or choose a continuation.
   **Closure:** versioned assertions/observations are separate from functional and
   mutation outcomes; assertion failure cannot advance/retry/refuse dispatch or
   produce `not_applied`; semantic effect-target resolution is absent. **Verify:**
   browser-backed popup/navigation/network/value/state assertion matrices,
   multiple-popup facts, origin refusal, post-dispatch failure/UNKNOWN truth,
   legacy read projection, full Praxis/affected Executor/API and boundaries.
   **Execution: Spark-ready after slice 7.**
9. **Replace adaptive authoring turns with explicit operation composition.** The
   API accepts agent-selected bounded operations and returns operation/mutation/
   privacy/evidence facts. Remove derived intent loops, internal retries,
   `AgentDecisionBoundary`, recommended `safeActions`, and objective-completion
   inference after callers use the factual protocol. **Closure:** adaptive/API/MCP
   entry points accept explicit pinned-reference operations and return only V2
   operation facts; no service derives an action/effect/retry/continuation or
   emits prescriptive safe actions. **Verify:** command idempotency/CAS, bounded
   budget as resource limit, crash/recovery and UNKNOWN tests, factual response
   schema tests, MCP integration, browser-backed authoring operations, typecheck
   and progression gates. **Execution: Spark-ready after slices 7–8.**
10. **Remove Executor whole-Flow progression authority.** Apply decision 4.
    Replace the internal step/readiness/onFailure progression loop in ordinary
    execution with agent-authorized operation dispatch. Retain Flow ordering as
    representation and checkpoints as mechanical state, not permission to pick
    the next step. **Closure:** V2 dispatch executes exactly one supplied bounded
    operation; no Run hot path loops Flow steps or consumes `after`, `onFailure`,
    assertions, or checkpoints to select continuation; explicit finalize owns
    terminalization. **Verify:** multi-operation sequencing/CAS, simultaneous
    dispatch, cancellation, timeout/crash, mutation fencing, checkpoint restore
    without cursor advance, browser-backed action families, legacy drain fixture,
    full affected Executor/API and boundaries. **Execution: Spark-ready after
    slices 3 and 7–9.**
11. **Retire automatic Mission orchestration.** Stop the timer from selecting
    ready objectives or creating Runs. Convert orchestration state to observed
    status/leases/concurrency, preserve explicit pause/cancel and authorization,
    and require the external agent to request Runs and persist objective
    conclusions. Remove progression-trigger MCP tools after callers migrate.
    **Closure:** no timer/reconciler creates a Run, selects an objective, infers
    pass/failure/dependency progression, or writes a recommended action; status
    is factual and Run/objective transitions require explicit commands. **Verify:**
    timer-disabled/no-spontaneous-run integration, explicit create/finalize,
    dependency facts without advancement, pause/cancel/concurrency/authorization,
    MCP/web compatibility, typecheck and progression scans. **Execution:
    Spark-ready after slices 3 and 9–10.**
12. **Persistence and compatibility cleanup.** Move remaining factual execution,
    checkpoint, probe, and evidence records toward Chronicle; delete obsolete
    contracts, columns/tables, repositories, UI copy, MCP tools, feature flags,
    and certification/adaptive fixtures only after repository-wide zero-use
    proof. Rename remaining mechanical “admission” surfaces for clarity.
    **Closure:** active production has zero legacy semantic admission/progression
    references; historic Runs/Flows/calibration/effects remain readable; additive
    migrations and retention/export proof precede destructive schema removal;
    remaining admission terminology denotes only mechanical or trust gates.
    **Verify:** repository-wide zero-use scans, old snapshot/database compatibility,
    migration forward/backward and mixed-release rejection, full repository tests,
    browser-backed Praxis/Veil/application suites, web/MCP builds, typecheck,
    fingerprints and every ownership gate. **Execution: Spark-ready last.**

### Execution model assignment

All twelve slices are Spark-mechanical under the resolved contracts above. Spark
must execute them in order and must not reinterpret the four decisions.

**Spark-ready work:**

```text
ownership/static gates and inventory assertions
capability/readiness copy corrections
MCP/controller/client call-site migrations with an established replacement
certification mode/flag/result deletion after Run cutover
dead contract/export/test/feature-flag cleanup
database zero-reference checks and additive/deprecation migrations
moving factual records behind an already-defined Chronicle repository interface
```

**Remaining judgment blockers:**

```text
NONE
```

If implementation discovers a requirement that contradicts a resolved contract,
the affected slice is blocked for explicit architectural review. Spark must not
add a compatibility delegate, semantic fallback, hidden scheduler, or alternate
admission path to proceed.

### R0.5 closure criteria

R0.5 may close only when all are true:

```text
Project / Mission / Flow / Run remain durable, readable, revisioned representation
an explicit agent-selected ordinary operation can execute without compile/certify ceremony
no production certification Run or compiled-contract admission gate remains
no confidence threshold grants or denies semantic target choice
Praxis refuses only mechanical/current-reference/actionability/safety invalidity
expected-effect data is optional assertion/observation, never next-action authority
no service derives the next browser action, retry, objective, or task progression
no timer automatically selects objectives or creates Runs
UNKNOWN mutation fencing and reconciliation remain fail-closed
checkpoint/resume remains mechanical and cannot select continuation semantics
Veil privacy/trust authority and protected-data invariants remain intact
Chronicle persistence remains factual and does not acquire execution policy
Assurance qualification has no production admission power
active API/MCP/web callers use the external-agent factual operation protocol
legacy certification/adaptive/progression compatibility has repository-wide zero-use proof
browser-backed Praxis/Veil/affected application qualification is green
typecheck, schema/migration, subsystem, execution-kernel, and ownership gates are green
```

Next checkpoint starts with slice 1 only. Do not begin implementation by deleting
Project, Mission, Flow, Run, UNKNOWN fencing, checkpoint integrity, mechanical
policy validation, or Veil trust authority.

Before doing anything:

```bash
git status --short
git log -5 --oneline --decorate
```

Do not reset work left by another agent.

---

# Important current architectural facts

## Executor

Executor no longer owns an independent browser/action/runtime substrate. Its
remaining code is temporary application compatibility and composition with a
named retirement path through R0.5; do not move that product orchestration into
Praxis or Veil.

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

# Legacy Qualification Salvage

The pre-reset Praxis and Veil campaigns are a parts warehouse.

Their scenarios may be useful.

Their campaign frameworks, certification hierarchies, scenario-count
requirements, release gates, and old authority assumptions are not inherited
by new Assurance.

A scenario listed here as a candidate is not automatically admitted to the
permanent corpus.

---

# Praxis

## Basic browser interactions

Examples:

- click / activate
- fill / type
- contenteditable
- select
- toggle
- public read

Disposition:

REWRITE AS SMALL CAPABILITY FIXTURES.

Qualification should use independent browser/fixture ground truth rather than
merely checking that Praxis returned `succeeded`.

---

## Target replacement, detachment and stale identity

Disposition:

HIGH-PRIORITY CORPUS CANDIDATE.

Desired invariant:

An operation must not silently dispatch against a different browser entity when
the referenced entity becomes stale, detached, replaced, or belongs to another
document.

Ground truth should independently record dispatches against original and
replacement targets.

---

## Frames, tabs and popups

Candidate phenomena include:

- nested frames
- frame reads
- delayed frames
- frame navigation
- frame detachment
- cross-origin frames
- popup creation
- page identity changes

Disposition:

HIGH-PRIORITY CAPABILITY CANDIDATES.

These should qualify browser topology and reference mechanics, not old
Executor behavior.

---

## Cross-frame / multi-target ambiguity

Disposition:

REWRITE.

Old behavior expected Praxis to adjudicate ambiguity and reject the task.

New behavior should verify that Praxis accurately exposes competing candidates,
their provenance, context, and observable distinctions.

The external agent owns the semantic choice.

---

## Expected-effect mismatch

Disposition:

REWRITE.

Useful facts include:

- whether dispatch occurred;
- how many dispatches occurred;
- what browser outcome was observed;
- whether the requested effect was observed;
- whether outcome remains unknown.

Absence of an expected effect must not become hidden semantic reasoning
authority inside Praxis.

---

## Origin/access refusal

Disposition:

RELOCATE / REASSESS.

Hard scope or trust boundaries may remain enforceable, but they should live
with the subsystem that actually owns that boundary rather than being retained
because an old Praxis campaign expected a particular error code.

---

## Canvas, visual, icon, OCR and occlusion cases

Disposition:

KEEP AS PERCEPTION FIXTURE CANDIDATES.

Qualification should compare Praxis observations with fixture ground truth.

Confidence scores are observations, not execution authority.

---

## Public application campaign

Disposition:

OPTIONAL LIVE-JOURNEY / COMPATIBILITY SURFACE.

Public websites are useful for heterogeneous reality checks.

They are not deterministic corpus fixtures and must not be required release
gates because external content changes independently of Scry.

---

## Endurance, latency and memory

Disposition:

OBSERVATIONAL BY DEFAULT.

Measurements become qualification requirements only when Scry has an explicit
performance or reliability SLO.

---

## Fixed corpus sizes

Examples:

- exactly 100 cases
- exactly 160 cases
- arbitrary repeated replicas

Disposition:

DELETE AS QUALIFICATION REQUIREMENT.

Scenario quantity is not evidence quality.

---

# Veil

## Secret/canary absence

Candidate surfaces include:

- DOM
- screenshots
- video
- traces
- network evidence
- reports
- metadata
- persisted artifact bytes

Disposition:

HARD TRUST INVARIANT.

A protected value must not appear in an unauthorized observable or persisted
surface.

These verifiers should use seeded canaries and direct byte/content inspection.

---

## Protected visual masking

Candidate phenomena include:

- cross-origin frames
- closed shadow content
- canvas
- WebGL
- unknown video regions

Disposition:

HARD TRUST INVARIANT where the corresponding protection feature survives the
lean Veil architecture.

The verifier should inspect decoded output, not merely Veil's decision object.

---

## Clipboard and download disclosure

Disposition:

HARD TRUST INVARIANT.

Protected values must not be disclosed through an unauthorized transfer
channel.

The verifier should independently inspect resulting transfer/artifact state.

---

## Trace sanitization

Disposition:

HARD TRUST INVARIANT.

Inspect decoded trace/archive contents for the seeded protected canary.

---

## Context/browser loss

Disposition:

HARD TRUST INVARIANT.

When Veil can no longer prove safe protection state, it must fail safely rather
than continue unsafe evidence capture or disclosure.

---

## Mask/runtime removal

Disposition:

HARD TRUST INVARIANT.

If a required protection mechanism disappears, the system must either restore
protection before observation/capture or refuse the operation.

---

## Protected capsule teardown and safe evidence continuation

Disposition:

REWRITE AGAINST LEAN VEIL.

Preserve the security property, not the old capsule/coordinator implementation.

Desired invariant:

Protected execution state does not remain observable after the protected
boundary, and ordinary evidence does not resume until the required safe
boundary is established.

---

## Renderer/context destruction

Disposition:

INTEGRATION CANDIDATE.

Where isolation relies on disposable browser contexts, teardown should be
independently observable.

---

## Worker crash recovery

Disposition:

STRONG INTEGRATION CANDIDATE.

Desired properties include:

- no protected-value leakage;
- no unsafe replay;
- deterministic ownership/recovery state;
- bounded recovery;
- no duplicate protected mutation.

Do not preserve the old database/campaign topology merely to preserve this
scenario.

---

## Public application Veil matrix

Disposition:

DELETE AS REQUIRED QUALIFICATION.

Generic public sites provide little additional proof of secret protection when
the secret state itself is synthetic.

A small optional live compatibility smoke may be retained later if useful.

---

## Performance campaign

Disposition:

OBSERVATIONAL.

Cache hits, latency and throughput should not become release gates without an
explicit requirement.

---

## Generated 100-case / replica certification matrices

Disposition:

RETIRE FRAMEWORK.

Preserve representative failure classes and negative controls, not arbitrary
matrix size.

---

# Protected Transaction Certification

The old certification framework is not retained.

Several principles are retained:

1. broad unit-suite success is not direct certification evidence;
2. missing direct evidence must remain unavailable/inconclusive;
3. the production owner of an invariant should be identifiable;
4. canary leakage should be checked directly;
5. partial commit and duplicate dispatch should be independently observable;
6. watchdog/harness failure must not be reported as functional success.

Individual old cells may later become fixtures, experiments, or regression
cases if they satisfy current Assurance admission rules.

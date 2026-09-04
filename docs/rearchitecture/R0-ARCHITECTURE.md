# Scry Four-Boundary Target Architecture

## 1. Canonical status

This document is the single canonical architecture authority for the Scry
four-boundary reset.

Repository source, tests, current reachability evidence, and immutable release
evidence remain authoritative factual evidence. Other architecture documents,
ADRs, roadmaps, state ledgers, implementation plans, runbooks, and historical
reports may explain prior decisions or implementation history, but they do not
override this document.

The reset begins from the deployed production baseline:

```text
0c9cf69cd91eaad1bcd2b11af0c2a8b76d676398
```

The working baseline is a source of proven behavior, not a permanent
architectural pin. Required behavior moves from that active path to the owners
defined here.

The governing architecture statement is:

> External agent reasons. Praxis perceives/acts. Veil protects. Chronicle records. Assurance observes/experiments/diagnoses/qualifies. Product composition organizes Project/Mission/Flow/Run. Completion requires same exact commit source/tests/deploy/journey evidence.

## 2. Reasoning and authority

The external intelligent agent owns semantic reasoning, including:

- interpreting user intent;
- deciding which factual candidate is semantically appropriate;
- deciding whether ambiguity is acceptable;
- selecting the next action;
- deciding whether to create, select, switch, combine, or revisit a Flow;
- deciding whether work is complete.

Scry may enforce mechanical, factual, protection, persistence, tenancy,
authorization, and mutation-budget boundaries.

Scry must not introduce:

- a deterministic semantic planner;
- semantic-confidence execution admission;
- silent semantic target substitution;
- a second protection classifier;
- a second browser-mechanics owner;
- a second durable evidence authority;
- runtime qualification by Assurance.

Uncertainty is represented explicitly. It is never converted into a stronger
claim merely to simplify recovery.

## 3. Praxis — sole browser mechanics owner

Target package:

```text
@scry/praxis
```

Praxis is the sole production owner of browser mechanics.

Praxis owns:

- Playwright browser launch and shutdown;
- browser, context, page, frame, tab, popup, and navigation lifecycle;
- browser owner generations;
- leases, heartbeats, fencing, and mechanical owner-loss detection;
- document epochs and browser page/document/frame identity;
- browser observations and exact browser references;
- DOM, accessibility, text, structure, geometry, visibility, occlusion, visual,
  OCR, canvas, and other browser-derived factual observations;
- action execution;
- exact-reference validation;
- mechanical stale/ref checks;
- synchronization and bounded waits;
- dispatch-boundary mechanics;
- pre-dispatch and post-dispatch mechanical classification;
- commit-window mechanics;
- mechanical origin and request gating;
- checkpoint capture and restore mechanics;
- factual dispatch-boundary classification;
- factual browser/action observations suitable for Chronicle emission.

A Praxis reference is bound to the exact browser entity that was observed.
Replacement elements are different entities even when they have identical
roles, labels, text, selectors, or visual appearance.

Praxis may expose candidate facts, rankings, scores, provenance, and
incompleteness as information. It must not decide which candidate best satisfies
the user's semantic intent.

Praxis must never automatically retry a mutation after dispatch may have begun.

If dispatch definitely did not begin, Praxis may report a mechanically proven
pre-dispatch failure. If dispatch may have begun and the effect is not
independently established, the result remains unknown.

Praxis does not own:

- user intent;
- semantic target choice;
- Mission completion;
- protection classification;
- disclosure policy;
- evidence persistence;
- experiment qualification;
- product tenancy;
- Project, Mission, Flow, or Run persistence.

Praxis may consult Veil only through a narrow protection interface.

Praxis emits factual events through injected ports. It does not depend on
Chronicle storage internals.

## 4. Veil — sole protection authority

Target package:

```text
@scry/veil
```

Veil is the sole authority for protected information and disclosure.

Veil owns:

- protected-value classification;
- exact protected-value matching;
- encoded protected-value matching;
- field, label, pattern, entropy, and context protection signals;
- disclosure authorization;
- protected-value use authorization;
- sanitation;
- screenshot redaction;
- recording redaction;
- trace redaction;
- uncertainty-region expansion when redaction certainty is incomplete;
- encryption and decryption of protected values and protected evidence objects;
- key custody and key-version handling;
- sealing raw protected captures;
- controlled structural interpretation of protected captures;
- protected-output publication authorization.

Exactly one Veil verdict is required before a value, DOM representation,
response body, screenshot, recording, trace, log payload, diagnostic payload, or
other potentially protected material crosses a disclosure boundary.

No other subsystem may independently reinterpret that material as safe.

Cleanup, later deletion, post-capture replacement, or absence scans are not
authorization to expose or persist protected data.

Recording chronology must not contain secret-caused gaps merely because a
protected interval exists. The recording timeline remains factual while visual
or structural protected regions are redacted according to Veil authority.

Raw protected evidence is never exposed to ordinary clients, logs, Chronicle
readers, Assurance evaluators, or the external agent.

Veil does not:

- select semantic browser targets;
- determine user intent;
- own browser lifecycle;
- own browser action mechanics;
- persist durable evidence as Chronicle;
- decide whether a Mission is complete;
- qualify releases.

## 5. Chronicle — sole factual history and evidence authority

Target package:

```text
@scry/chronicle
```

Chronicle owns durable factual history and evidence.

Chronicle owns:

- append-only factual events;
- append-only action facts;
- append-only effect facts;
- authenticated factual streams;
- recording chunks and recording manifests;
- evidence manifests;
- artifact storage;
- artifact provenance;
- artifact integrity;
- capture-publication receipts;
- evidence publication receipts;
- replay;
- offline video construction and rendering from admitted factual inputs;
- Mission report evidence composition.

Chronicle records what factually happened. It does not decide whether an action,
Flow, Run, Mission, or experiment was semantically good.

Chronicle may store an opaque Veil-encrypted object. Chronicle cannot decrypt,
classify, sanitize, or disclose protected content independently.

Chronicle does not own:

- browser mechanics;
- protection decisions;
- semantic planning;
- Mission completion;
- qualification decisions;
- product tenancy.

Runtime subsystems emit Chronicle-compatible facts through injected ports rather
than importing Chronicle storage implementation into browser mechanics.

## 6. Assurance — independent evaluation authority

Target package:

```text
@scry/assurance
```

Assurance is independent from synchronous production execution.

Assurance owns:

- observability queries and analysis;
- diagnostics;
- investigations;
- experiments;
- the Experiment Lab;
- fixtures;
- hidden variants and holdouts;
- failure injection;
- regression analysis;
- campaigns;
- local journeys;
- live journeys;
- independent oracles;
- qualification;
- release-readiness analysis.

Production packages and production entrypoints must not import
`@scry/assurance`.

Assurance may depend on Praxis, Veil, Chronicle, contracts, and public
application clients for evaluation purposes.

Assurance may use Playwright in explicit fixture or test infrastructure. That
does not create a second production browser owner.

Assurance never becomes a synchronous production gate.

A production action does not require Assurance approval.

Qualification result classes are:

```text
PASS
FAIL
BLOCKED
INCONCLUSIVE
SKIPPED
NOT_RUN
```

Only all required checks being `PASS` qualifies a candidate.

Any required `FAIL` fails qualification.

Any required `BLOCKED`, `INCONCLUSIVE`, `SKIPPED`, or `NOT_RUN` means the
candidate is not qualified.

Where practical, an Assurance verifier requires both:

```text
correct implementation -> PASS
deliberately broken comparator -> FAIL
```

A verifier that cannot distinguish them is not valid qualification evidence.

## 7. Product/application composition

Application composition owns product and tenancy semantics.

It owns:

- authentication;
- users;
- workspaces;
- memberships;
- tenancy;
- Projects;
- Missions;
- objectives;
- external agent sessions;
- Flows;
- Flow revisions where useful;
- Runs;
- environments;
- queues;
- job claims;
- database transactions;
- mutation budgets;
- API;
- MCP;
- web composition.

Product composition coordinates subsystem ports but does not duplicate subsystem
authority.

### Project

A Project is a durable workspace/domain boundary.

### Mission

A Mission is the user's durable objective.

Mission state is product state. Praxis does not decide Mission completion.

### Flow

A Flow is not an "alternative attempt."

An external agent may create, select, switch, combine, and revisit multiple
Flows within the same Mission, session, or resume path.

Creating or selecting a Flow never automatically replaces, abandons, fails,
cancels, or completes the Mission.

Scry does not decide that a second Flow should exist.

A Flow may have multiple Runs.

### Run

A Run is one concrete execution record associated with product context.

Run persistence remains application/product composition while factual
browser/evidence history is recorded through Chronicle.

## 8. Contracts

Target package:

```text
@scry/contracts
```

Contracts is a small wire-contract library.

It may contain:

- schemas;
- wire enums;
- transport DTOs;
- stable boundary types;
- validation required to establish the shape of a wire contract.

Every contract must state or make mechanically clear which subsystem owns its
semantics.

Contracts must not contain:

- browser engines;
- execution engines;
- protection decisions;
- secret classifiers;
- durable evidence implementation;
- experiment runners;
- product state-transition services;
- semantic planners;
- policy engines.

Schema validation may reject structurally invalid wire values. It must not
silently become runtime authority that belongs to Praxis, Veil, Chronicle,
Assurance, or product composition.

## 9. Dependency direction

Required dependency direction:

```text
@scry/contracts
  -> no Scry subsystem

@scry/veil
  -> @scry/contracts
  -> crypto/runtime libraries

@scry/chronicle
  -> @scry/contracts
  -> storage/encoding libraries

@scry/praxis
  -> @scry/contracts
  -> narrow @scry/veil interface

application composition
  -> @scry/praxis
  -> @scry/veil
  -> @scry/chronicle

@scry/assurance
  -> may depend on all four owners
  -> may depend on public application clients
```

There must be no dependency cycles.

Praxis emits facts using injected ports rather than depending on Chronicle
storage implementation.

Production packages and entrypoints must not import Assurance.

Playwright outside Praxis is permitted only in explicit test/fixture
infrastructure.

Protection classification or disclosure logic outside Veil is forbidden.

Durable evidence implementation outside Chronicle is forbidden.

Qualification decisions outside Assurance are forbidden.

## 10. Naming and runtime identity

Scry-owned runtime generation branding is not part of the target architecture.

Active runtime names must not retain identifiers such as:

```text
V2
v2
browser-v2
browser_v2
BROWSER_V2
browser-runtime-v2.*
/api/v2
```

These are removed during the naming/protocol cutover rather than renamed into a
disguised version.

Stable immutable identities remain appropriate where they represent factual
release or evidence identity:

- exact release commit;
- schema fingerprint;
- capability digest;
- evidence-format digest;
- immutable image digest.

Private package metadata may use `"version": "0.0.0"`.

## 11. Migration and compatibility rules

The deployed browser baseline is the working source of production behavior.

Required behavior is transferred deliberately to the canonical owners.

Older unreachable Praxis, Veil, Chronicle, Executor, Policy, Observability,
application, or MCP implementations are not restored into production merely
because their names resemble the target architecture.

There is no permanent compatibility architecture.

Temporary forwarding is permitted only inside an unmerged migration phase and
must be gone before the pull request is complete.

Before completing a migration slice:

- consumers use the canonical owner;
- forwarding is removed;
- displaced paths are unreachable;
- required behavior has focused characterization;
- static checks prove no duplicate authority remains.

There is no active-tree legacy archive.

Git history and immutable tags are the historical archive.

Do not create or preserve:

```text
legacy-old
old-runtime
disabled duplicate implementations
permanent compatibility branches
parallel entrypoints
maintained archive branches
```

## 12. Database reset

Execution history is not migrated into the new canonical execution model.

The canonical reset preserves only:

- users;
- workspaces;
- memberships;
- Projects required to preserve product identity.

Preproduction execution data is test data.

Do not backfill historical:

- Missions;
- Flows;
- Runs;
- agent sessions;
- effects;
- captures;
- recordings;
- credentials;
- artifacts.

The canonical schema is re-established from a fresh baseline migration after
the ownership moves are complete.

## 13. Mutation and recovery truth

Scry must not automatically retry a mutation that may have been dispatched.

Mechanical truth classes must distinguish at least:

- dispatch definitely did not begin;
- dispatch began and effect is established;
- dispatch may have begun and effect is unknown.

Recovery cannot convert an unknown mutation into not-applied merely because
cleanup succeeded.

Checkpoint mechanics belong to Praxis.

Product decisions about whether and how to continue belong to the external
agent and application composition.

## 14. Experiments and qualification

Experiments are required when repository evidence reveals architectural
uncertainty that cannot safely be resolved by inspection and characterization.

An isolated experiment records:

- observed problem;
- hypothesis;
- hard assumptions;
- unchanged baseline;
- candidates;
- frozen source commit;
- journey;
- independent oracle;
- broken comparator where practical;
- adversarial or refusal case;
- privacy boundary;
- external-effect boundary;
- fixtures;
- hidden holdouts;
- seeds;
- evaluator provider, model, and settings;
- time and tool budget;
- attempts;
- stop conditions;
- live relevance;
- output paths;
- result classification.

Experiment execution is isolated from production state:

- isolated worktree;
- isolated database;
- isolated queues;
- isolated fixtures;
- isolated artifacts;
- pinned evaluator;
- preserved failures;
- preserved commands;
- preserved timings.

Harness repairs and product repairs are distinguished.

Best-run selection is forbidden.

Production behavior remains independent from the experiment mechanism.

## 15. Anti-divergence invariants

The reset must preserve these invariants:

1. Start from the active deployed browser baseline.
2. Salvage only behavior supported by characterization or evidence.
3. Delete only after required behavior has moved or unreachability is proven.
4. Do not add provider/site-specific runtime logic for Vitract or any other site.
5. Do not add app, fixture, endpoint, or field-name exceptions to production mechanics.
6. Do not build a deterministic semantic planner.
7. The external agent cannot bypass mechanical scope, protection, or mutation boundaries.
8. Fixture success is not live proof.
9. Never automatically retry a possibly dispatched mutation.
10. Evidence persistence remains independent from semantic interpretation.
11. Recording redaction must not create secret-caused chronology gaps.
12. Raw protected evidence is never exposed.
13. Assurance is not runtime approval.
14. Do not combine naming, behavior transfer, database reset, and deletion into one unreviewable change.
15. Unexplained failures stop advancement.
16. Repeated failures with the same causal class require an isolated experiment.

## 16. Final closure condition

The reset is complete only when static and runtime evidence prove:

- Praxis is the sole production browser mechanics owner;
- Veil is the sole protection authority;
- Chronicle is the sole durable factual evidence authority;
- Assurance is the sole qualification authority and remains outside production execution;
- product composition owns Project/Mission/Flow/Run and tenancy semantics;
- contracts contain wire contracts rather than hidden engines;
- displaced Executor, Policy, Observability, browser-runtime, and obsolete application paths are gone after cutover;
- production names have no Scry-owned runtime version branding;
- the canonical database is active;
- source, qualification, deployment, and external journey evidence refer to the same exact commit and immutable image.

The final architecture is:

> External agent reasons. Praxis perceives/acts. Veil protects. Chronicle records. Assurance observes/experiments/diagnoses/qualifies. Product composition organizes Project/Mission/Flow/Run. Completion requires same exact commit source/tests/deploy/journey evidence.

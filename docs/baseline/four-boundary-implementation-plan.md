# Scry four-boundary implementation plan

Status: canonical plan for research and implementation

This plan turns the [four-boundary direction](four-boundary-direction.md) into
reviewable work. It begins from the current cleaned baseline and does not adopt
an earlier reset plan, its assumptions, or its sequence. The current product
and baseline documents are the authority for intended behavior.

The plan is deliberately evidence-led. Existing code named Praxis, Veil,
Chronicle, or Assurance is not automatically accepted, and code outside those
packages is not automatically obsolete.

## Completion outcome

The reset is complete when:

- all production browser mechanics have one owner in Praxis;
- all protection decisions and cryptographic protection have one owner in
  Veil;
- all durable evidence management has one owner in Chronicle;
- diagnostics, experiments, and qualification have one owner in Assurance;
- application code composes those owners without duplicating them;
- production code has no dependency on Assurance;
- displaced implementations and obsolete verification have been removed;
- public product behavior and durable data remain compatible unless an
  intentional, documented change is approved; and
- verification proves the important success and failure paths through the
  deployed composition.

## Working rules

- Separate architectural relocation from product feature expansion.
- Investigate reachability and behavior before deleting or moving code.
- Move one complete behavior slice at a time, including its failure semantics
  and verification.
- Preserve mutation truth, protected-information safety, workspace isolation,
  and evidence completeness throughout the work.
- Do not automatically retry a command after possible dispatch.
- Use capability and state checks for admission; do not couple admission to
  source or artifact identity.
- Keep one coherent change per commit so that failures and regressions remain
  attributable.
- Delete an old path only after all production consumers use the new owner and
  the replacement has production-shaped proof.
- Stop when evidence contradicts the planned ownership; update the model before
  adding a bypass.

## Workstream 1: fresh baseline research

### Objective

Establish what the current baseline actually executes and where each relevant
responsibility, state transition, and failure decision lives.

### Required research outputs

Create a baseline research record containing:

1. **Reachability ledger** — every production entry point, queue consumer,
   worker, package, and important source path reachable from the dashboard,
   API, agent integration, migration task, and deployed containers.
2. **Responsibility inventory** — each browser, protection, evidence, and
   assurance behavior with its present implementation and intended owner.
3. **State ownership map** — durable tables, in-memory state, artifact storage,
   queues, leases, checkpoints, and caches, including who may change them.
4. **Failure map** — pre-dispatch, post-dispatch, privacy, storage, ownership,
   recovery, and shutdown failures with the current observable result.
5. **Dependency graph** — runtime imports and calls between applications and
   packages, distinguishing production, migration, script, and test paths.
6. **Verification inventory** — every remaining test, static boundary check,
   migration check, smoke path, and deployment check, mapped to a baseline
   invariant.
7. **Disposition ledger** — each relevant implementation unit marked `retain`,
   `move`, `rewrite`, `replace`, or `delete`, with evidence and destination.

### Research method

- Start from deployed entry points and follow imports and calls inward.
- Confirm configuration and package declarations against actual runtime use.
- Compare durable schema with repository writes and read models.
- Trace at least one read-only command, one controlled change, one protected
  capture, one evidence stream, one recovery, and one report publication from
  admission to terminal state.
- Run narrow characterizations where code inspection cannot establish behavior.
- Record fact separately from inference and unresolved questions.
- Treat historical code and documents as leads only.

### Exit gate

No boundary implementation begins until the research record accounts for every
production path that can operate a browser, handle a protected value, persist
evidence, or gate release. Unknown or conflicting ownership remains an explicit
blocker rather than being assigned by package name.

Result: complete. The
[four-boundary baseline research](four-boundary-baseline-research.md) records
the reachability, ownership, state, failure, verification, disposition, and
explicit treatment of baseline gaps used by later workstreams.

## Workstream 2: contracts and composition seam

### Objective

Make ownership enforceable before moving behavior.

### Deliverables

- Define the smallest command, observation, dispatch-fact, protection,
  evidence, and diagnostic contracts required between owners.
- Define ports at the boundary that needs the capability and wire adapters in
  application composition.
- Add dependency rules that prevent production imports from Assurance and
  prevent applications from reaching boundary internals.
- Add ownership checks that identify duplicate browser, protection, evidence,
  and diagnostic implementations.
- Preserve the public HTTP and agent contracts while internal seams change.

### Verification

- Contract parsing and failure cases.
- Compile-time and repository-boundary checks.
- Characterization tests proving the composition seam preserves current
  behavior.
- A negative check showing a deliberately forbidden dependency is rejected.

### Exit gate

The seams are usable by one production slice without exporting an engine,
repository implementation, keyring, or mutable internal state as a shared
contract.

Result: the initial Praxis execution and Veil report-protection seams are in
use. More specific ports are defined when a complete behavior slice requires
them; unused speculative interfaces are not a completion requirement.

## Workstream 3: establish Veil as protection authority

### Objective

Move or rebuild protection behavior behind Veil before relocating producers of
sensitive browser output.

### Scope

- protected-input references and browser fill disclosure;
- classification, lineage, exact and encoded matching;
- observation, capture, replay, telemetry, and report sanitization;
- quarantine, field-level publication decisions, and discard behavior;
- cryptographic key selection, encryption, decryption, and compatibility reads;
  and
- fail-closed protection results and safe errors.

### Verification

- Protected values never appear in public observations, logs, replay, reports,
  or error bodies.
- Public classification cannot override protected lineage or detection.
- Partial publication failure exposes no partial output and preserves a
  recoverable quarantined capture.
- Discard destroys reusable protected payload material.
- Canonical writes and authenticated compatibility reads behave as documented.
- Other production components can request a Veil decision but cannot issue one
  themselves.

### Exit gate

Every production disclosure and cryptographic protection path is accounted for
by Veil or explicitly blocked pending migration. Duplicate protection engines
are removed only after consumer cutover.

Result: complete. Veil owns the extracted baseline protection engine,
sanitizers, protected capture quarantine, recording privacy rules, publication
admission, keyring, value cipher, and evidence cipher. API repositories retain
their transactions and call Veil for protection decisions. The dormant Veil
implementation and displaced runtime copies have been removed. See the
[progress and verification record](four-boundary-progress.md).

## Workstream 4: establish Chronicle as evidence authority

### Objective

Put the durable history of browser work and its review artifacts under one
evidence owner.

### Scope

- action, dispatch, effect, capture, recovery, and closure facts;
- evidence stream and chunk admission;
- artifact manifests, storage adapters, retention, and deletion;
- ordering, provenance, integrity, completeness, and replay construction;
- Mission and report evidence composition; and
- safe evidence read models for product review and Assurance.

### Verification

- Repeated delivery converges on the same durable fact or evidence identity.
- Missing, duplicate, reordered, or altered chunks prevent successful evidence
  closure.
- Chronicle cannot decrypt, publish, or reclassify protected content without a
  Veil decision supplied through composition.
- A stale browser owner cannot append authoritative evidence.
- Reports remain bound to the accepted Mission evidence set.
- Artifact deletion and retention preserve database and storage consistency.

### Exit gate

All production evidence writes and reads use Chronicle's public boundary, and
no alternate artifact or evidence ledger remains reachable.

## Workstream 5: establish Praxis as browser authority

### Objective

Move the complete browser execution lifecycle into Praxis after protection and
evidence ports are stable.

### Scope

- browser, context, page, tab, and frame lifecycle;
- ownership leases, heartbeats, generations, and stale-owner fencing;
- navigation, observation, targeting, document epochs, and action execution;
- read-only request gating and admitted controlled changes;
- factual dispatch boundary and mutation recovery observations;
- checkpoint capture and restore mechanics; and
- browser-specific capabilities, including the current Chrome-based path.

### Verification

- Read-only interactions cannot produce undeclared writes.
- A controlled change permits only its admitted request and budget.
- Stale owners and stale document references cannot write results.
- Pre-dispatch failure remains safely retryable; possible post-dispatch failure
  becomes observable uncertainty and is not automatically replayed.
- Ownership loss and checkpoint recovery preserve security and evidence
  continuity.
- The current end-to-end browser journey behaves through Praxis with Veil and
  Chronicle supplied through explicit ports.

### Exit gate

All production browser mechanics enter through Praxis. Application workers are
reduced to queue handling, transactions, lifecycle orchestration, and adapter
wiring. The displaced consolidated browser runtime and duplicated browser
paths can then be removed.

## Workstream 6: establish Assurance as diagnostic authority

### Objective

Consolidate diagnosis and qualification only after the production boundaries
and their public facts are stable.

### Scope

- diagnostic interpretation of safe logs, metrics, traces, facts, and evidence;
- reproducible defect characterizations and investigation records;
- local fixtures, scenario generators, controlled variants, and failure
  injection;
- browser, privacy, evidence, recovery, performance, and compatibility
  campaigns;
- finding, inconsistency, uncertainty, and coverage analysis; and
- qualification and release-readiness reports.

### Verification

- Production packages build and run when Assurance is absent.
- Assurance uses only public contracts, safe read models, and deployed
  interfaces.
- Qualification outcomes are reproducible and retain their evidence.
- A diagnostic conclusion cannot mutate or replace Chronicle facts.
- Required release checks fail for a demonstrated invariant breach and pass
  only after the breach is repaired.

### Exit gate

All retained diagnostic and qualification work has an explicit home in
Assurance, and unrelated historical campaigns or checks have been deleted.

## Workstream 7: displacement cleanup

### Objective

Remove the implementations and verification that the established boundaries
have replaced.

### Deliverables

- Remove the consolidated browser-runtime package after its last production
  consumer is gone.
- Remove duplicate browser, protection, evidence, and diagnostic paths wherever
  they reside.
- Remove transitional adapters after all callers use the final ports.
- Remove tests that assert obsolete structure, historical milestones, or
  behavior outside the documented baseline and direction.
- Keep or replace every test that protects a current product invariant.
- Update package manifests, workspace configuration, container build inputs,
  deployment commands, and documentation together.

### Exit gate

Repository search, dependency checks, build graphs, and deployed smoke tests
show no reachable displaced path. Every remaining verification maps to a
current product promise, security invariant, compatibility obligation, or
boundary rule.

## Workstream 8: completion proof

### Required proof portfolio

- clean install, formatting, type checks, builds, migrations, and package tests;
- static dependency and ownership checks;
- API and agent contract tests;
- transactional and queue redelivery tests;
- protected-input, protected-capture, sanitization, and key-compatibility tests;
- evidence corruption, incompleteness, retention, and replay tests;
- browser ownership loss, stale-reference, pre-dispatch, post-dispatch, and
  recovery tests;
- local production-shaped end-to-end journeys;
- deployed smoke tests for the supported browser path; and
- Assurance qualification showing that diagnostics are useful without being a
  production dependency.

Any failing invariant returns the work to the owner responsible for the defect.
Passing unit tests alone is not completion if the composed deployed path has
not been exercised.

## Recommended sequence

The recommended sequence is:

```text
fresh research
    -> contracts and composition seam
    -> Veil protection authority
    -> Chronicle evidence authority
    -> Praxis browser authority
    -> Assurance diagnostic authority
    -> displaced-code cleanup
    -> completion proof
```

Veil comes first because later browser and evidence movement must not open a
temporary path around protection. Chronicle follows so Praxis has one stable
destination for factual execution output. Praxis then absorbs the browser
mechanics without also inventing privacy or evidence ownership. Assurance is
settled after the production facts and interfaces it evaluates have stabilized.

The sequence may be revised only when baseline research proves a dependency or
safety constraint that makes another order necessary. Such a revision must be
recorded in this plan before implementation continues.

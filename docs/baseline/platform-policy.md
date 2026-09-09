# Scry platform policy

Status: canonical baseline policy

This document defines the operating rules for the product described in the
[Scry baseline brief](../product/baseline-brief.md). These rules apply to the
dashboard, agent integrations, browser execution, stored evidence, and final
reports.

## Purpose

Scry gives an AI agent a protected browser workspace for an authorized
application test. The agent supplies judgment and chooses the next action.
Scry supplies scope control, durable state, mutation safeguards, protected
information handling, evidence preservation, and report gates.

The baseline must never turn an agent's claim into a system fact merely because
the agent stated it. Facts about execution come from durable Scry records.

## Authority model

### User authority

The user controls:

- workspace membership and role;
- Project creation;
- the application origins authorized for an Environment;
- whether an Environment keeps all application output confidential or permits
  selected ordinary output to be released;
- creation and selection of saved credentials;
- the testing instruction and permitted mutation budget; and
- review of the resulting evidence and report.

### Agent authority

Within the user's scope, the agent may:

- create and continue a Mission;
- define Objectives and Flows;
- start Runs;
- choose supported browser commands;
- request a controlled application change;
- classify a mutation outcome when evidence supports the classification;
- classify the Run outcome; and
- write the final Mission report.

The agent may not broaden the allowed origins, reveal protected values, bypass
mutation controls, overwrite recorded history, or publish an incomplete
Mission as complete.

### Platform authority

Scry is authoritative for:

- workspace and Project scope;
- the immutable Environment snapshot attached to a Run;
- browser-owner and command-owner fencing;
- command and mutation idempotency;
- whether a mutation request was dispatched;
- the durable capture and publication state of mutation output;
- protected-value custody and disclosure decisions;
- evidence continuity and integrity; and
- whether finalization and report publication gates are satisfied.

Scry is not authoritative for whether the tested application is correct. The
agent makes that judgment and records a conclusion supported by evidence.

### Intended subsystem authority

The platform will enforce four non-overlapping subsystem authorities:

- Praxis is authoritative for browser execution mechanics and factual
  dispatch state;
- Veil is authoritative for protection, disclosure, and cryptographic handling;
- Chronicle is authoritative for durable evidence history, provenance,
  integrity, and completeness; and
- Assurance is authoritative for diagnostic interpretation, experiments, and
  qualification, but never for production lifecycle truth.

Application composition remains authoritative for product admission,
transactions, queues, and lifecycle state. It must request boundary decisions
rather than duplicate them. This is the planned ownership model; present
implementation gaps are governed by the
[four-boundary implementation plan](four-boundary-implementation-plan.md).

## Workspace and Project isolation

Every user-scoped resource belongs to a workspace, directly or through a
Project. A user or agent credential may access only resources reachable from
its workspace. Cross-workspace identifiers must behave as unavailable.

Project creation is a signed-in user action restricted to owners and admins.
Agent credentials may list Projects but cannot create them. Viewers cannot
create Environments.

## Environment policy

An Environment defines:

- one first-party application origin;
- optional service origins;
- whether the Environment is active; and
- its disclosure mode.

A Run copies this policy when it starts. Later Environment changes must not
broaden an active Run.

Navigation is restricted to the first-party origin. Read requests may support
ordinary page operation. Cross-origin writes are blocked. The presence of an
allowed service origin does not grant the agent permission to navigate away
from the first-party application.

## Browser interaction policy

The baseline supports navigation, observation, filling, clicking, selected key
presses, protected capture handling, mutation determination, and session
closure.

Observed element references belong to one browser document epoch. Navigation
invalidates earlier references. An action using a stale reference must be
refused rather than redirected to a newly matching element.

Ordinary clicks and key presses run under a read-only network policy. Safe read
requests may continue; any attempted write is blocked and the agent is told to
use a controlled change.

## Controlled-change policy

A controlled change is required for an action that may alter application
state.

For each controlled change, Scry must:

1. verify the current browser owner and document reference;
2. reserve capacity from the Run's authentication or business mutation budget;
3. create an idempotent effect record before dispatch;
4. permit only the first same-origin write caused by the selected control;
5. block every additional write;
6. capture the owned response within the configured bound;
7. preserve the successor observation; and
8. require a factual mutation outcome before successful closure.

A Run may have at most one unresolved effect in each mutation class. Repeating
the same idempotency key returns the existing effect only when its declared
intent is identical. A conflicting reuse is refused.

## Mutation truth

Mutation truth is represented independently across four dimensions:

- dispatch: whether a request was not started, started, acknowledged, or lost
  after dispatch;
- capture: whether response evidence is absent, durable, unavailable, expired,
  or corrupt;
- publication: whether captured output is unsettled, published, discarded, or
  failed; and
- outcome: whether the application change is pending, applied, not applied, or
  unknown.

`unknown` is a terminal factual result, not permission to retry. If dispatch
may have occurred and the result cannot be established, Scry preserves the
uncertainty. An undispatched action may be marked `not_applied`; it cannot be
marked `applied` or `unknown`.

## Protected-information policy

Saved credentials are stored as protected values. Listing them returns safe
metadata only: identity, display name, state, and expiry. Plaintext is never
returned by a read operation.

A credential may be bound to an active Run only after an explicit user choice.
A similar or unique display name is not sufficient authorization. Bound values
may be decrypted only inside the worker for the scoped browser fill.

Application output captured after a mutation remains quarantined until it is
published or discarded. Publication requires an explicit field selection and
a protection decision for every selected output.

The disclosure modes are:

- `confidential`: selected values remain protected references; and
- `trusted_application_output`: selected ordinary values may be released when
  the protection authority finds no protected lineage or high-confidence
  secret signal.

A protected classification always overrides a proposed public classification.
Discarding a capture destroys its encrypted payload and structural index and
creates no reusable output handles.

## Evidence policy

The browser session is continuously recorded. Inputs are masked, sensitive
values are sanitized, high-risk media surfaces are blocked from replay, and
recorded events are written to an encrypted, ordered hash chain.

A successful Run requires a complete, gap-free evidence stream with at least
one durable chunk and a chain head. The sanitized replay is derived from the
verified evidence stream, not from an independent browser recollection.

Evidence proves what Scry recorded. It does not independently prove that the
agent tested every possible scenario or that every statement in a report is
correct.

## Finalization and reporting policy

A passing Run cannot close while any mutation outcome is pending or unknown,
any durable capture is unsettled, or evidence is incomplete.

Failure finalization may preserve a post-dispatch effect as `unknown`, but it
still requires every durable capture to be published or discarded and the
evidence stream to be complete.

A Mission report may be published only when:

- every Objective is terminal;
- every Run is terminal;
- no mutation remains pending;
- at least one complete evidence stream exists; and
- every included evidence stream has a chain head.

Report text and structured report data are sanitized against protected inputs
and protected outputs before storage. Publication is idempotent: a Mission has
at most one final report.

## Baseline exclusions

The platform policy does not claim automatic scenario generation, automatic
Flow execution, built-in correctness assertions, multi-browser comparison,
responsive testing, visual-difference detection, autonomous campaign
scheduling, or application repair.

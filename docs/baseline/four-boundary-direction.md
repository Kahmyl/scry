# Scry four-boundary direction

Status: canonical architectural direction; not a description of completed work

This document records how the browser-testing platform described in the
[Scry technical brief](../product/technical-brief.md) will be divided. The
existing implementation remains described by the
[Scry baseline brief](../product/baseline-brief.md). Where current source code
does not match this direction, that mismatch is work to investigate and
resolve; it does not change the direction.

## Why these boundaries exist

Scry performs several kinds of work that have different rules and failure
consequences. Browser control, protection, evidence custody, and quality
analysis must not become interchangeable responsibilities inside one large
runtime.

The target model gives each responsibility one authoritative owner:

- **Praxis** owns browser execution;
- **Veil** owns protection;
- **Chronicle** owns evidence management; and
- **Assurance** owns diagnostics, analysis, experiments, and qualification.

These are responsibility boundaries, not marketing names and not claims about
the quality or reachability of packages that already use those names.

## Praxis: browser execution

Praxis owns the live mechanics of operating supported browsers. Its
responsibilities include:

- launching and closing browsers, contexts, pages, tabs, and frames;
- navigation, waits, interaction, and browser-level observation;
- document-scoped element references and stale-reference rejection;
- origin and request mechanics needed to enforce an admitted action;
- browser-session ownership, leases, heartbeats, generations, and fencing;
- checkpoint capture and restore mechanics;
- factual reporting of whether an action reached the point of dispatch; and
- browser-specific behavior across engines, devices, and viewports as that
  coverage is added.

Praxis does not decide whether information is safe to expose, own durable
evidence history, interpret findings, decide whether an application is
correct, or own Missions and Runs.

## Veil: protection

Veil is the sole authority for protecting sensitive information and deciding
whether a value or capture may cross a confidentiality boundary. Its
responsibilities include:

- protected-value classification and lineage;
- exact and encoded protected-value detection;
- disclosure decisions and safe replacement with opaque references;
- sanitization and redaction of observations, captures, telemetry, replay,
  and reports;
- protected-input and protected-output handling;
- key selection, derivation, encryption, decryption, and rotation policy;
- capture quarantine and publication authorization; and
- fail-closed behavior when protection cannot be established.

Veil does not drive the browser, decide what the agent should test, store the
authoritative evidence history, or classify product behavior as correct or
incorrect.

## Chronicle: evidence management

Chronicle owns the durable, reviewable account of what happened. Its
responsibilities include:

- append-only action, dispatch, effect, and recovery facts;
- evidence streams, ordered chunks, manifests, and artifact identity;
- provenance, ordering, integrity, retention, and completeness;
- capture publication and discard receipts;
- replay construction from admitted evidence;
- evidence relationships used by Runs, Objectives, Missions, and reports; and
- queries that allow a reviewer to trace a conclusion back to accepted facts.

Chronicle stores only material that has passed the required Veil boundary. It
may preserve ciphertext and verify integrity without gaining authority to
decrypt or reclassify it. Chronicle does not operate the browser, make
protection decisions, or turn observations into product judgments.

## Assurance: diagnostics and qualification

Assurance owns the work that evaluates Scry and derives diagnostic meaning
from safe operational facts. Its responsibilities include:

- diagnostics and observability analysis;
- investigations and reproducible characterizations;
- experiments, fixtures, controlled variants, and failure injection;
- functional, security, privacy, recovery, performance, and compatibility
  qualification;
- local and deployed testing campaigns;
- analysis of findings, inconsistencies, coverage, and uncertainty; and
- release-readiness evidence and qualification reports.

Runtime components still emit safe logs, metrics, traces, and facts. Assurance
owns their diagnostic interpretation and the harnesses that evaluate them.
Production execution must not import Assurance or wait for Assurance before it
can act. Assurance observes and evaluates production-shaped behavior; it is
not a synchronous runtime gate or a second source of product truth.

## Application composition

The Scry application remains responsible for product and transactional
composition. This includes:

- authentication, authorization, tenancy, Projects, and Environments;
- Missions, Objectives, Flows, Runs, and reports;
- database transactions, durable queues, outbox delivery, and idempotency;
- mutation budgets, lifecycle admission, and finalization;
- public API, dashboard, and agent integration; and
- wiring Praxis, Veil, and Chronicle through explicit ports.

Composition is not a fifth domain authority. It coordinates authoritative
decisions made by the product model and the four named boundaries; it must not
quietly reimplement their rules.

## Contract boundary

Shared contracts contain narrow data shapes, result types, and ports needed to
connect owners. They do not contain browser engines, protection policy,
evidence stores, diagnostic controllers, or mutable service state.

A boundary may expose facts and request another owner's decision through a
port. It must not reach into another boundary's internal state or duplicate its
algorithm. Existing imports and package names are subject to this rule; they
are not exceptions to it.

The intended dependency shape is:

```text
public clients
      |
application composition ----> shared contracts
      |       |       |
      v       v       v
   Praxis    Veil   Chronicle

Assurance ----> public contracts, safe read models, and deployed interfaces
```

Praxis, Veil, and Chronicle are peers composed by the application. When one
needs another's capability, composition supplies a narrow port rather than
creating shared ownership. Assurance may depend on their public surfaces for
qualification, but no production boundary may depend on Assurance.

## One browser-operation lifecycle

The ownership model for a browser operation is:

1. The application admits the command within the authorized Run, transaction,
   idempotency, and budget rules.
2. Praxis claims the work under a fenced browser owner and performs the browser
   mechanics.
3. Praxis reports factual action and dispatch state. It does not infer success
   from a transport response alone.
4. Any candidate observation or capture crosses Veil before it can become a
   public value or durable review artifact.
5. Chronicle appends the admitted facts and evidence, preserving order,
   provenance, integrity, and completeness.
6. The application projects the resulting product state and determines whether
   the Run is eligible for further work or finalization.
7. Assurance may later examine the safe facts and evidence to diagnose,
   compare, experiment, or qualify. Its availability cannot change the
   operation's truth.

## Non-negotiable invariants

- Every responsibility has one authoritative owner.
- No observation, artifact, replay event, diagnostic payload, or report bypasses
  Veil when it may contain protected information.
- Chronicle never grants itself disclosure or decryption authority.
- A possible post-dispatch mutation is never automatically repeated merely
  because completion is uncertain.
- Browser writes are fenced to the current Praxis owner and document state.
- Evidence accepted by Chronicle remains ordered, attributable, integrity
  checked, and visibly incomplete when required material is missing.
- Assurance derives findings but cannot rewrite runtime facts.
- Production execution has no dependency on Assurance.
- Application composition coordinates boundaries without becoming a duplicate
  browser, protection, evidence, or diagnostic implementation.
- Runtime admission is based on required capabilities and valid state; source
  or artifact identity is not an admission condition.

## Current-state interpretation

The repository currently contains a working baseline runtime and source paths
that already use some of these boundary names. Neither condition proves that
the intended ownership model has been achieved. The first implementation task
is therefore a fresh, reachability-based baseline investigation.

That investigation must classify current behavior by responsibility, state,
failure semantics, caller, and production reachability. Each implementation
unit will then be retained, moved, rewritten, or deleted on evidence. Historical
plans and package names may help locate code, but they are not architectural
authority.

The execution approach is defined in the
[four-boundary implementation plan](four-boundary-implementation-plan.md).

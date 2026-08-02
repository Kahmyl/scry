# Praxis implementation plan

> **Governing architecture decision:** This document is the authoritative implementation boundary for Praxis. Changes that introduce another owner for live application perception or interaction require an explicit superseding architecture decision.

## Status

- **Type:** subsystem correction inside Scry
- **Topology:** embedded in the existing Scry application and executor
- **Intelligence boundary:** deterministic; no model calls inside Scry
- **Authoring surface:** MCP is authoritative for Mission and Flow writes
- **Dashboard surface:** observational, reporting, and explicit human approval only
- **Primary concern:** reliable, safe, low-latency interaction with standards-compliant, customized, and poorly implemented web applications
- **Implemented gates:** Milestones 0–3 accepted internally; production consumer migration begins in Milestone 4

## Executive decision

Praxis is Scry's internal authority for perceiving and interacting with a live application. It is not a separate service, deployable, package, or user-facing product. It is a named architectural boundary within the existing codebase.

Praxis owns the complete interaction transaction:

```text
intent
  -> observe
  -> interpret
  -> ground
  -> select strategy
  -> revalidate
  -> dispatch
  -> verify local state
  -> verify intended effect
  -> classify
  -> report
```

The primary invariant is:

> No Scry execution path may identify, read, activate, or manipulate a live application control outside Praxis.

This invariant applies to normal execution, readiness, assertions, probing, calibration, protected operations, acquisition, recovery, and application-specific adapters.

Praxis is designed for broad interaction coverage, not an unqualified promise that every possible interface can be automated. It must succeed whenever a safe interaction can be established from supported observable evidence. When a surface is inaccessible, hostile, ambiguous, protected by the platform, or outside policy, Praxis must refuse safely and explain the exact boundary instead of guessing.

## 1. Problem statement

Scry already contains semantic grounding, visual grounding, OCR, interaction helpers, effect verification, calibration, probes, and application adapters. The design direction is sound, but authority is fragmented across execution paths.

Examples of current divergence include:

- grounding both identifies controls and directly dispatches several actions;
- normal execution can use grounding helpers while protected paths perform additional direct locator, keyboard, and page operations;
- probes and calibration call grounding but construct their own result shapes;
- assertions and readiness independently inspect live controls;
- protected extraction contains specialized acquisition behavior outside one universal transaction;
- browser runtime health, observation, scoring, dispatch, and effect verification are colocated;
- failure records do not yet provide a complete agent-facing remediation contract or application-quality diagnosis;
- latency is an implementation outcome rather than a governed product budget.

Because multiple execution paths independently own parts of perception and interaction, when a nonstandard application requires a correction, the correction can be added to one path without governing its siblings. Divergent behavior and repeated local patches become possible. The missing invariant is that one authority must own the entire perception-to-verified-effect lifecycle.

## 2. Goals

Praxis must:

1. Provide one authoritative interaction transaction for every live application operation.
2. Interact reliably with normal semantic HTML, custom component systems, poor markup, and visually rendered controls when sufficient evidence exists.
3. Combine independent evidence channels without treating any one channel as an unconditional bypass.
4. Select the least invasive reliable interaction mechanism.
5. Prove both dispatch and the declared effect before reporting success.
6. Distinguish application defects, authored-intent defects, Praxis capability gaps, policy refusals, environment failures, and infrastructure failures.
7. Return a structured report that an MCP agent can use to choose the next action.
8. Return application-quality findings that explain defective or inaccessible implementation patterns without confusing them with execution truth.
9. Meet explicit latency budgets through adaptive escalation, parallel observation, bounded work, and reuse.
10. Preserve Scry's privacy boundary and protected-operation guarantees.
11. Remain deterministic and auditable without adding a model to Scry.
12. Support incremental migration and safe rollback without a large-bang rewrite.

## 3. Non-goals

Praxis will not:

- interpret a user's natural-language objective;
- author Missions, Objectives, Flows, or execution plans;
- replan a Flow at runtime;
- call an AI model;
- bypass browser security boundaries;
- defeat CAPTCHAs, anti-bot systems, DRM, or authorization controls;
- infer permission for destructive, protected, credential, or live operations;
- retain raw protected observations merely to improve grounding;
- promise interaction with surfaces for which the browser exposes no safe observable or controllable channel;
- become a remote microservice in the current implementation;
- introduce public selectors, arbitrary JavaScript, or undocumented coordinate actions into Flow contracts.

## 4. Responsibility boundaries

### 4.1 Praxis owns

- observation of live application state relevant to an interaction;
- control inventory and behavioral capability inference;
- semantic, accessibility, textual, structural, visual, geometric, runtime, and historical evidence;
- scope resolution and relationship reasoning;
- candidate generation, constraint filtering, ranking, confidence, and ambiguity;
- target fingerprints and drift classification;
- strategy selection;
- pre-dispatch target revalidation;
- dispatch through approved browser mechanisms;
- local-state verification;
- declared-effect observation and verification;
- interaction retry eligibility and safe recovery recommendations;
- interaction timing and diagnostic events;
- agent-facing interaction results;
- application-quality findings related to interaction and observability;
- adapter registration and enforcement for exceptional applications.

### 4.2 Orchestration owns

- which Objective or Flow should run;
- dependency order and concurrency slots;
- run and attempt lifecycle;
- cancellation of the wider run;
- whether a failed interaction causes a Flow revision, calibration, retry, or terminal outcome;
- Mission resume pointers and report publication.

Orchestration may request a Praxis transaction and interpret its typed result. It may not perform a fallback browser interaction.

### 4.3 Policy owns

- allowed origins;
- allowed action and risk classes;
- authorization requirements;
- navigation, duration, and action budgets;
- protected-operation eligibility;
- whether a proposed interaction strategy is permitted.

Praxis enforces the supplied authoritative policy at the interaction boundary. It does not weaken policy to achieve success or latency.

### 4.4 Privacy owns

- which observation channels may operate during each interval;
- redaction and suppression requirements;
- protected-value handling;
- evidence persistence classification;
- quarantine and destruction decisions.

Praxis must request observation capability from the privacy boundary. A channel that is forbidden or suppressed is unavailable evidence, not a reason to capture it temporarily.

### 4.5 Evidence and artifact handling own

- durable artifact storage;
- checksums, availability, retention, and quarantine;
- report projection from stored facts.

Praxis emits sanitized structured facts and optional approved artifact references. It does not directly redefine artifact retention.

### 4.6 MCP owns intelligent authoring

The MCP-connected agent:

- interprets user intent;
- creates and updates Missions and Objectives;
- authors mutable Flow drafts using semantic intent;
- runs probes and reads Praxis diagnostics;
- revises intent when Praxis reports plan ambiguity or insufficiency;
- compiles and publishes immutable Flow revisions;
- reads results and decides whether application code, Flow intent, or environment configuration must change.

### 4.7 Dashboard owns observation and approvals

The dashboard remains able to display Projects, environments, Missions, Objectives, Flows, revisions, Runs, attempts, Praxis findings, artifacts, reports, calibration, privacy state, and credential incidents.

Mission and Flow authoring or management controls are removed from the dashboard. Explicit human approval controls remain where a human authorization is intrinsically required. Removing dashboard writes does not remove the underlying authenticated API operations used by MCP.

## 5. Supported universality model

Praxis uses capability-based support instead of website-specific claims.

### 5.1 Compatibility tiers

| Tier | Surface | Expected handling |
|---|---|---|
| A | Semantic native HTML | Fast semantic path with native dispatch |
| B | Accessible custom components | Accessibility, computed behavior, and native/pointer/keyboard strategy |
| C | Poor markup with observable behavior | Text, structure, hit-testing, focus, runtime behavior, and effect evidence |
| D | Visually rendered or canvas UI | Bounded visual/OCR/geometry grounding and explicit coordinate capability |
| E | Known exceptional application | Reviewed, origin-bound, versioned application adapter |
| F | Inaccessible or prohibited surface | Typed safe refusal with evidence and next actions |

### 5.2 Explicit hard boundaries

Potentially unsupported surfaces include:

- closed shadow roots without an approved application integration;
- cross-origin frames that do not expose an authorized controllable context;
- browser chrome and unsupported operating-system dialogs;
- DRM or protected rendering surfaces;
- remote desktop streams with no supported control protocol;
- CAPTCHAs and intentional anti-automation mechanisms;
- hostile applications that make a safe target indistinguishable;
- controls visible only through privacy-forbidden channels;
- actions prohibited by policy or missing authorization.

These are first-class classified outcomes. They must not collapse into `not found` or a generic timeout.

## 6. Core invariants

1. **Single authority:** every live control operation passes through Praxis.
2. **Intent, not locator:** Flow and MCP contracts express capability, evidence, scope, relationships, risk, and effect; never raw selectors or target coordinates.
3. **Evidence is not authority:** accessibility, DOM, OCR, visual appearance, runtime behavior, and history contribute evidence; none independently bypasses constraints.
4. **Correlated evidence counts once:** multiple signals derived from one underlying source cannot inflate confidence as independent families.
5. **Actionability is behavioral:** an element's tag does not decide whether it is interactive.
6. **No success on dispatch alone:** a successful browser call is not a successful interaction until required local state and declared effect are verified.
7. **Revalidate before action:** the selected live target must still match its approved fingerprint and constraints at dispatch time.
8. **Risk raises proof:** higher-risk actions require stronger evidence, greater runner-up separation, and stricter strategy restrictions.
9. **No unsafe fallback:** a failed preferred strategy may only fall back to another strategy that independently satisfies policy and evidence requirements.
10. **No hidden retries:** attempts are bounded and observable. Mutations with uncertain outcomes are never blindly repeated.
11. **Privacy precedes perception:** forbidden evidence channels are never activated.
12. **Determinism:** the same versioned intent, policy, observation snapshot, and history input produce the same ranking and classification.
13. **Typed failure:** every unsuccessful transaction has a stable phase, code, provenance, retry disposition, and safe action set.
14. **Ephemeral internals:** raw page graphs, screenshots used only for transient OCR, raw selectors, and protected values are not retained by default.
15. **Versioned behavior:** contracts, observation runtime, scoring policy, adapters, and report schema have explicit versions and release compatibility.
16. **Cancellation propagates:** cancellation stops observation, OCR, waits, dispatch preparation, and effect verification at safe boundaries.
17. **Latency cannot weaken correctness:** time pressure may produce a typed budget-exhausted result, never a lower-confidence action.

## 7. Transaction contract

All consumers use one internal transaction-shaped API. Exact TypeScript organization may evolve, but the semantic contract is fixed.

```ts
type PraxisRequest = {
  transactionId: string;
  operationId: string;
  stepId?: string;
  intent: InteractionTargetIntent;
  operation: PraxisOperation;
  expectedEffect: ExpectedEffect;
  risk: TargetRisk;
  policy: PraxisPolicySnapshot;
  privacy: PraxisPrivacyCapabilities;
  context: PraxisContext;
  budgets: PraxisBudgets;
  signal: AbortSignal;
};

type PraxisOperation =
  | { type: "activate" }
  | { type: "enter_text"; value: ProtectedOrPublicInput }
  | { type: "select_option"; value: ProtectedOrPublicInput }
  | { type: "set_checked"; checked: boolean }
  | { type: "press_key"; key: ApprovedKey }
  | { type: "read_value"; acquisition: AcquisitionPolicy }
  | { type: "wait_for_state"; state: ExpectedLocalState }
  | { type: "inspect" }
  | { type: "scroll"; direction: ScrollDirection };

type PraxisResult = PraxisSuccess | PraxisFailure;
```

### 7.1 Success

```ts
type PraxisSuccess = {
  status: "succeeded";
  transactionId: string;
  target: SanitizedTargetIdentity;
  strategy: PraxisStrategy;
  confidence: ConfidenceSummary;
  verification: VerificationSummary;
  timing: PraxisTiming;
  qualityFindings: ApplicationQualityFinding[];
  report: PraxisAgentReport;
};
```

Success means the required verification contract passed. `expectedEffect: none` is allowed only when the authored contract and risk policy explicitly permit dispatch-only behavior; local dispatch still has to be established.

### 7.2 Failure

```ts
type PraxisFailure = {
  status: "failed" | "cancelled" | "inconclusive";
  transactionId: string;
  phase: PraxisPhase;
  code: PraxisFailureCode;
  provenance: PraxisFailureProvenance;
  retry: "safe" | "unsafe" | "requires_reobservation" | "requires_revision";
  mutationOutcome: "not_started" | "not_applied" | "applied" | "unknown";
  timing: PraxisTiming;
  diagnostics: SanitizedPraxisDiagnostics;
  qualityFindings: ApplicationQualityFinding[];
  safeActions: PraxisSafeAction[];
  report: PraxisAgentReport;
};
```

The mutation outcome is mandatory for mutating operations. `unknown` prevents automatic repetition.

### 7.3 Context

Praxis receives a live browser context reference internally, plus stable run metadata, origin policy, document epoch, privacy capability token, optional historical fingerprints, adapter registry, and event sink. These details remain internal and are never serialized into public Flow contracts.

## 8. Internal component model

Praxis remains in the existing executor package unless repository evidence later justifies physical movement. Code structure should express responsibility without manufacturing a separate deployable boundary.

### 8.1 Transaction coordinator

Responsibilities:

- validate request completeness;
- establish phase and timing records;
- propagate cancellation and budgets;
- coordinate observation, grounding, dispatch, and verification;
- prevent invalid phase transitions;
- produce the final typed result;
- emit one coherent event sequence.

Allowed phase transitions:

```text
created
  -> observing
  -> grounding
  -> resolved
  -> revalidating
  -> dispatching
  -> verifying_local
  -> verifying_effect
  -> succeeded

Any non-terminal phase
  -> failed | cancelled | inconclusive
```

Dispatching a mutation introduces a point of no blind retry. A crash or timeout after this point must preserve `mutationOutcome: unknown` unless effect evidence establishes a stronger result.

### 8.2 Observation runtime

Produces a versioned, sanitized snapshot of relevant live controls and regions.

It must:

- remain self-contained when serialized into the browser;
- expose a runtime hash and readiness result;
- traverse open shadow DOM;
- distinguish DOM identity from computed accessibility identity;
- collect computed style, bounds, visibility, enabled state, focusability, editability, hit-test information, and safe behavioral hints;
- observe only the bounded scope required by the request;
- use a document epoch so stale observations cannot be acted upon;
- avoid retaining selectors or raw protected content;
- fail with a typed phase and reason when injection or mapping fails.

### 8.3 Capability interpreter

Converts observations into behavioral capabilities such as:

- focusable;
- pointer activatable;
- keyboard activatable;
- accepts text;
- editable;
- toggleable;
- selects option;
- submittable;
- readable value;
- coordinate action.

Capability inference considers native semantics, computed roles, state, event behavior, content-editability, focus behavior, hit-testing, and approved adapter declarations. HTML tag names are evidence, not the complete rule.

### 8.4 Evidence providers

Providers implement one versioned interface and return bounded evidence with provenance, correlation group, cost class, and privacy class.

Initial providers:

- native control;
- accessibility;
- textual identity;
- structural relationship;
- geometry;
- icon identity;
- OCR;
- canvas;
- runtime behavior;
- historical fingerprint;
- expected-effect compatibility;
- application adapter.

Each provider declares:

- supported request types;
- required privacy capability;
- expected latency class;
- whether it can run concurrently;
- maximum work bounds;
- failure and degradation semantics;
- sanitization behavior.

### 8.5 Grounding engine

The grounding engine:

1. resolves the semantic scope;
2. creates a bounded candidate inventory;
3. rejects controls that violate required capabilities, state, scope, relationships, prohibited properties, or policy;
4. groups correlated evidence;
5. calculates per-family scores;
6. applies risk-dependent confidence and family requirements;
7. calculates runner-up separation;
8. classifies drift against history;
9. chooses a candidate only if all gates pass;
10. returns an ephemeral target handle and sanitized target identity.

Scoring must be configurable through versioned policy, not scattered constants. Changes to scoring require corpus evaluation and release compatibility review.

### 8.6 Strategy selector

Selects the least invasive strategy capable of satisfying the operation:

```text
native semantic
  -> accessible/computed semantic
  -> focus and keyboard
  -> verified pointer
  -> custom editor/content-editable
  -> bounded visual/coordinate
  -> reviewed application adapter
```

This ordering is not an unconditional fallback sequence. Every selected strategy must be compatible with the target, risk, policy, privacy state, and required verification.

### 8.7 Revalidator

Immediately before dispatch, the revalidator checks:

- the document epoch;
- target attachment and visibility;
- required capability and state;
- fingerprint compatibility;
- hit-test result for pointer operations;
- scope and relationship constraints;
- policy and privacy capability validity.

If the page changed materially, the transaction may reobserve within budget only when the mutation has not started. Reobservation is never allowed to conceal repeated drift.

### 8.8 Dispatcher

The dispatcher is the only generic owner of Playwright control operations. It provides typed strategies for native fill, click, check, select, focus/keyboard, content-editable, pointer, scroll, coordinate action, and reviewed adapters.

It must:

- arm effect observers before dispatch;
- honor cancellation and action timeouts;
- classify Playwright errors without leaking unsafe data;
- record whether mutation started;
- avoid ambiguous automatic retries;
- normalize platform-specific key behavior behind typed operations;
- never expose the locator to calling components.

Navigation and page/session lifecycle remain executor concerns, but any navigation initiated through a live control is dispatched and verified by Praxis.

### 8.9 Local-state verifier

Verifies immediate control-level results, for example:

- text/value was accepted;
- checked state changed;
- selected option changed;
- focus moved as required;
- activation produced an observable local transition;
- read value passed acquisition validation.

It must not substitute nonempty value for exact intended semantics when an exact value can safely be checked.

### 8.10 Effect verifier

Verifies authored effects including:

- navigation;
- visibility change;
- value change;
- state change;
- new region;
- bounded network outcome;
- composite effects where the contract later permits them.

Effect verification reuses Praxis observation and grounding. It does not call locator helpers directly. Polling is a fallback; event observers should be armed before dispatch when possible.

### 8.11 Adapter registry

Adapters are exceptional, governed extensions—not bypasses.

Every adapter must declare:

- stable identifier and version;
- purpose and capability;
- allowed origins or application identity;
- configuration schema;
- required risk and authorization;
- allowed observation and dispatch channels;
- suppressed privacy channels;
- timeout and cancellation behavior;
- local and effect verification obligations;
- safe diagnostics;
- compatibility detection;
- release and rollback behavior.

An adapter may add evidence or implement a specialized strategy. It cannot return an unverified success or weaken policy.

### 8.12 Quality analyzer

The quality analyzer creates findings independently from execution success. Initial finding families include:

- interactive behavior without appropriate semantics;
- missing or conflicting accessible name;
- inaccessible keyboard path;
- label/control association failure;
- ambiguous duplicate identity;
- hidden overlay or obstructed hit target;
- unstable control identity or excessive DOM churn;
- visual and accessibility identity mismatch;
- state transition without observable feedback;
- invalid ARIA state or role pattern;
- custom control requiring unnecessarily specialized handling;
- touch/click target geometry problems;
- inaccessible canvas-only behavior.

Findings have stable codes, severity, confidence, safe evidence, affected intent, and remediation guidance. They must not expose protected values or raw private page content.

## 9. Failure taxonomy

### 9.1 Provenance

- `application`: the application did not expose or perform the required behavior;
- `intent`: the authored Flow intent is insufficient, contradictory, or ambiguous;
- `praxis`: a supported observable surface exposed a missing Praxis capability;
- `policy`: the action or strategy is not permitted;
- `privacy`: required evidence is forbidden or unavailable under the privacy state;
- `environment`: browser/application environment is unavailable or incompatible;
- `infrastructure`: Scry runtime, queue, browser, storage, or dependency failure;
- `cancelled`: an authorized cancellation interrupted the transaction.

### 9.2 Core failure codes

Observation:

- `PRAXIS_OBSERVATION_RUNTIME_UNAVAILABLE`
- `PRAXIS_OBSERVATION_INJECTION_FAILED`
- `PRAXIS_OBSERVATION_EXECUTION_FAILED`
- `PRAXIS_OBSERVATION_MAPPING_FAILED`
- `PRAXIS_OBSERVATION_BUDGET_EXHAUSTED`
- `PRAXIS_REQUIRED_CHANNEL_FORBIDDEN`

Grounding:

- `PRAXIS_SCOPE_UNRESOLVED`
- `PRAXIS_CONTROL_INVENTORY_EMPTY`
- `PRAXIS_NO_CAPABILITY_COMPATIBLE_CONTROL`
- `PRAXIS_RELATIONSHIP_UNSATISFIED`
- `PRAXIS_INSUFFICIENT_EVIDENCE`
- `PRAXIS_TARGET_AMBIGUOUS`
- `PRAXIS_TARGET_DRIFTED`
- `PRAXIS_SURFACE_UNSUPPORTED`
- `PRAXIS_ADAPTER_REQUIRED`

Dispatch:

- `PRAXIS_STRATEGY_UNAVAILABLE`
- `PRAXIS_STRATEGY_POLICY_DENIED`
- `PRAXIS_TARGET_CHANGED_BEFORE_ACTION`
- `PRAXIS_TARGET_OBSTRUCTED`
- `PRAXIS_DISPATCH_FAILED`
- `PRAXIS_DISPATCH_TIMED_OUT`
- `PRAXIS_MUTATION_OUTCOME_UNKNOWN`

Verification:

- `PRAXIS_LOCAL_STATE_NOT_OBSERVED`
- `PRAXIS_EXPECTED_EFFECT_NOT_OBSERVED`
- `PRAXIS_EFFECT_CONTRADICTED`
- `PRAXIS_VERIFICATION_BUDGET_EXHAUSTED`

Lifecycle:

- `PRAXIS_CANCELLED`
- `PRAXIS_CONTRACT_INCOMPATIBLE`
- `PRAXIS_RUNTIME_UNHEALTHY`

### 9.3 Safe actions

Safe actions are machine-readable and constrained by failure type:

- `retry_after_render`
- `reobserve`
- `narrow_scope`
- `revise_intent`
- `request_calibration`
- `use_supported_capability`
- `install_or_update_adapter`
- `request_user_assistance`
- `request_authorization`
- `fix_application_semantics`
- `check_environment`
- `check_executor_health`
- `inspect_artifact`
- `do_not_retry`

## 10. Agent-facing report

Every transaction produces a sanitized structured report embedded in run observation and accessible through MCP.

```ts
type PraxisAgentReport = {
  schemaVersion: number;
  transactionId: string;
  operationId: string;
  stepId?: string;
  outcome: "succeeded" | "failed" | "inconclusive" | "cancelled";
  summary: string;
  classification: {
    provenance: PraxisFailureProvenance | "none";
    code?: PraxisFailureCode;
    mutationOutcome: "not_started" | "not_applied" | "applied" | "unknown";
  };
  intent: SanitizedIntentSummary;
  resolution?: {
    target: SanitizedTargetIdentity;
    confidence: number;
    runnerUpMargin: number;
    evidenceFamilies: EvidenceFamily[];
    drift: DriftClassification;
    strategy: PraxisStrategy;
  };
  verification: VerificationSummary;
  timing: PraxisTiming;
  qualityFindings: ApplicationQualityFinding[];
  safeActions: PraxisSafeAction[];
  artifactRefs: string[];
};
```

The report must allow the MCP agent to answer:

1. Did the interaction actually succeed?
2. If not, did the application, Flow intent, Praxis, policy, privacy, environment, or infrastructure cause the outcome?
3. Is retry safe?
4. Did a mutation possibly occur?
5. Does the Flow need revision?
6. Does the application need repair?
7. Is calibration, authorization, an adapter, or user assistance required?
8. Which artifacts are safe and relevant to inspect?

Human-readable text is a projection of typed data. Agents must not be required to parse prose to determine retry or safety behavior.

## 11. Persistence and event model

### 11.1 Events

Replace generic grounding-only events with a complete but bounded Praxis lifecycle:

- `praxis.transaction_started`
- `praxis.observation_completed`
- `praxis.resolved`
- `praxis.rejected`
- `praxis.dispatch_started`
- `praxis.dispatch_completed`
- `praxis.verification_completed`
- `praxis.transaction_succeeded`
- `praxis.transaction_failed`
- `praxis.quality_finding`

Not every internal provider action becomes an event. High-cardinality details belong in bounded diagnostics or metrics.

### 11.2 Durable facts

Persist:

- contract and runtime versions;
- intent digest;
- sanitized target fingerprint;
- evidence-family summary and correlation groups;
- confidence and runner-up margin;
- selected strategy;
- drift classification;
- phase timings;
- verification outcome;
- failure classification, retry disposition, and mutation outcome;
- quality finding codes and safe evidence summaries;
- safe artifact references.

Do not persist by default:

- raw selectors;
- full page graphs;
- unredacted screenshots created only for OCR;
- clipboard content;
- protected values;
- raw DOM containing private data;
- arbitrary network bodies;
- inaccessible browser internals.

### 11.3 Schema evolution

Praxis result and event schemas are versioned in `@scry/contracts`. API, MCP, worker, and stored execution snapshots must advertise compatible schema and runtime versions through release admission. Additive migration is preferred. A cutoff is required before deleting legacy grounding fields.

## 12. Latency architecture

### 12.1 Principles

- Do not activate every channel for every interaction.
- Run independent low-cost providers concurrently.
- Escalate only when confidence, required families, or runner-up margin remains insufficient.
- Bound scope before collecting expensive evidence.
- Reuse work within a stable document epoch.
- Arm effect observers before dispatch.
- Attribute time to phases and providers.
- Treat budget exhaustion as a typed result, never permission to guess.

### 12.2 Adaptive escalation

```text
Level 0: history-assisted fast path
  cached document epoch + compatible prior fingerprint

Level 1: semantic fast path
  native + accessibility + text + structure

Level 2: behavioral path
  focus + hit-test + runtime behavior + geometry

Level 3: visual path
  bounded screenshot + icon + OCR + canvas mapping

Level 4: exceptional path
  reviewed application adapter

Level 5: safe refusal
  insufficient evidence, inaccessible surface, policy denial, or exhausted budget
```

Every escalation is recorded. High-risk operations may require additional families even when a lower level appears sufficient.

### 12.3 Caching

Cache only safe derived observations:

- document-epoch control summaries;
- bounded accessibility mappings;
- semantic fingerprints;
- provider health;
- approved application identity and adapter compatibility.

Invalidate on:

- navigation or frame replacement;
- meaningful DOM or accessibility-tree change;
- target detachment;
- viewport changes that invalidate geometry;
- privacy state change;
- policy epoch change;
- adapter version change.

History may accelerate candidate ordering but cannot suppress live revalidation.

### 12.4 OCR and visual performance

- Maintain warm OCR workers.
- Crop to the resolved scope or likely region.
- Use text and structure to narrow regions before OCR.
- Avoid full-page screenshots by default.
- Deduplicate identical visual work within a document epoch.
- Cancel OCR when cheaper channels reach authoritative confidence.
- Zero transient buffers after use.
- Maintain separate budgets for capture, recognition, and mapping.

### 12.5 Timing contract

Every transaction records:

```ts
type PraxisTiming = {
  queuedMs: number;
  observationMs: number;
  groundingMs: number;
  revalidationMs: number;
  dispatchMs: number;
  localVerificationMs: number;
  effectVerificationMs: number;
  totalMs: number;
  escalationLevel: number;
  providerTimings: Array<{ provider: string; durationMs: number; outcome: string }>;
};
```

Initial numeric service-level objectives must be set only after measuring the compatibility corpus. Release gates should use percentile targets by operation class, risk, and escalation level rather than one misleading global average.

### 12.6 Performance gates

Each release must show:

- no statistically material regression on semantic fast-path p50 and p95;
- bounded p95 for visual escalation on the reference hardware;
- no unbounded candidate scan or OCR region;
- stable memory across repeated OCR and page epochs;
- cancellation terminates expensive work promptly;
- confidence and success do not regress to achieve speed;
- cache use does not increase stale-target or drift errors.

## 13. MCP changes

Existing Mission and Flow authoring remains in MCP. Praxis adds structured read capabilities rather than asking the agent to infer from generic run errors.

Required MCP behavior:

- probe results return Praxis reports per interaction intent;
- run observation includes Praxis transactions and quality findings;
- failed-step reads include failure provenance, retry disposition, mutation outcome, and safe actions;
- artifact tools identify which artifact supports which Praxis finding;
- capability discovery exposes Praxis contract version, observation channels, strategies, adapter manifests, and hard boundaries;
- Flow authoring instructions continue prohibiting selectors, test IDs as authority, pixels, and arbitrary coordinates;
- structural or Praxis-capability failures return to probe/revision rather than blind exact rerun;
- exact rerun remains exact and does not invoke an AI or alter the stored Flow.

Potential tool projections may include `get_praxis_report` or filtered fields within existing run-observation tools. Prefer extending the existing run observation contract unless a dedicated tool materially reduces payload or permission scope.

## 14. Dashboard reduction

### 14.1 Remove from dashboard

- create, edit, cancel, reopen, or otherwise manage Mission definitions;
- create or edit Objectives;
- create, revise, compile, publish, or attach Flows;
- create or activate execution plans;
- start or orchestrate automated Objectives as an authoring decision;
- any UI that implies Scry can replace the higher-intelligence MCP agent.

### 14.2 Retain in dashboard

- Mission and Objective read views;
- Flow and immutable revision read views;
- execution plan and orchestration status views;
- Runs, attempts, events, and artifacts;
- Praxis transaction timelines and failure classifications;
- application-quality findings and remediation guidance;
- calibration and protected-operation status;
- privacy timelines and credential incidents;
- published Mission reports;
- explicit approval or authorization ceremonies that require a human;
- operational controls required for safety, such as cancelling an active run, where policy permits.

Read-only is a product-surface rule, not merely disabled HTML. Write routes and mutations should not be shipped in the dashboard bundle unless required for retained approval or safety controls.

## 15. Security and privacy requirements

1. Praxis receives capability-scoped privacy permissions, not a broad capture flag.
2. Every evidence provider declares the data it observes and persists.
3. Protected intervals disable or redirect forbidden providers before the interval begins.
4. Transient OCR images are bounded, memory-only, and cleared after use.
5. Logs and errors contain codes and safe fingerprints, not page text or values by default.
6. Application adapters cannot expand origin, credential, or evidence access.
7. Network-effect verification records bounded metadata, not response bodies, unless an independent approved acquisition contract permits it.
8. Clipboard and protected-value interactions remain inside protected coordination and use Praxis-governed strategies.
9. A privacy provider failure cannot silently degrade to unsafe capture.
10. Quality findings use sanitized evidence and cannot reproduce user content unnecessarily.

## 16. Concurrency, retries, cancellation, and recovery

### 16.1 Concurrency

- One live target transaction owns dispatch on a page at a time.
- Read-only observation may be concurrent only when it cannot race with dispatch or page mutation.
- The document epoch changes on meaningful mutation.
- Multiple pages or contexts may transact concurrently when orchestration and policy allow it.
- Provider caches are scoped by context, page, frame, epoch, privacy state, and runtime version.

### 16.2 Retries

- Observation may retry once for a proven transient render transition within budget.
- Grounding may reobserve before dispatch when the document epoch changes.
- Dispatch retries are strategy-specific and prohibited after uncertain mutation.
- Effect verification may continue observing within its budget but may not repeat the mutation.
- Protected and one-time mutations follow their stricter atomic recovery contracts.

### 16.3 Cancellation

- All provider and verifier interfaces accept an `AbortSignal`.
- Cancellation before dispatch produces `mutationOutcome: not_started`.
- Cancellation during or after dispatch requires outcome determination; otherwise it produces `unknown` and `do_not_retry`.
- Cleanup must not capture evidence prohibited by the current privacy state.

### 16.4 Crash recovery

Persist the transaction phase and mutation boundary with run events. After worker loss:

- transactions before dispatch may be safely restarted under the run-attempt policy;
- transactions with completed verified effects can be projected as successful if durable evidence is complete;
- transactions after dispatch without verification are inconclusive and cannot be automatically repeated;
- protected operations defer to the protected transaction recovery model.

## 17. Implementation sequence

The implementation is an incremental subsystem correction. Each milestone must leave the repository in a coherent, deployable state.

### Milestone 0: decision and baseline

Deliver:

- this architecture decision accepted as the implementation authority;
- complete inventory of direct browser control operations;
- characterization tests for current normal, probe, calibration, assertion, readiness, protected, and acquisition behavior;
- baseline compatibility and latency measurements;
- explicit legacy event and contract inventory.

Exit gates:

- every known bypass is classified;
- current behavior is reproducible in tests;
- no production behavior change yet.

### Milestone 1: contracts and transaction skeleton

Deliver:

- Praxis request, result, timing, provenance, mutation outcome, safe action, quality finding, and event schemas in `@scry/contracts`;
- transaction coordinator with explicit phase transitions and cancellation;
- adapters around current grounding and dispatch behavior;
- legacy result projection for compatibility.

Exit gates:

- contract tests cover every success and failure variant;
- invalid phase transitions and incomplete failure results are unrepresentable;
- existing execution tests remain green.

### Milestone 2: unified observation and grounding

Deliver:

- provider interface with cost, privacy, and correlation metadata;
- extraction of native, accessibility, textual, structural, geometry, visual, runtime, and historical providers from monolithic grounding code;
- document epoch and bounded observation cache;
- versioned scoring policy;
- sanitized target identity and ephemeral internal handle;
- consistent probe and calibration projections.

Exit gates:

- grounding does not dispatch actions;
- providers cannot persist prohibited raw data;
- scoring is deterministic and corpus-tested;
- probe, calibration, and execution resolve identical intents consistently.

### Milestone 3: unified strategy, dispatch, and verification

Deliver:

- typed strategy selector;
- single dispatcher;
- pre-dispatch revalidation;
- local-state verifier;
- effect observer arming and verification;
- mutation outcome tracking;
- transaction-level timing.

Exit gates:

- callers never receive a locator;
- browser control operations outside approved lifecycle/session modules are rejected by repository verification;
- all successful interactions include required verification;
- mutation-unknown outcomes cannot be automatically retried.

### Milestone 4: migrate all consumers

Migrate in controlled slices:

1. normal executor actions;
2. assertions;
3. readiness conditions;
4. inspection and reversible probes;
5. calibration structure and rehearsal;
6. protected transaction preparation and assertions;
7. protected extraction and acquisition;
8. recovery and continuation checks.

For each slice:

- preserve a failing characterization for each corrected divergence;
- route through the transaction API;
- remove the old direct interaction path;
- run sibling and privacy tests;
- verify report compatibility.

Exit gates:

- repository-wide search finds no unauthorized control operations;
- every consumer receives the same failure taxonomy;
- protected paths preserve stronger privacy and atomicity guarantees.

### Milestone 5: agent report and application-quality findings

Deliver:

- durable Praxis transaction summaries;
- agent report projection in run observation and MCP;
- quality analyzer and initial finding catalog;
- artifact-to-finding relationships;
- failure provenance mapping into run classification;
- MCP instructions for safe next-action handling.

Exit gates:

- the MCP agent can distinguish application, intent, Praxis, policy, privacy, environment, and infrastructure outcomes without parsing prose;
- retry and mutation safety are explicit;
- quality findings do not change execution truth;
- protected information is absent from reports.

### Milestone 6: adaptive latency system

Deliver:

- staged provider escalation;
- concurrent fast-path evidence collection;
- scope-first bounded visual work;
- warm OCR lifecycle;
- safe observation caches and invalidation;
- provider and phase metrics;
- corpus-based performance thresholds.

Exit gates:

- semantic fast path meets approved percentile targets;
- expensive providers run only when required;
- cancellation and budget enforcement are proven;
- effectiveness and safety metrics do not regress.

### Milestone 7: dashboard read-only transition

Deliver:

- removal of Mission, Objective, Flow, and execution-plan authoring controls from the web application;
- retained observational views and human authorization ceremonies;
- Praxis findings and interaction timeline views;
- route/bundle verification proving removed mutations are not shipped unintentionally;
- updated product documentation.

Exit gates:

- MCP remains capable of every required write workflow;
- dashboard users can inspect the complete Mission and Flow lifecycle;
- only explicitly retained approval and safety mutations remain.

### Milestone 8: cutoff and hard enforcement

Deliver:

- removal of legacy grounding helpers and compatibility projections;
- repository guard that fails on unauthorized Playwright control operations;
- release admission requiring compatible Praxis contract and runtime versions;
- finalized operational dashboards and alert thresholds;
- rollback procedure and cutoff record.

Exit gates:

- no active legacy bypass remains;
- mixed-version API, MCP, and worker deployments reject new work safely;
- production-shaped gauntlet passes;
- rollback does not require restoring divergent interaction ownership.

## 18. Repository enforcement

Add a verification script that permits direct low-level browser control only in explicitly owned modules, such as:

- browser/session creation and lifecycle;
- Praxis observation runtime;
- Praxis dispatch strategies;
- approved adapter implementations;
- privacy/recording initialization where no control interaction occurs.

The guard should flag direct use elsewhere of patterns including:

- locator action methods;
- page keyboard and mouse dispatch;
- direct text/value acquisition;
- arbitrary element evaluation used to decide or perform interaction;
- ungoverned coordinate actions;
- direct effect polling that bypasses Praxis.

The allowlist must be narrow and reviewed. It is an enforcement aid, not a substitute for code review and tests.

## 19. Verification strategy

### 19.1 Unit tests

- capability inference;
- evidence correlation and scoring;
- scope and relationship constraints;
- risk thresholds;
- ambiguity and drift;
- strategy selection;
- phase transitions;
- mutation outcome and retry rules;
- timing accumulation;
- quality finding classification;
- report sanitization;
- cache invalidation.

### 19.2 Contract tests

- MCP and API parse every Praxis result version;
- malformed or partial outcomes are rejected;
- public contracts contain no locators or arbitrary coordinates;
- release fingerprint changes when Praxis schemas change;
- legacy compatibility is maintained only during declared migration milestones.

### 19.3 Browser compatibility gauntlet

The local fixture corpus must include:

- correctly labelled native forms;
- unlabeled and wrapped inputs;
- clickable `div` and `span` controls;
- nested targets and event delegation;
- custom selects, comboboxes, and listboxes;
- custom checkboxes and toggles;
- content-editable and editor surfaces;
- disabled, readonly, hidden, and obstructed controls;
- duplicate names and ambiguous controls;
- dialogs, forms, field groups, tables, and recently changed regions;
- open shadow DOM and explicit closed-shadow failure;
- iframes under allowed and denied origins;
- canvas controls with approved coordinate capability;
- icons without text;
- OCR-only visible labels;
- responsive layouts and viewport changes;
- DOM replacement between resolution and dispatch;
- animations, loading overlays, and delayed hydration;
- navigation, network, state, value, visibility, and new-region effects;
- deceptive visual controls that are not actionable;
- action succeeds locally but declared effect fails;
- page crashes, browser loss, cancellation, and timeouts.

### 19.4 Application-quality tests

Each fixture asserts execution truth and quality findings independently. A poorly implemented but safely actionable control may pass interaction while emitting one or more findings.

### 19.5 Privacy gauntlet

- every provider under safe, suppressed, and protected intervals;
- OCR buffer clearing;
- report and event sanitization;
- no protected values in logs, traces, events, fingerprints, quality findings, or artifacts;
- adapter channel suppression;
- privacy failure blocks unsafe degradation.

### 19.6 Performance gauntlet

- warm and cold semantic paths;
- large DOM bounded inventory;
- repeated interactions within one epoch;
- frequent epoch invalidation;
- OCR warm-up and repeated visual work;
- concurrent pages;
- cancellation during OCR and verification;
- memory and worker stability over long runs;
- p50, p95, and p99 by escalation level.

### 19.7 Production-shaped verification

- API, MCP, worker, database, queue, browser, and artifact store together;
- release compatibility and mixed-version rejection;
- run restart and worker crash around the dispatch boundary;
- protected-operation recovery;
- dashboards display stored facts without becoming an alternative authority;
- exact reruns preserve immutable plans and use the current admitted Praxis runtime according to recorded release policy.

## 20. Observability and operations

Metrics:

- transaction count and success by operation, risk, strategy, and escalation level;
- failure count by phase, code, and provenance;
- ambiguity and drift rates;
- provider use, degradation, and latency;
- semantic fast-path hit rate;
- OCR and adapter escalation rate;
- local verification and effect verification failure rate;
- mutation-unknown count;
- cache hit and invalidation rate;
- quality finding rate by code;
- cancellation and budget exhaustion rate.

Alerts should prioritize:

- runtime health or injection failures;
- sudden semantic fast-path regression;
- increased target ambiguity or drift;
- increased mutation-unknown outcomes;
- privacy channel violations or quarantines;
- adapter-specific failure spikes;
- p95/p99 latency regression;
- mixed contract/runtime release rejection.

Operational data must use safe identifiers and bounded cardinality. Origin-specific dashboards require approved normalization and must not expose customer paths or content.

## 21. Rollout and rollback

### 21.1 Rollout

Use additive contracts and per-consumer migration. During migration, current behavior can run behind the Praxis transaction adapter, but there must never be two competing target decisions for one dispatched action.

Recommended rollout controls:

- internal release capability flag by consumer slice;
- shadow comparison for observation and ranking only, never double dispatch;
- corpus and production-safe diagnostic comparison;
- explicit cutoff version for legacy events and report fields;
- release admission across API, MCP, and worker.

### 21.2 Rollback

Rollback may switch a migrated consumer to the prior release only while the compatibility milestone explicitly supports it. It must not restore a code-level bypass after the final cutoff. After cutoff, rollback means deploying the previous complete admitted release, not mixing old callers with new Praxis contracts.

No rollback may repeat a mutation whose outcome is unknown.

## 22. Acceptance criteria

Praxis is complete when:

1. Every live control interaction path is governed by the Praxis transaction.
2. Callers cannot receive or act on a raw locator.
3. Normal, custom, poorly marked-up, visual, and adapter-backed fixtures pass the agreed compatibility matrix.
4. Inaccessible and prohibited surfaces fail with precise classified outcomes.
5. Every success includes the required local and effect verification.
6. Every failure includes phase, code, provenance, mutation outcome, retry disposition, safe actions, and timing.
7. MCP receives sufficient structured information to choose the next authorized action without parsing prose.
8. Application-quality findings are useful, independently classified, and privacy-safe.
9. Protected operations retain atomicity, suppression, and recovery guarantees.
10. Semantic fast-path and escalated-path latency meet corpus-derived percentile budgets.
11. Dashboard Mission and Flow management writes are removed while read, reporting, approval, and safety views remain.
12. Repository enforcement prevents reintroduction of direct interaction bypasses.
13. API, MCP, and worker release compatibility is enforced.
14. The full unit, contract, compatibility, privacy, performance, recovery, and production-shaped gauntlet passes.

## 23. Known risks and controls

| Risk | Control |
|---|---|
| Boundary becomes a monolith | Separate responsibilities internally while retaining one transaction authority |
| Universal support becomes unsafe guessing | Hard evidence, confidence, margin, risk, revalidation, and refusal gates |
| OCR makes common interactions slow | Adaptive escalation, bounded regions, warm workers, cancellation |
| History causes stale targeting | History only orders evidence; live revalidation remains mandatory |
| Application findings are mistaken for failures | Independent execution and quality classifications |
| Adapters become site-specific bypasses | Versioned registry, origin binding, policy, privacy, verification, and release review |
| Migration creates two authorities | One decision and one dispatch per transaction; compatibility only projects results |
| Reports leak sensitive content | Safe schemas, redaction, bounded evidence, privacy gauntlet |
| Retry duplicates mutations | Mandatory mutation outcome and retry disposition |
| Dashboard removal blocks required human action | Preserve explicit approval, authorization, inspection, and safety controls |
| Performance optimization lowers confidence | Latency budget exhaustion returns failure; thresholds remain invariant |

## 24. Immediate implementation backlog

1. Create a machine-readable inventory of all direct Playwright control and acquisition operations.
2. Add characterization fixtures for every existing grounding and protected-path behavior.
3. Define Praxis schemas in `@scry/contracts` without removing current grounding schemas.
4. Introduce the transaction coordinator as a compatibility wrapper over existing grounding behavior.
5. Make mutation outcome and retry disposition mandatory in the new result.
6. Move probe and calibration result production onto the new report projection.
7. Separate observation, scoring, strategy, dispatch, and verification behind internal interfaces.
8. Migrate normal actions, assertions, and readiness before protected paths.
9. Build the quality finding catalog and MCP projection.
10. Establish the compatibility and performance corpus before choosing numeric latency objectives.
11. Remove dashboard authoring mutations after MCP parity and read-view verification.
12. Complete protected-path migration, enforce the repository guard, and execute the final cutoff.

## 25. Governing principle

Praxis is not successful because it can click more elements. It is successful when Scry can establish, quickly and safely, that an intended interaction was performed on the correct live control and produced the required effect—and when it cannot, it explains exactly why without inventing success, leaking protected information, or shifting the ambiguity to the MCP agent.

# Scry technical brief

Status: canonical product direction

## Product definition

Scry is an agent-operated testing platform for web applications.

It gives an AI agent the tools, execution environments, evidence systems, and
long-running workflow required to test an application comprehensively. A user
provides the application, access, requirements, intended behavior, and testing
instructions. Scry enables the agent to carry out that work independently and
return a complete, reviewable body of evidence.

The product promise is:

> Tell Scry what needs to be tested, give it the required access and context,
> and it will test the application thoroughly and return evidence showing
> exactly what was tested, what happened, and what deserves attention.

The user should be able to start a substantial testing assignment, leave it
running, and return to a completed testing portfolio instead of supervising
each browser action.

## Primary outcome: testing with evidence

Scry does not merely report that a test passed or failed. It produces evidence
that allows a person or another agent to independently determine:

- which requirements and scenarios were tested;
- which browsers, devices, viewports, and environments were covered;
- what actions were performed and what behavior was observed;
- which outcomes matched the declared expectations and which differed;
- which scenarios could not be tested conclusively;
- what evidence supports each result;
- what was skipped, blocked, or left incomplete; and
- whether the requested scope was actually covered.

The user does not have to trust an agent's summary. The evidence must make the
work inspectable and the conclusions accountable.

## Testing scope

### Functional behavior

Scry tests complete product behavior and user journeys, including:

- navigation and authentication;
- forms and validation;
- state changes and API-backed actions;
- permissions and protected operations;
- error, recovery, and alternative paths;
- multi-step workflows; and
- edge cases supplied or discovered within the authorized testing scope.

### Browser compatibility

Scry begins with Chromium-based execution, but Chromium is not the product
boundary. The intended product tests equivalent behavior across multiple
browser engines and browsers, including Chrome, Firefox, Safari/WebKit, and
other supported environments.

An application passing in one browser does not prove that it works in another.
Scry must preserve the environment associated with every result and make
cross-browser differences explicit.

### Responsive and device behavior

Scry is intended to test applications across:

- desktop and mobile viewport dimensions;
- responsive breakpoints;
- portrait and landscape orientations;
- touch-oriented and pointer-oriented interaction;
- supported device profiles; and
- real device-specific environments when emulation cannot establish the
  required claim.

When a journey works on Android but fails on iPhone, for example, Scry should
not guess whether the cause is Safari, iOS, viewport behavior, touch handling,
or the application itself. It should compare the relevant environments,
preserve the observed differences, and state what the available evidence does
and does not establish.

### Visual and UI correctness

Scry is intended to identify visual inconsistencies, including subtle ones:

- spacing and alignment differences;
- typography or color inconsistencies;
- broken responsive layouts;
- overlapping or clipped content;
- inconsistent component presentation;
- unexpected visual changes; and
- browser- or device-specific rendering differences.

An observed inconsistency is not automatically a product defect. The difference
may be intentional. Scry reports the observation, supporting evidence, and
confidence, then leaves product intent to the owner unless an explicit
requirement makes the result unambiguous.

### Quality and performance observations

Scry may also report:

- unexpectedly slow loading;
- delayed or unstable controls;
- layout instability;
- failed network requests;
- browser console or page errors;
- intermittent behavior;
- low-confidence interactions;
- accessibility weaknesses; and
- inconsistent application states.

Where the evidence permits, Scry may identify likely contributing conditions
and suggest areas to investigate. Suggestions remain advisory and must not be
presented as proven causes or mandatory product decisions.

## Facts, findings, and recommendations

Scry keeps three kinds of output separate:

1. **Observed fact**: what the system directly established, such as "the form
   became interactive after 8.4 seconds."
2. **Finding**: an evidence-backed interpretation, such as "this exceeded the
   supplied expectation and was slower than the other tested environments."
3. **Recommendation**: an advisory next step, such as "investigate the request
   that remained pending during this interval."

Scry does not turn every difference into a defect. A result may instead be a:

- confirmed failure against an explicit requirement;
- probable issue;
- inconsistency requiring confirmation;
- warning;
- informational observation;
- improvement opportunity; or
- inconclusive result.

## Testing imperfect applications

Scry should not refuse to test an application merely because it has poor
markup, weak accessibility, unusual controls, visual complexity, or
inconsistent implementation.

It should make the strongest safe testing attempt available and report quality
problems independently from functional behavior. A poorly labelled control may
still work correctly. Scry may test that behavior while separately reporting
the accessibility or semantic weakness.

Application quality and Scry execution capability are different result
dimensions and must not be collapsed into one pass or failure.

## Autonomous operation

Scry is intended to support substantial unattended testing assignments. Once
it has the necessary instructions, application access, environments,
credentials, authorizations, expectations, scenario boundaries, and coverage
requirements, it should be able to:

- decompose the assignment into independently assessable objectives;
- execute the required scenarios;
- preserve progress across a long-running assignment;
- recover safely within explicit boundaries;
- collect and organize evidence;
- distinguish failures from inconclusive results;
- track coverage and disclose omissions; and
- produce a final testing portfolio.

Autonomous does not mean inventing requirements or taking unlimited actions. It
means completing the authorized testing assignment without requiring the user
to direct every step.

## Product output

The primary Scry deliverable is a testing evidence portfolio containing:

- the requested scope and declared expectations;
- coverage across requirements and scenarios;
- browser, device, viewport, and environment coverage;
- individual journeys and their outcomes;
- screenshots, recordings, traces, events, and diagnostics where admitted;
- confirmed failures and observed inconsistencies;
- warnings, improvement opportunities, and inconclusive results;
- recommendations kept distinct from facts;
- skipped or blocked work; and
- an explicit account of everything that remains unproven.

This portfolio should allow a product owner, engineer, tester, or another agent
to understand and independently review the application's tested state.

## Role of the AI agent and the platform

The AI agent supplies testing intelligence. It interprets requirements,
explores scenarios, compares behavior, and explains findings.

Scry supplies the testing platform around that intelligence:

- browser and device execution;
- cross-environment orchestration;
- durable assignment state;
- privacy and credential protection;
- evidence capture and integrity;
- coverage tracking;
- outcome classification;
- bounded recovery; and
- reviewable reporting.

Controlled browser execution is an enabling capability, not the purpose of the
product. Scry exists to equip an agent to perform comprehensive, accountable
application testing.

## Product model

- **Project**: the application or product under test.
- **Mission**: the complete testing assignment, authorization scope, evidence
  ledger, and reporting boundary.
- **Objective**: one independently assessable outcome within a Mission.
- **Flow**: one executable browser journey used to test an Objective.
- **Flow revision**: an immutable executable definition of a Flow.
- **Run**: one execution of one Flow revision in one environment.
- **Attempt**: one preserved execution attempt; retries do not overwrite prior
  outcomes.
- **Evidence**: factual outputs such as assertions, screenshots, recordings,
  traces, events, and diagnostics.
- **Mission report**: an immutable synthesis of tested outcomes, accepted
  evidence, findings, omissions, and inconclusive work.

## Platform responsibility direction

Scry will organize its platform capabilities around four authoritative
boundaries:

- **Praxis** operates browsers and owns browser execution mechanics;
- **Veil** protects sensitive information and controls disclosure;
- **Chronicle** manages durable evidence and the factual history of execution;
  and
- **Assurance** owns diagnostics, analysis, experiments, and qualification.

The application composes these capabilities with Projects, Missions,
Objectives, Flows, Runs, authorization, transactions, queues, and public
interfaces. The boundaries support the product promise; they do not replace
the product model or the external agent's testing judgment.

This is an architectural direction, not a claim that the current repository
already follows it. The ownership rules are defined in the
[four-boundary direction](../baseline/four-boundary-direction.md), and the work
to reach it is defined in the
[four-boundary implementation plan](../baseline/four-boundary-implementation-plan.md).

## Current implementation and intended MVP

The existing Chromium execution baseline, Missions, Flows, Runs, browser
interaction, privacy controls, and evidence storage are foundations. They do
not constitute the complete MVP.

The intended MVP is the first useful form of the product described in this
brief:

> An agent can receive a meaningful application-testing assignment, execute
> the required scenarios with the specified browser and environment coverage,
> identify functional and quality findings, and return trustworthy evidence
> demonstrating what was tested and what was not proven.

Capabilities may be delivered incrementally, but the state of the current
implementation must not be used to narrow or redefine this product outcome.

## Condensed statement

Scry is an agent-operated platform for comprehensive application testing. It
enables an AI agent to test complete browser-based experiences across
scenarios, environments, browsers, devices, and screen sizes; preserve
trustworthy evidence for every result; identify failures and inconsistencies
without pretending to know the product owner's intent; and return a reviewable
testing portfolio showing exactly what was tested, what was observed, and what
remains uncertain.

In the simplest terms:

> Describe what needs to be tested, leave the work running, and return to
> evidence showing what works, what does not, what looks inconsistent, and
> whether the requested testing scope was actually completed.

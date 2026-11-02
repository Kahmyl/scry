# Scry baseline brief

Status: description of the implemented baseline

This brief describes the product represented by the working baseline. It is
separate from Scry's broader product direction.

## Product definition

Scry's baseline is an agent-operated browser-testing workspace.

It allows an AI agent to carry out an assigned browser-based test, preserve a
record of what happened, protect sensitive information, and return a report
that a person can review.

The agent decides what to test, which actions to take, and whether the assigned
goal was completed. Scry gives the agent a controlled place to do that work and
keeps the resulting evidence.

The delivery priority is testing with faithful evidence, not exhaustive data
protection. New visual evidence must preserve the application's actual appearance
and use localized, best-effort opaque, frosted-style covers for recognizable secrets and financial
details. Some sensitive content may remain visible; missed masks must not be
confused with failed tests or incomplete recordings. The
[native evidence direction](../baseline/native-evidence-direction.md) defines this
replacement recording behavior; it is not a claim that the retained recorder has
already been replaced. Scry's broader testing direction is unchanged.

The product promise is:

> Give an AI agent an authorized browser assignment, and Scry will help it
> perform the work safely, protect sensitive information, preserve evidence,
> and return a reviewable report.

## The problem

When an AI agent works directly in a browser, it can be difficult to know:

- what the agent actually did;
- whether it changed something accidentally;
- whether a failed action may still have taken effect;
- whether a repeated action could create a duplicate result;
- whether a password or other sensitive value was exposed;
- whether the browser session was recorded completely; and
- whether the final report belongs to the work that was performed.

Scry provides a controlled browser session and a durable record so that the
agent's work can be inspected instead of accepted on trust alone.

## Who uses Scry

### The user

The user:

- creates a Project for the application;
- provides the location of the application to be tested;
- safely stores any required test credentials;
- gives the agent access to Scry;
- reviews Missions, Runs, evidence, and reports; and
- remains responsible for deciding what work is authorized.

### The AI agent

The agent:

- interprets the user's assignment;
- creates a Mission for that assignment;
- divides the Mission into clear Objectives;
- creates Flows to organize different journeys or approaches;
- starts and operates browser Runs;
- decides what action to take next;
- determines the outcome of the work; and
- writes the final Mission report.

Scry does not replace the agent's reasoning. It supports, limits, records, and
protects the agent's browser work.

## How the product works

### 1. Set up the application

The user creates a Project and identifies the application the agent is allowed
to visit.

If the test requires a login or another sensitive value, the user can store it
securely. The agent can refer to that value without being shown the saved
secret.

### 2. Start an assignment

The agent creates a Mission representing the user's complete assignment.

The Mission may contain:

- one or more Objectives describing the desired outcomes;
- one or more Flows describing useful journeys, attempts, or approaches; and
- one or more Runs in which the browser work takes place.

### 3. Open a browser Run

The agent selects the Project, Mission, Objective, Flow, and application
environment for the Run.

Scry opens a fresh supported Chrome-based browser session and keeps that
session associated with the Run.

### 4. Observe and operate the application

The agent can ask Scry what is currently visible in the browser. Scry returns
a safe description of the page, including ordinary controls and relevant page
content.

The agent can then:

- visit an allowed page;
- inspect the page;
- fill ordinary or protected values;
- click controls;
- press supported keys; and
- continue observing the result.

The agent chooses these actions one at a time. Scry does not automatically turn
a Flow into a complete test script.

### 5. Control actions that change the application

Ordinary interactions are treated as read-only. If an action attempts to
change data, Scry blocks the change unless the agent explicitly performs it as
a controlled change.

For a controlled change, Scry allows one declared application request, captures
its result, and blocks additional undeclared changes.

If Scry cannot determine whether the change happened, it records the result as
unknown. The agent must investigate or stop; it must not blindly repeat the
action.

### 6. Protect sensitive information

Saved credentials are represented by safe references rather than returned as
readable values.

When a page produces potentially sensitive information, Scry holds it back
until the agent selects what should be retained. Safe information may be
published, protected information remains protected, and information that is
not needed can be destroyed.

A Run cannot be completed while captured information remains unsettled.

### 7. Preserve the work

Scry preserves the browser session as the agent works so that progress can be
continued after a safe interruption.

It also creates a protected record of the session. When the Run ends, Scry
checks that the record is complete and produces a sanitized replay for later
review.

### 8. Complete the Run

The agent classifies the Run as:

- passed;
- an application failure;
- an environment failure;
- blocked; or
- cancelled.

Before a passing Run can close, every controlled change and every protected
capture must have a settled outcome.

### 9. Publish the Mission report

After all required work is complete, the agent writes the Mission summary and
report.

Scry protects the report from exposing saved or captured secrets and connects
it to the preserved evidence from the Mission's Runs.

The user can then review the Mission, its Objectives, Flows, Runs, controlled
changes, evidence, replay, and final report from the dashboard.

## What Scry delivers

For each completed assignment, Scry provides:

- the original Mission instruction;
- the Objectives and Flows created by the agent;
- a history of the browser Runs;
- the outcome of each Run;
- a record of controlled application changes;
- protected evidence from the browser session;
- a sanitized session replay; and
- a final Mission report connected to that evidence.

## Product principles

### The agent reasons; Scry preserves facts

The agent decides what actions to take and what the results mean. Scry records
what was done and preserves the evidence needed for review.

### Protection supports testing

Saved credentials remain securely handled, and known secrets are kept out of
ordinary logs and credential responses. Visual evidence uses best-effort targeted
masking, not a promise of complete secrecy. Preserving the real application UI is
more important than hiding uncertain regions. Users must be told that sensitive
information may remain and should review evidence before sharing it.

### Uncertainty must remain visible

When Scry cannot establish whether an application change occurred, it reports
that uncertainty instead of pretending the change succeeded or failed.

### Potentially repeated changes are treated carefully

An uncertain change is not automatically repeated. This helps prevent
duplicate accounts, requests, purchases, credentials, or other external
effects.

### Reports must follow completed work

A final report cannot be published while required Runs, changes, captures, or
evidence remain unfinished.

## Planned responsibility boundaries

The working baseline currently combines responsibilities that will be given
clear owners as the platform is reconstructed:

- Praxis will own browser execution;
- Veil will own protection;
- Chronicle will own evidence management; and
- Assurance will own diagnostics, analysis, experiments, and qualification.

This direction does not change what the implemented baseline can do today and
must not be read as a claim that the separation is complete. See the
[four-boundary direction](../baseline/four-boundary-direction.md) and its
[implementation plan](../baseline/four-boundary-implementation-plan.md).

## Product boundaries

This product:

- supports one Chrome-based browser environment;
- depends on an external AI agent to plan and direct the work;
- lets the agent operate the browser step by step;
- relies on the agent to judge whether the Objective passed or failed; and
- connects the final report to preserved evidence without independently
  checking every statement in the report.

It does not:

- create test scenarios on its own;
- automatically execute a Flow as a reusable test script;
- independently decide whether the application is correct;
- provide built-in test assertions;
- prove that every possible scenario was covered;
- compare several browsers or devices;
- test responsive layouts;
- detect visual inconsistencies;
- schedule large unattended testing campaigns; or
- repair the application being tested.

## Successful product experience

The baseline succeeds when:

1. A user creates a Project and safely stores a test credential.
2. An AI agent receives access and starts a Mission.
3. The agent creates an Objective and Flow for the assigned journey.
4. Scry opens a browser Run for the authorized application.
5. The agent navigates, observes the page, and uses the protected credential.
6. Scry prevents undeclared changes to the application.
7. The agent performs an explicitly controlled change when required.
8. Scry captures the result and protects sensitive output.
9. The agent settles the result and completes the Run.
10. Scry preserves a complete protected record and sanitized replay.
11. The agent publishes the Mission report.
12. The user reviews the work and its evidence from the dashboard.

## Condensed statement

> Scry gives an AI agent a protected browser workspace for carrying out an
> authorized application test. The agent directs the work, while Scry protects
> credentials, controls application changes, preserves evidence, and returns a
> Mission report for human review.

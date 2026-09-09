# Scry logical domain model

Status: canonical baseline domain model

This document defines the concepts and ownership relationships used by the
[Scry baseline brief](../product/baseline-brief.md).

## Domain map

```text
Workspace
├── Members
├── Agent access tokens
└── Project
    ├── Environments
    ├── Saved protected inputs
    └── Mission
        ├── Agent session
        ├── Objectives
        ├── Flows
        │   └── Flow revisions
        ├── Runs
        │   └── Browser session
        │       ├── Commands and actions
        │       ├── Controlled effects
        │       │   ├── Effect events
        │       │   ├── Captures
        │       │   └── Publications and outputs
        │       ├── Bound protected inputs
        │       ├── Checkpoint
        │       └── Evidence stream and artifacts
        └── Final report
```

## Identity and tenancy

### User

A person authenticated through the configured identity provider. A User has a
stable Scry identity and may belong to a Workspace through a Membership.

### Workspace

The primary tenancy and access boundary. Projects and agent access tokens
belong to a Workspace. Resources from another Workspace are not visible.

### Membership

Connects a User to a Workspace with one role: owner, admin, member, or viewer.
The role controls trusted dashboard actions such as Project and Environment
creation.

### Agent access token

A revocable credential created by a signed-in User. It carries the User's
Workspace and role into the agent integration. Only a hash and safe prefix are
stored after creation.

## Testing scope

### Project

The application or product under test. It owns Environments, saved protected
inputs, and Missions. Project identity is part of every downstream scope.

### Environment

A named execution scope for a Project. It declares one first-party origin,
optional service origins, an active or disabled state, and a disclosure mode.
Its policy is copied into each Run so active execution cannot be broadened by a
later edit.

### Saved protected input

An encrypted, named value supplied by a User or agent-assisted setup flow. It
may expire and can be bound only to Runs in the same Project. Agents can see
its safe metadata but not its plaintext.

## Assignment model

### Mission

The complete testing assignment. It stores the original instruction and owns
Objectives, Flows, Runs, the active agent context, and one final report.

Mission states are:

- `planning`;
- `running`;
- `blocked`;
- `awaiting_user`;
- `completed`;
- `failed`; and
- `cancelled`.

### Agent session

The durable identity of the agent acting within a Mission. It records the
provider, optional model name, settings, and instruction snapshot. Objective,
Flow, Run, and report writes must refer to the active Agent session for that
Mission.

### Objective

One independently assessable outcome within a Mission. It stores a title,
description, structured completion criteria, ordering, state, and eventual
conclusion.

Objective states are `pending`, `running`, `passed`, `failed`, `blocked`, and
`skipped`.

### Flow

A named journey, approach, retry path, or experiment created by the agent. A
Flow organizes Runs but is not automatically interpreted as an executable
test script.

### Flow revision

An immutable definition attached to a Flow. A Run points to exactly one Flow
revision, preserving what the agent meant to execute even if the Flow later
changes.

## Execution model

### Run

One execution of one Flow revision for one Objective and one Environment. It
belongs to one Mission and one Agent session. A Run stores both execution state
and the agent's outcome classification.

Terminal outcome classifications are:

- `passed`;
- `application_failure`;
- `environment_failure`;
- `blocked`; and
- `cancelled`.

### Browser session

The protected browser workspace associated one-to-one with a Run. It owns the
origin snapshot, disclosure mode, mutation budgets, current browser owner,
document epoch, checkpoint, commands, effects, and evidence stream.

### Browser owner

The worker process currently authorized to operate a Browser session. Ownership
uses a lease and monotonically increasing generation. Work from an expired or
replaced generation is fenced from state changes.

### Command

One agent-chosen browser instruction. Commands are ordered within a Browser
session, have idempotency keys, and move through queued, running, completed, or
failed states. A command result contains safe data only.

### Action

A factual execution-ledger entry recording a browser tool, sanitized
arguments, result classification, owner generation, document epoch, and
duration.

## Controlled-change model

### Effect

The durable truth record for one controlled application mutation. It records
intent, scope, ownership, mutation class, dispatch state, capture state,
publication state, and final mutation outcome.

An authentication effect covers sign-in or equivalent identity establishment.
A business effect covers an application data change. Each class has its own
Run budget.

### Effect event

An append-only transition within an Effect, ordered by sequence. It makes the
path from admission to final determination reviewable.

### Capture

An encrypted response or operation-owned document region associated with an
Effect. A Capture is temporary protected material until published or
discarded.

### Protection decision

The field-level decision that labels selected captured output as public or
protected and records the permitted sinks and supporting digests.

### Publication

The atomic settlement of one Capture. It binds the selection and complete
decision set to the resulting Outputs.

### Output

A selected named value. A public Output stores a safe ordinary value. A
protected Output stores only a reference to an encrypted Protected value.

## Evidence and reporting

### Evidence stream

The one-to-one durable recording for a Browser session. It summarizes the
ordered encrypted chunk chain, storage size, replay location, optional video,
completion state, and retention boundary.

### Evidence chunk

One ordered encrypted segment of recorded browser events. Each chunk points to
the prior digest so removal, reordering, or substitution is detectable.

### Artifact

A Run-associated stored object such as a recording, video, screenshot, trace,
or report attachment. The relational record stores its kind, object key,
digest, and safe metadata.

### Final report

The Mission's immutable, sanitized conclusion. It stores a human-readable
summary, structured safe report data, and one digest derived from the complete
evidence streams belonging to the Mission.

## Domain invariants

- Every Mission belongs to one Project.
- Every Objective, Flow, Agent session, and Run must agree on Project and
  Mission identity.
- Every Run belongs to one Objective, one Flow revision, one Environment, and
  one active Agent session.
- Every Browser session belongs to exactly one Run.
- A Browser session has at most one active owner.
- A Flow has at most one active revision.
- A Mission has at most one final report.
- A Browser session has at most one Evidence stream.
- An unresolved mutation cannot be silently replayed.
- A durable Capture must be published or discarded before session closure.
- Protected values never become ordinary API read results.

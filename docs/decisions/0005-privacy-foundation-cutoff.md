# ADR 0005: Privacy foundation and pre-production cutoff

## Status

Accepted. This decision supersedes the feature-release and privacy portions of
ADR 0004. Flow revision history remains authoritative.

## Context

The existing implementation grew through plan protocol, API, worker-contract,
and privacy generations. Protected capture was added around an executor and
recording system that had not been designed to make evidence privacy a primary
control. Full-frame overlays then became responsible for both secrecy and
recording continuity. Locator failure, timeout, cancellation, navigation, trace
capture, and shutdown could all change whether evidence was safe or usable.

Scry is pre-production and its database can be deliberately cleared. Preserving
feature-generation compatibility would carry the old assumptions into the new
core.

## Decision

Scry will perform one full pre-production cutoff to a single current product
contract. Public schemas and routes will not contain feature-generation names or
fields. MCP, API, web, queue, worker, executor, and persistence will advance as
one release. The cutoff removes compatibility adapters and the old protected
capture implementation.

Flow revisioning is a domain invariant, not feature release versioning, and is
retained:

- every active Flow has one immutable latest revision;
- revisions have a monotonic number and optimistic `expectedRevisionId` guard;
- a run references exactly one immutable `flow_revision_id`;
- an exact rerun uses the same revision and execution snapshot.

Protected work is expressed as one atomic `protectedOperation`, not a reveal
step followed by a capture step. It owns the reveal mutation, ordered discovery,
capture, persistence, evidence controls, cleanup, and explicit safe-resumption
boundary.

The evidence system uses three protections selected by risk:

1. `protected_element`: omit or mask the known element.
2. `protected_surface`: omit or mask the containing sensitive surface.
3. `protected_recording_gap`: record no frames during the protected interval.

Recording is coordinated from page screencast frames and emitted as segments.
Trace, screenshots, DOM, network, console, and recording all pass through one
Privacy Gate. A visual overlay is defense in depth only; it is never accepted as
the security boundary.

Safe resumption is a fact established by the operation. On uncertainty the
operation seals evidence and selects only an explicit terminal path: abort,
continue without recording, or restart from a safe checkpoint.

## Phase 0 freeze

Until the replacement privacy engine passes the Privacy Gauntlet:

- the overlay-era implementation is frozen except for containment or removal;
- no new feature-versioned public contract may be introduced;
- no new split reveal/capture action may be introduced;
- protected artifacts from the transitional engine are experimental evidence;
- no destructive database reset occurs.

The checked-in freeze verifier enforces these rules in the new foundation
surface. Later phases will shrink and finally delete the legacy allowlist.

## Consequences

This is intentionally a breaking cutoff. Test data and legacy feature-contract
records will be removed by a guarded reset only after the clean schema and
replacement runtime are ready. No production migration or compatibility path is
being designed. Historical Flow revisions after the cutoff remain fully
supported inside the current domain model.

# Scry system architecture and transactional design

Status: canonical baseline architecture

This document describes the deployed system that supports the
[Scry baseline brief](../product/baseline-brief.md). It covers only the active
baseline path.

## Architecture overview

```text
User browser
    │
    ▼
Edge proxy ───────────────► Web dashboard
    │
    ├─────────────────────► HTTP API ─────────────► PostgreSQL
    │                          │                       ▲
    │                          └────► Redis queues ────┤
    │                                                  │
    └─────────────────────► Agent integration ─► HTTP API
                                                       │
                                                       ▼
                                             Chromium worker owner
                                                       │
                                  ┌────────────────────┴──────────────┐
                                  ▼                                   ▼
                           Tested application              Protected artifact store
```

## Runtime components

### Edge proxy

Terminates TLS and routes dashboard traffic, API traffic, and agent integration
traffic to their internal services. The application services are not intended
to be exposed directly in production.

### Web dashboard

Provides user sign-in, Project creation, credential management, agent-token
management, and read views for Missions, Runs, effects, evidence, and reports.
It uses bearer-authenticated JSON requests and periodic reads for changing
Run state.

### HTTP API

Owns authentication, authorization, input validation, transactional lifecycle
writes, workspace-scoped reads, command admission, finalization, and report
publication. PostgreSQL is its durable authority.

### Agent integration

Exposes the supported Scry operations through the Model Context Protocol. It
binds each protocol session to one bearer credential, forwards logical
operations to the HTTP API, and returns safe structured results to the agent.
It does not own Mission or execution state.

### Queue dispatcher

Runs inside the API process. It reads durable outbox rows, publishes session
and command jobs to Redis-backed queues, and marks each outbox entry after
successful publication. It also revisits unpublished rows on a short interval.

### Chromium worker

Owns live browser processes. It claims a Browser session lease, restores an
encrypted checkpoint when available, opens a Chromium context, executes queued
commands, records the session, manages controlled mutations and protected
captures, and seals evidence at closure.

### PostgreSQL

Stores identity mappings, workspace scope, the Mission model, command and
effect truth, protected values, encrypted checkpoints and captures, evidence
metadata, reports, and outbox state. Relational constraints defend
cross-resource identity and terminal-state invariants.

### Redis

Provides durable job queues for Browser-session startup and browser commands.
Redis is transport, not product truth. A missing or repeated queue message must
be recoverable from PostgreSQL state.

### Protected artifact store

Stores encrypted evidence chunks and rendered replay artifacts on a mounted
durable volume. A filesystem manifest retains per-chunk locations, digests,
ordering, and chain links. PostgreSQL retains the completed stream summary,
chain head, replay and video locations, and retention metadata. The active
baseline does not write relational evidence-chunk or artifact rows.

## Authoritative ownership

| Concern                                          | Authority                                          |
| ------------------------------------------------ | -------------------------------------------------- |
| Identity and workspace role                      | Authenticated principal plus PostgreSQL membership |
| Project, Mission, Objective, Flow, and Run state | PostgreSQL                                         |
| Environment and Run policy snapshot              | PostgreSQL                                         |
| Queue delivery                                   | Redis-backed queue                                 |
| Whether work should exist                        | PostgreSQL outbox                                  |
| Active browser process                           | Current fenced worker owner                        |
| Mutation truth                                   | PostgreSQL Effect record and Effect events         |
| Protected-value disclosure                       | Protection authority plus persisted decisions      |
| Browser recording bytes                          | Protected artifact store                           |
| Evidence integrity                               | Filesystem chunk chain and database stream summary |
| Final Mission conclusion                         | Sanitized final report in PostgreSQL               |

## Planned subsystem architecture

The current deployed components will be reconstructed around four
responsibility owners:

```text
dashboard and agent integration
              |
              v
   API and application composition
       |          |          |
       v          v          v
    Praxis       Veil     Chronicle

Assurance -> safe read models, public contracts, and deployed interfaces
```

- Praxis owns browser processes, contexts, pages, navigation, observation,
  actions, document identity, owner fencing, and checkpoint mechanics.
- Veil owns protection decisions, sanitization, disclosure, protected capture,
  and cryptographic handling.
- Chronicle owns durable execution facts, evidence streams, artifacts,
  provenance, integrity, completeness, and replay construction.
- Assurance owns diagnostic interpretation, experiments, failure injection,
  qualification, and release-readiness evidence.

The API and workers continue to own transactions, queue orchestration,
idempotency, Run admission, budgets, and product lifecycle. They compose the
three production boundaries through narrow ports and do not become another
implementation of their rules. Production services must not depend on
Assurance.

Praxis, Veil, and Chronicle have completed their production cutovers. Protection policy
and cryptographic operations live in `@scry/veil`; application composition
supplies its capabilities to consumers. Application repositories retain scope checks,
locking, and transactions, and request Veil's publication-admission decision
before writing outputs. Chronicle owns evidence storage, accepted history,
capture custody, recording ordering and closure, replay publication, and evidence
review. Its SQL capability reuses the application's existing transactions.
Browser execution, recorder attachment, replay rendering, lifecycle, and local
lease revocation belong to Praxis. It consumes protection and evidence through
ports and has no Veil, Chronicle, application, or database-driver implementation
dependency. Application adapters persist owner facts and supply locked admission.

The diagram describes the completed target architecture. The
[four-boundary implementation plan](four-boundary-implementation-plan.md) and
[progress record](four-boundary-progress.md) distinguish completed cutovers
from remaining work.

## Transactional creation flow

Mission, Objective, Flow, Environment, protected-input, Run, command, Effect,
publication, and report creation use database transactions. Each durable write
either commits all participating rows or rolls them back together.

Idempotency keys are scoped to their owning aggregate. Reusing a key with the
same declared input returns the existing result. Reusing it with conflicting
input is rejected.

Starting a Run performs one atomic transaction that:

1. validates Project, Mission, Agent session, Objective, Flow revision, and
   Environment identity;
2. validates each selected protected input;
3. creates the Run;
4. creates the Browser session with immutable policy and mutation budgets;
5. binds the selected protected inputs;
6. inserts the Browser-session outbox row; and
7. moves the Mission and Objective into running state.

A queue outage after commit does not erase the Run. The dispatcher can publish
the remaining outbox row later.

## Command delivery

Submitting a command locks its Browser session, validates that it is still
commandable, assigns a monotonically increasing ordinal, writes the sanitized
command and encrypted sensitive input, and creates a command outbox row in the
same transaction.

The queue job identifier equals the durable command identifier. Queue retries
therefore converge on the same command row. A worker claims a command with a
lease token, heartbeats the lease while executing, and may complete or fail the
row only while holding that token. An expired claim can be recovered without
allowing the old claimant to complete afterward.

## Browser ownership and fencing

A Browser session has at most one active owner. Each new claim increments the
owner generation and receives a unique lease token. All Effect transitions,
checkpoint writes, and finalization operations verify the active generation.

When an owner is replaced:

- an admitted Effect that never dispatched becomes `not_applied` and returns
  its reserved budget; and
- an Effect that may have dispatched becomes `unknown` and is never replayed
  automatically.

This preserves external-side-effect truth across worker crashes and lease loss.

## Controlled mutation transaction

A controlled mutation separates admission from dispatch:

1. lock the Browser session and current owner;
2. reject another unresolved Effect in the same class;
3. reserve mutation budget;
4. persist Effect intent and an admission event;
5. install a network gate in the live page;
6. mark dispatch started before forwarding the first same-origin write;
7. block every later write;
8. capture the owned response into protected storage;
9. persist capture metadata and encrypted payload; and
10. return the sanitized successor observation.

If failure occurs before dispatch, the Effect becomes `not_applied`. If failure
occurs after dispatch but before durable capture, the Effect becomes `unknown`.

## Protected publication transaction

Publishing a Capture is atomic in PostgreSQL. The transaction validates the
Effect owner, capture state, expiry, selected paths, field digests, disclosure
mode, and complete protection-decision set. It then creates the Publication,
Protection decisions, public Outputs, and encrypted Protected values before
clearing the raw encrypted payload.

A database failure leaves the Capture durable and unpublished. It does not
release selected values to the agent. Discarding clears the payload and index
without interpreting fields or creating Outputs.

## Checkpoint and recovery design

After each non-closing command, the worker records same-origin resume location,
browser storage state, and session storage in one encrypted checkpoint. The
checkpoint is bound to Project, Mission, Run, Browser session, owner generation,
and revision through authenticated encryption.

A replacement worker may restore the checkpoint only after claiming the current
owner generation. Origin mismatch, digest mismatch, malformed state, unavailable
key material, or owner mismatch fails closed. The checkpoint is deleted after
successful evidence closure.

When persisted data predates the baseline naming reset, the worker may use an
explicit historical decryption candidate after the canonical key fails. This is
a read-only compatibility path; canonical encryption remains the sole write
path and failed authentication never falls back to plaintext handling.

## Evidence closure

The recorder masks inputs and sanitizes captured values before appending events.
Events are ordered, compressed, encrypted with authenticated metadata, and
linked by digest. Durable writes use private directories and atomic file
replacement.

Closing a session flushes the recorder, closes Chromium, verifies the complete
chunk chain, renders a sanitized replay when enabled, records the evidence
summary, and removes the checkpoint. Final database closure then requires the
complete evidence row and the correct browser-owner generation.

Initialization/reconciliation, durable chunk writes, ledger writes, and replay
publication require an application-supplied owner admission capability. The
application locks the session and current owner identity through each short
storage operation, excluding replacement until that operation ends. Long browser
rendering runs outside that transaction and rechecks admission before publication.
Stream completion independently checks the current generation, token, expiry,
and exact session/Run scope in its transaction. A failed ownership check or
heartbeat permanently revokes the local Praxis lease and detaches its recorder
without flushing stale buffered data. Expected product-state close refusals
leave an otherwise owned browser available for outcome/capture settlement.

## Report publication transaction

Report publication locks the Mission's report slot, proves all Objectives and
Runs terminal, proves no Effect pending, requires complete evidence, derives a
Mission evidence digest, sanitizes report content, inserts the final report,
completes the Mission, and completes the Agent session in one transaction.

## Failure behavior

| Failure                                           | Durable result                            |
| ------------------------------------------------- | ----------------------------------------- |
| API fails before transaction commit               | No partial aggregate is visible           |
| Database commits but queue publication fails      | Outbox remains pending for retry          |
| Duplicate queue delivery                          | Existing job or durable command is reused |
| Worker dies before mutation dispatch              | Effect is recoverable as not applied      |
| Worker dies after possible dispatch               | Effect is preserved as unknown            |
| Command owner lease expires                       | Old claimant is fenced                    |
| Protected publication fails                       | Capture stays quarantined                 |
| Evidence chain is incomplete                      | Passing closure is refused                |
| Report contains protected material                | Sanitization replaces protected content   |
| Database shape does not match runtime expectation | API and worker refuse startup             |

## Deliberate limits

The architecture runs one Chromium-based environment, depends on an external
agent for planning and judgment, executes commands step by step, and uses local
mounted artifact storage in the baseline deployment. It does not provide a
general workflow engine, automatic Flow execution, multi-browser orchestration,
or client push subscriptions.

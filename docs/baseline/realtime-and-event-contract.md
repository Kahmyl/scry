# Scry realtime and event contract

Status: canonical baseline contract

This document defines how changing state and internal events behave for the
product described in the [Scry baseline brief](../product/baseline-brief.md).

## Baseline interaction model

The baseline does not provide a client push channel. There is no supported
WebSocket, server-sent event stream, or browser subscription contract.

Clients observe change through repeated authenticated reads:

- the dashboard periodically refreshes active Mission and Run data;
- an agent command request may wait briefly for completion; and
- if work remains active, the caller reads the durable command resource until
  it becomes terminal.

Polling frequency is a client concern. It must be bounded and must not be used
to infer that an operation did not happen merely because a response was late.

## Durable state is authoritative

PostgreSQL lifecycle state is authoritative. Queue acknowledgements, worker log
messages, process memory, and client timers are not product facts.

Each asynchronous operation has a stable resource identifier. A caller follows
that identifier rather than submitting a replacement operation. Retrying a
creation or command uses the original idempotency key.

## Internal queue contract

Redis-backed queues carry two job families:

- Browser-session ownership requests; and
- Browser-command execution requests.

Each job refers to a durable database row. Database outbox rows are created in
the same transaction as the work they announce. The dispatcher repeatedly
publishes unacknowledged outbox rows and marks them only after queue acceptance.

Queue delivery may be delayed or repeated. Consumers must therefore:

- claim the referenced durable row;
- return safely when it is already terminal;
- use lease tokens and owner generation fencing;
- write results only while the claim remains valid; and
- avoid deriving product state from queue attempt count.

Browser-session jobs are not automatically duplicated after a worker takes
ownership. Command jobs may be redelivered, but all deliveries converge on the
same durable command identity.

## Command lifecycle

A Browser command moves through this logical sequence:

```text
queued → claimed → completed
                 ↘ failed
```

Claims expire unless heartbeated. A recovered claim receives a new token. The
previous claimant is fenced from completing or failing the command afterward.

Command ordinals increase within a Browser session and preserve admission
order. Completion order must not be used to bypass an earlier unresolved
controlled change.

## Browser ownership lifecycle

A Browser session has one current worker owner. Ownership uses a lease, a
heartbeat, a unique token, and an increasing generation.

All browser-sensitive writes verify the current generation. When ownership
changes, the replacement worker restores only an authenticated checkpoint
bound to that session and generation. A stale worker cannot publish capture,
checkpoint, evidence, effect, or closure state.

## Mutation event stream

Every controlled change owns an append-only ordered event stream. Supported
event meanings are:

- admitted;
- dispatch started;
- response observed;
- capture made durable;
- publication failed;
- published;
- discarded;
- applied;
- not applied;
- unknown; and
- reconciled.

Events record transitions; the Effect row records the current projection.
Events are immutable and receive an increasing sequence within their Effect.
The projection and event history must agree before closure.

The stream distinguishes four independent facts:

- dispatch state;
- capture state;
- publication state; and
- application outcome.

A post-dispatch interruption may end in `unknown`. That terminal state is
deliberately observable and must not trigger an automatic replay.

## Protected capture events

A response captured from a controlled change is quarantined as durable
encrypted data. It remains unsettled until exactly one of these outcomes:

- selected fields are published under complete protection decisions; or
- the capture is discarded and its reusable encrypted payload is destroyed.

Publication failure leaves the capture durable and unsettled so that the
caller can retry the same publication intent. It does not expose partial
outputs.

## Evidence event stream

Browser recording events are grouped into ordered chunks. Each chunk includes:

- its session and evidence-stream identity;
- an ordinal and event range;
- encrypted compressed content;
- the digest of the preceding chunk;
- its own digest; and
- authenticated storage metadata.

The database records durable chunk metadata and the chain head. Missing,
reordered, duplicated, or digest-mismatched chunks make the evidence stream
incomplete. Successful closure requires a verified gap-free chain.

## Client consistency rules

Clients must expect a short delay between accepted work and visible terminal
state. They must:

- retain resource identifiers and idempotency keys;
- read again after timeouts;
- treat `queued` and `claimed` as active work;
- treat `unknown` as a factual terminal mutation outcome;
- avoid inventing success from transport status alone; and
- stop polling once the durable resource is terminal.

Read responses may combine state written by separate completed transactions.
Where atomicity matters, the API returns the aggregate written by the governing
transaction rather than asking the client to reconstruct it from events.

## Ordering and delivery guarantees

Scry guarantees durable ordering where the domain requires it:

- command ordinal within a Browser session;
- Effect-event sequence within an Effect;
- evidence-chunk ordinal within an evidence stream; and
- Flow revision order within a Flow.

Scry does not promise global ordering across Projects, Missions, Runs, or
workers. Internal queue delivery is at least once in effect; domain handling is
idempotent and fenced so that observable state behaves as one durable operation.

## Planned event ownership

Praxis originates factual browser lifecycle, action, document, ownership, and
dispatch observations. Veil originates protection and publication decisions.
Chronicle admits and durably orders those facts, maintains their provenance and
integrity, and exposes safe evidence projections.

Assurance may derive diagnostics, findings, comparisons, and qualification
results from safe facts and operational telemetry. Those derived events are not
substitutes for Chronicle history and cannot change an Effect, capture,
evidence-stream, or Run outcome. Missing or unavailable Assurance processing
must not stop production command or evidence processing.

## Operational telemetry boundary

Logs, metrics, traces, health checks, and infrastructure alerts support
operators but are not a user-facing event contract. They must not be exposed as
Mission evidence or used to replace durable lifecycle records.

If a future client push channel is introduced, it must announce changes to
durable resources rather than become a second source of truth. Missing a
notification must remain recoverable through an authenticated read.

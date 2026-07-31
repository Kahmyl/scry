# ADR 0002: Execute a versioned action protocol

- Status: Accepted
- Date: 2026-07-30

## Decision

The worker interprets a discriminated, versioned action protocol. It does not
execute generated Playwright source or arbitrary JavaScript.

## Consequences

- Plans are auditable and portable.
- Unsupported actions fail validation before queueing.
- Protocol evolution requires explicit versioning.
- The initial action set is intentionally small.

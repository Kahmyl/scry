# ADR 0001: Keep intelligence outside the MVP

- Status: Accepted
- Date: 2026-07-30

## Decision

Scry MVP will not call an AI model. Codex or another client converts natural
language into Scry's structured protocol. Scry treats that output as untrusted,
validates it, and executes it deterministically.

## Consequences

- The complete Codex test/fix/retest loop remains possible.
- Dashboard-only users initially need a structured form or JSON plan.
- Model selection, prompting, cost, and runtime prompt injection are deferred.
- Native planning can later produce the same public protocol without changing
  the executor.

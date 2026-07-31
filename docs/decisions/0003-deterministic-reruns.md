# ADR 0003: Exact reruns are deterministic

- Status: Accepted
- Date: 2026-07-30

## Decision

An exact rerun uses the same plan version and execution configuration snapshot.
It creates a new attempt and does not invoke a planner.

## Consequences

- Failures can be reproduced and compared.
- Dynamic application data may still vary and must be controlled by fixtures or
  environment setup.
- Replanning is a separate future operation that creates a new plan version.

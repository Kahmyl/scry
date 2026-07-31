# Phase 0: Foundation

## Goal

Freeze the MVP boundaries and define contracts that Phase 1 can implement
without reopening fundamental product or security decisions.

## Deliverables

- [x] MVP product statement and exclusions.
- [x] Responsibility split between Codex and Scry.
- [x] Threat model and trust boundaries.
- [x] Architecture and package boundaries.
- [x] Run and attempt lifecycle.
- [x] Versioned test-plan schema.
- [x] Versioned execution-policy schema.
- [x] Event, result, and artifact schemas.
- [x] Valid and rejected example plans.
- [x] Contract validation tests.
- [x] Architecture decisions for external intelligence, protocol execution, and exact reruns.

## Exit gate

Phase 0 is complete when:

1. `pnpm test` passes.
2. `pnpm typecheck` passes.
3. Valid examples parse as protocol v1 plans.
4. Unsupported actions, cross-origin navigation, malformed locators, and unsafe
   budgets are rejected before execution.
5. Phase 1 can implement the contracts without inventing new run semantics.

## Phase 1 handoff

Implement a local CLI executor for protocol v1. Do not add API, database,
queue, dashboard, MCP, or AI dependencies until the deterministic executor can
produce a complete machine-readable attempt result.

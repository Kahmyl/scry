# Praxis Milestones 0–3 baseline

## Status

- Architecture authority: [Praxis implementation plan](praxis-implementation-plan.md)
- Baseline revision: `4a0135e2915a34a9ea5ab77eecba9d4c3187f9e1`
- Recorded: 2026-08-02
- Milestone 0 gate: accepted
- Milestone 1 internal gate: accepted
- Milestone 2 internal gate: accepted
- Milestone 3 internal gate: accepted
- Milestone 1 external exposure: none

Milestones 0 and 1 establish the accepted baseline and internal transaction skeleton. They do not remove locators, delete acknowledged bypasses, alter production execution, or enforce the final Praxis-only interaction cutoff. Consumer migration and hard enforcement begin in later milestones.

## Environment

| Component | Recorded value |
|---|---|
| Operating system | Darwin 25.2.0 arm64 |
| Node.js | 22.14.0 |
| pnpm | 10.29.3 |
| Playwright | 1.62.0, pinned by `@scry/executor` |
| Chrome | 150.0.7871.187 |
| Browser channel | `SCRY_BROWSER_CHANNEL`, default `chrome` |

Browser verification requires an environment that can bind local fixture servers to `127.0.0.1`, launch the configured Chrome channel, and grant clipboard permissions to the fixture origin.

## Commands

```text
pnpm verify:praxis-inventory
pnpm baseline:praxis
pnpm --filter @scry/contracts test
pnpm --filter @scry/contracts typecheck
pnpm --filter @scry/executor test
pnpm --filter @scry/executor typecheck
pnpm test
pnpm typecheck
```

`baseline:praxis` writes no repository files. JSON is emitted to standard output and the human summary to standard error so CI may archive the exact output.

## Accepted evidence

- Contract tests: 25 passed across 4 files.
- Contract typecheck: passed.
- Executor tests: 200 passed across 16 files using one worker.
- Executor typecheck: passed.
- Interaction inventory: 9 modules with discovered low-level operations covered; 14 modules classified in total.
- Authorized browser environment: accepted with `SCRY_BROWSER_CHANNEL=chrome`.
- Restricted browser run: retained as non-product evidence only.
- Restricted failures: local HTTP binding returned `EPERM`; Chrome processes exited with `SIGABRT` under sandbox restrictions.
- Those restricted-session failures are environmental evidence only and are superseded by the accepted authorized run.

## Milestone 1 verification evidence

- Contract tests: 29 passed across 5 files, including strict Praxis schema and serialization coverage.
- Executor tests: 222 passed across 18 files, including 16 coordinator cases and browser-backed legacy-adapter parity.
- Repository tests: web 15, artifact 3, contracts 29, policy 12, MCP 12, executor 222, and API 48 passed with 2 API tests intentionally skipped.
- Repository-wide typecheck: passed.
- Interaction inventory: 10 modules with discovered low-level operations covered; 15 modules classified in total.
- API, MCP, persistence, event, dashboard, and database contracts: unchanged by the Praxis skeleton.
- One full-suite run observed the existing SPA replacement scenario fail under concurrent suite load; the scenario immediately passed 5 of 5 isolated repetitions and the subsequent complete repository gate passed. This is retained as order/load-sensitive test evidence, not concealed by a product behavior change.

## Milestones 2–3 verification evidence

- Unified observation: versioned runtime identity, document epochs, opaque non-serializable handles, bounded sanitized caching, provider metadata, privacy gating, and provider timings are internal to the executor.
- Unified grounding: native, accessibility, textual, structural, and geometry/visual evidence are extracted behind deterministic providers; scoring policy version 1 preserves the accepted correlation and confidence behavior.
- Unified interaction: the Milestone 1 seam now uses one typed strategy selector, page mutation lease, dispatcher, exact local-state verifier, and effect verifier. The compatibility adapter contains no direct browser-control operations.
- Focused Praxis suites: 30 passed across coordinator, observation, runtime, and legacy parity coverage.
- Executor tests: 230 passed across 20 files.
- Repository tests: web 15, artifact 3, contracts 29, policy 12, MCP 12, executor 230, and API 48 passed with 2 API tests intentionally skipped.
- Repository-wide typecheck: passed.
- Compatibility and latency corpus: 152 passed, 0 failed, 53,316 ms; corpus digest remained `946de43c84fd3f84d46106492b55b4a03dfd12e334e4468e4d6ac5b90fe1c8dc`. The accepted Milestone 0 run was 53,083 ms, a 0.44% difference.
- Interaction inventory: 11 modules with discovered low-level operations covered; 18 modules classified. New unclassified browser-control owners fail repository verification.
- API, MCP, persistence, durable events, database, dashboard, protected acquisition, and production consumer routing remain unchanged.

## Acceptance rule

Milestone 0 is accepted only when the inventory verifier, contract tests, executor typecheck, browser runtime tests, grounding gauntlet, HTTP cohorts, privacy suite, and protected-transaction suite pass in the authorized environment. Any assertion failure that remains after infrastructure access is restored must be diagnosed separately before Milestone 1 is accepted.

The baseline harness records observed durations; it does not define a latency objective. Milestone 1 must not introduce a statistically material regression in non-OCR scenarios.

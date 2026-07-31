# Phase 1: Deterministic local executor

## Goal

Execute a protocol v1 plan locally without API, database, queue, dashboard,
MCP, or AI dependencies and produce a complete machine-readable attempt.

## Deliverables

- [x] CLI plan loading and contract validation.
- [x] Project-policy validation.
- [x] Deterministic Playwright action interpreter.
- [x] Semantic locator resolution.
- [x] Required assertion evaluation.
- [x] JSONL event stream.
- [x] Step and failure screenshots.
- [x] Playwright trace.
- [x] Console, page-error, and failed-request diagnostics.
- [x] DOM and network evidence requested by plan steps.
- [x] Secret reference resolution from an injected resolver.
- [x] Wall-clock timeout and abort-signal cancellation.
- [x] Machine-readable attempt summary.
- [x] Browser integration test against a local fixture.

## CLI

```bash
pnpm scry run examples/plans/signup.valid.json \
  --output artifacts/signup \
  --channel chrome
```

Secret references are resolved from environment variables with the `SCRY_SECRET_`
prefix. For example, `signup-test-email` maps to
`SCRY_SECRET_SIGNUP_TEST_EMAIL`. Values are never written to events.

## Output

```text
artifacts/signup/
├── events.jsonl
├── attempt.json
├── trace.zip
├── screenshots/
├── dom/
└── network/
```

## Exit gate

1. `pnpm test` passes, including a real browser journey.
2. `pnpm typecheck` passes.
3. Successful and failed required assertions produce distinct terminal states.
4. Failure evidence and trace finalization survive action/assertion errors.
5. Event payloads never include resolved secret values.

## Phase 2 handoff

Move origin enforcement from navigation-only checks to comprehensive browser
request policy, add private-network protection, capability classification,
popup/download controls, and adversarial policy tests.

# Verification

Scry uses impact-aware verification for normal development.

## Normal verification

```bash
pnpm verify
```

The verifier:

1. Detects changed files from Git.
2. Maps package changes through the pnpm workspace dependency graph.
3. Runs the reviewed static repository gates.
4. Runs typechecks and tests for affected workspaces.
5. Uses reviewed semantic impact profiles where the ordinary dependency graph is too broad.
6. Falls back to the full workspace suite for direct, unknown, global, or unreviewed impact.
7. Retains previously failing workspaces until a full healthy verification clears them.

Explain selection:

```bash
pnpm verify -- --explain
```

Inspect a specific change without executing:

```bash
pnpm verify -- --plan --explain --files packages/veil/src/index.ts
```

## Full verification

```bash
pnpm verify:full
```

This is the conservative escape hatch and does not use semantic narrowing.

## Selector audit

```bash
pnpm verify:audit
```

Audit runs the affected plan and then compares every semantically narrowed workspace against its full suite.

A focused pass followed by a failing full comparison is a selector miss and fails the audit.

Audit is intentionally expensive and is not the normal development loop.

## Safety rules

- Unknown impact broadens verification.
- Direct Executor, Praxis, and API changes run their full workspace suites.
- Skipped work is not reported as PASS.
- The historical M1 snapshot qualification is reported unavailable when its immutable snapshot is absent.
- External/live campaigns are outside deterministic affected verification.
- Semantic impact profiles supplement rather than duplicate the pnpm workspace dependency graph.

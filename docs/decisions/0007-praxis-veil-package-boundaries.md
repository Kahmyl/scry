# ADR 0007: Praxis and Veil package boundaries

- Status: Accepted
- Date: 2026-08-03

## Context

Praxis and Veil are authoritative internal subsystems, but their implementations are currently distributed across executor, contracts, policy, artifact, API, MCP, and web source trees. Prefixes communicate intent to people but do not create an enforceable ownership boundary. This permits duplicated authority, deep imports, accidental dependency cycles, and new transitional code after a cutoff.

## Decision

Scry owns the subsystems through two internal workspace packages:

- `@scry/praxis` owns observation, evidence correlation, grounding, target handles, strategy selection, dispatch, local/effect verification, transaction coordination, quality analysis, and the typed port through which it requests privacy authority.
- `@scry/veil` owns privacy preferences and policy compilation, capability leases, evidence-channel authorization, protected intervals, collectors, sanitization, evidence admission, retention decisions, and privacy-safe failure projection.

The packages are internal libraries, not services or deployables. During migration, current public behavior, database state, durable events, API/MCP contracts, and browser execution remain unchanged.

## Dependency direction

```text
apps/api, apps/mcp, apps/web
              |
          executor
          /     \
      praxis --> veil
          \     /
          contracts
              |
           artifact
```

`artifact` is a neutral storage and artifact primitive. Veil decides whether evidence may be admitted; artifact does not decide privacy. Praxis requests authority from Veil and cannot implement privacy policy. Veil cannot select targets, strategies, or browser interactions.

Required dependency rules:

1. Contracts, artifact, and policy cannot depend on executor, Praxis, or Veil runtime packages.
2. Veil cannot depend on Praxis or executor.
3. Praxis cannot depend on executor or applications.
4. Applications and executor consume only package-root exports; deep imports into Praxis or Veil are forbidden.
5. A package's `internal/` modules are never exported.
6. Transitional Praxis/Veil files outside their owner packages must appear in the checked-in migration inventory. New transitional files are rejected.

## Migration sequence

1. Establish package shells, dependency enforcement, and the migration inventory.
2. Move Veil policy and authority.
3. Move Veil runtime lifecycle, collectors, evidence admission, and retention ports.
4. Move Praxis observation and grounding.
5. Move Praxis transaction, dispatch, and verification.
6. Move the Praxis–Veil bridge and reduce executor to composition.
7. Migrate API/MCP/web adapters and remove inventory entries as each owner moves.
8. Remove transitional exports and require an empty migration inventory.

Every slice must preserve behavior, pass package and repository typechecks, pass boundary verification, and run its applicable production-shaped campaigns in an authorized browser environment.

## Consequences

Ownership becomes mechanically reviewable and circular subsystem authority is prohibited. Migration is incremental, so transitional files remain temporarily, but their set can only shrink. A package move that changes behavior must be delivered separately from the structural migration.

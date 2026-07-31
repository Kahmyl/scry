# Architecture overview

```mermaid
flowchart TD
    A["Codex, dashboard, or API client"] --> B["Structured protocol v1 plan"]
    B --> C["Schema validation"]
    C --> D["Project execution policy"]
    D --> E["Persist immutable run snapshot"]
    E --> F["Queue"]
    F --> G["Playwright worker"]
    G --> H["Browser context"]
    G --> I["Append-only events"]
    G --> J["Artifact store"]
    I --> K["Report projection"]
    J --> K
    K --> A
```

## Planned workspace boundaries

```text
apps/
  api/          NestJS API and SSE
  web/          React dashboard
  worker/       Playwright/BullMQ worker
  mcp/          MCP adapter over the API
packages/
  contracts/    Protocol and API schemas
  executor/     Deterministic action interpreter
  policy/       Plan and runtime policy enforcement
  artifact/     ArtifactStore interface and implementations
```

## Invariants

1. A run references an immutable plan and execution configuration snapshot.
2. A logical run may have multiple attempts; attempts never overwrite each other.
3. Events are append-only and monotonically sequenced within an attempt.
4. The worker revalidates the plan and policy immediately before execution.
5. Reports are projections of stored facts, not the primary execution record.
6. Exact rerun does not call an AI or change the stored plan.
7. Large artifacts are referenced by metadata rather than embedded in API or MCP responses.

## Initial domain model

```text
Project
├── Environment
│   ├── base origin
│   ├── execution policy
│   └── secret references
├── Test specification
│   └── Specification version
│       └── Plan version
└── Run
    └── Attempt
        ├── Step result
        ├── Assertion result
        ├── Event
        └── Artifact
```

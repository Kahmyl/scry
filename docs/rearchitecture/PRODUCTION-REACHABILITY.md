# Production Reachability at the Four-Boundary Reset Baseline

## Authority

This inventory describes static source reachability from the deployed entrypoints at:

`0c9cf69cd91eaad1bcd2b11af0c2a8b76d676398`

It is a characterization of the frozen starting architecture, not a statement of the desired architecture.

The resolver completed with zero unresolved internal `@scry/*` imports.

Static reachability includes import, export, type-import, and package-barrel edges. It proves source dependency reachability; it does not claim that every reached symbol executes during every request.

## Deployed roots

| Root      | Entrypoint                               | Reached source files | Reached Scry packages                                   |
| --------- | ---------------------------------------- | -------------------: | ------------------------------------------------------- |
| API       | `apps/api/src/browser-v2-main.ts`        |                   72 | `@scry/api`, `@scry/browser-runtime`, `@scry/contracts` |
| Worker    | `apps/api/src/browser-v2-worker.ts`      |                   73 | `@scry/api`, `@scry/browser-runtime`, `@scry/contracts` |
| Migration | `apps/api/scripts/migrate-browser-v2.ts` |                    3 | `@scry/api`                                             |
| MCP stdio | `apps/mcp/src/browser-v2-main.ts`        |                   37 | `@scry/mcp`, `@scry/contracts`                          |
| MCP HTTP  | `apps/mcp/src/browser-v2-http.ts`        |                   37 | `@scry/mcp`, `@scry/contracts`                          |
| Web       | `apps/web/src/main.tsx`                  |                   22 | `@scry/web`                                             |

## Production-reachable workspace packages

- `@scry/api`
- `@scry/browser-runtime`
- `@scry/contracts`
- `@scry/mcp`
- `@scry/web`

## Workspace packages not reached from deployed roots

- `@scry/assurance`
- `@scry/chronicle`
- `@scry/executor`
- `@scry/observability`
- `@scry/policy`
- `@scry/praxis`
- `@scry/veil`

Non-reachability does not by itself authorize deletion. A non-reached package may still contain a capability that must be moved to the canonical owner before deletion.

## Active API domains

Reached:

- `apps/api/src/auth`
- `apps/api/src/browser-execution`
- `apps/api/src/common`
- `apps/api/src/infrastructure`

Not reached from the deployed API, worker, or migration roots:

- `apps/api/src/access`
- `apps/api/src/adaptive-sessions`
- `apps/api/src/artifacts`
- `apps/api/src/authentication-authoring`
- `apps/api/src/authoring`
- `apps/api/src/calibration`
- `apps/api/src/external-agents`
- `apps/api/src/flows`
- `apps/api/src/lifecycle`
- `apps/api/src/missions`
- `apps/api/src/orchestration`
- `apps/api/src/praxis`
- `apps/api/src/recovery`
- `apps/api/src/runs`
- `apps/api/src/runtime`
- `apps/api/src/system`
- `apps/api/src/veil`
- `apps/api/src/workers`

## Active MCP source

Reached:

- `apps/mcp/src/browser-v2-api-client.ts`
- `apps/mcp/src/browser-v2-http.ts`
- `apps/mcp/src/browser-v2-main.ts`
- `apps/mcp/src/browser-v2-server.ts`
- `apps/mcp/src/tool-registry.ts`

The older MCP server, composition, qualification, and domain-tool trees are not reached from either deployed MCP root.

## Playwright imports in the deployed source closure

- `apps/api/src/browser-execution/browser-v2-worker-engine.ts`
- `apps/api/src/browser-execution/repositories/browser-command.repository.ts`
- `packages/browser-runtime/src/offline-renderer.ts`
- `packages/browser-runtime/src/recorder.ts`

This proves that the frozen deployed baseline does not yet satisfy the desired rule that production Playwright mechanics belong to Praxis.

## Assurance production dependency

No import of `@scry/assurance` is reachable from the deployed API, worker, migration, MCP, or web roots.

## Architectural consequence

The working deployed browser baseline is principally application composition plus `@scry/browser-runtime` and `@scry/contracts`.

Praxis, Veil, and Chronicle exist in the repository but are not the packages used by the deployed execution roots at this baseline.

Therefore subsequent phases must transfer proven working responsibilities from the active browser-execution/browser-runtime path to the four canonical owners. They must not replace the working baseline with older unreachable implementations merely because those implementations already use the desired package names.

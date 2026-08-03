# Repository topology

## Decision

Scry uses domain-owned source trees. File location communicates authority; filename prefixes are not
a substitute for a domain boundary.

Observable behavior, public contracts, persistence semantics, and runtime ownership remain unchanged
during topology migration. Each domain moves as one independently verified cutover.

## Application roots

Application `src` roots contain only bootstrap and composition files. NestJS API capabilities live in
domain modules. React capabilities live in feature folders. MCP tools live in domain folders with one
tool definition per file and a domain registrar as the public entry point.

The accepted API root files during migration are:

- `app.module.ts`
- `main.ts`
- worker composition entry points until the execution domain cutover is complete

The React source root contains only `main.tsx`. UI ownership is explicit:

- `app/` owns routing and application-shell composition;
- `features/` owns user-visible business capabilities;
- `infrastructure/` owns transport, authentication, and runtime configuration;
- `shared/` owns reusable presentation, formatting, and stateless UI policy;
- `styles/` owns the global style entry point.

Every app, feature, infrastructure, and shared boundary exposes an `index.ts`. Cross-boundary imports
use that public entry point; tests live beside the boundary they characterize.

## Domain shape

A domain exposes an `index.ts` public entry point and keeps implementation details private. Use only
the folders a domain actually needs:

```text
domain/
  domain.module.ts
  index.ts
  controllers/
  services/
  repositories/
  dto/
  entities/
  transformers/
```

One controller, service, or repository may remain directly under its domain. Create a category folder
when there are multiple peers or when it materially clarifies ownership. Empty ceremonial folders are
forbidden.

## Dependency rules

- Cross-domain imports use the owning domain's `index.ts`.
- Domain internals may use relative imports within that domain.
- Infrastructure is provided through `InfrastructureModule`; domains do not instantiate database or
  Redis clients.
- `AppModule` composes domain modules and does not re-declare their controllers or providers.
- Praxis and Veil remain package authorities. Application domains consume their public package APIs.
- Tests mirror the source domain they verify or explicitly exercise a public domain entry point.

## Formatting and generated data

Maintained JSON is formatted and checked by Prettier. Generated evidence remains in its explicit
evidence directory and may use generator-controlled serialization when byte stability is required.
Architecture inventories and performance profiles are maintained repository inputs and therefore use
normal JSON formatting.

## Migration order

1. Establish infrastructure and authentication modules.
2. Split project/environment/credential access from the legacy aggregate repository.
3. Move Flow, Mission, authoring, orchestration, calibration, artifacts, and run observation into
   domain modules.
4. Move worker execution into an execution domain while keeping the worker entry point as composition.
5. Organize web code by feature and shared UI/runtime layers.
6. Split MCP registrars into domain folders and one-tool files.
7. Organize contracts, Executor, Praxis, Veil, policy, and artifact packages by public boundary.
8. Remove the temporary topology allowlist and make root/domain violations release-blocking.

Every stage requires formatting, typechecking, focused tests, repository boundary verification, and
the relevant Praxis/Veil change gates. Browser-backed gates remain mandatory for interaction-owning
stages.

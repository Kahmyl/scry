# Scry technology stack

Status: canonical baseline stack

This document identifies the technologies that implement the product described
in the [Scry baseline brief](../product/baseline-brief.md). It covers the active
baseline path and does not treat unused packages as part of the product.

## Stack principles

The stack is organized around four needs:

- keep durable product truth in a transactional relational database;
- separate browser work from request handling through durable queues;
- operate a real Chrome-based browser under a fenced worker owner; and
- expose the same product capabilities to people and AI agents through
  authenticated interfaces.

Dependency release numbers are implementation metadata, not product identity.
They belong in lockfiles and deployment artifacts rather than in the product
contract.

## Application language and workspace

The application is a TypeScript and Node.js monorepo managed with pnpm. Shared
packages hold contracts and browser-execution behavior used by more than one
runtime. TypeScript checks and package boundaries provide build-time validation
across the dashboard, API, agent integration, and worker.

## Web dashboard

The dashboard uses:

- React for the user interface;
- Vite for development and production builds;
- React Router for application navigation; and
- the Supabase browser client for user authentication and access tokens.

The dashboard communicates with Scry through authenticated JSON requests. It
periodically refreshes changing Mission and Run state; it does not hold product
truth locally.

## HTTP API

The API uses NestJS with the Fastify HTTP adapter. It owns:

- request authentication and workspace authorization;
- input validation;
- lifecycle transactions;
- idempotency enforcement;
- browser-command admission;
- finalization gates; and
- report publication.

Zod schemas define request, response, and shared domain contracts. The API uses
the PostgreSQL driver directly for explicit transaction and locking behavior.

## Durable data and asynchronous transport

PostgreSQL is the durable system of record. It stores identity scope, product
aggregates, command and mutation truth, encrypted protected material, evidence
metadata, and reports.

Redis and BullMQ provide asynchronous delivery for Browser-session startup and
browser commands. Queue delivery is recoverable transport; the database and its
outbox records determine whether work exists and whether it completed.

The migration task uses node-pg-migrate for ordered SQL execution and applied
operation history. Scry supplies explicit database-identity guards, verified
transactional adoption of retained baselines, bounded migration coordination,
and a separate readiness check. Operation names are not SQL byte hashes or
product versions; additive schema changes do not require a complete-catalog
fingerprint match.

## Browser execution

The hosted candidate uses the pinned official Playwright MCP adapter, wrapped
by Scry's existing durable admission, worker ownership, targeted masking and
Chronicle custody. Runtime selection is shared by API admission and MCP tool
discovery; the worker executes each session's immutable adapter assignment.
The retained command adapter is not a hosted fallback. See
[production promotion](production-promotion.md#browser-runtime-selection) for
the packaged login and compatibility gate required before activation.

Playwright controls a headless or visible Chromium browser. The worker uses the
Chrome DevTools Protocol where lower-level network or browser lifecycle control
is required.

The shared browser runtime provides observation, document-scoped element
references, origin policy, read-only interaction, controlled mutations,
protected capture handling, checkpointing, and evidence collection.

New sessions use Playwright's native screencast and action screenshots. Veil's
isolated-world policy places targeted black masks without reconstructing the
page. Chronicle admits exact media receipts through the existing owner-fenced
evidence stream. Masking is best effort; ordinary UI remains visible. rrweb is
retained only for historical DOM recordings. See the
[native evidence baseline](native-evidence-direction.md) for limits and qualification.

## Agent integration

The agent integration uses the Model Context Protocol SDK over Streamable HTTP.
It translates supported agent operations into authenticated API calls. It does
not own browser or Mission state and cannot bypass API policy.

## Security primitives

Node's cryptographic library supplies:

- authenticated encryption for protected values, captures, checkpoints, and
  evidence;
- random nonces and tokens;
- cryptographic digests;
- constant-time comparisons; and
- context-bound key derivation.

Keys and authentication secrets are supplied through the deployment
environment. Plaintext credentials are not stored in product tables.

## Evidence and artifact storage

Encrypted evidence chunks and generated replay artifacts are written to a
private durable filesystem mount. Its manifest stores per-chunk identifiers,
sizes, digests, ordering, and chain links. PostgreSQL stores the completed
stream summary, chain head, replay and video locations, and retention metadata.
The active path does not populate relational evidence-chunk or artifact rows.

The filesystem is an evidence and artifact store, not the authority for
session state. Evidence is accepted only after the filesystem chain verifies
and the completed stream summary is persisted.

## Deployment

The baseline is packaged as containers and composed as these runtime services:

- edge proxy;
- web dashboard;
- HTTP API and outbox dispatcher;
- browser worker;
- agent integration;
- database migration task;
- PostgreSQL; and
- Redis.

Caddy terminates TLS and routes external traffic to the internal services.
Container health checks and startup ordering protect service dependencies.

Backup and metrics services may be enabled as operational support, but they are
not part of the browser-testing product path.

## Package responsibilities

Veil is now the active protection owner. The API composes its public
capabilities for classification, sanitization, quarantine,
publication admission, recording privacy rules, and cryptographic operations.
The API retains a small dependency-injection adapter for the Veil value cipher.
Veil depends only on shared contracts and Node's built-in libraries.

The baseline now uses these four responsibility boundaries:

- `@scry/praxis` for Playwright, browser protocol, browser lifecycle,
  observation, action, ownership, and checkpoint mechanics;
- `@scry/veil` for protection policy, sanitization, disclosure, protected
  capture, and cryptographic handling;
- `@scry/chronicle` for evidence facts, streams, chunks, artifacts, integrity,
  retention, replay, and evidence composition; and
- `@scry/assurance` for diagnostic analysis, experiments, test campaigns, and
  qualification.

The API and workers compose production capabilities through public contracts.
Chronicle owns evidence storage, ordered recording custody, capture-envelope
storage, accepted event history, completeness, replay publication, review
projections, and Mission evidence digests. It depends only on contracts and Node
built-ins; composition supplies Veil protection, SQL, and browser-rendering
capabilities. Praxis owns the active browser engine, recorder attachment,
replay rendering, browser lifecycle, and local owner revocation. It depends only
on contracts, Playwright, rrweb and the existing tsx runtime loader for its private
browser custodian; Veil and Chronicle are injected capabilities,
not Praxis implementation dependencies. The application supplies transactional
owner admission for durable evidence and retains encrypted checkpoint storage.
Assurance exercises public surfaces, but production services build and run without
it. Its analysis depends only on shared contracts and Node built-ins. Public
Praxis, Veil, and Chronicle implementations, Playwright, Vitest, and tsx are
development-only fixture and qualification dependencies. It has no database
driver or application-internal dependency.
The dormant implementations of all four packages have been replaced by the
proven baseline. Dormant application implementations, historical campaigns and
migrations, unused contracts, Executor, Policy, Observability, and Agent Lab have
been removed after tracing production, verification, and operational consumers.
Current completion is recorded in the
[reset progress record](four-boundary-progress.md).

## Engineering assurance

Vitest, TypeScript checks, Prettier, repository-boundary checks, contract checks,
container checks, and browser-shaped tests protect the baseline. Verification
must exercise both successful behavior and the failure paths that preserve
mutation truth, protected information, evidence integrity, and workspace
isolation.

`pnpm verify` runs the Assurance `fast` profile. `pnpm qualify list` lists the
explicit profiles in `packages/assurance/src/catalog.ts`; the reusable CI lanes
invoke that same catalog rather than maintaining separate test selections.
Owner-local unit and transactional tests remain beside their components.
Assurance runs them as subprocess checks and owns the cross-boundary browser
fixture, repository gates, safe outcome reporter, and qualification runner.

Profiles cover ordinary characterization, real Chromium recording/replay,
database lifecycle, durable worker execution, owner admission, failure
finalization, process recovery, long journeys, and deployment qualification.
Database profiles require matching `DATABASE_URL`,
`SCRY_BROWSER_TEST_DATABASE_URL`, and `SCRY_BROWSER_EXPECTED_DATABASE`; migration
still requires its own explicit target and confirmation. Queue profiles also
require `REDIS_URL` and a distinct `SCRY_BROWSER_QUEUE_NAMESPACE`. The runner
does not provision, migrate, reset, or drop caller-supplied databases. The separate
`deployed-smoke` profile creates its own disposable, portless Docker project and
uses the existing migration task there; it never targets an operator's database.

The workspace explicitly lists the eight baseline applications/packages. API
and MCP typechecks cover all retained source and tests. The repository-closure
gate rejects source outside production or supported qualification paths,
unresolved local imports, computed module loads without disposition, undeclared
dependencies, and displaced workspaces. Negative fixtures exercise the tracer;
no exact-byte source or schema fingerprint is required.

`pnpm qualify deployed-smoke` builds the production image and exercises public
authenticated API/MCP calls through a real Chromium worker, protected fill,
evidence and zero-network replay closure, safe report publication, workspace and
session refusal, and web serving. Its issuer and target application are local
fixtures; no real Supabase account or external application is contacted. The
`ci-fast` profile includes this composed smoke in addition to production-only
dependency and operational-manifest checks. Routine `fast` remains independent
of those full-image checks.

Each invocation retains an exclusive, private JSON report under
`artifacts/assurance/`. Reports contain selected check IDs, guarantees, times,
outcomes, and bounded test counts, not raw stdout, stderr, exception text,
environment values, or captured payloads. Child output is bounded in memory;
timeouts, cancellation, missing prerequisites, missing test reports, insufficient
passing tests, and unexpected integration skips cannot pass. Ordinary profiles
explicitly expose their browser/database skips; they do not substitute for the
integration profiles. A passing report covers selected checks only and is
diagnostic evidence, not a product verdict or release-admission authority.

Runtime deployment preflight, deployment actions, backup scripts, and recovery
operations remain outside Assurance. Their checks live in Assurance; the
`production-recovery` profile is a separate opt-in isolated recovery drill, not
part of routine verification or a claim that production was restored.

## Deliberate exclusions

The active baseline does not depend on a multi-browser execution grid, native
mobile automation, a visual-difference engine, a test-generation service, or a
client push channel. Adding any of those capabilities requires an explicit
product and architecture decision rather than treating an unused dependency as
an existing feature.

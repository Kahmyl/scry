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

## Browser execution

Playwright controls a headless or visible Chromium browser. The worker uses the
Chrome DevTools Protocol where lower-level network or browser lifecycle control
is required.

The shared browser runtime provides observation, document-scoped element
references, origin policy, read-only interaction, controlled mutations,
protected capture handling, checkpointing, and evidence collection.

rrweb records browser events for sanitized replay. Input masking, protected
value handling, event sanitization, authenticated encryption, and hash chaining
are applied before evidence becomes durable.

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
on contracts, Playwright, and rrweb; Veil and Chronicle are injected capabilities,
not Praxis implementation dependencies. The application supplies transactional
owner admission for durable evidence and retains encrypted checkpoint storage.
Assurance exercises public surfaces, but production services build and run without
it. Its analysis depends only on shared contracts and Node built-ins. Public
Praxis, Veil, and Chronicle implementations, Playwright, Vitest, and tsx are
development-only fixture and qualification dependencies. It has no database
driver or application-internal dependency.
The dormant implementations of all four packages have been replaced by the
proven baseline. Broader dormant-application cleanup remains separate.
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
does not provision, migrate, reset, or drop databases.

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

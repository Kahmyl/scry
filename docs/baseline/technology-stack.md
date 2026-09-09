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
private durable filesystem mount. PostgreSQL stores their identifiers, sizes,
digests, ordering, chain heads, and retention metadata.

The filesystem is an artifact store, not the authority for session state.
Evidence is accepted only when its database metadata and integrity chain agree.

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

## Engineering assurance

Vitest, TypeScript checks, Prettier, repository-boundary checks, contract checks,
container checks, and browser-shaped tests protect the baseline. Verification
must exercise both successful behavior and the failure paths that preserve
mutation truth, protected information, evidence integrity, and workspace
isolation.

## Deliberate exclusions

The active baseline does not depend on a multi-browser execution grid, native
mobile automation, a visual-difference engine, a test-generation service, or a
client push channel. Adding any of those capabilities requires an explicit
product and architecture decision rather than treating an unused dependency as
an existing feature.

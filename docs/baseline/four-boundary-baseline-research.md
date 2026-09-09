# Scry four-boundary baseline research

Status: completed pre-implementation baseline research

This record establishes what the current Scry baseline actually builds,
deploys, executes, stores, and verifies. It is the evidence required by
[workstream 1](four-boundary-implementation-plan.md#workstream-1-fresh-baseline-research)
before behavior is relocated into Praxis, Veil, Chronicle, and Assurance.

The research preserves the working baseline. Existing packages and historical
source paths are not treated as authority merely because their names resemble
the intended boundaries.

## Executive conclusion

The deployed baseline is a small path through a much larger repository. It is
composed from the web dashboard, HTTP API, browser worker, agent integration,
PostgreSQL, Redis, the shared contracts package, and the consolidated browser
runtime. The packages currently named Praxis, Veil, Chronicle, and Assurance
are not dependencies of that deployed path.

The working behavior can be relocated without redefining it. The current
browser worker and repositories contain the behavior that must be separated:

- browser mechanics and factual dispatch state belong in Praxis;
- protection, sanitization, protected capture, and cryptography belong in
  Veil;
- evidence custody, integrity, replay, and accepted execution history belong
  in Chronicle; and
- tests, diagnostics, experiments, and qualification belong in Assurance.

Application composition remains responsible for authentication, tenancy,
product lifecycle, transactions, queues, admission, budgets, and finalization.

Research also found three important differences between prior descriptions and
the running path:

1. Evidence chunk files and their filesystem manifest are durable, but the
   active path writes only an evidence-stream summary to PostgreSQL. It does
   not write relational evidence-chunk rows.
2. The active path does not write relational artifact or browser-action rows.
   Command history is the current safe action ledger, while replay and video
   object keys are stored on the evidence-stream summary.
3. Production startup can require an activated permanent identity-import
   receipt, but the active deployment interface can only activate a receipt
   that already exists. A fresh production database has no supported command
   in the baseline that creates that permanent receipt.

These are baseline gaps, not permission to add behavior during the reset. The
recommended path is to preserve the observed behavior while relocating it,
keep the unused tables non-authoritative, and handle each gap later as a
separate, intentional correction.

## Authority and method

Facts in this record came from:

- container definitions, package manifests, runtime entry points, and import
  traversal;
- source inspection of the active worker, repositories, runtime, contracts,
  migration, dashboard, and agent integration;
- fresh-database migration and repository integration tests;
- isolated browser-worker, recovery, failure, and long-journey tests;
- build, type, package-boundary, workflow, deployment, and container checks;
  and
- read-only database queries after successful browser journeys.

The import traversal is conservative. A package index that re-exports a module
can make that module statically reachable even when no active component
instantiates it. Runtime construction and database effects were checked before
assigning ownership.

## Production reachability ledger

### Deployed entry points

| Surface                                      | Entry point                   | Reachable responsibility                                                                                              |
| -------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| HTTP API and outbox dispatcher               | `apps/api/src/main.ts`        | Authentication, scoped product API, transactions, outbox publication, browser admission, reads, finalization, reports |
| Browser worker                               | `apps/api/src/worker.ts`      | Queue consumption, browser ownership, command execution, protection, capture, evidence closure, recovery              |
| Database migration                           | `apps/api/scripts/migrate.ts` | Baseline schema installation and capability admission                                                                 |
| Agent integration over HTTP                  | `apps/mcp/src/http.ts`        | Supported tool registration, bearer binding, API forwarding                                                           |
| Agent integration over standard input/output | `apps/mcp/src/main.ts`        | The same supported tools and API forwarding                                                                           |
| Dashboard                                    | `apps/web/src/main.tsx`       | Sign-in, project setup, browser work views, reports, and settings                                                     |

The deployment also runs PostgreSQL, Redis, and Caddy. Backup and metrics
profiles support operations but do not define browser-testing behavior.

### Runtime package graph

```text
web dashboard ------------------------------> HTTP API
agent integration -> shared contracts ------> HTTP API
                                                   |
                                                   v
                                        PostgreSQL + Redis outboxes
                                                   |
                                                   v
browser worker -> shared contracts + consolidated browser runtime
                                                   |
                                                   v
                                    Chromium + protected artifact volume
```

The API package declares the consolidated browser runtime and shared contracts
as its Scry runtime dependencies. The agent integration declares shared
contracts. Production container construction copies those package manifests;
it does not copy Praxis, Veil, Chronicle, Assurance, Executor, Policy,
Observability, or Agent Lab as runtime dependencies.

### Reachability result

Static traversal from the six entry points found a union of 72 runtime files.
The inspected application and package roots contain 572 non-test source files;
502 were not reachable from those entry points. The exact number is a location
aid rather than a deletion rule, because exports, scripts, migrations, and
dynamic configuration require separate inspection.

Important reachable implementation is concentrated in:

- `apps/api/src/browser-execution`;
- `apps/api/src/auth` and `apps/api/src/infrastructure`;
- `packages/browser-runtime/src`;
- the browser execution, lifecycle, and command contracts;
- the current agent server, API client, and tool registry; and
- the current dashboard application and its direct features.

Important unreachable groups include the existing named boundary packages,
Executor, Policy, Observability, Agent Lab, alternate API modules, alternate
agent tools, alternate dashboard features, and 29 old shared-contract modules.
They are candidates for replacement or deletion, not evidence of current
product capability.

## Responsibility inventory

| Current behavior                                                                                                              | Present implementation                                                        | Intended owner                                                               | Disposition                                                    |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Browser launch, context, page, navigation, observation, element references, clicks, key presses, and fills                    | `browser-worker-engine.ts`                                                    | Praxis                                                                       | Move behind a Praxis session port                              |
| Document epochs, stale-reference rejection, origin checks, read-only network gate, and one-write commit gate                  | `browser-worker-engine.ts`                                                    | Praxis                                                                       | Move with characterization coverage                            |
| Browser lease, generation, heartbeat, owner replacement, and checkpoint mechanics                                             | Worker engine plus browser execution repository                               | Praxis supplies browser facts; application persists and coordinates          | Split through an explicit port without changing SQL semantics  |
| Protected-value classification, exact and encoded detection, sanitization, and disclosure decisions                           | Classifier, sanitizer, protection authority, worker, and lifecycle repository | Veil                                                                         | Move and remove application-side decision duplication          |
| Key selection, key derivation, authenticated encryption, and decryption                                                       | API keyring and cipher plus runtime evidence and capture stores               | Veil                                                                         | Move cryptographic policy behind Veil; inject storage adapters |
| Capture quarantine, publish-or-discard decision, and plaintext lifetime                                                       | Protected capture vault, worker, and repositories                             | Veil                                                                         | Split confidentiality decision from transactional persistence  |
| Evidence recording, encrypted chain, closure, integrity check, and replay rendering                                           | Authenticated evidence store, recorder, offline renderer, worker              | Chronicle, after Veil admission                                              | Move as one complete evidence lifecycle                        |
| Effect intent, dispatch facts, effect transitions, recovery facts, and evidence summaries                                     | Worker plus command and execution repositories                                | Chronicle owns accepted history; application owns admission and transactions | Define fact ports, retain database transactions                |
| Authentication, workspace scope, Projects, Missions, Objectives, Flows, Runs, command admission, budgets, queues, and reports | API controllers, services, repositories, and schema                           | Application composition                                                      | Retain                                                         |
| Diagnostic and release checks                                                                                                 | Root scripts, package tests, browser tests, deployment checks, and workflows  | Assurance                                                                    | Consolidate only after production boundaries stabilize         |

Two consolidated runtime exports require special treatment:
`effect-ledger.ts` and `browser-owner-supervisor.ts` are statically reachable
through the package index but are not constructed by the deployed worker. The
PostgreSQL repositories own the corresponding active truth. These exports are
duplicate candidates, not sources to transplant.

## State ownership map

| State                                                                                                          | Current authority                     | Current writer                    | Boundary interpretation                                                 |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------- | ----------------------------------------------------------------------- |
| Users, workspaces, memberships, tokens, Projects, Environments, Missions, Objectives, Flows, Runs, and reports | PostgreSQL                            | API repositories                  | Application composition                                                 |
| Browser session, command, outbox, budget, and finalization state                                               | PostgreSQL                            | API and worker repositories       | Application composition, accepting facts from boundaries                |
| Browser owner generations, leases, checkpoints, document and dispatch facts                                    | PostgreSQL plus the live worker lease | Worker repositories               | Praxis facts persisted by application adapters                          |
| Effects and effect events                                                                                      | PostgreSQL                            | Worker repositories               | Chronicle history, with admission controlled by application composition |
| Protected values, capture ciphertext, publication decisions, and public outputs                                | PostgreSQL                            | Worker and lifecycle repositories | Veil decisions persisted atomically by application adapters             |
| Evidence-stream completion summary and chain head                                                              | PostgreSQL                            | Command repository                | Chronicle                                                               |
| Encrypted evidence chunks and filesystem manifest                                                              | Private artifact volume               | Authenticated evidence store      | Chronicle storage, using Veil-protected material                        |
| Rendered sanitized replay and optional video                                                                   | Private artifact volume               | Offline renderer                  | Chronicle artifact storage after Veil admission                         |
| Live browser, page, document epoch, target map, owner heartbeat, recorder, and transient capture plaintext     | Worker memory                         | Current fenced worker             | Praxis, Veil, and Chronicle state separated by responsibility           |
| Session and command jobs                                                                                       | Redis and BullMQ                      | Outbox dispatcher                 | Transport only; PostgreSQL decides whether work exists                  |
| Agent protocol sessions                                                                                        | Agent-integration process memory      | Agent server                      | Non-authoritative connection state                                      |
| Dashboard state                                                                                                | Browser memory                        | Dashboard                         | Non-authoritative presentation state                                    |

PostgreSQL remains the shared durable system of record. The boundary reset does
not require one database per owner. Authority is expressed through ports and
the meaning of accepted facts, while application adapters retain transactions
that span product records.

## Lifecycle traces

### Read-only browser command

1. The API locks the browser session, validates scope and lifecycle, stores the
   command and outbox intent, and assigns its ordinal.
2. The dispatcher publishes a stable queue job identifier.
3. The worker claims the command and current browser-owner lease.
4. Browser interaction runs with a request gate that rejects undeclared writes.
5. The observation is sanitized before becoming a safe command result and
   evidence event.
6. Completion is accepted only for the current command claim.

### Controlled change

1. The application transaction reserves budget and admits one Effect.
2. The worker installs a same-origin gate for the admitted request.
3. Dispatch is persisted before the request is forwarded.
4. Additional writes are blocked.
5. The response becomes an encrypted protected Capture.
6. Veil decisions determine whether selected values become public output or
   protected references.
7. Publication is atomic; a possible post-dispatch loss becomes `unknown` and
   is not automatically repeated.

### Protected capture

Capture plaintext exists only in the worker's transient vault. The durable raw
capture is encrypted in PostgreSQL before local plaintext is cleared. Publish
requires a complete decision set and clears the raw payload only after the
publication transaction commits. Discard clears reusable payload material
without creating output handles.

### Evidence closure

The recorder sanitizes browser events before appending encrypted chained files.
Closure flushes pending events, verifies the filesystem manifest and chain,
renders the sanitized replay, and writes one completed evidence-stream summary
to PostgreSQL. Successful session finalization requires complete evidence.

### Owner recovery

The replacement owner increments the generation and fences the previous lease.
An admitted Effect that did not dispatch becomes `not_applied` and restores
budget. An Effect that may have dispatched becomes `unknown`. An authenticated
checkpoint may restore browser state only when session, origin, and ownership
checks agree.

### Report publication

The lifecycle repository requires terminal objectives and Runs, no pending
Effects, complete evidence summaries, and settled protected Captures. It
sanitizes the report through the protection authority and stores the immutable
Mission report and evidence digest in one transaction.

## Failure map

| Failure boundary                                      | Current observable result                                     | Invariant preserved                         |
| ----------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------- |
| Queue publish fails after product transaction         | Outbox stays pending and is revisited                         | Committed work is not lost                  |
| Command worker loses claim                            | Stale claimant cannot complete                                | One authoritative completion                |
| Browser owner lease is replaced                       | Old generation is fenced                                      | Stale owner cannot write truth              |
| Controlled change fails before dispatch               | Effect becomes `not_applied`; budget returns                  | Safe retry remains possible                 |
| Controlled change may have dispatched                 | Effect becomes `unknown`                                      | External write is not repeated blindly      |
| Read-only operation attempts a write                  | Request is blocked and command fails safely                   | Read-only means no undeclared mutation      |
| Protection cannot classify or sanitize safely         | Operation fails closed                                        | Protected material is not exposed           |
| Partial publication or incomplete decisions           | No partial public output is committed                         | Publication is atomic                       |
| Evidence gap, alteration, or closure failure          | Evidence remains incomplete and successful close is rejected  | Incomplete history is visible               |
| Checkpoint authentication, origin, or ownership fails | Restore is rejected                                           | Corrupt or cross-scope state is not trusted |
| Finalization sees pending or unknown work             | Success is rejected; failure finalization retains uncertainty | Reports do not erase unsettled truth        |
| Required schema capability is missing                 | API, worker, or migration fails before serving work           | Runtime and database remain compatible      |

## Verification inventory and result

The following checks passed against the isolated worktree:

| Verification                                                                                                   | Baseline guarantee                                                            |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Workspace typecheck and build                                                                                  | Reachable applications and packages compose                                   |
| Package tests                                                                                                  | Contracts, browser runtime, API, agent integration, and dashboard behavior    |
| Baseline topology and Playwright checks                                                                        | Only the intended baseline graph and browser installation are admitted        |
| Workflow, container publication, server deployment, deployment-tier, operations, preflight, and runtime checks | Built services and operational manifests agree; Caddy configuration validates |
| Browser-runtime end-to-end test                                                                                | Real Chromium behavior and protected recording work                           |
| Fresh-database repository integration tests                                                                    | Schema, scope, lifecycle, effect, capture, and failure transactions work      |
| Browser command worker integration                                                                             | Durable command execution through a real worker works                         |
| Long browser journey                                                                                           | Repeated commands, evidence closure, and product finalization work together   |
| Worker process recovery integration                                                                            | Lease replacement, checkpoint recovery, and uncertainty behavior work         |
| Failure-finalization integration                                                                               | Failure closure preserves unsettled mutation semantics                        |

The package suites reported 8 contract tests, 44 browser-runtime tests, 15 API
tests, 7 agent-integration tests, and 3 dashboard tests passing; browser- and
database-dependent cases skipped by the ordinary package run were exercised
separately. Isolated database and queue namespaces were required for concurrent
browser suites because shared infrastructure otherwise contaminated pending-job
counts.

The formatting gate currently fails on four pre-existing active files:

- `apps/api/src/browser-execution/browser-schema.ts`;
- `apps/api/test/browser-command.worker.integration.test.ts`;
- `apps/api/test/browser-worker-process-recovery.integration.test.ts`; and
- `packages/contracts/src/browser-lifecycle.ts`.

This is a repository-hygiene failure, not evidence that runtime behavior failed.
It should be corrected as the first mechanical prerequisite so every later
slice can use the complete verification command.

## Baseline gaps and explicit treatment

### Relational evidence rows are inactive

After successful durable-worker and long-journey tests, read-only queries found
a completed evidence-stream row but no evidence-chunk rows, artifact rows, or
browser-action rows. The files, manifest, stream chain head, replay location,
and optional video location exist through the current filesystem and summary
path.

Treatment during relocation: preserve this behavior. Do not populate the
inactive tables merely to make the architecture documents appear true. A later
Chronicle capability may introduce relational chunk or artifact admission only
with an explicit contract, migration, compatibility plan, and verification.

### Production activation cannot be bootstrapped from a fresh database

Production composition enables the activated-cutover requirement by default.
The activation command updates an existing permanent import receipt, but no
reachable baseline command creates that receipt. A retained and already
activated database can start; a fresh production database cannot satisfy this
gate through the documented active interface.

Treatment during relocation: do not weaken startup admission and do not invent
an import flow inside boundary work. Record fresh-production bootstrap as a
separate operational defect requiring an explicit product and data decision.

### Complete verification is not initially green

The full verification command stops at formatting even though behavioral,
database, browser, build, deployment, and runtime checks pass independently.

Treatment before relocation: apply formatting-only corrections to the four
identified files and rerun the full command. No semantic change belongs in that
commit.

## Disposition ledger

| Implementation unit                                                                                                                       | Decision                                                               | Evidence and destination                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Public dashboard, HTTP, and agent contracts                                                                                               | Retain                                                                 | They define the current observable product behavior                                                                                 |
| Product lifecycle, tenancy, authorization, transactions, queues, budgets, and finalization                                                | Retain in application composition                                      | They are active and are not one of the four subsystem authorities                                                                   |
| Browser mechanics inside the worker engine                                                                                                | Move                                                                   | Active Praxis source of truth                                                                                                       |
| Protection authority, classifier, sanitizer, keyring, cipher, and protected capture behavior                                              | Move and split                                                         | Active Veil source of truth, currently spread across runtime and API                                                                |
| Evidence store, recorder, renderer, and accepted execution facts                                                                          | Move and split                                                         | Active Chronicle source of truth, currently mixed with browser and repository concerns                                              |
| SQL repositories                                                                                                                          | Rewrite behind narrow ports while retaining SQL semantics              | Transactions span application records and boundary facts                                                                            |
| Current named Praxis, Veil, and Chronicle package contents                                                                                | Replace selectively                                                    | Not deployed, untested, broader than the baseline; individual ideas require independent proof                                       |
| Current Assurance package contents and scripts                                                                                            | Replace selectively                                                    | Not a production dependency and not exercised by the baseline gates; retained qualifications must be rebuilt around public surfaces |
| Consolidated browser-runtime package                                                                                                      | Delete after consumer cutover                                          | It is the active mixed implementation today and becomes obsolete only after all three production boundaries are proven              |
| Export-only effect ledger and owner supervisor                                                                                            | Delete after negative consumer check                                   | Active PostgreSQL paths already own their behavior                                                                                  |
| Executor, Policy, Observability, Agent Lab, alternate API modules, alternate agent tools, alternate dashboard features, and old contracts | Delete after final static, script, workflow, and test consumer checks  | They are outside the deployed baseline and must not define the reset                                                                |
| Baseline schema tables without active writers                                                                                             | Retain as non-authoritative compatibility structures during relocation | Removing data structures is a separate migration decision                                                                           |

`Replace selectively` does not mean merge old implementations into the new
owners. The default is to build the boundary from the proven active behavior;
an old unit is retained only when its caller, invariant, and production-shaped
verification independently match the baseline.

## Implementation readiness and first slice

All production paths that operate a browser, handle protected values, persist
current evidence, or gate release are now accounted for. Responsibility and
state ownership are sufficiently understood to begin the reset, subject to
preserving the explicit gap treatments above.

The recommended first slice is:

1. make the formatting-only prerequisite green;
2. freeze the current command, observation, dispatch, protection, evidence,
   and diagnostic shapes with characterization tests;
3. create narrow boundary ports and composition adapters without moving
   behavior;
4. add dependency checks that forbid production imports from Assurance and
   forbid direct access to boundary internals; and
5. move the first complete protection behavior only after the unchanged
   end-to-end path passes through the new seam.

This order makes ownership enforceable before files move and keeps each later
change attributable. It does not adopt the contents of the dormant packages,
change public behavior, populate unused tables, or reset durable data.

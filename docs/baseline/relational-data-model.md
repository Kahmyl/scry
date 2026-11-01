# Scry relational data model

Status: canonical baseline relational model

The test-resource capability uses mission-owned `test_resources`, immutable
`test_resource_events` and database-wide `test_provider_limits`. Credentials
and usable access values reuse the existing cipher; raw message copies are not
retained. See [Test resources](test-resources.md) for lifecycle and limits.

The active `browser_execution_sessions` inventory also represents live browser
capacity reservations. Creation is serialized across both entry paths by one
short database transaction lock, with exact replay checked before the capacity
count. The additive live-capacity partial index covers only active Sessions;
historical evidence, owners and attempts are not rewritten. Capacity is released
only by the existing confirmed finalization lifecycle, never by lease expiry alone.

This document describes the PostgreSQL model supporting the
[Scry baseline brief](../product/baseline-brief.md). PostgreSQL is the durable
authority for identity scope, assignment state, execution truth, protected
data, evidence metadata, and reports.

## Relationship overview

```text
app_users ──< workspace_memberships >── workspaces ──< projects
                                                       │
                 ┌─────────────────────────────────────┼───────────────┐
                 ▼                                     ▼               ▼
            environments                          missions     protected_values
                                                       │
                     ┌───────────────┬─────────────────┼───────────────┐
                     ▼               ▼                 ▼               ▼
               agent_sessions  mission_objectives    flows      mission_reports
                                                       │
                                                flow_revisions
                                                       │
                                                       ▼
                                                      runs
                                                       │
                                              browser_execution_sessions
                                                       │
              ┌────────────────┬───────────────────────┼──────────────────┐
              ▼                ▼                       ▼                  ▼
      browser_commands  browser_owner_generations  browser_effects  browser_evidence_streams
                                                       │                  │
                                      ┌────────────────┼─────────┐        ▼
                                      ▼                ▼         ▼  browser_evidence_chunks
                             browser_effect_events  captures  publications
                                                                  │
                                                               outputs
```

## Compatibility and activation

| Table                      | Purpose                                                                   | Important constraints                                                                               |
| -------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `schema_baseline`          | Records the active browser-execution capability and application time.     | Singleton row; readiness is proven from required tables and columns rather than an exact hash.      |
| `identity_import_receipts` | Records rehearsal or permanent identity import and production activation. | Identity digest is unique; only an activated permanent receipt satisfies production startup policy. |

The API and worker verify the required tables and columns, then confirm that
the database admits the browser-execution worker capability. Missing required
capabilities fail closed; unrelated additive schema changes remain acceptable.

Production startup may additionally require an activated permanent receipt.
The active command can activate an existing receipt but does not create the
permanent import receipt needed by a fresh production database. Retained
deployments may already satisfy this precondition; fresh-production bootstrap
is an open operational gap rather than an implicit migration behavior.

Databases retained from the earlier browser rollout cross a one-time,
transactional compatibility bridge. The bridge renames the same stored fields
in place and removes obsolete fingerprint metadata; it does not delete product,
identity, evidence, or encrypted-value rows. Deployment takes a fenced database
backup before the bridge and restores it if candidate activation fails.

## Identity and tenancy tables

| Table                   | Purpose                                                                                   | Keys and relationships                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `app_users`             | Local identity mapped from the external identity provider.                                | Unique external user identifier; unique local primary key.                                |
| `workspaces`            | Tenant boundary for Projects and agent access.                                            | Unique slug.                                                                              |
| `workspace_memberships` | Connects Users to Workspaces with owner, admin, member, or viewer role.                   | Composite primary key of Workspace and User; both parents cascade on deletion.            |
| `mcp_access_tokens`     | Stores agent-token hash, safe prefix, owner, Workspace, expiry, revocation, and last use. | Token hash is unique; belongs to one User and Workspace.                                  |
| `projects`              | Application under test.                                                                   | Name is unique within a Workspace; Workspace deletion is restricted while Projects exist. |

## Assignment tables

| Table                | Purpose                                                            | Keys and relationships                                                                                                                       |
| -------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `missions`           | Complete testing assignment and final-report pointer.              | Belongs to a Project; idempotency key is unique within the Project; terminal state and completion time must agree.                           |
| `agent_sessions`     | Agent identity and instruction snapshot within a Mission.          | Composite foreign key enforces matching Mission and Project; one idempotent session per Mission key.                                         |
| `mission_objectives` | Ordered, independently assessable outcomes.                        | Unique order and idempotency key within a Mission; composite identity preserves Mission and Project agreement.                               |
| `flows`              | Named testing journeys or approaches.                              | Belongs to one Mission and creating Agent session; idempotency key is unique within the Mission.                                             |
| `flow_revisions`     | Immutable Flow definition selected by a Run.                       | Unique revision number within a Flow; partial unique index permits only one active revision.                                                 |
| `runs`               | One execution of a Flow revision for an Objective and Environment. | Composite foreign keys require all referenced resources to share Project and Mission identity; idempotency key is unique within the Mission. |
| `mission_reports`    | Final sanitized Mission report and evidence digest.                | One-to-one with Mission; final state requires finalization time; Mission report pointer is constrained back to the same Mission.             |

### Mission and Run terminal rules

A Mission in `completed`, `failed`, or `cancelled` state must have a completion
time; a non-terminal Mission must not. A Run in `passed`, `failed`, `cancelled`,
or `infrastructure_error` state must have both a completion time and outcome
classification; a non-terminal Run must not.

The additive attempt-conclusions migration adds nullable `runs.conclusion`.
New finalizations persist a sanitized per-attempt conclusion in the same
transaction as terminal state. Terminal replay cannot replace it. Historical
nulls remain null; there is no speculative backfill from Objective summaries.
Starting another attempt resets the Objective's current assessment to running,
without changing older Run conclusions. Sibling finalizations serialize on the
Objective before checking whether another attempt remains active.

## Browser-session and queue tables

| Table                         | Purpose                                                                                                                                                   | Keys and relationships                                                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `browser_execution_sessions`  | One protected Browser session for a Run, including policy snapshot, budgets, owner generation, checkpoint lifecycle, and disclosure mode.                 | One row per Run; composite foreign keys bind Run, Project, Mission, Objective, Environment, and Agent session. Used counts cannot exceed configured budgets. |
| `browser_execution_outbox`    | Durable intent to start a Browser session.                                                                                                                | One row per Browser session; remains pending until queue publication succeeds.                                                                               |
| `browser_commands`            | Ordered agent commands, safe input and result, encrypted sensitive command input, claim lease, and failure code.                                          | Unique ordinal and idempotency key within a Browser session; command and Run must refer to the same Browser session scope.                                   |
| `browser_command_outbox`      | Durable intent to execute a command.                                                                                                                      | One row per command; publication attempts and last error are retained.                                                                                       |
| `browser_owner_generations`   | Fenced lease history for Browser-session owners.                                                                                                          | Composite primary key of session and generation; only one active owner per session.                                                                          |
| `browser_session_checkpoints` | Encrypted resumable browser state.                                                                                                                        | One row per Browser session; bound to Run, Project, Mission, and owner generation.                                                                           |
| `browser_actions`             | Reserved schema for ordered safe audit entries. The active baseline derives its safe action ledger from `browser_commands` and does not write this table. | Unique action ordinal within a Browser session; references the owner generation that executed it.                                                            |

### Command consistency

Completed commands require a safe result. Failed commands require a safe error
code. A running command requires both a claim token and an unexpired claim
lease. Sensitive fill input is stored only when ciphertext, nonce,
authentication tag, digest, and key identifier are all present together.

## Controlled-change tables

| Table                          | Purpose                                                      | Keys and relationships                                                                                                   |
| ------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `browser_effects`              | Authoritative truth for one controlled mutation.             | Unique ordinal and idempotency key within a Browser session; bound to owner generation and complete Run scope.           |
| `browser_effect_events`        | Ordered transition ledger for an Effect.                     | Composite primary key of Effect and sequence; cascades with the Effect.                                                  |
| `browser_captures`             | Encrypted HTTP response or operation-owned document capture. | Belongs to one Effect and Browser session; object key is unique; durable captures expire and must be settled.            |
| `browser_protection_decisions` | Field-level public or protected decision and allowed sinks.  | Unique path, canonical name, and decision digest within a Capture; public decisions require complete trusted provenance. |
| `browser_publications`         | Atomic settlement record for selected Capture output.        | One Publication per Capture; binds selection digest and decision-set digest.                                             |
| `browser_outputs`              | Published public value or protected-value reference.         | Unique canonical name within an Effect; exactly one of public value and protected reference is present.                  |

### Effect consistency

The database enforces these facts:

- published output requires a durable Capture;
- a durable Capture requires an acknowledged dispatch;
- an applied mutation requires acknowledged dispatch;
- an unknown outcome requires dispatch to have started;
- terminal mutation outcomes require determination source and terminal time;
- a public Output requires a public protection decision; and
- a protected Output requires an encrypted Protected value.

## Protected-value tables

| Table                              | Purpose                                                              | Keys and relationships                                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protected_values`                 | Encrypted user inputs and generated protected outputs.               | Belongs to a Project and, for generated values, a Mission, Run, and source Effect; external reference and idempotency key are unique within the Project. |
| `browser_session_protected_inputs` | Explicit binding between a Browser session and selected user inputs. | Composite primary key of Browser session and Protected value; composite Project keys prevent cross-Project binding.                                      |

Protected-value lifecycle states are `active`, `revoked`, `expired`,
`compromised`, and `deleted`. A deleted value must carry a deletion time.
Generated values require source Effect lineage; user inputs do not.

## Evidence and artifact tables

| Table                      | Purpose                                                                                                                                                                                                                     | Keys and relationships                                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `browser_evidence_streams` | Completion and integrity summary for one Browser session recording.                                                                                                                                                         | One stream per Browser session; complete state requires completion time, chain head, and at least one chunk.                         |
| `browser_evidence_chunks`  | Reserved relational metadata for ordered encrypted evidence segments. The active baseline stores this metadata in the filesystem manifest and does not write this table.                                                    | Composite primary key of stream and chunk index; object key and digest are unique; every noninitial chunk references a prior digest. |
| `artifacts`                | Reserved relational metadata for Run-associated recordings, videos, screenshots, traces, or report attachments. The active baseline stores replay and video locations on the evidence stream and does not write this table. | Object key is unique; each row carries a digest and safe metadata.                                                                   |

The presence of these reserved tables does not make them current runtime
authorities. Adding writers or moving their metadata into PostgreSQL is a
separate capability change, not part of behavior-preserving boundary
relocation.

## Idempotency boundaries

Idempotency is enforced at the aggregate that owns the write:

| Aggregate             | Scope             |
| --------------------- | ----------------- |
| Environment           | Project           |
| Mission               | Project           |
| Objective             | Mission           |
| Flow                  | Mission           |
| Run                   | Mission           |
| Browser session       | Run               |
| Command               | Browser session   |
| Effect                | Browser session   |
| Saved protected input | Project           |
| Report                | Mission singleton |

Idempotent replay must return the existing identity only when the material
request fields match. A reused key with different intent is a conflict.

## Planned data ownership across boundaries

PostgreSQL remains the shared durable system of record during the boundary
reset. Responsibility is assigned by the meaning of a fact, not by creating a
database for every package:

- application composition owns tenancy, product lifecycle, admission,
  idempotency, budgets, queue, and transactional projection records;
- Praxis supplies fenced browser ownership, document, action, and dispatch
  facts;
- Veil supplies protection, disclosure, cryptographic, and capture-settlement
  decisions;
- Chronicle owns append-only execution history, evidence metadata, artifact
  identity, provenance, integrity, and completeness; and
- Assurance reads safe facts and may persist derived diagnostic or
  qualification records, but cannot update the underlying runtime facts.

Repositories and transactions may persist facts on behalf of these owners
through explicit ports. They must not recompute another owner's decision. The
reset does not require table movement merely to demonstrate package ownership;
schema changes are made only when a domain invariant or access boundary needs
them.

## Deletion and retention behavior

Workspace membership and tokens cascade with their Workspace. Mission-owned
planning and execution records generally cascade with the Mission. References
whose removal would destroy evidence lineage or historical identity use
restricted deletion.

Evidence streams carry a retention deadline. Durable Captures carry an expiry
deadline and are indexed for cleanup. Protected values may expire independently.
A published or discarded Capture has its raw encrypted payload and structural
index cleared while its safe settlement record remains.

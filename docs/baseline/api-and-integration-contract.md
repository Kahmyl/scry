# Scry API and integration contract

Status: canonical baseline contract

## Live browser capacity

Both supported session-creation paths share database-wide admission. A Session
reserves capacity from creation through startup, between commands, and until its
normal or recovered finalization completes. Losing an owner lease, finishing a
queue job, or marking a Run terminal does not by itself release that reservation.
Existing commands and finalization remain available when capacity is full.

`SCRY_BROWSER_MAX_LIVE_SESSIONS` defaults to `1`; all API/worker replicas serving
the same database must use the same setting. A new start at capacity returns
`SCRY_BROWSER_SESSION_CAPACITY_EXHAUSTED` with HTTP 503 and plain-English next
actions, before launching another browser or dispatching application work. Exact
retries of admitted starts return their existing Session even at capacity. A
refused start can be retried with the same identity after capacity is available.
There is no new mission-duration cutoff, automatic business-action replay, or
app-specific limit. Capacity refusal is not an application defect.

The qualified baseline has one browser-owning worker. Admission is not a
distributed worker-routing scheduler; increasing this limit requires measured
resource qualification and does not establish multi-worker routing support.

This document defines the external operations for the product described in the
[Scry baseline brief](../product/baseline-brief.md). It describes product
behavior and resource identity without adopting temporary labels from source
code as permanent product language.

## Contract principles

- All product operations except health checks require authentication.
- Every resource read or write is scoped to an authenticated workspace.
- Caller-supplied idempotency keys identify retryable creation and command
  intent.
- Conflicting reuse of an idempotency key is rejected.
- Protected values are represented by opaque identifiers and safe metadata.
- Browser work is asynchronous even when an integration waits briefly for a
  command result.
- Unknown mutation truth is returned honestly and is never converted into
  permission to retry.
- The API is the policy boundary. The dashboard and agent integration cannot
  bypass it.

## Transport conventions

The dashboard and internal integrations use JSON over HTTPS. Authentication is
sent as a bearer token. Successful responses return the requested resource or
operation result. Creation operations return stable resource identifiers that
can be used for later reads.

Request bodies are validated before domain work begins. Identifiers are opaque;
callers must not derive workspace, Project, or lifecycle meaning from their
shape.

The route names below are the canonical baseline resource map. Transitional
transport aliases found in implementation source are not part of this product
contract.

## Native evidence reads

`GET /api/runs/{runId}/media` lists safe descriptors for admitted native recordings
and screenshots, plus the best-effort redaction warning. Already admitted
screenshots are readable during an active Run; an open stream is read from a
short-transaction immutable metadata snapshot, not from unadmitted files.
`GET /api/runs/{runId}/media/{index}` returns verified private image or video bytes.
PNG, JPEG, WebP, WebM and MP4 are supported without rewriting historical media.
Descriptors include an artifact digest and optional complete/partial recording
coverage; no secret, browser connection endpoint or filesystem path is returned.
Both use the existing bearer authentication and workspace-scoped Run access.
Descriptors contain no filesystem paths. Media responses are private/no-store.
Historical evidence is not rewritten or presented as newly captured media.

## Controlled browser-adapter integration

The isolated candidate adds the official browser tools alongside the existing
Mission/Flow/Run lifecycle, not another API or ownership system. It remains
inactive by default. A Run snapshots its adapter and cannot switch adapters
later; commands from the other adapter are rejected without fallback.

The candidate's browser tools accept the Run's `browserSessionId` and a stable
`actionId` for one intended interaction. Ordinary arguments are encrypted in the
existing durable command record. The worker records dispatch uncertainty before
calling the browser and saves the returned action result before independent
observation. An unavailable later observation does not erase that result. A
reclaimed interaction is reconciled from its receipt or returned as unknown;
it is never automatically redispatched.

The scoped `browser_type_secret` tool types a bound opaque credential reference.
Arbitrary evaluation, scripts, file upload, browser installation, filesystem
paths and network/header dumps are not part of this surface. Native screenshot
image responses are retrieved through the same authorized media API.

Browser-tool completion is not proof of an applied business change. The agent
must inspect the resulting application state. These receipts support agent
recovery; they are not customer report results. The dashboard does not show raw
tool diagnostics.

The journey-reliability candidate adds `browser_edit_text` with an observed
opaque target reference, explicit `replace` or `insert` intent, and a selected
native `paste` or `keyboard` method. It does not run app-private editor APIs or
automatically try another input after possible dispatch. Input observations are
`observed`, `mismatch`, `unverified`, `not_dispatched`, or `unknown`; even matching
readback does not establish saved application state. A new snapshot or explicit
business readback is the recovery path, not blind replay. Ordinary Playwright
typing keeps its existing semantics, including insertion for sequential typing.

The MCP `start_run` tool accepts an optional `attemptId`. A new identity creates
a deliberate new attempt within the same Flow; reusing it retrieves the same
start request. Older clients that omit it retain their existing idempotent
behavior. This is distinct from a browser command's `actionId`.

Native screenshots accept optional `evidenceTitle` and `evidenceDescription`.
These are bounded, sanitized presentation data attached to Chronicle's admitted
receipt, not claims that Scry automatically verified the described outcome.
Media descriptors may include these fields and complete/partial coverage, but
not internal interruption diagnostics.

Customer reports supply `safeReport.presentation` with `subject: application`,
`scope`, `checks` (title, optional expectation, actual observation, status and
exact Run/artifact references), application `observations` and `limitations`.
Check status is `matched_expectation`, `different_from_expectation`,
`inconclusive` or `not_tested`; comparisons require an explicit app expectation.
Execution errors and capability qualifications do not belong in these checks.

The MCP initialization instructions and `publish_mission_report` tool description
carry the same self-contained reporting guidance for both supported profiles.
External agents receive the application-report shape through `tools/list`, not
only prose or context from a prior chat. The instructions include a valid format
example, explain recovery without uncertain-write replay, distinguish app-check
coverage from recording coverage, and require honest untested/inconclusive scope.
They do not authorize operator access or assume familiarity with Scry internals.

Legacy publication input remains accepted for compatibility, but unclassified
historical data is not automatically promoted into customer findings. A report
links the Mission's existing authorized evidence; it does not manufacture or
duplicate artifacts. A missing reference is shown as unavailable, never silently
replaced with a different screenshot.

`GET /api/reports/{reportId}` and the project report list return allowlisted
customer projections. Unknown/raw payload keys and technical digests are omitted.
`GET /api/dashboard/missions/{missionId}` returns customer journey history without
execution conclusions; the agent's existing Mission observation contract is
unchanged. Customer Run reads describe progress and recording availability,
not application pass/fail. Owner generation remains available for command
recovery, but is not presented as a customer result.

`GET /api/operator/reports/{reportId}` and `GET /api/operator/runs/{runId}` expose
original safe records only to the existing internal service principal. Customer
workspace owner/admin status and MCP credentials do not grant operator access.
These routes are private/no-store. No new customer-admin role or public log
viewer is introduced.

See the local [controlled integration record](../../experiments/journey-reliability/INTEGRATION.md)
for the activation gate and qualification results.

## Health

### Read service health

`GET /api/health`

Returns service readiness without requiring authentication. It must not expose
secrets, user data, or protected operational detail.

## Projects and Environments

### List Projects

`GET /api/projects`

Returns Projects visible to the caller's workspace.

### Create a Project

`POST /api/projects`

Creates a Project in the caller's workspace. This is restricted to a signed-in
human owner or admin. Agent and service credentials cannot create Projects.

### List or create Environments

`GET /api/projects/{projectId}/environments`

`POST /api/projects/{projectId}/environments`

An Environment declares the first-party application origin, optional service
origins, active state, and disclosure mode. Viewers may read but cannot create
Environments.

## Protected inputs

### List or create protected inputs

`GET /api/projects/{projectId}/protected-inputs`

`POST /api/projects/{projectId}/protected-inputs`

Listing returns safe metadata only. Creation accepts plaintext over an
authenticated encrypted connection, stores encrypted material, and returns an
opaque reference. The plaintext is not returned later.

### Bind protected inputs to a Run

`POST /api/runs/{runId}/protected-inputs`

Binds explicitly selected Project inputs to an active Run. Each input must
belong to the same Project. Display-name matching is not authorization.

## Missions, Objectives, and Flows

### Start a Mission

`POST /api/missions`

Creates the assignment, links it to a Project and agent session, and records the
user's instruction. The operation is idempotent within the owning agent
session.

### Read or list Missions

`GET /api/missions/{missionId}`

`GET /api/projects/{projectId}/missions`

Returns workspace-scoped Mission state and its related execution summary.

### Create an Objective

`POST /api/missions/{missionId}/objectives`

Creates an expected outcome under a Mission. An Objective becomes terminal only
through Run finalization and explicit outcome handling.

### Create a Flow

`POST /api/missions/{missionId}/flows`

Stores a named journey or approach. The stored definition organizes Runs; Scry
does not automatically execute it as a test script.

## Runs

### Start a Run

`POST /api/runs`

Requires a Project, Mission, Objective, Flow revision, Environment, agent
session, mutation budgets, and optional protected-input selections. On success,
Scry atomically creates the Run, creates its Browser session, snapshots policy,
binds selected protected inputs, and schedules browser ownership.

Each terminal Run retains its own sanitized conclusion. Starting a follow-up
attempt returns its Objective to `running`; the Objective stays running while
any sibling attempt is active. Finalization does not erase earlier attempt
conclusions. Historical Runs without a separately stored conclusion stay empty;
the migration does not attribute an Objective's later conclusion to old attempts.

### Read or list Runs

`GET /api/runs/{runId}`

`GET /api/projects/{projectId}/runs`

Returns lifecycle state, outcome, Browser-session state, command history,
effects, captures, evidence summary, and other safe review data. Protected
plaintext is excluded.

### Finalize a Run

`POST /api/runs/{runId}/finalize`

Records a terminal classification of `passed`, `application_failure`,
`environment_failure`, `blocked`, or `cancelled`. Successful closure requires
settled effects, settled captures, and complete evidence. Failure closure may
retain a post-dispatch effect as `unknown`, but cannot omit unsettled capture or
evidence work.

## Browser commands

### Submit a command

`POST /api/browser-sessions/{sessionId}/commands`

Accepts one supported command with an idempotency key and the expected session
state. Supported commands are:

- navigate;
- observe;
- fill;
- click;
- press;
- capture document state;
- perform a controlled change;
- publish a protected capture;
- discard a protected capture;
- determine a mutation outcome;
- close successfully; and
- close for failure.

Command admission assigns a durable ordinal and schedules execution. Sensitive
fill material is encrypted separately from the safe command representation.

### Read a command

`GET /api/browser-commands/{commandId}`

Returns queued, claimed, completed, or failed state and the safe result when
available. Re-reading is the supported way to follow work that outlasts an
integration request.

## Reports

### Publish a Mission report

`POST /api/missions/{missionId}/report`

Requires every Objective and Run to be terminal, no pending mutation, and
at least one complete evidence head or sealed, admitted partial evidence head.
A failure report does not require an unrelated successful recording. Partial,
missing and unavailable coverage remain explicit; publication never marks those
attempts or recordings complete. Unsealed or corrupt partial evidence cannot
anchor a report. Scry sanitizes the supplied report, derives its Mission
evidence digest, stores one final report, and completes the Mission and agent
session atomically.

### Read or list reports

`GET /api/reports/{reportId}`

`GET /api/projects/{projectId}/reports`

Returns the sanitized report and its evidence relationship within the caller's
workspace.

## Agent access tokens

### List, create, or revoke tokens

`GET /api/mcp-tokens`

`POST /api/mcp-tokens`

`DELETE /api/mcp-tokens/{tokenId}`

Token creation is a signed-in human operation. Plaintext is displayed once;
only a digest, safe prefix, scope, expiry, and revocation state remain stored.
A revoked or expired token cannot start or continue an agent protocol session.

## Agent integration

The Model Context Protocol endpoint is:

`POST /mcp`

It requires an agent access token. A protocol session is bound to the digest of
the token that created it, so a different credential cannot take over an
existing session.

The integration exposes these logical operations:

- list Projects, Environments, protected inputs, Missions, and Runs;
- create an Environment or protected input where policy permits;
- start a Mission;
- create an Objective or Flow;
- start a Run and bind protected inputs;
- read Mission and Run state;
- submit and read Browser commands;
- finalize a Run; and
- publish a Mission report.

Logical operation names describe capability, not a promise about a particular
source-code function name. Every operation delegates to the authenticated HTTP
API and receives the same scope and policy enforcement.

## Internal boundary contract

The public HTTP and agent contracts remain stable while the implementation is
reorganized. Internally, application composition will use narrow ports:

- Praxis accepts admitted browser work and returns browser and dispatch facts;
- Veil accepts material requiring protection and returns authoritative safe,
  protected, publishable, or rejected decisions;
- Chronicle accepts admitted facts and evidence and returns durable identities,
  completeness, and safe review projections; and
- Assurance consumes public interfaces and safe read models for diagnosis and
  qualification, never for synchronous command execution.

These ports expose data and results, not another subsystem's engine, keyring,
repository, or mutable state. Internal relocation must not weaken workspace
scope, idempotency, error safety, mutation uncertainty, or public compatibility.

## Error contract

Expected domain errors use an appropriate HTTP status and a safe structured
body containing:

- a stable error code;
- a human-readable safe message when available; and
- safe next actions when the caller can recover.

Common meanings include:

- `401`: missing, invalid, expired, or revoked authentication;
- `403`: valid identity without permission for the operation;
- `404`: resource unavailable within the caller's scope;
- `409`: lifecycle, idempotency, ownership, or unresolved-effect conflict;
- `422`: structurally valid request that violates domain requirements; and
- `503`: required execution or storage capability is unavailable.

Unexpected failures return a generic internal error. Database text,
cryptographic detail, stack traces, secrets, and protected values must not cross
the boundary.

## Compatibility rules

Additive response fields are permitted. Callers must ignore fields they do not
understand. Removing fields, changing their meaning, weakening an invariant, or
changing retry semantics requires an intentional contract migration.

Aliases may exist during implementation cleanup, but documentation, dashboard
behavior, agent guidance, and new integrations must use the baseline resource
and operation language defined here.

# Scry four-boundary reset progress

Status: all four boundary cutovers locally qualified; final cleanup is next

The current baseline remains the authority for behavior, public contracts, and
durable data. This record tracks implementation of the
[four-boundary plan](four-boundary-implementation-plan.md).

## Completed and remaining work

| Workstream                              | State                                                                                                           |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Baseline research                       | Complete; reachability, state, failure, verification, and disposition recorded                                  |
| Initial contracts and composition seams | Complete; the worker uses the Praxis execution port and report persistence uses the Veil report-protection port |
| Veil protection ownership               | Complete; active baseline consumers use the extracted Veil implementation                                       |
| Chronicle evidence ownership            | Complete; recording and publication now consume owner-locked admission                                          |
| Praxis browser ownership                | Complete; active browser mechanics, lifecycle, and local lease revocation belong to Praxis                      |
| Assurance diagnostics and qualification | Complete; shared profiles, safe reports, public fixtures, and read-only diagnostic interpretation               |
| Final cleanup and completion proof      | Pending                                                                                                         |

## Veil ownership

The production API composes `@scry/veil` protection capabilities for browser
and evidence adapters. Veil owns:

- sensitive-value classification, exact and encoded matching, and lineage;
- observation, replay, and report sanitization;
- error representations used for public replies, finalization, and stored
  command failures;
- protected command masking and safe DOM semantic hints;
- protected capture quarantine, publication, discard, expiry, and recovery;
- validation of publication decision completeness, captured paths, values,
  allowed sinks, and trusted disclosure;
- recording input masks, blocked surfaces, and privacy options;
- protected key selection, key derivation, and historical configuration reads;
- protected-value encryption and decryption; and
- evidence encryption and authenticated historical reads.

The API retains product admission, scope validation, database locking,
transactions, and lifecycle coordination. Its cipher and report-protection
adapters delegate to Veil. Browser mechanics now live in Praxis; Chronicle owns
recording custody and closure.

Evidence ordering, compression for storage, manifests, chain validation,
retention, and replay rendering remain outside Veil. The evidence cipher
protects the existing compressed payload format while the evidence store
continues to own the chain and filesystem manifest.

No schema migration or data reset is required. Existing key identifiers,
derivation contexts, authenticated metadata, encrypted-value records, capture
envelopes, and evidence records keep their existing representations. Historical
read compatibility remains covered by tests.

## Removed implementations

The ten dormant Veil modules have been replaced by the active baseline's
protection implementation. The classifier, sanitizer, protection authority,
capture vault, and keyring no longer have implementations in their former
runtime or API locations. An unused browser-sanitizer source generator was also
removed after confirming it had no callers. These removals are recoverable
from Git history.

Dormant consumers of the retired Veil API are outside the production baseline.
They remain excluded from deployment and are scheduled for the later
reachability-led cleanup; compatibility facades were not added for them.

## Verification

The relocated tests retain the baseline's privacy and capture cases. Additional
checks cover publication admission and authenticated value context.

| Check                                        | Result                                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Complete repository verification             | Pass: formatting, types, 82 ordinary tests, build, topology, workflows, publication policy, and deployment-controller behavior |
| Veil suite                                   | 43 tests pass, including quarantine, failed publication, discard, tampering, expiry, and historical-key reads                  |
| Ownership-rule negative tests                | Pass: cryptographic implementations outside Veil, internal imports, and production Assurance dependencies are rejected         |
| Database lifecycle and failure integration   | 13 tests pass on a fresh isolated database                                                                                     |
| Real-browser recording and replay            | 2 tests pass                                                                                                                   |
| Durable worker journey                       | 1 test passes through the production composition seam                                                                          |
| Failure finalization                         | 1 test passes while preserving uncertain mutation outcomes                                                                     |
| Worker process recovery                      | 3 tests pass                                                                                                                   |
| Long browser journey                         | 1 test passes through evidence closure and replay                                                                              |
| Production dependency image and import smoke | Pass: Veil, API adapters, and the evidence store load without development tools or Assurance                                   |

The API typecheck now enumerates the active authentication files. Its previous
glob pulled in a dormant authentication module and the old observability
implementation on a fresh dependency installation. The active authentication
path and its scope tests remain covered.

Container definitions now install and copy Veil in the production image, and
development sync includes Veil changes. Browser qualification explicitly enables
the real-browser recording cases. `pnpm verify:boundary-runtime` repeats the
production dependency build and import smoke and is required by fast
qualification. This proves production package availability; it is not a
deployment to a running environment. The known fresh-production activation gap
and inactive relational evidence tables recorded by baseline research remain
separate from this relocation.

## Protection correction found during the consumer audit

The structural relocation was committed separately from one confirmed
confidentiality correction. Browser observations previously sanitized the URL
and page text but returned the page title directly. A real-browser regression
put a known protected credential in the title and reproduced its disclosure
through a completed durable command.

The observation now passes the title through the same Veil policy used for
other observation text. The regression verifies that ordinary title text
remains readable while the credential is removed. The database qualification
lane runs this durable-worker journey with Chromium, Redis, and its own fresh
database. This is an intentional correction to the previous observable
behavior, with no new protection policy or data format.

## Chronicle ownership

Chronicle now owns the active baseline's evidence chain and manifest, ordered
recording queue, recording diagnostics, completeness checks, session evidence
closure, replay plan and publication, safe action ledger, accepted effect-event
history, encrypted capture custody, Run review projections, and Mission evidence
digest. Capture registration, publication settlement, and discard storage use
the application's existing transaction client; product locks, owner checks,
budget accounting, output admission, and Run lifecycle remain in the application.
Veil still owns quarantine and disclosure authorization.

Chronicle accepts encryption and recording-protection capabilities supplied by
Veil through composition. It receives no master keys and does not import Veil,
Playwright, a database driver, application code, or Assurance. Browser attachment,
rrweb execution, frame capture, network blocking, and video recording remain in
browser-runtime adapters for the Praxis move. Chronicle controls what is
published; the browser adapter performs the render plan.

No schema or persisted format changed. Filesystem chunks and manifests plus the
PostgreSQL stream summary remain authoritative; inactive relational chunk and
artifact tables were not activated. Retention timestamps, capture expiry checks,
envelope deletion on settlement, and replay staging cleanup keep their baseline
semantics. No new retention scheduler or cloud storage provider was introduced.

The dormant Chronicle implementation and unused cloud-storage dependencies were
removed. The export-only runtime effect ledger and owner supervisor, with no
production callers, were also removed together with their five duplicate-model
tests. Their removal and all displaced source are recoverable from Git history.
The three active evidence-store characterizations moved into Chronicle.

Dormant application consumers of the retired Chronicle API remain outside the
production graph, like the retired Veil consumers. They are scheduled for the
reachability-led cleanup, without compatibility facades or production imports.

### Chronicle verification

- Chronicle has 19 passing tests: historical reads, restart, tampering,
  competing continuation, missing/duplicate/reordered chunks, scope mismatch,
  receipt-order protection snapshots, diagnostics, closure, failed replay
  publication and retry, safe ledger projection, and Mission digest binding.
- The retained database integration suite passes 13 tests, including stale-owner
  capture rejection, transaction rollback, publication, discard, scope isolation,
  and failure truth. Added assertions prove repeated capture delivery adds no
  duplicate history and conflicting capture identity is rejected.
- Both real-Chromium recording/replay tests pass, including protection before
  durability, zero-network replay, and publication reuse.
- Worker journey, failure finalization, process recovery, and long journey pass
  six tests across four fresh isolated databases.
- Types, ordinary tests, web build, topology, negative ownership checks,
  workflow validation, and deployment checks pass. The production dependency
  image loads Chronicle, Veil, and browser adapters without development tooling
  or Assurance. `pnpm verify:boundary-runtime` replaces the Veil-only smoke and
  remains required in fast qualification.

At the Chronicle cutover, the ordinary suite passed 93 tests. The production dependency smoke also
records a Veil-protected event, seals it through Chronicle, and verifies the
authenticated restart read under Node 22.

This is local production-shaped qualification, not a deployment. Filesystem
sequence conflict checks remain separate from the application's database owner
generation checks; the move does not introduce a new browser lease protocol.
That audit identified an additional baseline limitation: stream-summary
completion retains `ON CONFLICT(session_id) DO NOTHING` and does not independently
revalidate owner generation. Recording-file sequencing likewise does not
authenticate a browser lease. The stale-owner capture test proves capture and
effect fencing, not stale-owner recording or stream closure. Those latter
guarantees were carried into the Praxis ownership seam and corrected separately
below. The overall reset still has Assurance and final cleanup work remaining.
Existing activation bootstrap and inactive-table gaps remain deferred as recorded
by baseline research.

## Praxis structural cutover

The active browser engine, recorder attachment, and replay browser adapter now
live in `@scry/praxis`. Its only runtime dependencies are contracts, Playwright,
and rrweb. Application composition supplies command/admission persistence,
Veil browser-protection capabilities, and Chronicle evidence management through
ports. Browser storage-state capture/restore stays in Praxis; the application
retains encrypted checkpoint persistence and scope validation.

The dormant Praxis implementation (including unused OCR and policy dependencies)
and the displaced browser-runtime package were removed after consumer cutover.
They remain recoverable in Git. Production manifests, container inputs,
development synchronization, and qualification commands now select Praxis.
Public browser commands, data formats, mutation budgets, and report behavior
remain unchanged by this structural step. Types, 93 ordinary tests, real-browser
recording/replay, and the durable worker journey pass through the new composition.
This relocation does not by itself close the ownership limitation above; the
intentional correction is a separate change.

## Praxis ownership correction

The structural move is commit `5df9a66`. The following intentional correction
is separate: the baseline ignored heartbeat failures, allowed recording writes
without lease admission, and completed streams without independently checking
the current owner. A living replaced browser could successfully close; buffered
recording and a render finishing after replacement could still be published.
All three paths were reproduced as failing regressions before repair.

The correction reuses the existing PostgreSQL owner identity and session lock:

- Praxis owns the local browser lease lifecycle. Any failed ownership check or
  heartbeat permanently revokes that browser instance and closes its resources;
  a later database recovery cannot re-admit its buffered work.
- The application validates active session, generation, lease token, and expiry,
  and holds its session/owner locks across each short admitted storage operation.
  Replacement claims use the same session lock. A write admitted before
  replacement completes as the existing prefix; a later admission is rejected.
- Chronicle requires admission for initialization/orphan recovery, durable
  chunk flush, safe ledger writing, and replay publication. Rendering runs
  outside database locks; its publication is separately rechecked.
- Stream completion uses the same locked transaction and verifies both session
  and Run identity. A stale owner cannot bypass fencing through an idempotent
  completion retry.
- Recorder detachment stops new input before the final queue flush. Chronicle
  checks diagnostics again when sealing. Replay browsers close on setup failures.
- Heartbeats remain active through rendering and stop only after closure or
  revocation. Product-state refusals (unresolved outcomes or captures) preserve
  the owned browser so the agent can settle them and retry close.

A heartbeat-only repair would leave the durable-write race open. A new lease
system or storage format was unnecessary; the bounded correction extends the
existing authority rather than adding a second one. No schema or persisted
format changed, no new mutation retry was added, and no old evidence was reset.
Filesystem and PostgreSQL are still not one atomic store: a crash may leave
authenticated orphan chunks, which retain the existing reconciliation behavior.
The correction gates admission, not rollback of already-admitted external work.

### Praxis verification

| Check                                                                    | Result                                                                                                                                |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary suite                                                           | 105 tests pass, including 10 Praxis lifecycle tests and 21 Chronicle tests                                                            |
| Database lifecycle, failure truth, privacy, and scope                    | 13 tests pass                                                                                                                         |
| Live owner and evidence admission                                        | 5 tests pass: living replacement, expiry, exact scope/token, buffered continuation, and replacement/write serialization               |
| Browser recording and offline replay                                     | 2 real-Chromium tests pass                                                                                                            |
| Durable worker, failure finalization, process recovery, and long journey | 6 tests pass across fresh isolated databases                                                                                          |
| Migration                                                                | Fresh creation and second-run idempotence pass; no new migration                                                                      |
| Production dependencies                                                  | Node 22 import, protected recording, closure, and authenticated restart read pass without development tools or Assurance              |
| Repository and deployment                                                | Types, formatting, web build, six negative ownership checks, topology, workflow, publication, deployment, and operational checks pass |

The retained worker journey caught a refused-close regression during repair;
the browser-preserving refusal behavior was restored and independently tested
before the journey passed. CI now runs the live owner-admission suite against
its own fresh database in the database qualification lane.

This is local production-shaped proof, not a deployment. When rolling out,
drain/stop old workers before switching to the corrected worker set: an old
binary does not acquire the new storage-admission gate. Existing activation
bootstrap and inactive relational evidence-table limitations remain deferred.

## Assurance diagnostic cutover

The dormant Assurance labs, numbered campaigns, alternate runtime experiments,
and obsolete qualification scripts were removed, not adopted as product
authority. They remain recoverable in Git. The active repository and deployment
gates now live in `packages/assurance/gates`; the unchanged protected
recording/replay fixture moved from Praxis to Assurance and consumes public
Praxis, Veil, and Chronicle entry points. Owner-local component and transaction
characterizations remain beside their implementations. Assurance invokes them
as processes rather than importing application internals or a database driver.

The shared check catalog drives `pnpm verify`, `pnpm qualify <profile>`, and the
three reusable CI qualification lanes. Reports under `artifacts/assurance/`
retain selected IDs, guarantees, outcomes, timestamps, durations, and safe test
counts. They exclude raw logs, exception text, environment values, and captured
payloads. No report overwrites a previous invocation. Reports are diagnostic
only: they neither rewrite Chronicle facts nor grant product/release admission.
The pure recording/evidence diagnostic functions return fixed informational or
warning codes without copying raw messages or concluding the application is
defective. This does not introduce visual analysis, performance coverage, or a
production observability service.

Missing scope blocks execution; failed checks stop later checks. Required test
profiles enforce minimum passing cases and reject unexpected skips, incomplete
or missing reports, timeout, cancellation, and bounded-output violations.
Ordinary profiles explicitly retain integration skip counts, not integration
coverage claims. A real database-profile run exposed an environment-selection
bug that skipped all 13 tests; the runner refused a pass. A failing regression
was preserved, effective environment validation was corrected, and the original
database profile passed all 13 cases afterward. The failed diagnostic report
was retained alongside the successful rerun.

Production deployment preflight and deployment/backup/recovery operations remain
outside Assurance. Production import and authenticated evidence-reopen smoke
tests still pass without Assurance or development dependencies. The opt-in
isolated backup/restore drill remains separate from routine verification.

### Assurance verification

| Check                                 | Result                                                                                                                                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary characterization             | 137 tests pass, including 32 Assurance tests; integration skips are explicit                                                                                                                                                 |
| Required browser/database journeys    | 26 tests pass without skips: recording/replay 2, lifecycle 13, worker 1, owner admission 5, failure finalization 1, process recovery 3, long journey 1                                                                       |
| Runner failures and diagnostic safety | Missing/malformed counters, insufficient tests, skips, pending/error states, nonzero exits, process timeout/cancellation/output limits, fail-fast behavior, scope refusal, immutable reports, and raw-message exclusion pass |
| Ownership                             | Seven negative boundary tests and production/fixture dependency scans pass                                                                                                                                                   |
| Migration                             | Fresh creation and second-run idempotence pass; no schema/data migration introduced                                                                                                                                          |
| Repository and deployment             | Types, formatting, web build, workflows, publication, deployment-controller refusal/rollback, real Caddy, tiers, operations, preflight, and production-only dependency checks pass                                           |

Safe reports are retained locally for the browser, database, worker, owner,
failure, recovery, journey, and CI-shaped profiles; CI uploads its safe reports
on success or failure. This is local qualification, not a remote CI run or a
deployment. The separate full backup/restore drill was syntax-checked but not
rerun in this slice. Existing fresh-production activation bootstrap and inactive
relational evidence-table limitations remain deferred.

## Next implementation slice

Complete the reachability-led cleanup of dormant application code, packages,
scripts, and obsolete verification. Check static, workflow, operational, and test
consumers before deletion; preserve active baseline contracts, stored data, and
the now-qualified four-boundary composition. Then rerun completion proof across
the reduced repository. The overall reset is not complete yet.

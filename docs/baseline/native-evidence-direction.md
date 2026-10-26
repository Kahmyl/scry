# Scry native evidence direction

Status: selected implementation direction; not activated for customers

This direction supports the [baseline brief](../product/baseline-brief.md).
It changes how new visual evidence is produced, not what Scry promises to test.
The existing recording producer remains active until its replacement passes the
qualification gates below. Historical evidence remains unchanged and readable.

## Product outcome

People must be able to recognize their application in the evidence. Screenshots
and recordings use the browser's original pixels, with localized solid-black
redactions where required. They are not substitutes assembled from reconstructed
HTML, styles, or assets. Ordinary text, images, icons, layout, and business content
remain visible by default.

Recordings preserve the real order and pacing of the captured journey, including
pauses. Encoding may finish after the browser session closes. The dashboard must
distinguish capture, protection, encoding, readiness, and failure; a processing
message must not imply that protected secrets will eventually be disclosed.

## Automatic protection scope

Automatic protection covers access secrets and financial details:

- passwords, authentication tokens, session cookies, API keys, and recovery codes;
- payment-card numbers, security codes, and expiry details; and
- bank-account numbers and international bank-account identifiers.

Email addresses, phone numbers, personal information generally, and business
content are not automatically private under this direction. Additional
customer-requested content policies are future work, not implicit defaults.
Existing evidence retains the policy under which it was admitted.

The same scope must apply to screenshots, video, observations, tool results,
command failures, diagnostics, URLs, and persisted metadata. A safe video does
not compensate for a secret exposed through another channel.

## Responsibility boundaries

Praxis owns browser execution, capture transport, document identity, and the
read-only discovery of relevant controls and regions. Recording work must not
block normal browser commands. Commands retain ordered admission, bounded
execution, cancellation, and explicit recovery semantics.

The isolated deadline foundation records the first claim's database deadline and
selected budget. Queue waiting does not consume execution time, and retries never
renew that deadline. Initial routine-command limits are two minutes; retained
synchronous replay closure has a separate fifteen-minute upper limit pending
independent native encoding. These are operational ceilings, not response-time
targets. Historical rows remain unchanged and receive a deadline only if claimed
again. Durable facts alone do not stop a browser; the candidate's carried
execution, cancellation and fencing mechanisms must be qualified together with
owner recovery and independent process supervision before lifecycle activation.

The isolated execution kernel uses one command lane per session. Praxis owns
browser acquisition through an exact startup/session cell registered before any
asynchronous startup work. The kernel owns command admission, lifetime, and drain,
not a second resource-factory API or a late lookup by session name. Cancellation
stops the registered cells and drains the awaited work
before another attempt is admitted. If termination or drain cannot be confirmed,
that lane remains unavailable; a timer firing alone is not permission to retry.
The cells retain late acquisitions even after an uncertain-drain report.
Observing callback completion closes binding admission before the final outcome
transition. That transition checks the monotonic clock again on success and
failure, and an accepted cancellation cannot return success after physical stop.
Successful attempts detach old callbacks so they cannot kill a later browser.
The isolated engine candidate now adopts that kernel across startup, actions,
checkpointing, and closure. Startup receives a single-use incarnation identity
before asynchronous admission; cancellation revokes that exact identity, including
an older background startup still waiting on admission. A stopped incarnation
cannot renew itself into a replacement. Driver and explicit phase timeouts retire
the browser instead of assuming that returning an error stopped its work.

Execution limits have one application-owned policy injected into Praxis. Private
application-to-runtime control may carry a remaining duration and cancellation
signal and a current-claim checkpoint; these are not new customer command fields.
The isolated queue candidate mirrors database-relative lifetimes from a private
process-local monotonic query anchor, deducting query, commit and transport time.
Checkpoints never extend the execution deadline or renew a claim. Acknowledged
heartbeats may renew claim authority, but never resurrect an expired local lease
or extend the immutable command deadline. Renewals do not overlap, and frequent
checks cannot postpone an already scheduled renewal.

Expiry or claim failure cancels the exact active attempt. Native dispatch checks
current command authority. Final success and failure writes remain post-lock
database admissions. Unconfirmed native drain is not a terminal command failure:
the host stops admission and begins failed-exit recovery before attempting any
best-effort diagnostic write. An expired/replaced claimant cannot overwrite that
command's recovery facts. These controls do not resolve an uncertain business
effect as not applied, or prove automatic browser-owner retirement/recovery.
Local callbacks cannot interrupt a blocked controller event loop. Synchronous
pre-dispatch clock checks catch an elapsed budget before another dispatch, but
independent worker/process supervision remains necessary for already running
browser activity when the controller itself is unresponsive. Native custody,
resource isolation, and the lane are complementary guarantees, not substitutes.

### Independent browser supervision direction

The selected isolated candidate puts each native browser's supported Playwright
BrowserServer custody in a separate, bounded control process. The application
keeps database, protection and evidence authority; the custodian's control channel
receives only private execution budgets and minimal browser-launch configuration.
The separate private browser-protocol connection can carry values intentionally
provided to the browser, including access secrets; it is not a public delivery path.
Recognition,
encoding and other CPU-heavy work do not run in the custodian. A dedicated remote
browser service remains an alternative if measured isolation requires it; adding
another network service is not necessary for the reproduced controller-loop stall.

Authority crosses the process boundary through a bounded challenge/response, not
by treating a ping as permission to keep acting. The custodian anchors each
challenge on its own monotonic clock and subtracts transport conservatively.
Repeated owner or claim revisions may only tighten their deadlines. Only a new
acknowledged database-renewal revision may extend renewable authority. The absolute
command deadline never extends. Exact command sequences and monotonic phase
sequences prevent stale completion, overlap or command reuse. An action must wait
for the matching authority acknowledgment before native dispatch.

A positive native-exit receipt ends dispatch authority; it is not reclassified as
unknown merely because a phase acknowledgment was still pending or the local
authority sampler refused further work. Those waits reject as fenced after
confirmed stop. A failed termination or missing native receipt remains unconfirmed
and still requires host containment. No timeout budget is extended by this rule.

Beginning retirement fences dispatch before any stop message is sent. An earlier
acknowledgment may settle transport bookkeeping, but cannot admit a waiting action
after that fence. Pending dispatch and subsequent synchronization join the bounded
stop outcome; a former admission timer cannot preempt it with false uncertainty.
Immediately before native invocation, Praxis synchronously rechecks custody,
incarnation, owner and command authority after the acknowledgment wait.

Missing, malformed, late or backpressured control traffic is a containment event.
Startup, command execution, individual phases and controller liveness are bounded
separately. Expiry is permanent for that custodian. A lost socket or dead custodian
is not an exit-confirmed native receipt. Unexpected custodian death requires
failed-host containment and qualified namespace cleanup; no guessed native PID is
killed and no unknown business effect is replayed automatically.

Liveness monitoring is reciprocal: the application also bounds absence of exact
custodian acknowledgments. A paused or blocked custodian cannot leave the
application assuming that its watchdog is still running. Losing that monitor
triggers unconfirmed containment through the actual owned helper capability;
it does not manufacture a native-exit receipt. This safety monitor cannot renew
an owner, claim, command or phase budget.

The mechanism experiments used the actual production image and seeded pages.
Six custodian-death cases observed Chromium exit across idle, busy and before-unload
states in both browser modes. Eight authority-protocol cases proved delayed-start
refusal, independent phase stop during a blocked controller, immutable command
deadlines, revision-controlled renewal, overlap refusal, ended-command fencing and
late-message refusal. These are mechanism proofs, not full runtime integration or
ten-product acceptance. The isolated implementation now wires the private
authority state machine through a separate custodian and matching dispatch
acknowledgments. Native phase, setup, transport and helper-death tests remain
mandatory. Deployment/crash containment, resource-shaped soak and full product
acceptance are still required before release. The helper is not an operating-system
security sandbox; browser sandboxing and namespace/resource policies require their
own production-shaped qualification.

The protocol uses supported [Playwright BrowserServer custody](https://playwright.dev/docs/api/class-browserserver)
and [Node child-process IPC](https://nodejs.org/docs/latest-v24.x/api/child_process.html).
Node send completion does not prove remote admission, so Scry waits for the exact
custodian acknowledgment. [Playwright's Docker guidance](https://playwright.dev/docs/docker)
also distinguishes process/container placement from Chromium sandboxing; running
the browser as root is not treated as a secure browser sandbox.

Veil owns the protection policy and private processing of original frames.
Semantic observations can identify sensitive content, but timestamps alone do
not prove that a region belongs to a particular frame. Frame-local checks and
explicit uncertainty handling are required before protected pixels are released.
Text recognition is a tool, not proof that every possible secret was found.

Chronicle accepts only protected evidence through current-owner admission. It
owns immutable receipts, completeness, sealing, retention, and the presentation
timeline. File processing and encoding must not hold long coordination locks or
extend the browser's lifetime. An encoder cannot authorize an unadmitted frame.

Assurance independently tests these guarantees through failure injection,
privacy controls, pixel comparisons, timing checks, and live application journeys.
It cannot waive protection or complete evidence on behalf of the production
owners.

## Evidence admission direction

The custody correction separates slow byte preparation/durability from short
current-owner admission. The actual-source reproduction showed that the generic
admission callback held ownership locks around file work; checking the lease
afterward could not undo bytes already written. An authentic file is not, by
itself, proof that its write was admitted by the current owner.

Isolated comparisons exercised the actual store, PostgreSQL blocking and ownership
expiry. The selected candidate stages
immutable, generation-scoped protected objects outside coordination locks, then
admits their exact sequence/head receipts in a short guarded database transaction.
Reads, sealing and recovery follow admitted receipts rather than directory
discovery. Protected-payload PostgreSQL staging also passed the isolated cases.
File staging retains the baseline artifact backend without moving native-media
payloads into relational storage and its backup workload; a separate artifact
service is not required by the evidence so far.

The experiment must cover slow storage with continued renewal, stale and replaced
writers, duplicate/conflicting receipts, rollback, crashes before/after admission,
missing/tampered admitted objects and unchanged historical readers. File/network
work and arbitrary callbacks must not remain inside the new SQL admission gate.
The existing Evidence stream and chunk entities remain authoritative. The
correction adds explicit provenance and short receipt admission, not another
parallel evidence system. A guarded additive migration must preserve retained
history, refuse live-owner cutover and prevent older workers from granting new
receipt-less authority. Authenticated old files cannot be relabeled as new
admissions. Sealed heads and artifact references are immutable.

Owner authority is checked after stream coordination locks and again at the
serialized database admission decision. Waiting for relational work cannot admit
an expired owner's candidate. Recorder completeness is retained with the actual
stopped-capture fact, including errors discovered during shutdown; closure retry
cannot erase a known recording failure. Report coverage is stored separately from
caller-provided report JSON. Historical reports keep their original contents and
have no newly inferred coverage claim.

Capture stop and media publication are distinct facts. Only actual native-stop
and recording-drain receipts authorize the controller's stopped-capture fact.
Recovery can finish an already captured closure without opening a new application browser or
repeating a business action. Publication and action-ledger paths are immutable and
generation-scoped, not shared directories overwritten by a replacement.

Mutable capture restoration caches are also scoped to their owner generation;
restoration must not delete or replace a newer owner's files after fencing.
This does not authorize longer retention of private captures. Quiescent cache
disposal and existing expiry enforcement remain mandatory release qualification;
isolated fixtures do not authorize customer activation of unfinished cleanup.

The retained offline renderer may still launch its isolated, network-refusing
rendering browser; that is not a reopened application session. It remains a legacy
projection until the native producer is qualified and replaces it. Receipt-backed
custody does not itself establish native-pixel fidelity.

An interrupted recording is incomplete evidence, even when its admitted prefix is
valid. A passed Run still requires complete evidence. Failure finalization may
close an explicitly incomplete recording; API and dashboard must show that fact.
An unavailable zero-chunk recording is not a complete stream. Abort alone never
authorizes completion or publication. Reports keep the baseline minimum of
complete accepted evidence and gain authoritative coverage metadata so other
partial or missing attempts are not silently hidden. Existing reports stay
unchanged.

Unavailable-file and encoding failure closure remain required release work. A
missing or damaged admitted object currently refuses verification, without an
orphan fallback. The next failure-lifecycle slice must allow an honest unavailable
terminal outcome without promoting it to complete evidence or rewriting a sealed
historical stream. Passing the admission checks alone is not release readiness.

The isolated candidate implements this experiment-supported admission direction;
that is not release activation or full product qualification. Temporary raw-frame
retention has separate bounded approval, as specified below; it is not activated
by this correction.

## Private frame processing

An isolated experiment supports bounded encrypted quarantine as a candidate for
absorbing capture bursts without blocking interactions. Raw frames would stay in
Veil's private processing scope, not Chronicle's evidence store or dashboard.
Encryption, explicit ownership, byte and age limits, cleanup, crash behavior,
and key custody are required parts of that capability.

The owner approved temporary encrypted raw-frame quarantine with a maximum
retention of fifteen minutes and a bounded quota. This approval covers the data
handling direction, not release activation. Raw frames remain private to Veil;
only protected output may reach Chronicle or the dashboard. Cleanup, crash
handling, key custody and privacy qualification remain mandatory. It is not an
active customer default. Isolated tests use fictional seeded data. No customer
raw-frame persistence may be enabled implicitly by a recording flag.

If capacity, protection, ownership, or processing fails, the system reports the
specific incomplete interval or unavailable artifact. It must not publish raw
pixels, silently skip frames, claim complete evidence, or manufacture a
whole-page substitute that looks like a broken application.

## Native presentation and screenshots

Video timestamps derive from absolute native capture times rather than adding
individually rounded frame durations. The final frame remains visible until the
actual capture termination time. A required encoder terminal-repeat marker is
not represented as another browser action or another captured screenshot.

Receipt order remains immutable even when the browser asynchronously delivers
images out of timestamp order. Presentation order is a separate explicit mapping,
stable for equal timestamps. Capture transport must validate its clock and
document identity before admission; timeline planning is not that validation.

Independent encoding consumes ordered, protected receipts. Every native frame
must remain accounted for. A millisecond container clock has finite precision;
unrepresentable input is an explicit failure, not permission to accelerate or
silently discard evidence.

Screenshots represent meaningful visual states and actions. Repeated requests
for an unchanged state should not flood the evidence gallery. Selection and
deduplication must preserve distinct states and must not rewrite historical
evidence.

## Qualification and activation

The native direction requires all of the following before activation:

- narrow-policy privacy tests across visual, textual, and metadata channels;
- independent coverage and unchanged-outside-mask pixel checks;
- motion, replacement, embedded-frame, shadow-content, and recognition failures;
- frame-order, final-pause, encoded-timestamp, and playback checks;
- ownership loss, crashes, quota exhaustion, expiry, and cleanup tests;
- concurrent-command responsiveness and resource-bounded soak tests;
- fresh end-to-end journeys through Scry's API, agent integration, and dashboard
  against the ten approved isolated established applications; and
- reviewed implementation changes with passing exact-head CI and compatibility
  checks for historical evidence.

Direct browser experiments demonstrate specific mechanisms, not complete Scry
acceptance. The isolated ten-application quarantine experiment accounted for all
1,394 captured frames without queue overflow. This supports further integration;
it does not establish universal secret recognition or release readiness.

Activation is a separate, qualified change. Merge and deployment remain separate
decisions and are not authorized by this document.

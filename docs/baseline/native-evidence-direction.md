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

## Private frame processing

An isolated experiment supports bounded encrypted quarantine as a candidate for
absorbing capture bursts without blocking interactions. Raw frames would stay in
Veil's private processing scope, not Chronicle's evidence store or dashboard.
Encryption, explicit ownership, byte and age limits, cleanup, crash behavior,
and key custody are required parts of that capability.

Customer activation of temporary raw-frame retention remains unapproved. The
candidate retention policy is a maximum of fifteen minutes with a bounded quota;
it is not an active customer default. Isolated tests use fictional seeded data.
No customer raw-frame persistence may be enabled implicitly by a recording flag.

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

# Scry native evidence baseline

Status: the controlled official-adapter integration passed its local complete-path qualification. Customer activation, staging merge and deployment have not occurred. See the [integration record](../../experiments/browser-foundation/INTEGRATION.md) for proof and limits.

## Product priority

Scry is a testing platform. The current baseline tests browser journeys and
provides evidence a person can review. Mobile and desktop application testing
are future capabilities. Protection supports testing; it is not the product's
primary purpose or a requirement for perfect recognition of sensitive content.

## Faithful evidence

New recordings capture the live browser's native pixels using
[Playwright screencast](https://playwright.dev/docs/api/class-screencast).
They preserve capture timing and pauses at normal playback speed. Screenshots
are native action checkpoints, not frames assembled to manufacture a video.
Exact duplicate screenshots are excluded from the gallery.

The controlled official-adapter candidate uses native X11 capture and ffmpeg
to record a continuous real-time MP4 at the fixed browser viewport. The existing
independent Praxis custodian owns both browser and encoder lifetime. This is not
DOM reconstruction or a sequence of screenshots. The candidate remains inactive
outside the dedicated integration stack; the existing reader and producer remain
compatible with historical WebM evidence.

Chronicle records a private capture reservation before the encoder starts. Only
a finalized recording from that admitted reservation may be recovered after
interruption, copied into immutable media and admitted under the current owner.
Recovery does not reopen the app or repeat an uncertain action. Partial footage
is labeled as an evidence gap, not a defect in the tested application.

Do not reconstruct HTML, CSS, images or application layout for new evidence.
Ordinary text, images, icons and business content remain visible. A mask is a
localized solid-black rectangle. There is no blanket image/input policy,
whole-page replacement, disclosure-pending screen or speculative over-blocking.

Historical evidence is not rewritten. The historical reader and offline renderer
remain for old DOM recordings only; new browser sessions do not use that producer.

## Best-effort protection

Target access secrets and financial details: passwords, authentication tokens,
session cookies, API keys, recovery codes, payment-card details and bank-account
identifiers. Start with recognizable controls and known secret values. Email,
phone, general personal content and business content are not visual targets.
Customer-specific content rules are future work.

Text recognition follows the same narrow scope: no default email/phone/identity
masking or random-looking-identifier heuristic. Explicitly registered protected
values remain protected across safe textual sinks.

Veil supplies a targeted overlay policy. Praxis installs it in an isolated
browser world, keeping the known-secret registry out of application JavaScript.
Masks follow the current controls and text ranges without replacing their
content, styles or layout. Removed elements stop producing mask rectangles.
The baseline does not promise OCR recognition, recognition inside canvas/images,
universal widget coverage or zero transient misses.

When a target cannot be recognized or located confidently, leave its pixels
unchanged. A missed mask alone does not fail the application journey, mark a
complete recording incomplete or withhold otherwise usable evidence. Do not
describe processing completion as proof of complete masking.

Every evidence viewer states:

> Automatic redaction is best effort. Sensitive information may remain. Review before sharing.

This does not relax credential encryption, bearer authentication, workspace
authorization, known-secret exclusions in logs/API responses or artifact custody.
Native media is private evidence, not a public download. No new temporary raw-frame
quarantine, OCR worker, per-frame approval service or separate encoding service is
required by this baseline. Previous quarantine approval is not an active default.

## Ownership and lifecycle

- Praxis owns ordered browser commands, bounded execution, cancellation, native
  capture, recorder drain and physical browser stop.
- Veil owns targeted masking policy and existing credential/transport safeguards.
- Chronicle owns generation-scoped private artifact directories, exact media
  receipts, duplicate exclusion, sealing and authorized byte verification.
- Assurance tests behavior and failure paths; it is not a runtime authority.

The browser encoder finishes a video before Chronicle admits its metadata.
Chronicle makes final files durable, then admits their exact metadata through
the existing short current-owner transaction. File work does not hold ownership
locks. Native bytes do not travel through DOM-event JSON or relational payloads.
Recovery follows admitted receipts, never orphan-directory discovery. Stale
owners cannot promote staged files. Sealed history is unchanged.

The baseline admits assets up to 128 MiB each and 256 MiB per recorder. These
are final-asset admission limits, not a claim of continuous disk-quota enforcement
while the browser encoder is running. Missing or unreadable captured media is an
evidence failure, distinct from an unmasked region or an application defect.

The controlled official-adapter recorder additionally bounds each capture to
120 MiB or 15 minutes. Reaching either limit produces partial footage, not a
claim of complete recording. Its fixed viewport is 1280 × 720 at 20 frames/second.

## Dashboard and API

Mission pages expose each Run's recordings and screenshots. Run pages include
a native evidence viewer with explicit selection, native video controls,
normal-speed playback, loading/error states and the best-effort warning.
Collapsed Mission sections do not fetch recordings until opened.

`GET /api/runs/{runId}/media` lists admitted native evidence, including screenshots
already admitted while a Run is open. A video appears after encoder finalization
and receipt admission, not as a live stream.
`GET /api/runs/{runId}/media/{index}` delivers verified PNG, JPEG, WebP, MP4 or
historical WebM bytes.
Both require existing authentication and Run/workspace authorization. No local
filesystem paths or bearer tokens are put in public media URLs. Browser-local
blob URLs are revoked when selection changes or the viewer unmounts.

## Required baseline proof

Verify real commands and business journeys, complete native capture, black masks
on obvious secret/financial controls, faithful ordinary UI, authorized dashboard
playback and cross-workspace refusal. Keep deadline, cancellation, owner recovery,
evidence availability, migration and authentication tests. Masking completeness
is not a release gate.

Fast CI owns component checks, types, build and repository boundaries. Browser
CI owns actual browser/capture checks. Database CI owns migrations and database
lifecycles. Do not repeat the fast component/build checks in the other two jobs.
The isolated deployed smoke remains an end-to-end compatibility check, not a
claim that all ten established application journeys have passed this candidate.

Consolidate reviewed implementation PRs into `codex/staging-baseline`. Main merge
and remote deployment remain separate decisions. Do not manufacture additional
PRs or qualifications to satisfy an arbitrary count.

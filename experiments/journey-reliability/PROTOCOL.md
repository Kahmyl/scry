# Journey reliability experiment

Status: isolated research and executable experiments. No baseline activation, migration, merge or deployment.

## Product rules

Scry is a testing platform. Browser interaction and truthful evidence come first. Keep Playwright and the official MCP adapter as the foundation. Add a dependency only when a measured capability or reliability gap warrants it; do not add another hidden agent merely to retry the customer's agent's work.

Keep ordinary UI intact. Native video is not reconstructed from DOM or screenshots. Automatic masking is best effort and narrowly targets access secrets and financial details; missing protection must be disclosed, not used to invent blanket page blocking.

There is no fifteen-minute journey or recording cutoff. Storage and compute are finite resources, so admission, exhaustion and interruptions must be explicit. Internal MP4 fragments are not separate user-facing videos. Separate videos require an explicit request, a meaningful test section, or a genuine discontinuity. Never conceal a gap by stitching unrelated recordings. Titles must explain their contents and relationships.

## Questions and falsification criteria

1. Can one native recording continue beyond fifteen minutes during real edits, with independent saved-content verification? Run an actual twenty-minute Nextcloud soak, not accelerated clock time. Measure whole-container memory and output size. This is an operator-paced soak, not blind acceptance or a memory-leak proof.
2. Can one interaction lifecycle prevent duplicate mutations after a timeout across different action families? Compare an unsafe retry with retained in-flight ownership, stable action identity, explicit readiness, and independent postconditions. Fail the candidate on a duplicate effect, mismatched identity reuse, false success, or late action interleaving.
3. Can Playwright's existing semantic and native-input capabilities cover representative controls without app-specific engine branches? Test click, keyboard, form, drag, scrolling, frame, shadow-root, popup, dialog and file-transfer boundaries. Controlled fault fixtures establish causality; actual established applications establish relevance. They are different kinds of evidence.
4. Is the complete path usable by an agent that knows only public tools? Fresh blind acceptance through API, worker, Chronicle and dashboard remains required after integration. Direct Playwright probes do not satisfy this gate.
5. Can a person understand what happened without decoding identifiers or JSON? Inspect the actual dashboard; prototype Mission/Flow/Run/report information architecture before deleting concepts.

## Selected design hypotheses

- One session owns one interaction at a time. An elapsed client deadline does not cancel a browser action. Retain ownership until it settles or the old generation is definitively stopped.
- Stable action identity returns the same receipt. Reusing an identity for a different intent is an error. Existing durable command tracking remains the production authority; the in-memory lab is not a replacement.
- Before dispatch, re-observe stale references and readiness within a bounded budget. After possible dispatch, do not automatically replay a business mutation. Observe, reconcile, or return uncertainty.
- An action receipt is not a business assertion. Record the requested action, its execution outcome, the observed postcondition, and the remaining uncertainty separately.
- Recovery must not erase a failed required interaction. A keyboard alternative can complete the journey without making a broken pointer interaction pass.
- Browser/evidence closure is not business resumption. Resume from a meaningful checkpoint only after checking actual application state; do not promise to recover unsaved browser memory after a crash.
- Maintain resource bounds without silently evicting deduplication authority or adding arbitrary recording cuts.

## User experience hypothesis

Keep Mission as the live workspace, grouped into named Flows (test directions), with numbered and named Run attempts. Preserve the model's existing flow revision links rather than creating a competing hierarchy. A Mission links directly to its compiled test report. The report is the readable review artifact: scope, outcomes, observations, suggestions, limitations and relevant evidence. It refers to the same evidence, not copies. Technical identifiers and custody details belong in optional diagnostics.

Current UI inspection confirmed a flat run list, `Run <short ID>`, generic screenshot labels `page`, no direct report CTA on the Mission, and a report dominated by a digest and raw JSON. These are presentation/contract gaps, not evidence that the report domain should be deleted. Historical evidence must remain accessible.

## Alternatives and primary research

- [Playwright actionability](https://playwright.dev/docs/actionability) and [actions](https://playwright.dev/docs/input): retain semantic actions, native keyboard and pointer controls. Do not force-click or synthesize DOM events to conceal a real usability defect.
- [Playwright assertions](https://playwright.dev/docs/test-assertions): use explicit, retrying expected-state checks; action completion alone is insufficient.
- [Downloads](https://playwright.dev/docs/downloads) and [uploads](https://playwright.dev/docs/input#upload-files): Playwright already supplies mechanics. A public Scry capability still needs scoped artifact handles, authorization, quotas, and cleanup; arbitrary host paths are not acceptable.
- [Browser isolation](https://playwright.dev/docs/browser-contexts): private contexts and session-scoped clipboard avoid shared routing/state. A new context does not preserve unsaved application state.
- [Stagehand fallback pattern](https://docs.stagehand.dev/v3/best-practices/agent-fallbacks): useful comparison for explicit fallback. A second agent SDK is not selected: it adds reasoning, data flow and latency without yet demonstrating a gap the customer agent plus existing primitives cannot fill.
- [Temporal long-running activity guidance](https://docs.temporal.io/design-patterns/long-running-activity): borrow meaningful checkpoints, progress and idempotent recovery. Installing Temporal is not justified by this experiment; existing durable command ownership should not be replaced without evidence.
- [FFmpeg fragmentation](https://ffmpeg.org/ffmpeg-formats.html#Fragmentation): existing native recorder already uses fragmented MP4, allowing a continuous file. Test the existing encoder before adopting a new recorder.
- [Allure result aggregation](https://allurereport.org/docs/how-it-works/): compiled reports and execution attempts serve different purposes; preserve that distinction without duplicating evidence.

## Boundaries of proof

No finite experiment proves every web application works or eliminates all regressions. Each result must name its executed source, conditions, failures and limitations. No tool or architecture is selected solely because its documentation sounds comprehensive. Full integration, privacy checks, fresh blind journeys and UI review remain distinct gates.

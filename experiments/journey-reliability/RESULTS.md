# Journey reliability: research and isolated results

## Decision

Keep Playwright and the official MCP adapter. The evidence supports a shared interaction/recovery subsystem around them, not a replacement browser engine, another hidden agent, or a new recorder.

This is an isolated experiment result, not release qualification. No production source was changed, no baseline was activated, and no merge or deployment occurred. The lab's in-memory lifecycle is a causal prototype, not a second command authority to install alongside Scry's durable store.

## What actually ran

Artifacts are under `/Users/habib/Documents/monorepo/scry/artifacts/assurance/browser-blind-20261031/`. Executed sources are copied into the capability/recovery artifacts. The original compact long-soak source is preserved as `journey-long-1793448283045/executed-source.mjs`; the checked-in copy was formatted afterward.

| Experiment                           | Observed result                                                                                                                                                                                                           | Limit of proof                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Twenty-minute real Nextcloud soak    | 36 native edits, peer convergence, final save/reopen matched. One H.264 recording: 1,216.75 seconds, 14,585,454 bytes, 20 fps, complete coverage. Entire file decoded successfully.                                       | Operator-paced two-page soak, not fresh blind acceptance, privacy qualification or arbitrary-duration proof.                                                          |
| Identical-code pointer comparison    | Raw hover-to-drag failed twice; generic source preflight passed three repeated 28-check batches.                                                                                                                          | Controlled fixture; not a universal drag workaround or all-app qualification.                                                                                         |
| Final extended tool profile          | 35/35 checks passed; all 21 current public core/vision tool names exercised. New drop/click effects were checked, not merely an already-matching value.                                                                   | Does not test every argument, widget, browser or combination. File-transfer mechanics use direct Playwright, not a supported public Scry file contract.               |
| Lifecycle tests                      | 6/6 passed, including immutable receipt snapshots, in-flight exclusion, reconciliation exclusion, quota and intent conflicts.                                                                                             | In-memory prototype; production durability, generation fencing and crash recovery still need integrated proof.                                                        |
| Real Nextcloud receipt-loss recovery | One edit/save execution despite repeated action identity and deliberately lost result/observation. Independent WebDAV read matched; fresh browser context reopened the same content. Repeated after lifecycle correction. | Uses a unique fictional document and operator-supplied assertions. Clean context replacement after saving is not an abrupt browser-crash/unsaved-state recovery test. |
| Desktop/mobile report preview        | Actual earlier GitLab evidence loaded, report links and evidence selection worked, no horizontal overflow at 390 px, video playback default 1× and autoplay off. Inspected in the in-app browser and automated browser.   | Read-only UX prototype with one actual flow/attempt, not activated dashboard code or a multi-flow usability study.                                                    |

Final evidence directories:

Additional checks passed: 8/8 observed MCP-reference cases (ordinary, shadow and frame inputs; removed controls, same-URL navigation, newly created tabs, selector injection and wrong-tab rejection), plus 90 existing Praxis and 45 API authority/deadline regression tests. The reference probe uses the pinned native resolver contract, not a replacement selector registry. These are not fresh blind acceptance results.

- `journey-long-1793448283045`: continuous native recording, 121 memory samples, independent edit checks and final readback.
- `journey-comparison-1793450345958`: two raw and three preflight comparisons, identical source at that stage. Underlying trial directories are recorded in its results.
- `journey-capability-1793450649990`: final 35-check tool profile, call log, event traces, exact sources and video.
- `journey-real-recovery-1793450653192`: final actual-app recovery result and screenshots, exact lifecycle sources.
- `journey-artifact-review-1793450429254`: full native decode, frames at 30/925/1180 seconds, desktop/mobile preview screenshots and player checks.
- `journey-references-1793451280064`: final 8/8 observed-reference probe, including the detached-frame guard; exact sources preserved. Initial probe: `journey-references-1793451177976`.
- `journey-artifact-review-1793451322862`: final mobile dropdown/readable screenshot presentation and player checks passed. A prior rerun (`journey-artifact-review-1793451282864`) could not resolve `host.docker.internal` on the target-app network; DNS also returned `EAI_AGAIN`. The default-network rerun passed. This is a lab connectivity failure, not a UI pass or a diagnosed Scry production DNS defect.
- `journey-artifact-review-1793451392897`: final loaded-video desktop screenshot and mobile presentation passed after reserving the native video's aspect ratio. Full decode and 1×/autoplay-off checks passed again.
- Earlier failed batches remain present, including `journey-capability-1793448659514`, `journey-capability-1793448736424`, `journey-capability-1793448807683` and `journey-capability-1793450569294`.

## Causes established or narrowed

### Timeout is not cancellation

The unsafe comparison made two actual server-side changes after retrying an action whose expected page state had not appeared quickly. The bounded lifecycle retained the first in-flight action, rejected a different concurrent mutation, returned the same pending receipt for the same identity, and verified one eventual change. Lost observation and a transport error after the effect did not trigger replay.

Scry already has durable command identities, ownership and action receipts. Preserve that authority. The integration correction must make admission, private adapter execution, observation and agent-facing status agree on the lifecycle; it should not add an independent retry coordinator.

### Pointer readiness can change during native movement

The combined fixture exposed a hover menu that changed layout as the next drag began. In the raw event trace, the source moved from y=271 to y=235 and the normal drop/end sequence was absent. Subsequent pointer operations produced no expected changes. An explicit move away from the menu fixed the sequence. A generic native source hover followed by geometry/hit-test confirmation also fixed it, adding about 120 ms in the measured example. No application name or menu selector is in that helper.

Minimal headed/headless comparisons passed with ordinary Playwright drag, manual native drag and CDP drag interception. Therefore this is not evidence that Playwright cannot drag. Escape, mouse-up and `Input.cancelDragging` did not repair the original failed sequence; no additional CDP remedy or dependency was selected. The exact upstream internal race is not proven, and the helper remains a hypothesis to qualify across real application gestures, moving targets and frames.

### Editing needs explicit intention

An extended test initially expected slow native typing to replace existing text. It inserted instead. That is a contract/expectation distinction, not proof of an upstream defect: replacing a selection and inserting at a caret are different operations. The corrected tests prove both separately. Previous rich-editor experiments also show that one transport method is not universally correct.

Keep explicit replace/insert intent, owned receiver/document scope, and observable readback. Preserve method provenance. Do not quietly try a second mutation method after a possibly applied edit. A native action's completion is not a claim of saved business state.

The reference probe uses the same `page.locator('aria-ref=' + reference)` mechanism as the installed official MCP resolver, rather than deriving app selectors or inventing a reference registry. It successfully used the rich-input helper through ordinary, shadow-root and frame references. Bindings check element identity, document lifetime and frame detachment; pages created after construction are subscribed too. This closes one lab limitation, not the remaining integrated-command gate. Upstream upgrades require these pinned-contract checks.

### The existing recorder can run continuously

The recorder already produces native fragmented MP4. Passing no time limit in the isolated test kept one file recording beyond fifteen minutes. No video-reconstruction library or new encoder was required. Fragmentation inside the container file is not user-facing segmentation.

The deployed candidate still calls the recorder with its existing default duration limit; this experiment has not removed that production setting. Integration should introduce an explicit no-arbitrary-duration policy while retaining honest finite-resource handling. Do not serialize JavaScript Infinity into a JSON contract; use an explicit absent/null duration policy if a serialized setting is needed.

Keep bounded individual command deadlines and renewable ownership leases. They prevent hung interactions and are not total-journey limits. Separate customer-facing videos only for an explicit request, meaningful test section, or genuine interruption; explain each part and the gap. Internal storage chunks must not become arbitrary visible chapters.

The soak was deliberately paced, so it does not establish readability of an unpaced customer-agent journey. Preserve native real-time footage, provide normal playback plus slow/pause/seek controls and semantic timestamps, and qualify real-agent pacing. An optional review-paced execution mode may add deliberate dwell at meaningful states; do not silently slow every command or alter the evidence's timing.

Memory for the two-page browser, private MCP client, encoder and Node process peaked at 1,365 MiB in a 2 GiB container; first sample 955 MiB, last 1,070 MiB. Node RSS went from 173 to 213 MiB. Native edit p50 was 884 ms, p95 1,240 ms. These are measurements, not proof of no leak or adequate multi-session capacity. App-server memory is outside this container. Practical admission/capacity qualification remains necessary.

### The dashboard has the concepts but not the presentation

Actual local UI inspection confirmed a flat run list, short IDs as attempt labels, screenshots titled `page`, no direct report link from the Mission, and a report dominated by a chain digest and arbitrary JSON. The local sign-in fixture expires after 900 seconds and does not implement the normal refresh grant; that observation is not evidence of a production Supabase auth defect.

Keep Mission → named Flows → named/numbered Run attempts. Keep a directly linked compiled report: it answers a different question from the live workspace. Render the same evidence references in both, not copies. Retain recovered failures and unverified scope. Put IDs and custody diagnostics behind optional technical details.

The preview manually supplies meaningful titles for an existing report. Production must not depend on GitLab-specific JSON keys or array positions. Use a small common report/evidence presentation contract, with safe backward-compatible fallbacks for historical records. Test more than one flow/attempt before selecting final navigation.

## Tool choices

- Retain official Playwright/MCP semantic actions and native pointer/keyboard primitives.
- Retain private, session-scoped clipboard transport for the cases already justified by the rich-editor experiments; do not share the desktop clipboard between customer sessions.
- Retain existing FFmpeg native recording and Chronicle custody. No reconstruction or replacement recorder.
- Add no Stagehand/browser-use agent SDK at this point: no measured gap justifies a second hidden reasoning/retry system, extra data flow and latency.
- Borrow checkpoint/idempotence principles from established workflow systems; do not install Temporal or replace existing durable command tracking without a demonstrated need.
- Playwright already supplies upload/download mechanics. If required as a public capability, add project-scoped artifact handles and explicit quotas/cleanup, not arbitrary host filesystem access.

Primary-source research and alternatives are linked in [the protocol](./PROTOCOL.md).

## Recommended implementation boundary

| Option                                    | What it would do                                                                                                                                                                                                                                                          | Assessment                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Contained patches                         | Change a timeout, special-case Nextcloud/Grafana, add automatic retries, replace generic gallery labels only.                                                                                                                                                             | Does not enforce shared action/observation semantics or prevent new sibling failures. Not recommended as the durable solution.            |
| Shared interaction and journey correction | Extend the existing command/adapter lifecycle with explicit intent and safe typed outcomes, document/receiver and pointer readiness, bounded diagnostics/reobservation, checkpoint reconciliation, continuous evidence policy, and a common report presentation contract. | Recommended. Keep the existing owner, API, worker and evidence authorities; integrate the proven mechanisms, not the toy lifecycle store. |
| Whole-platform/browser rebuild            | Replace Playwright, workflow engine, recorder and domain model.                                                                                                                                                                                                           | Current evidence does not justify the cost, new migration risk or duplicated authority.                                                   |

## Next execution gates — not completed by these probes

1. Wire the selected mechanisms into a separate integrated candidate. Keep existing durable action identity and generation authority. Carry safe typed diagnostics across private IPC rather than collapsing all errors into `ADAPTER_CALL_FAILED`. A client deadline must not release an executing session or silently redispatch a mutation. Bound every phase and prove retirement of an abandoned generation.
2. Preserve meaningful application checkpoints separately from recording closure. Qualify actual process death before/after an effect, browser crash, lost replies, stale owners, delayed background commits and cancellation; show no duplicate business action. New-context saved readback is only one part of this.
3. Exercise opaque public references, input scope, dynamic tabs/frames, moving/virtualized controls, held modifier/pointer cleanup, and required interaction modes. Add alternate methods only when intention and current state make them safe; preserve the first failed test finding.
4. Carry human evidence titles, descriptions, coverage and meaningful recording boundaries through Chronicle/API/report/dashboard, preserving old artifacts. Resource interruption must be explicit, not disguised as a planned chapter. Remove the arbitrary duration default in that candidate, not by claiming this override already changed the baseline.
5. Test the complete API → worker → Praxis → Veil/Chronicle → dashboard path with practical resource limits and long native recording. Keep best-effort masking narrow; do not reintroduce protection as an interaction gate.
6. Run fresh blind customer journeys on all ten dedicated established-product instances against that integrated candidate, including distinct approaches/attempts and explicit expectations. Earlier ten-app results and these operator probes cannot stand in for this gate.
7. Review final desktop/mobile UI and the multi-flow/attempt report narrative; then consider activation. No universal-failure-free or release-ready claim is supported yet.

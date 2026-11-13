# Customer experience qualification

This campaign follows the 10 November 2026 customer review. Its scope is Scry's
communication, recovery and agent workflow; Vitract application findings remain
Vitract findings. No Vitract retest is part of this qualification. The earlier
S01–S18/C01 register in `agent-workflow-reliability-plan.md` remains historical
evidence; this document does not replace or retroactively close it.

## Current result — mutation attribution and remaining local CI, 13 November 2026

**Mutation attribution is complete for the retained failure classes. The remaining
deployment-relevant local checks passed after two qualification-fixture repairs.
No application mutation fix or relaxation of privacy/strict DOM gates was needed.
Hosted CI on a new candidate commit remains pending; nothing was pushed or
deployed.** The five unsupported rendering checkpoints remain explicit limits.

The complete saved inventory contains 214 failed screenshot phases: 90 changed
style-attribute presence/serialization and recorded mutation events; 124 recorded
style events without a final structural change. Every reported mutation category
is `attributes:style`. The pinned provider's screenshot implementation temporarily
sets `caret-color:transparent!important`, then restores the property; a previously
absent style attribute can remain empty. Scry's graph writes styles only on its
own four kinds of protection nodes, not on application controls.

An additive witness on the unchanged three-checkpoint worker fixture measured
12 actual worker/provider screenshots. All changes were the provider caret
operations or empty-style markers: zero unexpected mutations, unchanged node
identity/parent/child order, unchanged text and other attributes, and unchanged
native control state. Nine additional witness controls reject changed values,
text, attributes, inserted/reparented nodes and unrestored caret styles. Raw DOM
values stayed in browser handles; only finite facts were saved. Original strict
failures remain red. This is bounded attribution, not a universal no-mutation
claim: the provider's style writes can be observed by application code or CSS.

The two qualification repairs preserve their original guarantees:

- Caddy configuration validation no longer allocates a Compose network, volumes
  or service ports. It validates the exact Compose-rendered configuration with
  the configured real Caddy image and `--network none`. This resolved exhausted
  local automatic subnet pools. OAuth wiring assertions remain unchanged; a real
  invalid-directive negative control is rejected and the exact fixture is removed.
- The owner-retirement fixture installs its append pause **after** startup. Native
  capture now durably reserves an epoch during startup; the previous first-append
  pause deadlocked that setup before it could test retirement. The repaired failed
  case passes on Linux with every physical-exit, pending-append and durable-owner
  assertion retained. Its two already-passing sibling cases were not rerun.

Completed local checks, with passing work reused rather than replayed:

| Check                                                                       | Result                                                                                                                              |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Ten previously unexecuted database lifecycle files                          | 78 passed, zero skips; four earlier passing files reused separately                                                                 |
| Native custody / supervision / cancellation                                 | 4 / 10 / 4 passed                                                                                                                   |
| Remaining rendering checks at three device scales                           | 6 passed; two earlier recording cases reused                                                                                        |
| Queue / worker shutdown                                                     | 1 / 1 passed                                                                                                                        |
| Owner admission / engine lifetime / watchdog                                | 5 / 3 / 3 passed                                                                                                                    |
| Unchanged worker journey on the deployment Linux runtime                    | 1 passed                                                                                                                            |
| Repaired owner-retirement append case on Linux                              | 1 passed; two deliberate test-name exclusions reuse passing siblings                                                                |
| Remaining Linux command lifetime / evidence closure / unavailable evidence  | 3 / 5 / 13 passed                                                                                                                   |
| Production dependencies / Caddy / deployment tiers / operations / preflight | Passed                                                                                                                              |
| Fresh production image and isolated deployment smoke                        | Passed, including authentication, protected actions, decoded MP4, scoped evidence/report and authenticated desktop/mobile dashboard |
| API typecheck / source formatting / repository closure                      | Passed; closure reports no unresolved imports or displaced sources                                                                  |

The fresh production smoke retained every original assertion. Its only harness
adaptation selected a new task-owned explicit-subnet network because automatic
pools were exhausted; no shared network was pruned or altered. Services, volumes,
temporary image and that network were removed. The temporary production image was
`sha256:c9d62343dd14898b13e4d85bd0df478e37ba6c3bb342dc1d77c9a54a4b528c7d`.
It was built from the frozen runtime sources and removed by the standard smoke
before a separate image-tree hash comparison. Local ARM Chromium does not play
H.264; FFmpeg decoding passed. Official x64 Chrome playback remains a hosted-CI
check, not a claimed local pass.

Two macOS worker attempts conservatively withheld recordings after
`native_protection_refresh_incomplete`; a diagnostic attempt completed. These
outcomes are retained, not a repaired flake or erased failures. The unchanged
original worker case passed on Linux. The precise macOS refresh timing cause
remains unproven; no privacy gap was cleared, evidence promoted or write replayed
to obtain a pass. Continuous recording remains best effort.

The baseline's [required hosted qualification](https://github.com/Kahmyl/scry/actions/runs/42881299045)
passed on commit `f4f513e9326f2edd6344a6394a4324d87391c941`, including Windows.
Unchanged migration, resource, OAuth, operational-key and installer checks reuse
that baseline plus retained scoped campaign evidence. That is not a hosted pass
for these uncommitted changes. A review-branch commit/push is required for GitHub
to qualify the exact candidate; merge, publication and deployment remain separate.

Safe evidence is in
`artifacts/assurance/customer-experience-campaign-20261110/results/mutation-attribution-20261113/`.
All failed attempts, diagnostic setup errors and original strict outcomes remain.

## Final focused sweep — earlier result, 13 November 2026

**The remaining unexplained capture failure is repaired locally. Identity passes;
all seven public-crop differences are now attributed. Five deliberately unsupported
rendering checkpoints still withhold images, so the original absolute acceptance
target remains unmet. No push, commit, merge or deployment occurred.**

This sweep began at 14:07 UTC. It reused the previously passing full campaign,
connection, renewal, recording, cleanup and ordinary application evidence. Only
unresolved cases and checks affected by the repair were executed.

| Previous remaining item              | Current result                         | Evidence / consequence                                                                                                                                                                                                                      |
| ------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Round-three fullscreen image missing | Fixed                                  | Actual worker returned both lifecycle images, with four private and six public pixel checks passing; no node-identity failures or additional final control-fact differences against the matched provider                                    |
| Two new repeated-input crop failures | Attributed                             | Both paired trials have 736 and 640 changed pixels inside the already-overlapping private input, zero outside; native hit/geometry receipts match the earlier input-root case                                                               |
| Five earlier public-crop failures    | Existing attribution retained          | Private-owner occlusion and aggregate bounding crops explain the measured rectangles; no oracle relaxation or universal public-glyph claim                                                                                                  |
| R4 node-identity failure             | Already resolved in the previous image | Every saved identity receipt on image `1747f851` passes; the earlier summary incorrectly carried forward the historical failure. No identity retest or node exemption was needed                                                            |
| Five R4 withheld images              | Confirmed capability limits            | Mixed public/private pseudo-content requires separate pseudo geometry; the modal case additionally has a real public-paint collision and scaled SVG text                                                                                    |
| Strict DOM/control differences       | Provider effects distinguished         | All 108 previous paired final control receipts and screenshot mutation-kind categories match the unprotected provider. This does not attribute every structural difference; strict failures remain recorded and are not converted to passes |

The fullscreen cause is specific: the graph treats an ordinary button behind an
opaque fullscreen surface as a public-paint collision. A branch-only diagnostic
reproduced the refusal without changing its decision. The repair permits ignoring
that public collision only when native fullscreen membership, an opaque unrounded
background, supported paint styles and full containment of the guarded mask are
proved. It never skips private candidates or changes mask dimensions. Native
`overlay:auto` prevents ignoring dialogs, popovers, future top-layer elements or
pending top-layer removals, including a closing popover that no longer matches
`:popover-open`. Missing or uncertain facts retain the original refusal.

The change follows the native top-layer rendering model in the
[CSS Positioned Layout draft](https://drafts.csswg.org/css-position-4/#top-layer)
and [Fullscreen standard](https://fullscreen.spec.whatwg.org/). Both the ordinary
page and other top-layer surfaces remain possible sources of public paint;
fullscreen alone is not treated as proof of occlusion.

Final delta verification passed **88 affected unit/regression tests**, Veil
typechecking, **20 real-browser boundary checks across both protection entrypoints**,
and the unchanged actual-worker paired fullscreen lifecycle. Browser negatives
include transparent/translucent backgrounds, real public overlap, modal and
popover overlays, pending popover removal, rounded surfaces and mask overflow;
opaque positive cases include device scales one and two. The earlier full result
of 1,490 tests / 18 fast gates / 303 explicit skips belongs to the previous image,
not a repeated full campaign on this delta. Unaffected gates are reused honestly.

All 234 copied runtime/plugin/web files match immutable local candidate
`sha256:7c99953fa2eb6972c32c74f9cc30fd3e4c1190b1a012a0655509e2b46b76c5f3`.
Only `packages/veil/src/native-mask-runtime.js` differs from the preceding image's
runtime manifest. The new boundary regression is
`packages/veil/test/native-fullscreen-occlusion.test.ts`. The cached OS/browser/
dependency base and best-effort recording limits are unchanged.

The remaining unsupported checkpoints are `r4-01-b`, `r4-02-a`, `r4-03-a`,
`r4-05-a` and `r4-05-b`. Direct current-graph diagnostics preserve the original
decisions and identify each refusing owner. Four involve generated private pseudo
text sharing its owner with public text. The modal checkpoint also includes scaled
SVG text and a real public collision. Supporting them would require the separately
described geometry-transport feature and its lifecycle/privacy qualification;
relaxing the existing gates is not a safe repair. These are explicit limits, not
completed visual tests or newly diagnosed application defects.

Evidence is under `results/final-focused-*` and
`results/final-window-20261113/image-r7-manifest.json` in the campaign artifact
directory. Original evaluators, authored fixtures, strict comparison expectations,
all historical failed attempts and earlier blind efficiency results remain intact.
The incomplete prototype is not integrated. No broader campaign follows this
focused close automatically.

## Fourth focused sweep — earlier result, 13 November 2026

**The Etherpad capture defect is repaired locally, and the live packaged Desktop
connection is restored. Release qualification remains incomplete; nothing was
pushed or deployed.** This sweep ran from 13:18:39 UTC with investigation stopped
at 13:53:39 UTC and a hard close of 14:03:39 UTC. Earlier failures and incomplete
results below remain historical evidence.

The actual worker reproduced 42 failed paint receipts in empty Etherpad editor
frames: an unnecessary empty-layer `hidePopover()` raised `InvalidStateError`.
The contained repair removes only its own empty layer after all existing privacy
and geometry gates pass. Explicit paint readiness is recorded only after successful
cleanup or painting. Private-content failures, capacity limits and observation
history retain their existing behavior. The before/after worker probe returned
four of four Etherpad images versus zero of four unchanged; the Node-RED control
returned four of four in both variants. Independent source review found no blocker.

All 18 fast gates passed: **1,490 tests passed, 303 explicit platform/gated skips**.
The Veil package passed 323 tests. All 234 copied runtime/plugin/web files match
the immutable image
`sha256:1747f851ee250f0cbfa4ee49b231d345d39a0ac01f55486485a839f725f9ccf6`.
The complete API/MCP/queue/SQL/browser campaign passed 20 checks across three
fictional application jobs, including video playback/seek, physical browser
release, cleanup and report readback. Its fixed strategy used 95 calls and
707,566 returned JSON bytes; this is compatibility proof, not an agent-loop gain.
The cached Linux/browser base remains a qualification limit.

The unchanged rendering suites completed without evaluator errors:

| Group                  | Cases | Checkpoints | Usable text | Returned images |
| ---------------------- | ----: | ----------: | ----------: | --------------: |
| Original and round two |    24 |          83 |          83 |              83 |
| Round three            |     6 |          12 |          12 |              11 |
| Counterquality         |     1 |           1 |           1 |               1 |
| R4                     |     6 |          12 |          12 |               7 |

No measured private-text failure, public-text omission or informative private-field
pixel dependence remains in these 108 checkpoints. Six images remain unavailable;
unsupported private geometry still fails closed. The specific missing-image cause
at round-three checkpoint `03-enter` is not established by its empty issue array.
Seven public-crop comparisons fail in the original group. A focused unchanged
replay reproduced the five historical failures and located every changed pixel
inside declared private-owner rectangles, with zero outside in both trials.
Hit-testing and text-fragment receipts demonstrate occluded or aggregate crops;
they do not establish universal public-glyph preservation. Two additional failed
comparisons became measurable when the repeated input-root image returned; their
specific attribution remains open. The original oracle is unchanged and red.

A separate identity characterization reproduced the R4 failure class: a late
frame's added node is exactly the constructor-owned protection overlay. Original
application nodes, parents, collections and relative order remain intact; disposing
only that graph restores the strict comparison. This identifies an ownership
boundary, not the discarded historical random seed or exact adapter timing. Strict
DOM/identity acceptance is not silently waived or relabeled as passing.

Desktop inspection established that the installed packaged plugin had no usable
login; custom MCP and packaged plugin names have separate credential keys. The
installer already targets the correct packaged name, so no speculative installer
change was made. The owner completed the normal packaged sign-in and workspace
consent. This chat now exposes **61 Scry tools**, and authenticated discovery reads
two Projects. Two natural five-minute token renewals succeeded, at 13:46:13 and
13:52:49 UTC, with the grant available and not revoked. No reinstall or extra
configuration change was needed. This is current access and renewal evidence,
not a guarantee of arbitrary future Desktop behavior.

Safe evidence is retained under
`artifacts/assurance/customer-experience-campaign-20261110/`: the
`investigation/etherpad-refresh`, `investigation/desktop-exposure-sweep-20261113`,
`results/empty-layer-*`, `results/focused-public-crop-20261113` and
`results/r4-owned-host-characterization-20261113` records. The controlled Etherpad
API capture follow-up passed **13 of 13 checks** on the same image: admitted
1280×720 desktop and 768×720 tablet screenshots, an authenticated five-second
recording with actual playback/seek and range requests, physical browser release
with no pending commands, cleanup and immutable report readback. Recording retains
its explicit best-effort automatic-redaction warning. The test made no application
edits and excluded business journeys. Evidence is in
`results/etherpad-capture-postfix-20261113/runtime/acceptance.json`, with the approved
PNG/MP4 files alongside it. This controlled follow-up is separate from the earlier
blind comparison; it cannot retroactively change that tester's findings or
efficiency score.

## Earlier release status — 13 November 2026

**Not release-qualified; no push or deployment.** The initial complete source
passed all 18 fast-profile gates (1,432 tests passed, 303 explicit gated/platform
skips). All 234 copied runtime/plugin/web files matched image
`sha256:6db2d97eda8116208f5b24fa778ea35c99a584421f61e4ca2e28cf986035bf44`.
The unchanged complete native job passed all 20 checks and three application
jobs, including physical release, video playback/seek, cleanup and report readback.
It retained 95 calls and returned 707,578 JSON bytes versus 619,223 baseline bytes;
this establishes matching outcomes, not an agent-loop or speed improvement.
Two real-browser legacy recording checks and the queued legacy journey passed.

The first runtime use of the independently authored R4 evaluator exposed a
measurement defect before any protection trial: a string callback returned an
uninvoked function. A callable fix preserved the comparator and passed actual
same-node/replacement/reordering negative witnesses. The failed initial run is
retained. The repaired evaluation completed six cases/twelve checkpoints without
evaluator errors and failed acceptance. It exposed missing qualified recovery
credential recognition and selected-option rendered-owner mapping; both now have
causal regressions and contained repairs, with 272 Veil tests passing. Their
rebuilt-image acceptance remains required.

R4 also expects available images for generated private pseudo-content sharing
an owner with public captions, and recognition of opaque unbound values beside
unassociated paragraph labels. The selected subsystem deliberately withholds
the mixed-owner images; the latter labels supply no supported naming authority.
Neither full-owner masking that hides public captions nor an ID-suffix naming
shortcut was accepted. These limitations remain recorded failures of that fresh
acceptance target, rather than silently converted to passes. Broader rendering
or semantic scope requires an explicit reviewed plan. No overall readiness,
universal recognition or continuous recording privacy claim is made.

The contained-repair source subsequently passed all 18 fast-profile gates
(1,439 tests passed, 303 explicit skips). All 234 copied files match rebuilt image
`sha256:b31a47ed858d7f00600ff5a54f3f3f2bdd6ac3e0a4fc0fa16df2d6db526a8614`.
Actual API/MCP/queue/worker/SQL withholding acceptance passed four checks: safe
earlier screenshot retained, unsupported private image withheld, terminal release
confirmed independently of missing video, and cleanup/report readback preserved.
Its first failed fixture assertion had demanded an image assessment from a
text-only navigation; the explicit screenshot assessment and all release/media
assertions remain mandatory. The first red is preserved.

The unchanged R4 rerun completed all twelve checkpoints with no evaluator errors.
All tested functional and native-state invariants passed; no public-text omission
was measured. Seven checkpoints returned images. Fifteen informative available
private-field measurements had no measured generated-value pixel dependence.
Five checkpoints withheld images, and two checkpoints still exposed fragments of
unbound values with unsupported paragraph-label relationships. Only seven of
twelve required output gates passed. Strict DOM checks also remain failed and
separate from native-state/identity proof; they are not silently counted as passes.
R4 readiness remains false. No post-push blind workflow, overall loop improvement,
remote CI, merge or deployment is claimed.

### Additional bounded sweep — 13 November

The owner authorized a second 45-minute window, from 11:28:55 to 12:13:55 UTC,
limited to remaining failures and existing regression coverage. This did not
authorize replacing failed acceptance with a narrower passing oracle.

A reviewed, bounded adjacent-field relation now recognizes private noun-phrase
labels immediately before atomic payloads, including the disclosed unbound
recovery/access values. Canonical names, explicit own names and public metadata
take precedence; prose, action/state controls, hidden labels, ambient headings,
independent groups and capacity overflow cannot supply this weak relation.
It uses the existing graph and bounded history, with no new store, input authority,
public tool or value-bearing IPC. The 30 maintained policy regressions and all
302 Veil tests pass. Thirty-two exact-product browser/ARIA/projection checks pass,
including dynamic naming, hidden/public/canonical labels and traversal bounds.
The complete fast profile then passed all 18 gates: 1,469 tests passed and 303
explicit gated/platform skips. Report: `artifacts/assurance/2f67c5c8-6c9f-4ae5-8ade-d8e303636f9b.json`.
All 234 copied files match rebuilt image
`sha256:1e96824ef2f78bdf66b81e0de457046a4303098b972db232a31afd71d5c7f254`.
This establishes source/image lineage; unchanged R4 acceptance remains separate.

That unchanged packaged R4 rerun completed six cases/twelve checkpoints with zero
evaluator errors and **failed acceptance**. All twelve native state/identity checks
pass, and all twelve protected DOM receipts exactly match their paired provider
receipts. Seven checkpoints return images. Eleven checkpoints return usable text
with no measured generated-value fragments or public-text omissions; the remaining
checkpoint withholds text, so its privacy text condition is unmeasured. A newly
failed private-field pixel comparison at 01a and text withholding at 05b remain
open; its cause was not yet established at that checkpoint. The `public*Preserved`
flags on a secret field compare raw and masked pixels inside that private field;
false is expected for successful masking and does not establish outside-region
damage. Only six of twelve required output gates pass. The earlier seven-gate
result remains preserved; neither focused browser checks nor a favorable rerun may
replace this red packaged result. Finite facts are in
`results/final-window-20261113/r4-adjacent-safe-summary.json` under the campaign.

The text-withholding cause was subsequently reproduced: closed native Details
content retained layout rectangles but was absent from accessibility output.
The narrow correction discharges that hidden owner only when the native rendering
predicate confirms invisibility. First-summary content, reopened content and
author CSS that exposes closed content retain protection; unavailable, throwing
or affirmative visibility checks cannot assert invisibility. Bounded ancestry
uncertainty withholds through the existing capacity path. All 304 Veil tests and
both affected typechecks pass. Exact-source browser checks cover open, closed and
CSS-exposed states with retained privacy history.

All 234 files match the final rebuilt image
`sha256:2382203b487000214e6632ebf3ef3c7bcf3a3b83eabab362e41d1a0b97414ede`.
The unchanged R4-05 case, rerun alone in that image, restores usable protected text
at both checkpoints with no measured private fragments and unchanged native state.
Images remain withheld, strict DOM gates remain red, and this diagnostic subset
is not full acceptance. R4-01a was not favorably rerolled or closed. Its pixel
failure, remaining geometry scope, complete regression and real loop comparison
still prevent release qualification.

The final frozen source passed all 18 fast gates: 1,471 tests passed and 303
explicit skips, report `artifacts/assurance/c9f6a8f6-facc-43ee-b54d-4a9c1df3ae38.json`.
Docker became unavailable during an optional repeat of image inspection after
the suite. It was not restarted. The earlier authenticated image receipt and
completed packaged Details check remain valid; a separate host-hash comparison
records whether current files still match that receipt. No additional browser
campaign or release action follows this timebox.

### Third sweep — bounded continuation

The owner subsequently authorized another sweep, with time reserved for bounded
finish. A deterministic preselected character pair reproduced the R4-01a failure
class: private glyph overhang changed the mask edge and its texture phase even
though the owner layout box stayed fixed. The historical exact random seed was
not retained, so this is causal class reproduction rather than a claim to replay
identical historical pixels.

The contained repair uses the whole HTML owner's layout box and a fixed device
pixel guard for paint bounds. Measured private ink can reject admission when it
does not fit; it cannot size or phase the mask. Existing control, pseudo, SVG,
style, overlap and rounding rules remain. Independent source review found no
blocker. Actual planned-pair output is identical between private values, all
measured private glyphs are covered, four declared public regions remain unchanged,
and independent public-paint overlap and unsupported overhang withhold images.
Blank guard padding is not falsely described as unchanged page whitespace.

All 18 fast gates passed on this source: 1,482 tests passed and 303 explicit skips,
report `artifacts/assurance/3ec97d28-25dc-41b3-aa58-63af4899dbfb.json`.
All 234 copied files match rebuilt image
`sha256:db88ee03d69df4da42a4b40239eb99f68686572a1658cfc8fa1947f7da554c5d`,
including a host-hash comparison after the web rebuild. The unchanged broader
regression and fresh R4 runs remain separate acceptance gates.

The earlier geometry unknowns are now attributed: R4-02a has both a native modal
public-paint collision and an independently unsupported scaled SVG; R4-03a has
private pseudo text sharing its owner with a public caption. Withholding remains
the supported behavior. Adding SVG scaling alone cannot restore the modal image;
no public-owner masking shortcut or experimental CDP transport entered product.

The final measurement bridge passed actual SDK conformance against controlled
HTTP data: discovery, schemas and project reads remain byte-identical to the
original helper, with attempted, successful and failed deliveries accounted for.
This is measurement proof, not a blind execution or efficiency improvement.

### Bounded finish after the third sweep

The unchanged fixed suites completed on the frozen image without evaluator errors:

| Group                  | Cases | Checkpoints | Usable text | Available images |
| ---------------------- | ----: | ----------: | ----------: | ---------------: |
| Original and round two |    24 |          83 |          83 |               82 |
| Round three            |     6 |          12 |          12 |               11 |
| Counterquality         |     1 |           1 |           1 |                1 |
| R4                     |     6 |          12 |          12 |                7 |

Across these 108 checkpoints, no measured private-text failure, public-text
omission or informative private-field pixel dependence remains. R4-01a now passes
its required output gate after the pixel repair. **Overall acceptance remains
failed.** Seven images are unavailable; five visible public-crop comparisons in
the original group remain unresolved. Two of those crops already differ between
raw provider trials. Source layouts permit occlusion by private content, but that
does not establish the actual cause or prove public glyph preservation. All 83
original-group protected DOM receipts match paired provider receipts exactly;
strict oracle failures remain recorded. In R4, the protected-B actor's lifecycle
identity check fails at both R4 frame-case checkpoints; its cause remains
unresolved. No oracle was relaxed. The optional public-crop diagnostic failed
before browser trials on harness setup; it provides no Scry evidence.

A fresh source-blind tester completed the same customer assignment through the
public SDK surface and published/read back its report. Both browsers were released,
pending commands were zero and cleanup was complete. Node-RED's UI import, deploy,
single trigger, debug view, persistence, completed JSON export, scope denial and
removal checks completed. Etherpad's note/reload, read-only view and completed text
export checks completed; live synchronization remained inconclusive, and its
screenshots/recording were unavailable. The tester needed no customer decision.
One local Docker sandbox prerequisite required an operator correction before the
first service request. A local screenshot-parser delivery failure is also retained.

The final job used **65 attempted wrapper requests: 61 service calls and four
discovery/schema attempts**, including failures, versus 85 (77 plus eight) in the
retained baseline with its visual addendum. Metadata receipts reconcile with the
tester manifest: 64 bridge responses plus one pre-bridge sandbox failure; one
recorded service response was not observed because of the local parser failure.
Returned JSON was 1,229,703 bytes versus 1,731,225 baseline bytes. These are
descriptive reductions on one assignment, **not a qualified overall efficiency
win**: core business outcomes match, but the baseline inspected three visual
screens and the final run inspected only Node-RED's debug screen. Etherpad live
sync was not established in either run. JSON bytes are not model tokens; differing
timing boundaries and container init topology prevent causal wall-time claims.

Safe evidence and the returned public PNG are retained under
`results/upstream-final-20261113`, including `complete-job-comparison.json` and
`blind-result.json`. Fixture report ID: `c3adaed2-d891-4659-b3a3-05964688fb12`;
no production report URL was returned or invented. Helper-only blindness is
behavioral rather than an enforced OS boundary. Desktop still exposes no Scry
tools in this chat; fixture success does not validate Desktop loading or OAuth.

The bounded result is a frozen local repair and review record, **not release
qualification**. Remaining work is limited to the named image/crop/identity and
real client exposure gaps; no additional broad experiment campaign follows this
window automatically. No commit, push, merge or deployment was performed.

A separate geometry prototype remains **artifact only**. Seventeen bounded
experiments admit four cases with complete measured private-glyph coverage and
zero changed public-caption pixels; thirteen unsupported, overlapping, stale,
late, mismatched or over-capacity cases withhold. The second disclosed case opens
its credential compartment for this isolated proof; its original closed state
still has another unsupported owner. Inline pseudo quads overlap public text and
remain unsupported. These results establish feasibility, not a production repair,
continuous privacy coverage or a pass of the unchanged R4 acceptance campaign.

Read-only paired receipts attribute all twelve strict DOM differences to the
pinned provider: protected and unprotected receipts match exactly, including its
screenshot-time style mutations. Strict gates remain red. A narrow replay of
the original image establishes that checkpoints 02a/03a are Scry geometry refusals
(`native_protection_geometry_unsupported`, `preserve_gap`) with usable text and
no returned image. The specific unsupported owner remains unidentified. Empty
evaluator issue arrays were a diagnostic limitation: they tracked text readiness,
whereas the existing adapter already returned a separate image assessment.

Release remains held. No complete original regression sweep, final real blind loop
comparison or Desktop host exposure proof is implied by this additional work.
Prior failed and incomplete evidence remains preserved. Production and Vitract
were untouched.

## Design and authority

Use existing command, context, report and connection owners. New interaction
feedback is a pure projection of their facts, not another execution state machine,
permission store or business-outcome judge. Keep all native and retained tool
names, schemas, annotations and authentication metadata compatible with cached
clients. Successful routine calls remain concise. Failure responses identify an
available next action without inventing dispatch, approval or client controls.

Selected-Mission resume facts include bounded task, attempt and exact saved-report
provenance. Recorded text is untrusted task data, never permission. Missing or
truncated consequential facts require the appropriate existing read. Scope-denial
diagnostics are bounded and protected by Veil. Live native semantic recognition
can learn values after a fact receipt, so native publication preserves denial
counts and event windows while withholding endpoint details. Standalone
bound-value diagnostics retain their protected HTTP-origin/CONNECT distinction.
A denied destination alone proves neither cause nor application failure.

## Complete issue register

UX01–UX14 are implemented locally. UX15 includes the verified representation,
capture-readiness and fullscreen corrections described in the current result.
Five unsupported geometry checkpoints and the absolute strict DOM target remain
unmet; they are not relabeled as passing. Qualification remains open until the remaining
independent, packaged and release checks below pass.

| ID   | Improvement                                                                | Required proof and practical limit                                                                                                                                                            |
| ---- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UX01 | Finite command/context/release/error feedback with next actor and action   | Pending checkpoints, refused dispatch, acknowledged action followed by media failure, real uncertainty and common scoped refusals; no uncertain-write replay                                  |
| UX02 | Connection guidance and UI distinguish supported client recovery           | Packaged Desktop uses whole-plugin controls; custom MCP guidance is conditional on offered controls. Healthy authorization does not prove host tool exposure. No forced reconsent loop        |
| UX03 | Native proxy scope-denial observations survive as bounded diagnostics      | Native count-only publication, protected standalone transformed hostnames, idle/current event boundaries, disposal, real proxy and successor admission. Contextual denial is not causal proof |
| UX04 | Guidance separates application outcomes from Scry/provider/evidence limits | Independent semantic and real application tests preserve blocked, excluded, uncertain and verified results                                                                                    |
| UX05 | Short scoped questions reuse applicable recorded answers                   | Fresh held-out scenarios cover necessary human choices, no invented approvals and no routine Scry repair offloaded to customers                                                               |
| UX06 | One context read supplies factual selected-Mission resume                  | Exact report identity, missing/timeout/rejected/truncated parts, exclusions in scope/limitations, independent-read provenance; no inferred correction lineage                                 |
| UX07 | Reuse returned observations and request only missing facts                 | Matched complete-job call/byte ledgers, including discovery, errors, cleanup and report readback; request timing alone is insufficient                                                        |
| UX08 | Guidance promotes guarded known-step groups                                | Existing semantic guards and durable acknowledged prefixes stay authoritative; split when page meaning changes                                                                                |
| UX09 | Consolidated native guide and contextual recovery                          | Native guide reduced from 14,300 to 12,544 UTF-8 bytes; exact 61-native/33-retained catalog compatibility and budget gates remain required                                                    |
| UX10 | Reuse actual stop/release receipts and reconcile cleanup                   | Poll only unfinished operations or missing release facts; completion is not inferred from an agent statement                                                                                  |
| UX11 | Reports name unresolved owner/action and evidence limits                   | Immutable publication/readback, original exclusions and exact report linkage preserved; no false follow-up authorization                                                                      |
| UX12 | Privacy warning explains affected intervals and usable review controls     | Friendly reasons, technical detail disclosure, recording-relative seek only when media is ready; absence of diagnostics is not a privacy guarantee                                            |
| UX13 | Semantic, adversarial and whole-job qualification                          | Independent authors/judges, fresh blind application runs, preserved red regressions and explicit environmental limits                                                                         |
| UX14 | Concise goal-level progress and natural next steps                         | No fake background work, premature future outcomes or unsupported UI instructions; synthetic personas do not establish actual novice usability                                                |
| UX15 | Protect recognizable generated credentials without corrupting public text  | Actual text and returned PNG checks, modal/popover/fullscreen ordering, typed control semantics, bounded failure and disposal; no universal unknown-secret recognition claim                  |

## Qualification evidence so far

The sections below preserve earlier source identities and their outcomes. The
current result and issue register above govern the latest status; historical
failures are not silently removed when a later repair resolves them.

**UX15 — Recognizable generated credentials in native observations.** The blind
Etherpad run exposed an unnecessary deletion-token field. A separate fictional
matrix proved that native text cleaning discards control semantics, while visual
masking misses associated labels and some credential names. Trusted application
output does not exempt credentials. The selected repair keeps semantic policy in
Veil and uses existing private worker evaluation to protect text and pixels,
with bounded session-local recognition and no reusable credential creation. It
must preserve ordinary token counts and identifiers, action/dispatch truth, and
best-effort warnings. Later fresh tests reopened the protection subsystem as
described below; source and packaged-browser acceptance remain release gates.

Recognized page values remain private session data; they do not become reusable
credential references, bindings or permission. A later operation requiring a
one-time generated token needs an actual supported protected handoff. Otherwise
retain the resource and report the cleanup/access gap with its next owner; never
recover plaintext from pixels or logs. The Etherpad acceptance task explicitly
preserves its pad, and Node-RED cleanup requires no generated credential.

Text admission and pixel protection remain distinct. Incomplete text protection
withholds page text and actionable observation identity while preserving actual
action receipts. The selected subsystem correction will omit a whole image when
known private paint cannot be covered, while retaining independently valid text.
New recordings require a capture-bound best-effort assessment; an observed known
protection gap prevents admission of that recording. This is not continuous
privacy certification, and unobserved surfaces remain an explicit limitation.
That subsystem is still being qualified in isolation.

Media feedback is now integrated locally after a 328-assertion isolated contract
experiment. It retains pending, refused, uncertain and scope-restricted ownership.
Image-only gaps distinguish actual guarded snapshots from error-only receipts;
a supported read-only image recovery requires both tool exposure and the live
Run fact, and is conditional on need and no previous attempt. Confirmed release
with a withheld recording continues reporting instead of polling missing media.
Contracts (82 tests) and the MCP SDK/transport/catalog suite (87 tests) pass;
producer/media-admission integration and packaged acceptance remain outstanding.

A later fresh source-blind communication round used six situations and fourteen
stages. Independent judgment found one avoidable screenshot after sufficient
basket text; no material truth, permission or recovery failure was found. The
original result remains recorded. Guidance now ties screenshots to a visual
question or distinct required evidence. A new independent author, assistant and
judge then passed four unseen situations/six stages, plus the two relevant
regression situations/four stages, with seven proposed calls and no judged
unnecessary calls or questions. These are conditional model simulations, not real
service executions, tool-schema compatibility, timing or human usability proof.

The selected privacy subsystem is now being integrated across Veil, the native
worker, physical recorder and Chronicle. Private per-read source ownership keeps
text and image claims separate, including duplicate values, shadow/frame scope,
metadata history and unsupported paint. Finite capture facts carry no learned
values or DOM descriptors. New recording admission requires authenticated v2
lineage, actual stopped bytes, a newly challenged post-stop read, producer drain
and a seal. Historical admitted media retain their historical policy. A known
private protection gap withholds the affected recording; an unobserved public
transient remains a best-effort limitation rather than universal suppression.

The closure boundary explicitly revokes producer authority before draining all
previously accepted callbacks. A late in-memory veto after a green seal was
rejected because a crash could preserve the seal without the veto. Chronicle's
current component suite passes 163 tests, including authenticated crash prefixes,
durable seal failures and recovery. The maintained SQL integration suite passed
seven tests; four underlying SQL concurrency/rollback regressions also passed.
These use actual database admission and harmless placeholder media, rather than
a running encoder. Worker transport and complete-system acceptance remain gates.
Physical recording now separates encoder stop from display/browser cleanup,
uses original process handles and kernel parent-death cleanup, and conservatively
reports uncertain startup retirement. Product Linux custody proof is pending;
earlier isolated physical experiments are not complete-system release proof.

An independent review of the stable evidence boundary found no confirmed blocker,
and independently repeated the seven SQL integration tests. Three further actual
worker/Chronicle/engine bridge probes passed. Ten maintained refresh tests still
need migration to the new private typed protocol while retaining their earlier
frame, budget, late-reply, paint and disposal guarantees. A separate safe injected
counterexample also showed that losing registration of a newly spawned utility
could falsely confirm cleanup after initial startup. The selected correction
registers an acknowledged acquisition intent before every spawn and preserves
uncertainty until identity or positive exit proof arrives. This is still being
implemented and qualified; it invalidates the earlier physical source freeze.

Existing status and media responses now carry the same finite recording
assessment. Optional assessment I/O failure preserves authoritative release
facts and reports availability uncertainty. Six focused API transport tests,
seven focused contract tests and 22 related web tests pass. The UI explains that
withheld footage cannot be recovered by refreshing and preserves independent
safe media. A separate actual API/MCP/queue/worker/SQL acceptance harness has been
prepared to test withheld recording, safe earlier screenshot, physical release,
cleanup and incomplete report readback. It has not yet run on the final image.

The host removed Scry's tool namespace during this campaign. This establishes
unavailable host tool exposure, not revoked authorization or a server failure.
No connection or installation was changed. Final Desktop authenticated-read
acceptance remains unavailable unless the host exposes the tools again; isolated
service qualification can continue. Reinstallation or reconsent is not prescribed
without evidence that it repairs the actual failing layer.

Evidence is retained under
`artifacts/assurance/customer-experience-campaign-20261110/` (local assurance
artifacts are not automatically included in a source commit).

- Frozen main baseline: `f4f513e9326f2edd6344a6394a4324d87391c941`.
- Independent author supplied 24 held-out scenarios. First conversation comparison
  found a shared premature final-count assertion, not a candidate advantage. After
  revision, a fresh 13-case/23-stage round passed semantic review. Simulations do
  not replace actual execution evidence or human usability research.
- Independent source review found four defects despite initially passing tests:
  embedded IDNA disclosure, false uncertainty after refusal, intermediate receipt
  misclassification and omitted report constraints. Red reproductions were
  preserved before correction. Final independent recheck is required.
- Actual database/queue qualification passed 45 tests across scoped context,
  refusal/successor admission, journey/workflow, authorization, saved reports,
  cleanup, claim fencing and process recovery. No new schema migration is added.
- Web suite: 255 passed, one existing platform-dependent skip. Web/plugin production
  build passed with packaged plugin version 0.1.6.
- Deterministic baseline: 95 SDK requests, 619,223 returned JSON bytes and 61,191 ms
  for the complete three-app and failure/lifecycle/evidence campaign. Candidate
  results must preserve the same accepted state and checks before comparison.
- First candidate passed the same checks with 95 requests but returned 719,355
  bytes, a 16.17% increase. This is not an efficiency improvement. Repeated
  interpretation of successful actions with incidental restrictions was removed;
  all authoritative diagnostics remain. The revised complete-job comparison is
  outstanding. Single-pair timing is not a speedup claim.
- A subsequent unchanged-source serial diagnostic passed the same 95 requests,
  cleanup and report checks with 697,133 returned bytes and 48,724 ms. Payload
  remained 12.58% larger than baseline. A concurrent run had withheld a third
  application's observation after two completed jobs. Both results are retained;
  neither proves an agent-loop or timing improvement.
- Source-blind upstream baseline completed with 74 tool calls plus seven attempted
  discovery/schema requests, including one local sandbox refusal. Both browsers
  were released and cleanup reconciled. Live Etherpad propagation remains
  unconfirmed; completed exports do not prove their semantic contents were read.
- A separately retained read-only visual addendum retrieved and inspected all
  three screenshots. Cumulative baseline: 77 calls plus eight attempted
  discovery/schema requests. Pixels confirm the note, local debug result and
  removed flow. Recordings remain unwatched. The earlier 74-call result is not
  replaced or silently enlarged when comparing campaigns.
- The predecessor candidate's independent Etherpad/Node-RED run completed its
  business checks and report with 88 attempted tool calls and five attempted
  discovery/schema calls. Its ledger recorded 86 completed tool requests and four
  schema calls; two tool deliveries and one failed discovery attempt had no
  structured receipt. Those attempts are not discarded. The agent asked no human
  questions and did not replay business writes. Ten protection-refresh failures
  and ordinary-word overprotection prevent accepting it as an efficiency win.
  Three screenshots were inspected; recordings and live Etherpad propagation
  remain unverified. This run does not qualify the later corrected source.
  Against the baseline plus its visual addendum, candidate discovery/schema
  attempts fell by three and context/status reads by one, but actions increased
  by seven and observation/media requests by five: eight more attempts overall.
  Name-only traffic ledgers cannot attribute every extra call or establish replay
  semantics; the blind agent's no-replay statement is separate evidence.
- The unchanged original privacy oracle executed all 16 cases and 62 checkpoints
  without evaluator errors. It exposed a top-layer modal image leak and a private
  service-credential text/image leak. All 72 capacity rows had an informative
  image checkpoint; three clipped checkpoints lacked glyph signal and remain
  unverified. Strict DOM failures are retained: their style-attribute mutation
  kinds matched the pinned unprotected provider. Core value, type, readonly,
  focus, selection, scroll and event invariants held. Fresh eight-case acceptance
  remains hidden from the implementation author until the next source freeze.
- Independent reproduction showed that a password-setting checkbox's default
  value could be learned as a credential and corrupt ordinary words. The repair
  uses one source-aware control decision for text and pixels, with separate
  authoritative bound values. It does not solve this by ignoring short secrets.
- A quiet cold three-frame page also reproduced an availability defect: critical
  fact reads took at most 0.1 ms each, but optional image waits of 101–103 ms per
  frame exhausted the 200 ms admission budget. The selected correction separates
  critical facts from optional paint confirmation, retains the budget and failure
  warnings, and may add one private browser evaluation per frame. It adds no
  public tool call. The earlier no-extra-private-evaluation design constraint is
  superseded. The focused corrected-image probe admitted all six reads, including
  cold three-frame and two-page/three-frame topologies. Combined waits remained
  118–202 ms; optional paint timeout/failure warnings were retained, and critical
  reads had no pending work. This is availability proof for those fixtures, not
  a universal timing or screenshot-protection guarantee. Final packaged and
  independent-source qualification is still required.
- A later independent actual-runtime composition reproduced a background-learning
  race: native browser knowledge changed during optional paint after the parent
  accepted empty facts, and a diagnostic hostname could escape protection.
  Native endpoint details are therefore deliberately withheld rather than
  authorized from a momentary empty registry. Counts, event windows and actual
  dispatch/refusal facts remain. A new knowledge-epoch protocol is outside this
  bounded repair; another final read would not close arbitrary idle callbacks.

## Historical release gates and progression

The earlier, superseded complete local image was
`sha256:c2c1e94a353744ac9c4d57d00a7944f49db40a99926a0d8ddb5fced4b37d1a23`.
Its 71 changed product/plugin and built-web file hashes match the checkout.
Required fast qualification passed all 18 selected gates: 1,277 tests passed and
296 gated/platform tests were explicitly skipped. That profile includes types,
format, package tests, web/package build, closure, ownership, cached catalog and
release-controller checks. Database/browser campaigns below are separate proof.
The first complete image was superseded when the required web build refreshed
downloadable plugin ZIPs for the final guide; none of its stale packages are used
for final acceptance. The cached Linux/browser base remains a qualification
limit; remote fresh builds are still required.

This image is **not release-qualified**. Its unchanged 24-case/83-checkpoint
browser evaluation had no secret-text exposure, generated-secret pixel dependence,
unavailable outputs or evaluator errors. The eight new cases nevertheless exposed
public display-name overprotection: seven public-text omissions and thirteen
public-region pixel failures. Six unoccluded pixel failures in three cases
independently establish the metadata defect; seven occluded regions lack sufficient
pixel attribution and remain unverified. Native control/state facts matched the
provider. All 82 strict DOM failures remain recorded with matching provider
mutation facts. The separate checkbox counter-check preserved public content,
credentials and native state, with its provider DOM failure retained.

The source cause was independently reproduced: metadata semantics recognized
“credential name” but not a metadata head such as “Display name for private access
credential”. The bounded correction in the existing shared semantic owner is
implemented and independently reviewed, including routine whitespace, prefix and
suffix forms. Strong private-source and explicitly protected-value authority stay
intact. Eight focused real-browser text/PNG checks passed across both wrappers,
ordinary pages, modal, fullscreen and rebuild states. Public pixel differences
were exactly zero; private value dependence was zero. Six new independently
authored cases remain hidden from the implementer for acceptance after correction;
the failed cases are now regressions.

The latest complete image before the subsystem integration was
`sha256:1809eac67e83eb25edc460643c0313955bb59742419c46c9fac01a150ecd0bfe`.
Independent review verified all 71 host/image hashes and current packaged skill
bytes. Required fast qualification passed all 18 gates with 1,317 passing tests
and the same 296 explicit gated/platform skips. The changed real-database context
and successor-admission boundaries passed eight tests without skips; the earlier
45-test database campaign is retained separately. No migration is added.

The same complete deterministic campaign passed with matching application states,
fault checks, evidence, physical release, cleanup and report readback. It used
95 calls, exactly matching baseline, and returned 692,681 JSON bytes versus
619,223: an 11.86% increase. Its 48,551 ms versus 61,191 ms single-run timing is
not a causal speedup claim. This establishes outcome equivalence, not total
agent-loop reduction. Fresh blind traffic is measured separately. This historical
image does not qualify the newer subsystem source now being integrated.

1. Complete source integration, independent boundary review and actual SQL,
   physical custody, callback-drain and withheld-media terminal/report checks.
   Run full fast qualification, rebuild the complete image and verify its source
   and downloadable plugin hashes. No prototype-only result substitutes for this.
2. Rerun the unchanged original/regression cases and new independent rendering
   cases on that frozen complete image. Preserve strict provider effects and
   unverified regions without normalizing passes. Repeat the unchanged complete
   deterministic comparison, retaining accepted states, calls, bytes and limits.
3. Push a proper PR only after local qualification. Complete fresh source-blind
   runs on separate Etherpad and Node-RED fixtures against the exact pushed source.
   Use public Scry interfaces and actual persistence, export, cleanup, release and
   report readback. Preserve upstream limitations separately from Scry defects.
4. Require remote checks and fresh post-push other-app acceptance before guarded
   merge/deployment. Preserve active
   work admission. Do not substitute Vitract for these fixtures.

### Fresh rendering/representation failures — release blocked

The next serialized acceptance completed 31 cases and 96 checkpoints without
evaluator errors. The original metadata failures were corrected. Six genuinely
fresh cases exposed eight returned-text fragment observations and ten failed
private-pixel checks. Three private regions were exactly equal to the unprotected
provider with positive glyph signal: the same explicitly bound record after
relocation into an open shadow root, and CSS-generated credential text before and
after an update. Seven other private-pixel comparisons remained value-dependent;
these are failures requiring attribution, not seven established full disclosures.

Controlled reproduction on the unchanged image confirmed that qualified CODE and
SVG payloads never entered input-only learning, and browser and Node intrinsic
recognizers disagreed. Actual `browser_snapshot` returned the complete fictional
repository token; explicit binding removed it. Shadow relocation and `::after`
content independently reproduced the raw-image gaps in both wrappers and the
actual worker. This is a shared candidate/representation invariant failure, not a
set of application defects. A bounded Veil subsystem correction is recommended;
no renderer-level replacement, credential store or public permission is added.

The same run suppressed one public reference identity across 33 observations,
with preserved pixels. Its original random value/output were discarded, so the
exact historical cause remains unknown. Independent controlled probes establish
alternative generic-builtin and conditional AX-parser false positives with no
bound/learned authority; they must not be retroactively assigned to that run.
Qualified labels such as Secret, Private key and Private token also have a
separately reproduced vocabulary gap. These findings remain open.

All fresh functional, native-state and required node-identity checks passed.
Physical fullscreen coverage failed at two checkpoints in both provider and
protected trials and remains unverified. Provider DOM changes and seven occluded
public-region comparisons remain separately retained. No failed oracle was
edited, normalized or silently promoted to a pass. No commit, push or deployment
has occurred at this stage.

Source-private helper instructions provide behavioral isolation, not an OS
security boundary. The Scry request ledger proves requests; it does not prove
every possible source access. Desktop/Windows UI behavior, live third-party
providers and actual human usability retain their own limits. There is no claim
of a universal optimum or zero possible regression.

## Research applied

[Microsoft's human–AI interaction guidance](https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/)
informs capability, uncertainty and recovery communication.
[GOV.UK error guidance](https://design-system.service.gov.uk/components/error-message/)
informs concrete, actionable messages.
[OpenAI skill evaluation](https://developers.openai.com/blog/eval-skills)
informs trace and thrashing assessment instead of final-prose-only scoring.
[MCP tool-result requirements](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
inform contract compatibility and failure results.

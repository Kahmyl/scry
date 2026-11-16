# Remaining rendering and recording repair

Status: implemented locally with isolated verification and independent review.
Push was authorized on 16 November 2026; deployment still requires owner review. The serving release remains
`b7666ce`; no production configuration,
connection, customer data or Vitract workflow is part of this work.

## Local implementation results — 14 November 2026

The approved repair now exists in the product source. At the close of local
verification on 14 November, nothing had been committed, pushed or deployed. The earlier investigation below is retained as historical
evidence; its prototype-only conclusions do not describe the current local diff.

- **SVG safety:** native character envelopes reject strokes, decoration, outlines,
  reflection and unsupported transforms. Descendant `tspan` overrides are checked.
  The whole-SVG shortcut requires actual viewport clipping. Positive axis-aligned
  scaling is supported; unsafe ink still withholds the image.
- **Generated text:** selected substrings are recognized and safely refused when
  only part of one generated string is private. Whole-private pseudo text beside
  independent public content uses graph-selected native quads. Private DOM handles,
  values and protocol descriptions stay inside the worker. Font loading, layout,
  policy, read, world incarnation and deadline fences invalidate stale geometry.
  CSS reflection and unreliable font metrics are explicitly rejected.
- **Public content:** opaque native modal/fullscreen surfaces are checked before
  ignoring background collisions. Background masks are subtracted from a unique
  proved foreground surface. Ambiguous, translucent and unsupported surfaces retain
  safe refusal. Native controls and application nodes are not rewritten.
- **Recording:** successful installed masks can be acknowledged at the existing
  deadline only after fresh owner, layout and rectangle validation. Missing first
  paint, replacement owners, stale policy and real earlier gaps remain failures.
  After physical recording stop, one bounded final read retry is permitted for a
  recoverable read, with the same epoch/challenge and no required gap. The live
  maintenance budget remains **200 ms**; the final-only allowance is **600 ms**.
- **Recovery feedback:** permanent geometry refusals retain their finite
  `geometry_unsupported / preserve_gap` receipt and usable text, rather than being
  presented as an endlessly retryable refresh failure.

Verification uses fictional local fixtures, isolated Chromium and network-disabled
Docker. Passing checks were reused; only affected scenarios were rerun after a
change. New tests are registered in the maintained verification gate.

| Evidence                                   | Local result and interpretation                                                                                                                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original actual-worker rendering scenarios | All five formerly unavailable checkpoints now return images. Across eight checkpoints, both generated-value trials return images; all **39 private and 35 public scored fields** pass their existing field checks.                                                  |
| Final child-frame transport check          | Both original child checkpoints return images and pass their required gates after the final coordinate guard.                                                                                                                                                       |
| SVG/pseudo ink safety                      | 28 browser cases across both native-script wrappers pass, including descendant strokes and `font-size-adjust`.                                                                                                                                                      |
| Independent adversarial browser review     | 17 cases pass: selected pseudo substrings, unsafe envelope outsets/reflection, font-cache invalidation and transport-to-receipt refusal feedback.                                                                                                                   |
| Private transport                          | 47 unit/fault cases and three real-CDP scenarios pass across targeted runs; nine capability lifecycle/boundedness cases pass.                                                                                                                                       |
| Final-read helper and caller               | 21 helper cases, six existing recorder-retirement cases and four targeted caller lifecycle cases pass.                                                                                                                                                              |
| Actual native recording lifecycle          | Four physical custody → native worker → Chronicle cases pass. After shared acknowledgement changes, normal recording and the known-gap refusal were rechecked and pass. The admission fixture is in memory; this is not a new database-owner-fencing qualification. |
| Paint acknowledgement faults               | 13 maintained browser cases pass, including delayed second frame, missing first frame, changed CSS/layout/policy, replacement nodes in both acknowledgement branches, disposal and preserved earlier gaps.                                                          |
| Existing rendering/recording regressions   | Six rendering and two recording cases pass after integration.                                                                                                                                                                                                       |
| Types and packaging reachability           | Veil, Praxis and Assurance typechecks pass. Repository closure passes, including the new private runtime modules and adjacent TypeScript declarations.                                                                                                              |

**Retained limits and failed checks:**

1. The original combined rendering evaluator still exits nonzero. Its strict DOM
   assertions detect Playwright's caret-style writes, also observed in the bare
   provider control. Both shadow-DOM checkpoints additionally count one newly
   installed closed masking host during capture (`identityValid` fails). All
   baseline application nodes retain identity/membership; teardown restores the
   original tree. These strict failures have not been renamed or waived.
2. A generated private presentation that appears before its native mask is
   installed can create a genuine recording gap. A later available screenshot
   preserves that historical gap; its video remains withheld. This repair does
   not certify every dynamic layout or a compositor-wide privacy guarantee.
3. Lossy WebM can overshoot the source mask colour palette. The earlier failed
   colour-only measurements and opaque calibration control remain preserved;
   no encoding tolerance was widened and no new universal pixel guarantee is
   claimed. Exact historical macOS failure timing remains unproven.
4. No hosted CI, production rollout, real-account testing or new full database
   qualification was run in this local review phase.

Primary receipts are under
`artifacts/assurance/customer-experience-campaign-20261110/results/local-implementation-20261114/`
and
`artifacts/assurance/customer-experience-campaign-20261110/investigation/rendering-recording-repair-20261113/results/`.
The unchanged original worker oracle result is
`results/final-focused-round4-local-implementation-r1-20261113/evaluation.json`
within that campaign. Prior failures remain alongside later targeted passes.

## Historical investigation: outcomes and acceptance

1. Restore images at the five original unsupported checkpoints without changing
   their authored actions, required public content, privacy requirements or oracle.
2. Explain the intermittent recording gap and prevent avoidable gaps at their
   source. Never clear a recorded gap, publish uncertain footage or retry business
   actions to obtain a successful recording.
3. Keep private values, DOM descriptions and raw pixels inside disposable fixture
   processes. Persist finite diagnoses, measurements and source identities only.
4. Retain earlier failures and distinguish expected safe refusals from restored
   capability. A negative-control pass is not an available-image success.

## Evidence and repair scope

Rendering attribution already identifies mixed public/private generated content
at four checkpoints. The fifth also has scaled SVG text and a public modal paint
collision. An earlier prototype measured selected open-state feasibility, not the
five original checkpoints. It used a copied earlier graph and lacks complete
world, lifecycle and layout-invalidation qualification.

Recording has observed `native_protection_refresh_incomplete` outcomes on macOS,
plus successful macOS and Linux attempts. The precise causal phase is unproven.
Increasing a deadline or accepting incomplete protection is not a repair.

Options:

| Scope                                                                    | Coverage                                                                                          | Cost and residual risk                                                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Retain refusals and improve explanation                                  | No rendering capability restored                                                                  | Smallest change; fails the requested outcome                                                           |
| Focused geometry/paint transport, plus a cause-specific recording repair | Exact graph-owned generated/SVG candidates, bounded supported paint, coherent recording lifecycle | Recommended; requires private transport and lifecycle tests; unsupported effects remain explicit       |
| Replace rendering and recording foundations                              | Potentially wider arbitrary-layout support                                                        | Large compatibility and verification burden; current evidence does not justify a wholesale replacement |

The experiment will evaluate the recommended scope outside shipped sources. Any
broader production implementation remains a review decision after the results.

## Investigation and experiment sequence

1. Freeze current sources and reuse the existing failure receipts. Inspect only
   unresolved checkpoint ownership and recording admission transitions.
2. Instrument a copied recording path with finite phase, deadline, read-generation
   and gap-reason facts. Reproduce the narrow fixture on macOS/Linux; use controlled
   delayed/stale transport to separate real missing protection from lifecycle
   bookkeeping failures. Preserve cancellation, final-read and failed-start behavior.
3. Port the earlier geometry feasibility mechanism onto the exact current graph.
   Resolve only graph-selected owner references in their originating isolated world.
   Test precise pseudo fragments, scaled SVG and modal/public occlusion separately.
   Avoid broad document snapshots as a second classifier or value transport.
4. Verify original states before synthetic variants. Measure private glyph coverage
   and unchanged public pixels from actual screenshots in memory. Exercise wrong
   page/world/read/policy, stale layout, navigation/removal, late replies, capacity,
   cancellation and remote-object release. Keep failures unavailable.
5. Test candidate recording prevention with the original recorder and Chronicle
   admission contract, including incomplete/withheld outcomes and teardown. No
   favorable retry counts as proof of resolving the original timing cause.
6. Report exact results, unverified claims, implementation order and release gates.
   Do not rerun unrelated passing campaigns or start hosted CI in this phase.

## Ownership and proposed invariants

Veil remains the sole candidate classifier, policy owner and geometry acceptor.
The worker transports bounded geometry for exact ephemeral owner references; it
does not discover secrets or persist browser node descriptions. Facts are scoped
to page, execution context, graph instance, read, policy and layout generation.
Old/partial/late facts cannot certify a newer image. Every acquired remote object
is released on success, failure and cancellation.

Chronicle remains the evidence admission authority. A physical recording needs a
complete admitted capture epoch and a fresh final protection assessment. A missed
required-protection interval remains a gap even if later frames recover. Text
readiness, optional paint completion and historical continuous coverage are
distinct states; diagnosis must identify which transition actually fails.

## Research basis

- Chromium's [DOM protocol definition](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/DOM.pdl): exact node references, pseudo nodes and content quads.
- Chromium's [DOMSnapshot protocol definition](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/DOMSnapshot.pdl): paint-order/layout data is available, but snapshots also include broad DOM/value data and version-sensitive text layout. It is not an approved default transport.
- The [HTML rendering-update model](https://html.spec.whatwg.org/multipage/webappapis.html#update-the-rendering) distinguishes animation callbacks, style/layout and rendering updates. The proposed mask acknowledgement remains a bounded best-effort assessment, not a compositor or universal privacy certificate.

## Findings and tested direction

| Item                                              | Proven cause or remaining uncertainty                                                                                                                       | Proposed repair and isolated result                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generated text with an independent public caption | Whole-owner masks cover public content; ordinary DOM ranges do not identify the private pseudo fragment                                                     | Resolve only graph-selected pseudo nodes through native CDP geometry, with read/world/policy/layout fencing. Direct tests restored the four affected original states with measured glyph coverage and unchanged declared public fields.                                                                                                                                                |
| Scaled SVG text                                   | The existing non-atomic SVG envelope accepts translation only                                                                                               | Map native character bounds through positive, axis-aligned SVG transforms. Preserve refusal for unsupported ink effects. The original scaled case is measurable; a stroke stress test exposed insufficient bounds in the first prototype, so stroked/decorated text is explicitly refused by the revised prototype.                                                                    |
| Modal overlap                                     | A global top-layer mask can cover a public modal, and public content behind the modal can be mistaken for a foreground collision                            | Share one bounded opaque-surface proof with fullscreen support. Subtract only proved opaque occlusion and ignore only proved background public paint. The original modal case passes its direct pixel check. Unknown/translucent/rounded/native-stack cases must remain refused until separately qualified.                                                                            |
| CSS-only layout changes                           | A fixed owner box can remain unchanged while a descendant moves its generated text                                                                          | A bounded descendant-layout witness, checked at acceptance and rendering, rejects the demonstrated CSSOM flow-collapse counterexample. Scope is capped; expired/missing/foreign/duplicate geometry and same-read revival remain refused.                                                                                                                                               |
| Geometry and recording interaction                | Rebuilding a graph for acknowledgement discards a geometry packet keyed to the old graph object                                                             | Use a shared, immutable mask-installation receipt with fresh owner/layout validation. The independent prototypes did not compose; a combined prototype exercises the receipt rather than reopening an expired geometry ticket.                                                                                                                                                         |
| Late paint notification                           | A successful mask installation can be rejected while waiting for a second animation-frame notification                                                      | At the existing deadline, validate the completed installation against a fresh classification, unchanged owners/layout/rectangles and the still-connected mask. Controlled baseline recording is withheld; the guarded prototype completes. A delayed first paint and changed CSS still withhold. No old gap is cleared.                                                                |
| Final read after physical stop                    | A late private reply can exhaust maintenance time after native recording has ended, leaving a recoverable final assessment unconfirmed                      | After confirmed physical stop only, drain pending private work and permit one challenge-bound read for `read_only_once`, provided no required gap was observed. The experiment recovers the late reply, refuses an earlier real gap and finishes a never-returning case without an unbounded retry.                                                                                    |
| Historical macOS attempts                         | Earlier receipts identify `native_protection_refresh_incomplete` but lack the phase detail needed to prove which mechanism caused those particular attempts | The controlled mechanisms are proven; exact retrospective attribution of the two earlier attempts remains unavailable. Three new unmodified traces completed normally. A passing rerun does not resolve historical uncertainty.                                                                                                                                                        |
| Video colour check                                | Lossy WebM can overshoot the source mask palette                                                                                                            | Linux reproduced bright-only overshoots. A no-text, fully opaque control also produces them: source red tops out at 234, decoded control reaches 243. An unmasked-text control produces abundant dark pixels. Keep the original failed measurements; replace colour-only privacy inference with calibrated appearance checks plus independent glyph/nondependence and admission tests. |

These are **prototype results**, not production fixes. Tests that deliberately
withhold uncertain evidence prove refusal behavior, not restored image capability.
Neither the existing strict DOM/provider-style outcomes nor prior incomplete
assessments are relabeled.

## Coherent implementation plan

### First priority: the contained SVG safety guard

The stroke boundary is also a defect in the **current translation-only renderer**,
not just a risk from adding scaling. In the offline current-graph reproduction,
the result was available but only 12,080 of 15,393 measured private glyph pixels
changed under the mask; 3,313 remained uncovered. This is a fictional fixture,
not evidence of a particular customer's exposure. It nevertheless makes the
small refusal guard the first repair, before broader capability work.

The actual isolated adapter/MCP screenshot path confirms it too: the final
baseline returned an available image with 3,697 of 15,777 measured private glyph
pixels uncovered. With the guard, no image was returned and `imageEvidence`
reported `native_protection_geometry_unsupported` / `preserve_gap`; usable text
remained available. An ordinary unstroked SVG sibling still returned an image
with all 3,381 measured glyph pixels covered. This is an actual worker/provider
boundary proof in an offline fixture, not a test of live customer data or the
full API/database lifecycle.

`investigation/rendering-recording-repair-20261113/stroke-refusal.patch` in the
campaign contains the reviewable minimal guard. It refuses unproved SVG stroke,
decoration and CSS text-stroke outsets in the non-atomic text envelope. It changes
no policy, deadline, data or evidence history. The broader prototype already
refuses the stroked case. Shipped source has not been edited; deployment remains
held for owner review.

### 1. One private geometry and mask-receipt contract

Define a typed worker-private scope containing browser incarnation, page, frame,
isolated execution context, graph/read identity, policy generation and layout
revision. Separate an external geometry ticket from the receipt of a completed
mask installation. A late reply cannot reopen a failed/expired ticket. A later
acknowledgement may reuse a completed installation only after fresh classification,
owner identity, geometry and connected-layer checks all agree.

Veil owns classification, candidate selection, occlusion and acceptance. The
private browser transport resolves only exact selected node references and
returns bounded quads. It releases object groups on every exit path. Both native
adapters use the same implementation; no new public MCP tool or agent round trip
is required. Retain the current public tool schemas and evidence reason codes.

The prototype's full computed-style/layout witness is deliberately conservative.
Production implementation must retain its CSSOM counterexample guard and bounds,
measure its cost, and refuse unsupported cases instead of dropping checks to fit
the budget. Native pseudo objects in the tested Chromium expose no rectangle or
quad method; simply replacing CDP with a guessed browser API is not viable.

### 2. Implement the supported rendering slice

Support whole-private pseudo fragments with independent public captions, positive
axis-aligned SVG scaling and the proved opaque modal/fullscreen cases. Centralize
native opaque-surface validation; do not copy separate modal/fullscreen policy
branches that can drift. Retain existing private-owner recognition and bounds.

Keep rotated/mirrored SVG, unproved stroke/decoration outsets, ambiguous public
overlap and stale layout unavailable. Those boundaries must be explicit in
capability/result feedback. This fixes the five named qualification states; it
does not promise arbitrary CSS/SVG support.

Avoid redundant private calls: include the request's local owner box in the
private packet, resolve references using cheap identity fencing, and repeat the
full layout witness at acceptance/rendering. Main-frame quads need no extra frame
conversion query. Child-frame mapping stays validated. Read/paint work shares
the existing live 200ms envelope; do not create independent budgets that add up
beyond it. No causal agent-latency improvement has been established by this study.

### 3. Repair recording acknowledgement and finalization as distinct phases

Use the same mask receipt for screenshots and recording status. The live path
keeps its existing deadline. Missing protection, changed ownership/layout, stale
worlds and recorded gaps still fail closed. A DOM installation acknowledgement
is not a certified compositor/privacy guarantee; the product remains best effort.

Finalization begins only after physical recording stop. Permit at most one
read-only retry of a recoverable unconfirmed final read, with the same capture
epoch/challenge, a new read generation, pending-task drain and the outer stop
deadline. The prototype uses a 600ms final-read allowance; its never-returning
case closed in 704ms including later still/teardown work, with recording withheld.
This is separate from the unchanged 200ms live maintenance budget. The exact
production bound must fit the existing owner-retirement deadline.

Never clear an observed gap, treat a timed-out task as completed, retry a business
write, promote unadmitted footage or rewrite old evidence. Explain any remaining
unavailability in ordinary customer language and retain usable text/screenshots
and truthful report coverage.

### 4. Integrate vertically, then qualify the actual candidate

The artifacts use source copies, fault hooks and string substitutions. They must
not be copied into production as patches. Implement typed capabilities in Veil,
the shared private transport, recorder and existing Chronicle admission boundary.
No database change is currently indicated. Verify this rather than assuming it
if the final receipt contract changes persistence. Keep old evidence readable.

Required local gates before another push or deployment review:

1. Run all twelve original R4 checkpoints through the actual API/MCP/queue/worker,
   using unchanged authored actions and oracle. Require available evidence for
   all five formerly unsupported states, measured private glyph coverage,
   preserved declared public pixels, node identity and native control behavior.
2. Run the geometry-ticket and combined-acknowledgement negatives against the
   integrated source: real wrong-page/world replies, navigation/context loss,
   CSSOM/font/layout changes, removal, capacity, deadline, same-read replay,
   pending top-layer removal, translucent/rounded surfaces and SVG ink outsets.
3. Exercise real recording/Chronicle admission on macOS and deployment Linux:
   normal capture, delayed acknowledgement, genuine missing paint, post-stop late
   reply, permanently pending reply, prior-gap recovery, cancellation and restart.
   Validate saved pixels and decoded media with independent negative controls;
   do not turn the calibration's colour-only failures into privacy passes.
4. Verify the two repairs together in one production-shaped binary. Include
   multiple pages/frames, final-read challenge/owner fencing, cancellation, remote
   object cleanup and zero raw-value/CDP-description egress. The current direct
   geometry probes are not a substitute for this worker-lifecycle proof.
5. Have a fresh independent reviewer/fixture author challenge the stable integrated
   candidate. Current experiments were coordinator-authored, not a new blind
   campaign. Repeat unrelated passing suites only when the implementation affects
   their guarantees; keep every earlier failed attempt and source identity.

After those local results are reviewed, use exact-commit hosted qualification,
immutable publication and deployment verification. No such release action is
authorized in this phase.

## Evidence and review status

Evidence is under
`artifacts/assurance/customer-experience-campaign-20261110/investigation/rendering-recording-repair-20261113/`.
The immutable runtime image is the retained `7c99953` candidate, whose production
sources match the serving release's runtime; test/controller files are disposable
and are not mounted over production sources. Recording experiments use real
recorder/Chronicle ports with an in-memory admission fixture, not database-owner
custody proof. Linux containers have no network. macOS fixtures intercept their
fictional local origin; no user profile or real application is used.

The frozen final combined direct-browser experiment passes all five original
states, including delayed notification: 24,299 of 24,299 measured private glyph
pixels changed, and all 23 declared visible public-field regions were unchanged.
Its private geometry transport measured approximately 17–33ms for the five owners;
deliberately delayed acknowledgement measured approximately 107–123ms. These are
single-run component measurements, not endpoint/agent latency or availability
guarantees. The earlier combined framed-state deadline failure is preserved; the
follow-up removed redundant private protocol queries before the final run.

The final focused geometry failure matrix reports 19/19 expected outcomes: one
ordinary available control and 18 refused invalid/unsafe states. SVG stress checks
preserve ordinary axis scaling while refusing the tested stroke/decoration,
rotation, mirror and vertical-writing boundaries. Earlier prototype leaks and
test-setup mistakes remain in the evidence, not overwritten as successful tests.

Recording evidence includes three unmodified successful macOS traces; a controlled
baseline/candidate late-notification comparison; genuine first-paint and CSS-layout
gap negatives; a gap that remains withheld after later reads recover; and the
baseline/candidate final-read comparison plus the permanently pending reply.
Actual admitted macOS recordings decoded 95 application frames and sampled 1,272,240
protected-region pixels with no colour-check violations. Linux also reproduces
the late-acknowledgement failure and candidate recovery, but its stricter palette
check reports bright overshoots. The calibration and unmasked negative establish
why that check cannot alone certify privacy. Its failed appearance receipts remain
failed; no tolerance was silently widened.

Key receipts: `results/combined-final.json`,
`results/final-combined-source-identity.json`, `results/geometry-negatives.json`,
`recording-candidate-results.json`, `recording-recovered-gap-results.json`,
`recording-final-read-results.json`, `recording-final-stuck-results.json`,
`recording-video-results.json`, `results/recording-linux-initial-video-result.json`,
`results/recording-linux-pixel-finite.json`, `results/video-calibration.json` and
the SVG boundary/guard results. No new blind-author result or end-to-end durable
worker qualification is implied by these component experiments.

The contained safety guard is separately reviewable in `stroke-refusal.patch`;
its adapter regression is `results/stroke-worker-proof-final.json`. The broader
rendering and recording implementation should follow that guard, not delay its
review behind a rewrite. The new capability's remaining integration gates are
not grounds to dismiss the confirmed current-renderer defect.

The conclusion at the end of the investigation was: **the focused repair direction was supported by isolated
evidence; a production repair is not yet qualified.** The original historical
macOS timing attribution and the integrated worker lifecycle remain explicit
verification limits of that phase. No source had been edited then. The local
implementation and newer worker verification are described at the top of this
document; pushing was authorized on 16 November; deployment remains prohibited pending owner review.

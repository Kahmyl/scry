# Browser interaction causes and repair recommendation

## Recommendation

Keep the official Playwright adapter and Scry's existing API, durable command
ownership, native recording and Chronicle. Correct the bounded interaction
subsystem: text-entry intent and acceptance, native activation/readiness, consistent
deadline budgets, bounded diagnostics and live-session capacity admission. Do not
replace the runtime again or apply a universal typing workaround.

The experiments support native paste for the rich/code editor replacement failure,
but reject paste as a universal solution. Odoo requires its row-edit transition to
finish before any input method works. The durable invariant is that completing a
browser call does not establish that an application accepted or saved an edit.
Scry already labels business outcomes unverified; it needs a more useful input
acceptance result before the agent proceeds to Save.

This is a diagnosis and isolated experiment result, not an implemented repair or
an activation pass. Production source and the running candidate image are unchanged.

## Evidence and scope

The starting point is [fresh blind acceptance](./BLIND-ACCEPTANCE.md): ten independent
agents completed real business journeys, but Nextcloud recovered from a persisted
empty-document defect. Those receipts and reports remain unchanged. These new
experiments are operator-led causal comparisons, not another blind qualification.

The checkout is `codex/browser-foundation-integration`, starting at `4362224` with
production integration source at `3b71ddc`. Experiments use the existing image
`scry-browser-integration:local`, digest
`sha256:fef120cf566252d02048281d8e6db6aeb173cefb45b910dd6d56d551cadf19f4`.
The paired MCP driver is `1.64.0-alpha-1790635538000`; a comparison with the installed
stable client uses the same Chromium executable, not a second browser revision.

The evidence root is
`/Users/habib/Documents/monorepo/scry/artifacts/assurance/browser-blind-20261031`.
The table below uses subdirectories of that root. Private fixture credentials are
read into memory, not included in this report or committed. Test content is fictional.

| Finding                                      | Causal evidence                                                                                                                                                                                                                                                  | Classification and consequence                                                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Nextcloud replacement empties the document   | Direct pinned adapter, no Scry queue/recorder/masks, reproduces the loss. Replacing an already-edited document fails; a fresh initial fill can succeed. Save/reopen confirms actual data loss, not missing accessibility text.                                   | Input compatibility. Default bulk selection/input is not interchangeable with the editor's native edit/paste handling.             |
| Grafana retains starter text                 | Its Monaco input is a small textarea proxy. Default fill prepends content instead of replacing the editor model. Native keyboard replacement and native paste produce exact content, including fresh-login persisted readback.                                   | Same input boundary, different editor implementation. Tag name alone cannot select a reliable primitive.                           |
| Odoo note silently reverts                   | Inactive row textarea receives trusted input, briefly changes, then blurs and restores its previous value. Immediate click/fill, keys and paste all fail. Waiting for the actual selected editable row and focus makes fill and paste persist correctly.         | Application readiness. DOM actionability is not completion of the app's asynchronous row-mode transition.                          |
| OpenProject/GitLab navigation wait errors    | A controlled six-second POST navigation returns the same four-second post-click timeout. The server receives exactly one save and the final page shows success. A twelve-second bounded call and separated action/commit wait both succeed, still with one save. | Deadline configuration and result ergonomics, not evidence of an undispatched click. Never replay an uncertain save automatically. |
| GitLab broken avatars                        | Strict origin proxy refuses external Gravatar; direct browser without Scry also fails DNS. No masking is installed in these controls.                                                                                                                            | Environment/network scope, not visual redaction. Required external dependencies must be explicitly configured and reachable.       |
| Discourse broken avatars                     | Authenticated topic has the same three broken images with and without the Scry proxy. The application's own avatar endpoint returns HTTP500; no scope refusal occurs.                                                                                            | App fixture failure. Its internal server exception remains unknown; fixing Scry's recorder cannot repair this endpoint.            |
| Metabase product identifiers are masked      | Ten generated valid EAN identifiers also pass Luhn and are all treated as payment cards by the text classifier. Pixel and text paths use different financial-context rules.                                                                                      | Over-broad heuristic and duplicated policy. Use one small financial-context rule, not a new privacy platform.                      |
| GitLab sidebar count differs from issue list | Fresh independent browser shows count34 for the existing issue34; the blind session showed cached33.                                                                                                                                                             | Session/app presentation state. No evidence of Scry rebuilding or changing the UI.                                                 |
| Gallery screenshots all say page             | Integrated engine supplies literal `label: "page"` when admitting screenshots.                                                                                                                                                                                   | Metadata omission, not an evidence-custody problem. Supply meaningful safe action/page context.                                    |
| Earlier Penpot memory failure                | Historical isolated trial exceeded an explicit1.5GiB cgroup cap with two heavy editor tabs: two OOM kills. Adequately resourced repetitions passed. Fresh ten-app worker used a3GiB cap and bounded batches.                                                     | Capacity mismatch is proven; a general memory leak is not. Manual batching is not a deployable admission policy.                   |

Expected stale references, invalid selectors and toast interception remain explicit
tool errors. They should lead to fresh observation and an informed next action,
not hidden retries or claims that every normal control refusal is a runtime defect.

The earlier isolated qualification also retains one native `Page.captureScreenshot`
failure with zero OOM events; an unchanged repeat passed. Its exact cause remains
unresolved. It is a recoverable screenshot-tool failure, not evidence of an editor
repair or permission to silently retry a business action. See the preserved
non-passes in [isolated qualification](./QUALIFICATION.md).

## Input experiments

| Experiment                           | Result                                                                                                                                                                                                             | Meaning                                                                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `editor-matrix-1793442092132`        | 32 cases. Default fill0/8; explicit clear/insert and pointer/keyboard variants24/24. Both clients, masks on/off, Unicode and save/reopen.                                                                          | Rules out masking, the recording pipeline and changing only the client package as sufficient explanations. Early successful alternatives still require harder tests.                       |
| `editor-peer-1793442443472`          | Live coauthor defeats simple clear/keys and bulk replacement; first-line loss or empty saved content.                                                                                                              | Reject the early candidate despite its clean single-user matrix. Its fixed500ms peer readback is insufficient to classify convergence; local persisted corruption is independent evidence. |
| `editor-peer-1793442586713`          | ArrowRight variants4/4; Home variants0/2, losing the first line.                                                                                                                                                   | Caret normalization matters. Do not ship an arbitrary ArrowRight/Home sequence as a universal editor abstraction.                                                                          |
| `editor-native-paste-1793442793326`  | 16 cases: direct paste4/4, clear/paste4/4, arrow/keys4/4. Default fill succeeds on each first edit, then fails both second edits and saves empty content.                                                          | Trusted paste handles repeated rich-editor replacement in this comparison without editor-model mutation. Correct physical tab focus is verified; it is not a background-tab explanation.   |
| `editor-native-paste-1793443030828`  | 4/4 direct-paste cases with a private Xvfb display and current black masks enabled. Includes two consecutive edits, Japanese-first text, blank lines, accented text, emoji, live peer convergence and save/reopen. | Positive headed/masked compatibility evidence, not proof of every website or full protection coverage.                                                                                     |
| `grafana-native-paste-1793443134582` | Two exact replacements plus independent-login save/reopen:3/3 checks.                                                                                                                                              | The same native operation works in the Monaco sibling, not only Nextcloud.                                                                                                                 |
| `odoo-row-cause-1793443153371`       | Four immediate strategies fail to change the inactive note; all explicit-discard baseline checks in that run pass.                                                                                                 | Paste alone does not solve the application-ready race.                                                                                                                                     |
| `odoo-ready-input-1793443263727`     | Fill and paste both accepted and persisted after selected-row/focus readiness,2/2 on separately duplicated quotations.                                                                                             | Observe readiness before editing, and verify actual acceptance afterward.                                                                                                                  |

`odoo-ready-input-1793443522758` narrows the Odoo scope further: the existing
official `browser_click` followed by `browser_type`, with the current completion
behavior, accepts and persists the note on research quotation7. No Odoo-specific
readiness engine is needed. The app-specific selected-row condition above is a
diagnostic oracle, not proposed general adapter code. Earlier official-tool attempts
used an uninitialized supplied context or a CSS selector matching a hidden duplicate;
the final semantic textbox target removes those harness errors.

The native-paste experiment uses ordinary trusted Ctrl+V. A private localhost
helper writes fictional text to the isolated browser clipboard with permissions
restricted to the helper origin. It does not grant the tested app clipboard API
permissions, change browser security flags, dispatch synthetic paste events, set
editor content, invoke framework transactions or rebuild DOM. Trusted paste events
are recorded. The clipboard is cleared when the experiment closes.

That helper is experimental apparatus, not a shipping design. Integrating a private
per-Run clipboard path must prove isolation, cleanup/crash behavior, focus and tab
routing, and must not expose a helper tab in the recorded customer journey. A site
can reject paste; rejection must be visible rather than triggering silent mutations.

Readback distinguishes editable document text from non-editable collaborator cursor
labels using a detached DOM clone. Earlier harness attempts counted cursor labels,
queried an empty zero-height code node, selected uninitialized tabs, or checked a
row before rendering. They are retained as invalid experiments, not product failures
or passing cases. The final result tables above exclude them.

An Odoo diagnostic initially assumed reload abandoned edits. The app persisted the
fictional original quotation's quantity9. The original quantity3 and note
were restored through the UI and verified in
`odoo-row-cause-1793443067847`. Subsequent persistence checks use separate research
quotations3,4 and7. Research quotations2,5 and6 retain exploratory changes. No historical
Chronicle bytes, blind reports or original Nextcloud qualification file were rewritten.
The selected-row test also demonstrates why a completed Discard click must be
observed to finish before another navigation; cancellation must not be inferred
from a button press alone.

One early direct Grafana diagnostic serialized a fictional login password during
the app's asynchronous login state. That private diagnostic entry was sanitized
and the diagnostic serializer now filters fixture passwords. It is not a production
Scry disclosure finding. Raw direct-browser snapshots are not a protected evidence
channel and should not be published.

## Navigation diagnostics and capacity

`navigation-cause-1793441430874` preserves the three timing comparisons. The current
four-second call errors at4218ms after dispatch; the twelve-second configuration
returns at7721ms, and separate click/commit waiting returns at6287ms. Each server
counter is exactly1. Pinned upstream click passes its action timeout into the click
that also waits for scheduled navigation, so a separate configured20s navigation
timeout does not give that click20s.

Align inner action/navigation/completion budgets with the existing durable command
deadline, reserving time for observation and physical stop. Do not add another
deadline supervisor or remove the current no-replay dispatch marker. A call-log
string is not a new authoritative dispatch receipt; uncertain business effects
must remain unknown until inspected.

Source inspection also explains poor failure visibility. The adapter emits request
metadata, phase and page-crash messages that its parent ignores; the origin proxy is created
without a blocked-origin callback. Return bounded, deduplicated, safe diagnostics
such as blocked origin/resource, DNS/HTTP failure, page crash and phase. Do not restore raw
console bodies, headers, query strings or unbounded per-request arrays. Those can
contain secrets or turn an asset retry storm into another resource failure.

The current worker's measured cgroup counters show zero OOM events/kills and no
restarts, with257,114,112 bytes current and2,585,194,496 bytes peak under a3GiB cap.
This is not a long-running soak. Heavy browser/encoder references are explicitly
deleted after finalization; small in-process idempotency tombstones remain. No
claim that all retained per-session metadata is bounded over an unlimited worker
lifetime is justified.

Queue concurrency limits opening/command jobs, not the number of browsers left
alive after those jobs return. The integrated engine has no explicit live-browser
capacity admission at launch. Add a lifetime slot before launch, keep it through
confirmed browser exit and recorder drain, and defer excess starts. Releasing a
slot on an unconfirmed stop would violate the existing custody guarantee. Start
with a conservative measured deployment profile; do not disguise this as an
infinite-concurrency promise or simply raise memory limits again.

## Financial masking experiment

`financial-cause-1793441478912` tests21 fictional cases. A context-based candidate
keeps ten EANs, ordinary phone/order/business text visible; retains explicit access
secret detection; and protects obvious labelled card, account, routing and CVV
values. All21 expectations pass. An unlabelled card-like number is deliberately
missed in this candidate: that is the chosen best-effort tradeoff, not full privacy
qualification. The experiment changes no live policy.

An adversarial follow-up, `financial-context-boundary-1793443525951`, rejects that
prototype's whole-text context check: it passes only1/6 mixed card/product cases.
A field-local label association passes6/6, preserving the EAN even when a real card
number is elsewhere in the same text. The repair must bind context to the candidate
region, not merely find the word card somewhere on the page. This is still a small
policy hypothesis, not a completed shared pixel/text implementation.

Use one shared small recognition policy across tool text and black pixel overlays.
Keep customer content and ordinary icons/images outside default protection. The
current text-only candidate is not sufficient to ship because it does not yet
centralize both paths or prove masking geometry and secret-boundary behavior.

## Repair scope options

| Scope                                    | Coverage and recurrence                                                                                                                                                                                                                                                                                            | Cost risk and reversibility                                                                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contained workaround                     | Set slowly typing, add waits, or hardcode caret movements. Experiments show sibling/live-peer failures; no common acceptance or capacity invariant.                                                                                                                                                                | Small initial diff, high recurrence. Suitable only as an explicitly limited operator recovery, not the baseline fix.                                                                                                         |
| Bounded subsystem correction recommended | One text-entry intent/acceptance boundary around the official adapter; supported native edit methods; observable readiness; coherent deadline budgets; bounded diagnostics; live-session capacity. A separate small shared financial policy and meaningful screenshot metadata complete the identified follow-ups. | Moderate integration work. No new business datastore, recorder rewrite, customer retention or historical evidence migration is indicated. Keep inactive behind the existing adapter selection and qualify before activation. |
| Foundational runtime rebuild             | Replace the official adapter, durable ownership, recorder or evidence pipeline. Current controls reproduce the important input failures without those Scry components and show existing recovery working.                                                                                                          | Largest compatibility and migration burden without causal justification. Reject unless later experiments prove those abstractions cannot enforce the required guarantee.                                                     |

Native paste is an input mechanism, not the architecture. The boundary must express
replace versus append/keystrokes, bind one fresh unambiguous target, perform native
focus/edit events, and report accepted, mismatched or unverified input separately
from durable execution and persisted business outcome. Verification must not echo
secret values. Formatting/normalizing controls require an explicit observable
condition, not arbitrary string normalization that hides an incorrect edit.

Do not guess every app's internal readiness or insert Odoo-specific selectors into
the general adapter. Reuse official native click/completion behavior first; do not
invent a second readiness DSL from a failure that the existing click path handles.
Support ordinary observable conditions and new observations
when a control changes. A completed call with rejected input must give a useful
result, not tell the agent to continue to Save. Never automatically retry an
uncertain dispatched business action. Agent instructions alone are not the repair.

## Verification before activation

1. Preserve the original failures as characterization tests. Implement only the
   selected bounded scope; use the existing official target resolver rather than
   a competing reference/selector system or public arbitrary-code tool.
2. Exercise repeated replace/append/clear, ordinary controlled fields, rich/code
   editors, formatted values, Unicode, readonly/disabled/ambiguous targets,
   dialogs, iframe/tab changes, detached targets and rejected input. Verify
   acceptance without exposing secrets or confusing it with saved state.
3. Prove private clipboard isolation and bounded resource slots through parallel
   Runs, cancellation, timeout, stale owner, worker/browser crash and failed drain.
   Preserve unknown/no-replay and Chronicle admission behavior.
4. Repeat the slow navigation and asset retry-storm cases with bounded safe
   diagnostics, consistent deadlines and no duplicated external effect. Verify
   capacity admission under more requested Runs than available live slots.
5. Run the complete HTTP MCP/API/worker/Chronicle/dashboard path, then fresh blind
   journeys across all ten preserved apps. Check actual saved/reopened business
   state, native UI/video fidelity, gallery labels and final reports. The isolated
   causal passes above do not substitute for this gate.
6. Run relevant regression/recovery/authorization/migration compatibility checks
   in proportion to the final diff. Activation, merge and deployment remain
   separate decisions. There is no new schema migration requirement established
   by these experiments alone.

## Primary research supporting the choice

Playwright documents `fill` as the normal field primitive and character events for
controls with special keyboard handling; neither is a universal editor-model
guarantee. [Playwright input actions](https://playwright.dev/docs/input),
[Locator API](https://playwright.dev/docs/api/class-locator).

Application hydration/readiness is distinct from element actionability. That
supports observable state conditions rather than a universal sleep or retries.
[Playwright navigation guidance](https://playwright.dev/docs/navigations).
Odoo's own row handler awaits `enterEditMode` before assigning the new focus target,
matching the observed transition. [Odoo list renderer](https://github.com/odoo/odoo/blob/19.0/addons/web/static/src/views/list/list_renderer.js).

ProseMirror handles real paste through its editor transaction/clipboard parsing
path, rather than treating arbitrary DOM text insertion as equivalent. This
explains why native paste is a credible experiment; the local persistence results
establish its applicability here. [ProseMirror input implementation](https://github.com/ProseMirror/prosemirror-view/blob/master/src/input.ts).
The installed Nextcloud plaintext editor uses nested document/code-block nodes.
[Nextcloud plaintext extension](https://github.com/nextcloud/text/blob/stable32/src/extensions/PlainText.js),
[plaintext document](https://github.com/nextcloud/text/blob/stable32/src/nodes/PlainTextDocument.js).

Clipboard permission can be scoped to an origin. Broadly granting clipboard access
to customer pages is not necessary for the experiment and is not recommended.
[Playwright browser context permissions](https://playwright.dev/docs/api/class-browsercontext#browser-context-grant-permissions).
An established OS clipboard bridge is another candidate for the existing private
X11 display, avoiding a helper tab and customer-site permission changes. It remains
an integration choice requiring isolation/crash proof, not a tested dependency in
this image. [Clipboardy system clipboard implementation](https://github.com/sindresorhus/clipboardy).

Luhn indicates a possible PAN, not that a number is an issued payment card.
[PCI SSC FAQ1137](https://www.pcisecuritystandards.org/faqs/1137/).
Established recognition implementations combine patterns and context, but their
scoring can still over-prioritize Luhn; importing a larger library does not resolve
our policy choice. [Presidio card recognizer](https://github.com/data-privacy-stack/presidio/blob/main/presidio-analyzer/presidio_analyzer/predefined_recognizers/generic/credit_card_recognizer.py),
[maintainer discussion](https://github.com/data-privacy-stack/presidio/discussions/1634).

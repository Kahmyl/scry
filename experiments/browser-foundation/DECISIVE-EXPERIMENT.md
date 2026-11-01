# Decisive browser interaction experiment

## Decision

Keep Playwright and correct the shared interaction subsystem. The experiment rejects
a universal paste fix, a universal keyboard fix, and application-name exception
tables. It supports one target-ownership and outcome contract around explicit
native input methods. It does not justify replacing Scry's API, command ownership,
Chronicle or native recorder.

The final isolated candidate completed supported editing and persisted-readback
journeys in seven established applications. Its 69-case control matrix had zero
observed wrong-field writes and zero immediate false-positive readbacks. This is
not 69 successful edits: refusals, mismatches, unavailable observations and delayed
rollbacks remain distinct outcomes. Six business-condition experiments separately
demonstrate why input readback cannot establish saved business success.

Production source and the original candidate image are unchanged. Nothing was
activated, merged, pushed or remotely deployed. Node-RED's local Deploy button was
used only to save a disconnected fictional function in its dedicated test instance.

## The underlying problem

A visible control, its keyboard receiver, its editing host and its application
document are not necessarily the same thing. A rich editor can use a hidden
textarea or a standard browser EditContext receiver. A DOM element can become
editable again inside a non-editable wrapper. Selecting text nodes can omit empty
paragraphs, while a keyboard shortcut can select outside the intended control.

Consequently, binding only a visible DOM element and then issuing global input can
edit the wrong control or produce a different application document. Reading back
through the same mistaken focus can falsely confirm that edit. Separately, an app
can revert an apparently accepted edit, transform it intentionally, or save after
the browser call times out.

The missing common invariant is that the command must retain one intended control
scope, current document and owned keyboard receiver, contain its selection, and
classify its observation honestly. Application readiness and persisted business
outcome require explicit conditions; they are not consequences of successful input.

## Alternatives tested and rejected

| Alternative                                                | Decisive observation                                                                                                                                                 | Consequence                                                                                                                                    |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Unguarded native paste and native-copy readback            | A focus-stealing control caused text to be entered into Decoy. Copy then read Decoy and returned the intended value as accepted while the intended field stayed old. | Reject global focus as target authority. A matching clipboard value is not proof of the right edit.                                            |
| One visible element is the input receiver                  | HedgeDoc's visible editor overlays its hidden keyboard textarea. Clicking the textarea times out.                                                                    | Activate the visible scope, then bind its owned receiver; do not force hidden-receiver pointer clicks.                                         |
| Editable text-node range for every rich editor             | The Etherpad holdout returned matching text immediately but an independent session contained extra blank lines. Peer comparison reproduced the discrepancy.          | Reject text-node selection as a universal representation of the editor's document. Do not trim away the failed comparison.                     |
| Native Select All and paste everywhere                     | Etherpad's repeated replacement still produced an extra newline. A mixed non-editable-widget control could select outside the intended editor.                       | Selection needs containment checks; native paste is a supported method, not a universal guarantee.                                             |
| Native Select All, clear and keyboard typing everywhere    | Etherpad passed, but Nextcloud lost its first line on the second edit. HedgeDoc automatically continued a Markdown list and produced an extra list prefix.           | Keyboard semantics and literal paste semantics differ. Choose the method before dispatch; do not silently retry with another method afterward. |
| Only input, textarea and contenteditable can receive input | Untouched Node-RED used the browser's standard EditContext API. The candidate refused its editor without dispatching text.                                           | The capability model must include standard EditContext and visible-scope activation, not a Node-RED classname handler.                         |
| Immediate matching text means the task passed              | Hydration and rollback controls matched at return but saved old data.                                                                                                | Input observation must remain separate from readiness and persisted outcome.                                                                   |

The Node-RED correction reads the browser's `editContext` capability and sends
native input. It does not write the editor's internal model or disable EditContext.
Neither the shared runtime nor its input-method dispatch contains application
names, hostnames, editor-library classes or framework APIs.

## Final real application results

All rows below use the same frozen shared runtime. Input methods are explicit
experiment inputs, not application routing inside that runtime. Fictional content
includes accented text, Japanese, emoji and multiline text where the field allows
it. Every measured edit occurs through the browser UI.

| Application | Selected method                                         | Independent outcome                                                                                                                              |
| ----------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Nextcloud   | Scoped native paste                                     | Two replacements, live peer convergence and Save/Close/reopen matched exactly.                                                                   |
| Grafana     | Scoped native paste                                     | Two replacements and a separately authenticated fresh-session saved readback matched exactly.                                                    |
| Odoo        | Scoped native paste after ordinary native activation    | Two note replacements and saved/reloaded quotation state matched; the original quotation remained the source fixture and a duplicate was edited. |
| WordPress   | Native keyboard replacement                             | Two title replacements and two paragraph replacements in the editor iframe; Save draft and fresh-login exact native-copy readbacks passed.       |
| HedgeDoc    | Scoped native paste                                     | Two Markdown replacements and independent-session exact native-copy readback passed, including heading, Unicode and list text.                   |
| Etherpad    | Native keyboard replacement                             | Both replacements converged exactly in a separate peer before closing the writer; a new session returned the exact final text, without trimming. |
| Node-RED    | Scoped native paste into the owned EditContext receiver | Two JavaScript replacements, local Done/Deploy confirmation, then a new browser session reopened the node and copied the exact saved source.     |

Setup and independent oracles are deliberately separate from the engine. Logins use
ordinary fixture setup; Nextcloud creates a unique seed file through WebDAV before
the measured UI journey. No application business API or editor-model mutation is
used to make a measured edit or repair a failed readback.

HedgeDoc, WordPress, Etherpad and Node-RED each began as untouched targets for an
earlier candidate. Their counterexamples caused revisions. They therefore become
regressions for the final candidate, not four fresh holdouts of an unchanged
implementation. These are operator-led experiments, not fresh blind-agent tests or
a rerun of all ten original business journeys.

## Outcome and failure checks

The final control matrix compares three explicit methods across 23 cases. It
covers ordinary and controlled fields, nested editing, non-editable widgets,
iframes, open shadow roots, replacement during activation, focus theft, rollback,
paste rejection, formatting, readonly/disabled/ambiguous controls, denied copy,
hidden keyboard proxies, editable islands, empty trailing blocks and direct/scoped
EditContext receivers with readonly/disabled variants.

Wrong-field writes and immediate false-positive readbacks were both zero in this
finite matrix. The 69 results comprise 40 immediate matching observations,
15 not-dispatched results, six mismatches, five unknown results and three
unverified observations. All three delayed-rollback cases still reverted: they prove that
the result named `accepted` means only observed at return, not persisted. The
paste-only proxy refuses the keyboard method by mismatch; selection escaping the
mixed widget scope is stopped. These are not counted as successful interactions.

| Business condition                          | Observed result                                                                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Input before hydration without readiness    | Matching immediate value, but one Save persisted old data. Failed business test.                                             |
| Wait for explicit readiness before input    | One Save persisted the intended value.                                                                                       |
| Delayed rollback without outcome assertion  | Matching immediate value, but one Save persisted old data. Failed business test.                                             |
| Wait for settled state and assert the field | Rollback was detected and Save was suppressed. Correctly failed test, not a completed journey.                               |
| Intentional uppercase formatting            | Raw input comparison mismatched; an explicit uppercase expectation and saved readback passed.                                |
| Save takes longer than the action timeout   | Timeout remained recorded; read-only observation found the completed save. Server received exactly one Save, with no replay. |

Two concurrently alive private browsers on separate X displays retained distinct
native clipboards. This proves that isolation mechanism in the lab, not production
worker cancellation, stale-owner recovery or crash cleanup.

## Environment and evidence

The baseline image remains
`sha256:fef120cf566252d02048281d8e6db6aeb173cefb45b910dd6d56d551cadf19f4`.
The isolated image adds only the native X11 clipboard utility. It uses the paired
Playwright MCP runtime already in the candidate, a private headed display and
native browser screenshots/video, without visual reconstruction or helper tabs.

The final executed runtime source is archived with its receipts. Its SHA-256 is
`ef11e19ac13007f83448258dcf2b00a78fcf78102a5c322df0482a5de2550cbb`.
This identifies experiment provenance; it is not a deployment byte-contract gate.

New dedicated fixtures are WordPress 7.1.4, HedgeDoc 1.12.0, Etherpad 3.3.12 and
Node-RED 5.0.9. Their exact local image identities are respectively
`848b03bb7b4b160e3a670454e8e928e309c9aaeb1c2584e917f42ab5197662e2`,
`202460cadb220ca568328045827f49a6e5575cb33de337b7ee59e6a5f9b79509`,
`e240564a6897845ee665b02c35853564c0866aafc4641f04c94ce82813373194` and
`2ccd38b4066648bd5e17430c50a2f8102c566a82fd4f2fc5c342e61664d6896f`.
The fixtures use separate persisted lab volumes and internal Docker aliases.

Evidence root:
`/Users/habib/Documents/monorepo/scry/artifacts/assurance/browser-blind-20261031`.
The generated `decisive-evidence-audit.json` verifies the final receipt set:

- `decisive-controls-1793446593213`: 69 control cases.
- `decisive-training-1793446673224`: Nextcloud, Grafana and Odoo.
- `decisive-rich-regressions-1793446706463`: WordPress.
- `decisive-rich-regressions-1793446716457`: HedgeDoc.
- `decisive-etherpad-comparison-1793446723596`: Etherpad peer and persistence proof.
- `decisive-live-1793446563137`: Node-RED measured edits, local save and native images/video.
- `decisive-nodered-audit-1793446749449`: Node-RED fresh-session readback.
- `decisive-postconditions-1793446732908`: six business-condition comparisons.
- `decisive-final-batch-1793446672333`: serial regression jobs and clipboard isolation.

Earlier failed receipts remain alongside these results. In particular, retain
`decisive-controls-1793444629840` for the wrong-target false acceptance,
`decisive-holdout-audit-1793445799003` and
`decisive-etherpad-comparison-1793445933683` for paste discrepancies,
`decisive-training-1793446090240` for the keyboard/Nextcloud failure, and
`decisive-rich-regressions-1793446311619` for Markdown autoformatting.

An additional guarded-candidate training attempt, `decisive-training-1793446177435`,
failed before any Grafana edit: the Grafana fixture exited 137 with Docker reporting
OOMKilled and a configured 640 MiB limit. It was restarted unchanged; a subsequent
independent run and the final batch passed. The OOM event is not explained away as
an input defect or a proven memory leak. Its precise allocation cause remains
unresolved and capacity qualification remains necessary.

Early apparatus failures also remain recorded: a missing virtual-list selector,
a peer opened at a root route rather than the document, an identical already-saved
Grafana payload disabling Save, an initially unavailable peer copy, and a hidden
radio overlaid by its visible label. They are not successful runtime tests. A
global text wait also timed out on a hidden duplicate while the requested heading
was visible; outcome assertions must be scoped and visibility-aware.

Private fixture passwords, deletion tokens, raw snapshots and videos are not
committed or suitable for public sharing. This trial does not qualify Veil privacy
coverage, video review pacing or Chronicle/dashboard evidence admission.

## Research supporting the choice

[Playwright's actionability rules](https://playwright.dev/docs/actionability) cover
whether an element can receive an action, not application hydration or business
commit. Its [input documentation](https://playwright.dev/docs/input) provides
different primitives for ordinary fill, keyboard events and shortcuts rather than
promising one mechanism for every custom editor.

The inspected [Stagehand locator implementation](https://github.com/browserbase/stagehand/blob/main/packages/extension/understudy/locator.ts)
and [browser-use action implementation](https://github.com/browser-use/browser-use/blob/main/browser_use/browser/watchdogs/default_action_watchdog.py)
also distinguish focus, control types and native input. They inform the comparison;
their fallback behavior is not adopted as permission to type into whichever page
currently has focus. A related [Playwright inherited-editability report](https://github.com/microsoft/playwright/issues/43483)
illustrates why a paragraph and its editing host cannot simply be treated as
interchangeable; the local experiments establish Scry's own failure mechanisms.

[Chromium's EditContext explanation](https://developer.chrome.com/blog/introducing-editcontext-api)
and the [W3C EditContext specification](https://www.w3.org/TR/edit-context/) establish
that native text receivers need not be textareas or contenteditable DOM.
[Monaco's documented EditContext option](https://microsoft.github.io/monaco-editor/typedoc/interfaces/editor_editor_api.editor.IEditorConstructionOptions.html)
supports treating this as a browser capability, not an application exception.
The dedicated Node-RED fixture follows its [official container guide](https://nodered.org/docs/getting-started/docker).

## Recommended integration boundary

| Scope                                                                                | Decision                                                                                                                                                            |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add application selectors, caret tricks, longer sleeps or automatic fallback retries | Reject. The comparisons show sibling failures and misleading success.                                                                                               |
| Correct the complete interaction subsystem around the official adapter               | Recommend. Reuse its authority and native operations, bind control ownership, expose explicit methods and truthful conditions, then qualify the complete Scry path. |
| Replace the browser foundation, durable workers or recorder                          | Not supported by these causes. Greater migration and compatibility risk without evidence that those components require replacement.                                 |

The next implementation must reuse the official resolver and Scry's opaque target
references inside one owned command. The experiment uses selector strings; it has
not proven the new operation through Scry's public reference contract. Do not add a
second reference authority, parse generated code for handles, or use selectors as
a replacement for customer-facing references.

Use one small lifecycle: resolve the intended scope; activate it natively; bind the
owned receiver and current document; select and input by the explicitly chosen
method; observe without mutation replay; evaluate explicit readiness/business
conditions separately. Keep native fill, keyboard and paste as honest capabilities,
not silent post-failure fallbacks or a framework-detection registry. App transforms
and unavailable observations must remain visible to the agent.

Return secret-safe comparison/status information rather than the prototype's raw
fictional text. The prototype also has a coarse guard-failure reason that can mean
selection escaped, not only focus changed; production diagnostics must distinguish
those phases. Empty, append, IME composition, platform-specific controls and
cross-browser behavior are not established by this replace-only trial.
The prototype's document listeners cover pages present when it is constructed;
new tabs/popups and changes inside a native event require further lifecycle and
focus-race tests. The finite wrong-target result is not a claim that page scripts
can never redirect native input between checks.

Before activation, prove the public MCP/API/worker path with existing command
serialization, ownership fencing, cancellation, timeouts and crash recovery;
private clipboard teardown and bounded live-session capacity; unchanged Veil and
Chronicle admission; and actual dashboard evidence. Then repeat fresh blind-agent
journeys across all ten original apps using only normal tool guidance and business
goals. Agents must not need editor internals or experiment selectors.

The separate diagnostics/deadline, resource-admission, financial false-positive and
gallery-label work in [the causal investigation](./CAUSE-INVESTIGATION.md) remains
open. This experiment provides evidence for the interaction direction, not a claim
that those issues, every website or the release are now qualified.

# Native browser action recovery

Browser dispatch reservation, execution acknowledgement, observation and business outcome are separate facts. Reserving a step before IPC remains necessary: losing the worker after a possible effect must never permit automatic replay.

## Dispatch and partial plans

A v2 worker can acknowledge that its final observation guard refused a step **before** entering the upstream invocation path. The private acknowledgement echoes a fresh parent challenge, plan, action, index and owner generation. The parent checks every field, the v2 response envelope and current command authority before persisting the refusal. The challenge is not an MCP input and is not retained in public evidence. Missing, old, mismatched or late proofs remain uncertain. The public durable receipt retains the source and owner generation of a verified refusal.

A sequence with a completed prefix and a proven undispatched suffix returns `execution: partial`, `complete: false`, per-step receipts and a fresh observation when available. A first-step refusal returns `not_dispatched`. Neither means application success. Completed prefixes are never replayed. A new plan may address only the remaining authorized work after reviewing the new observation. Historical unknown receipts are not retroactively reclassified by this change.

After an acknowledged non-submit input, the worker can advance the existing global and exact-control guards together. Both retain the original handles and semantic fingerprint. Only the exact input's restored submission name and redundant attribute writes are admitted; a redundant write must have the same old and current value for every mutation. Actual or transient type changes, changed form destinations, replaced controls, new choices, other controls, navigation, frames and journal overflow refuse advancement. A blocked event is never cleared. The bounded journal holds at most 256 relevant mutations. Repeated references in a plan share one original guard so stale duplicate event barriers cannot suppress a later native change event.

## Uncertainty and recovery status

The command repository derives `nativeActionFence` under its existing live-claim persistence path using the shared receipt classifier. Caller-provided classifications are removed. Submit, claim and status reporting use the same query predicate. Unclassified old partials and malformed aggregates remain conservative. Unknown steps dominate reassuring aggregate labels. No public tool can attest that an unknown action is resolved.

`get_run_status` returns the current pending command identity and a `recovery` object when an earlier action is uncertain. Its stable incident reference derives from the authorized saved command, and includes the related command, permitted inspection admissions, incomplete-stop tool and support URL. Admission is not proof the browser remains reachable: ownership, stop, capability and runtime checks still apply on execution. Stopped or terminal sessions advertise no further browser observations. Stopping/finalizing preserves uncertainty and evidence; it does not prove an earlier write failed. A released Run is not reopened.

A queued successor refused during claiming links the same earlier incident in its durable result. A request refused before admission has no new command ID; the HTTP error links the earlier command instead. Existing idempotent identities continue to retrieve their original receipt rather than replay work.

True unknown actions remain fenced. The current service has no trusted native business-outcome verifier that can authorize clearing them. A generic screenshot, arbitrary GET request, evidence ID or agent assertion is insufficient. Support receives the correlation reference when the customer contacts the returned support URL; Scry does not automatically create a ticket or promise background continuation. A future automatic verifier would require a separate authority-bound, append-only evidence contract.

## Diagnostics and error compatibility

Diagnostic privacy owners can return typed disclosed/withheld decisions. Intentional child-knowledge withholding is distinct from a missing cleaner, an exception, malformed output or redaction. Counters and bounded retention remain exact within their existing limits. Protected destinations stay absent; denials do not establish why an action failed.

API errors admit only finite public codes. Raw messages, causes and proposed provider actions are not serialized into the MCP error payload. Native tools return `isError: true` with versioned finite JSON containing code, canonical guidance and any valid incident/related command. Unknown provider codes become a generic service error.

Structured MCP error content requires the initialized client's exact experimental capability `scry.errorEnvelope: {version: 1}`. The server advertises this optional version. Clients opting in must handle that envelope despite older cached success schemas. Without negotiation, the same typed JSON is returned in text and `structuredContent` is omitted: pinned SDK clients validate any present structured error against cached output schemas, even when `isError` is true. Existing success schemas and identities are unchanged. Normal Codex clients may use this text fallback.

## Verification and rollout

The standalone browser regression is `node --test packages/praxis/test/native-input-guards.browser.mjs` after installing the pinned full Chromium runtime. It compares native change/save events and final values with guardless controls, and rejects adversarial DOM changes, including existing, newly attached and transient open shadow roots. The shadow inventory walk is linear in the observed tree and root count.

The browser CI entry point is `xvfb-run -a -s "-screen 0 1280x720x24 -nolisten tcp -ac" env SCRY_NATIVE_RECOVERY_QUALIFY=1 pnpm --filter @scry/praxis exec vitest run test/native-recovery-qualification.test.ts --maxWorkers=1`. It bundles the fictional web fixture, runs the guard regressions and exercises real native worker sequences, including a hard kill after an accepted effect. It requires the pinned full Chromium runtime, Xvfb, xclip and xauth. The explicit flag keeps native prerequisites out of the ordinary unit lane. Safe results and subprocess logs are saved under `artifacts/assurance/native-action-recovery/`.

Database integration tests use `SCRY_BROWSER_TEST_DATABASE_URL` pointing to a disposable migrated database; they cover claim-time races, malformed truth, stop access and workspace isolation. SDK tests cover modern errors and a legacy strict schema cached through `listTools`.

New parent/old worker failures stay unknown because there is no trusted v2 acknowledgement. New worker/old parent uses the prior refusal path when no identity is supplied. New API classifies old payloads conservatively. Old readers may describe a v2 partial conservatively; they must not be used to certify complete application success. No schema migration or customer data reset is needed. Rollback must preserve saved receipts and their original unknown outcomes; it must not reinterpret unknown as failure or bypass the fence.

This document describes local implementation contracts, not a deployed release. Deployment and a live qualification follow-up require separate review and authorization.

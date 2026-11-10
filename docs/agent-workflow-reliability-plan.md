# Agent workflow reliability and efficiency

Owner request (10 November 2026): repair all Scry-side findings from the Vitract
blind assessment. Vitract defects, unavailable fixtures and host approval policy
remain outside this change. The source audit is retained under
`artifacts/assurance/vitract-scry-audit-20261110/`.

Agent-loop efficiency is a primary acceptance criterion: calls, observations,
output size, decisions and recovery handoffs per verified business journey.
Request latency alone does not establish an efficient workflow.

### S01 reopened after production deployment — 10 November 2026

The original blind chat again exposed zero Scry tools after an explicit plugin
mention. Read-only Desktop logs establish rejected saved OAuth refresh credentials,
followed by tool omission. The server retains the client registrations; two recently
used Codex grants were revoked at approximately 01:20Z, before release 88ccf8e.
Isolated characterizations reproduce whole-family invalidation after a lost refresh
response is retried, concurrent refresh consumption, and access-token revocation.
The historical initiating event is not proven: the replaced server's old error logs
and revocation reasons were not retained. The owner selected bounded retry handling.
The repair preserves provider validation and serializes issuance plus one encrypted
ten-second receipt per grant in one database transaction. It rechecks authentication,
membership, grant expiry, the exact request and the unused immediate successor;
older replay still revokes the family. Safe renewal events and explicit setup
reconnection recovery are included. Native Desktop acceptance still requires a
legitimate reconnect for already-revoked credentials and an idle/restart check.
No existing grants or host configuration were changed during isolated testing. Evidence:
`artifacts/assurance/desktop-tool-loss-20261110/`. Earlier release success does not
close customer OAuth or actual Desktop acceptance.

## Complete issue register

| ID  | Required correction                                                                                      | Verification                                                                   |
| --- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| S01 | Durable connection diagnostics and actual required-tool readiness; preserve deployed scope/session fixes | expiry, rotation, revocation, restart and native-host readiness                |
| S02 | Agent **and** dashboard incomplete-work recovery, explicit release facts                                 | fenced ownership, active work, uncertain writes, retry, terminal replay        |
| S03 | Non-disruptive deployment refusal, dependency-free proxy recovery                                        | active preflight, admission race, failed migration dependency, rollback        |
| S04 | Safe masking reason/interval diagnostics; investigate persistent degradation                             | installation, timeout, navigation, popup and seeded pixel/text secrets         |
| S05 | Authorized seekable playback without whole-file browser buffering                                        | range, scope, expiry/revocation, interrupted transfer and retry                |
| S06 | Correct canonical protected-link extraction and understandable candidates                                | text/HTML, entities, duplicates, malformed and unsupported links               |
| S07 | One capability/context preflight before dependent work                                                   | unavailable reader, lifecycle and optional providers; truthful support         |
| S08 | Efficient agent workflow tools and guidelines                                                            | deterministic call/output budget; partial failure, retries, no blind writes    |
| S09 | Scoped API testing without repetitive docs UI                                                            | protected credentials, origin/redirect/SSRF controls, limits, factual receipts |
| S10 | Completed-download evidence                                                                              | success, interrupted/oversized/wrong content, privacy and cleanup              |
| S11 | Supported mobile viewport with coherent recording geometry                                               | observed dimensions, reset, screenshots and native recording                   |
| S12 | Complete typed customer report and publication preview/receipt                                           | publication/readback, privacy separation, unknown fields, final retry          |
| S13 | Separate blocked/excluded/not-attempted reasons                                                          | old reports compatible, no false passes, counts reconcile                      |
| S14 | Bounded receipt refresh with waiting/provider timing facts                                               | cached receipt, delay, throttle, timeout and consistent envelope               |
| S15 | Restoration preflight and reduced human offloading in skills                                             | reader unavailable before removal, reuse actual approvals, no bypass           |
| S16 | Visible cleanup ledger and explicit credential retention                                                 | preserve shared/pre-existing resources, no values, safe expiry                 |

Additional findings: **S17** is the reproduced viewer mutation bypass; **S18** is
the container dependency regression introduced by the new evidence types.
**C01** tracks duplicate connection presentation without merging grants. All
three are included in the current status table below.

## Scope and invariants

Use contained corrections where one path is defective. Correct workflow,
recovery and reporting contracts across their existing owners. A foundational
rewrite is not selected: durable actions, origin scope, protected values,
ownership fencing and admitted evidence remain authoritative.

Convenience tools compose existing authorized operations. Every browser action
keeps its own stable identity and durable receipt. A sequence stops on failure,
uncertainty or unfinished work; retries retrieve earlier receipts instead of
redispatching writes. Known steps can be combined; steps depending on unseen
state still require observation. Host approvals apply to all proposed effects.

No promised speedup is inferred from fewer tool names. Compare a fixed fictional
journey's calls and returned bytes while preserving verified state and evidence.
No universal zero-regression guarantee is claimed; acceptance, sibling, failure
and production-shaped checks are release gates, with unavailable gates explicit.

## Current delivery status — review candidate

All identified Scry-owned source corrections are implemented in this local
candidate. The remaining capability campaign extends the earlier integrated
workflow; it does not replace or relabel its incomplete Vitract attempts. Initial
qualification made no release changes. The owner subsequently authorized push
and deployment through [PR #79](https://github.com/Kahmyl/scry/pull/79). See the current
[qualification report](../artifacts/assurance/remaining-workflow-20261110/report.md),
the earlier [integration report](../artifacts/assurance/integrated-workflow-20261110/report.md)
and `agent-workflow-rollout.md`. Local qualification is not live acceptance.

| ID  | Implemented correction and isolated evidence                                                                                                                                                                                        | Remaining acceptance / practical limit                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S01 | Scoped grant, registration, expiry, revocation, membership and historical-use diagnostics; dashboard details and client-reported missing-tool comparison; OAuth restart/rotation/scope regressions                                  | Actual Desktop idle/restart/disappearing tools remain unverified. Server facts cannot establish host discovery or repair an unproven provider defect.                   |
| S02 | Agent and dashboard incomplete-work finalization; stop/dispatch fencing; physical owner retirement, pending-command and sealed-evidence facts; replay and failure tests                                                             | Preserve uncertain business outcomes and earlier incomplete Runs. Live operational acceptance is separate.                                                              |
| S03 | Database-serialized deployment admission/refusal and controller rollback fixtures; serving release remains untouched on refusal                                                                                                     | Migration 0019 must be installed through the guarded migration path before the revised controller's first rollout. Live rollout is unperformed.                         |
| S04 | Page-specific masking reasons, admitted bounded history, recovery/closure intervals and seek controls; closed-popup dialog ownership repaired; truncation conservatively remains partial                                            | Masking remains best effort. Native browser UI, unknown content and unobserved intervals are not certified safe. Review before sharing remains required.                |
| S05 | Verified bounded-memory video ranges, private immutable read snapshots, scoped HttpOnly playback grants, renewal/revocation, frontend direct playback, actual Chromium seeking                                                      | Four concurrent read snapshots per API process, 128 MiB/source, 120-second renewable grant. Bytes already buffered cannot be recalled.                                  |
| S06 | Canonical HTML/text protected-link extraction with entity handling, deduplication, malformed/unsupported rejection and typed candidates                                                                                             | Real Priya invitation acceptance remains outside this fictional campaign; no Vitract finding is relabeled fixed.                                                        |
| S07 | One bounded context check; optional metadata failure isolation; factual dependency readiness and permission-aware capabilities                                                                                                      | Snapshot readiness is not a reservation. Provider health, host exposure and later state still require actual verification.                                              |
| S08 | Atomic journey setup, worker-owned guarded known-step sequences, durable prefixes and exact replay; revised ordered guidance                                                                                                        | Measured native comparison covers the same three observed login controls only. No universal latency or call-reduction guarantee.                                        |
| S09 | Worker-owned scoped JSON HTTP, private credential/body bindings, exact origin and pinned DNS/address checks, no redirects/retries, bounded redacted receipts and unknown-write quarantine                                           | Explicit origin scope required; private origins additionally need operator allowlisting. No ambient browser cookies, arbitrary binary response or HTTP approval bypass. |
| S10 | Session-local completed-download size/hash/format facts, explicit expectations, finite count/verification waits, timeout and late-completion refusal, private scratch disposal                                                      | 16 MiB verification, 20 receipts, two pending transfers. Progress cancellation is best effort and can overshoot; signatures do not prove document semantics.            |
| S11 | Four observed viewport profiles, coherent fixed-canvas native recording and capture-time alignment; four-edge PNG/MP4 checks                                                                                                        | Desktop 1280×720, mobile 390×720, landscape 720×390, tablet 768×720. Viewport resizing does not emulate phone hardware, touch or user agent.                            |
| S12 | Typed customer sections, preview, immutable publication/readback and exact evidence references; cleanup detail survives publication                                                                                                 | Preview is not privacy certification. Final published reports remain immutable.                                                                                         |
| S13 | Blocked, excluded and not-tested coverage stays separate; counts and legacy report navigation reconcile                                                                                                                             | Historical customer content is not retroactively recategorized.                                                                                                         |
| S14 | Bounded provider scheduling, metadata and transport/body waits; shared cooldown and timing facts; partial receipt preservation; cached cursor semantics; failed baseline reads release their lease                                  | Normal provider waiting is not an app defect. External Mail.tm/Hookdeck delivery and quotas were not exercised live.                                                    |
| S15 | Ordered discover/preflight/act/verify/reconcile/report guidance, restoration prerequisite checks, protected received-link workflow and reduced routine human offloading                                                             | Real restoration still depends on authorized available access and actual application acceptance. Never invent permissions or retention choices.                         |
| S16 | Persistent scoped cleanup intent and factual inventory; agent tools, Mission controls and report read-only view; shared credential retention, in-use revoke guards, pending cleanup/retry and customer mailbox disconnect semantics | Retention requires an actual authorized decision. Expiry does not prove external resource deletion. Provider failures remain pending.                                   |
| S17 | Newly discovered viewer authorization bypass repaired across old testing mutation controllers; cached observation GET and viewer playback remain usable; failing-before/passing-after reproduction                                  | Workspace readers must still be allowed to inspect evidence; denial is not implemented by hiding UI alone.                                                              |
| S18 | Container build includes Contracts source required by evidence types; the composed dashboard fixture uses same-origin HTTPS and asserts the unchanged Secure/HttpOnly/SameSite cookie policy                                        | Cached qualified OS/browser base reused. A fresh remote base and actual deployment are separate acceptance gates.                                                       |
| C01 | One presentation group per known workspace/client label, scoped diagnostics and separate underlying grant controls                                                                                                                  | No device identity is inferred; grouping never combines or revokes authorizations.                                                                                      |

## Qualification and review boundary

New journey/sequence behavior defaults off through
`SCRY_BROWSER_WORKFLOW_V1_ENABLED=false`. Native HTTP, download and viewport
capabilities default off through `SCRY_BROWSER_WORKFLOW_V2_ENABLED=false`.
Disabled admission is tested before command persistence; ordinary individual
controls remain available. Enabling V2 does not authorize extra origins or grant
extra workspace permissions.

The complete current source, raw results, red reproductions, corrected fixture
explanations, source hashes and review patch are retained in the current evidence
bundle. Earlier prototype checks, the previous independent blind campaign and
current scenario checks are reported separately, without adding repeated runs
as new coverage. No perfect or zero-regression claim is made.

Review the combined patch and the additive migration/rollout contract before any
push or production change. Actual Desktop/Windows behavior, live providers and
production rollout remain explicit external gates, rather than silently passed
local tests.

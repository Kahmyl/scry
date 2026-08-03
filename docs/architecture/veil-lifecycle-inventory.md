# Veil privacy lifecycle inventory

This inventory records the pre-Veil implementation boundary inspected on
2026-08-03. It is governing input to the Veil cutoff, not evidence that the
current system is production-ready.

## Ownership map

| Lifecycle | Current implementation | Current authority | Veil target owner | Current gap |
|---|---|---|---|---|
| Policy input | `ExecutionPolicy` in contracts; environment/API/MCP inputs | policy schema and runtime request policy | policy compiler | No privacy profiles, safety floor, immutable snapshot, digest, or restrictive merge. |
| Secret storage | credential controllers/repositories and credential crypto | API repository and environment allowlist | credential subsystem, constrained by Veil capabilities | Values are resolved into executor callbacks; safety subsequently depends on redactor registration and call-site discipline. |
| Protected execution | protected transaction coordinator and capsule | transaction coordinator plus `PrivacyGate` | runtime session and protected-operation lease | Gate capability is an object reference, not bound/expiring proof. |
| Runtime privacy state | `PrivacyGate` | executor-local mutable state | `VeilRuntimeSession` | State lacks policy/document/context epochs and lease invalidation. |
| Recording | recording coordinator | recording coordinator plus gate adapter | Veil recording collector | Real stop/gap behavior exists, but page/browser loss seals recording directly rather than the privacy session. |
| Trace | trace coordinator and trace sanitizer | trace coordinator | Veil trace collector and admission | Trace is sanitized after capture; no admission capability binds the segment. |
| Screenshot | direct Playwright screenshots in executor and visual grounding | individual call sites | Veil screenshot collector | Direct screenshot paths exist; action screenshots do not consult the gate, and visual grounding captures in memory outside admission. |
| DOM/accessibility | `page.content`, grounding/calibration/control observation | individual call sites | Veil structural collectors | Gate checks only requested DOM artifacts; internal observations and accessibility providers have no lease. |
| Diagnostics/events | page listeners, event JSONL, attempt report | emitter suppression and `SecretRedactor` | Veil diagnostic/event collectors | Passive gate acknowledgements do not prove listener buffering/suppression; report is written outside admission. |
| Network | request interception and body collection | request policy, redactor, gate callback | Veil network collector | Bodies can be collected before later artifact sanitation; collector acknowledgement is a no-op. |
| Clipboard/download | protected extractor; browser guards; downloads disabled | call sites and execution policy | Veil scoped collectors | Clipboard reads exist without a capability lease; policy forbids downloads but there is no unified disposition lifecycle. |
| Evidence construction | `availableArtifact` and literal manifests | executor, recording, trace | `VeilEvidenceAdmission` | Helper labels bytes `safe` without privacy proof. Multiple constructors bypass one admission boundary. |
| Durable storage | worker reads output files and calls `LocalArtifactStore.put` | worker plus repository provenance check | Veil admission store | Worker trusts executor availability/classification and copies bytes before repository admission. |
| Persistence | artifacts, timeline, capture epochs, observations | execution repository | Veil metadata repository | Provenance is required, but policy/decision/lease/admission digests and destruction proof are absent. |
| Retrieval | artifact service/controller, MCP resources, web blob readers | DB availability and workspace authorization | admitted-manifest projection | Any record marked available is retrievable; consumers cannot verify Veil admission. |
| Praxis | evidence providers, grounding, transaction/reporting | Praxis modules and executor | Praxis constrained by Veil leases | Providers self-declare privacy categories but do not request capabilities; reports may reference artifacts without Veil disposition. |
| Observation/UI | run observation service, MCP `get_run`, web dashboard | API projection | read-only Veil projections | Existing privacy timeline is gate/recording oriented and lacks effective profile, policy/decision digest, masks, omissions, and guidance. |
| Retention/destruction | artifact store delete and DB retention fields | storage/repository callers | Veil retention and destruction jobs | Delete primitive exists; no centrally enforced lifecycle or auditable proof ties it to quarantine/expiry. |
| Recovery | checkpoints, capture epochs, protected continuation | executor/coordinators | Veil runtime session | Context provenance exists, but privacy leases are not invalidated across document/context restoration. |

## Proven bypasses and unsafe representations

1. `availableArtifact` reads arbitrary bytes and always returns
   `privacyClassification: "safe"`; it requires no policy decision, collector
   acknowledgement, or admission capability.
2. The worker copies every artifact marked `available` into durable storage
   before `recordArtifact` validates only context/capture-epoch provenance. It
   trusts executor-supplied availability and privacy classification.
3. The explicit screenshot action creates an available artifact without calling
   `PrivacyGate.getDecision`; requested and failure screenshots have separate
   gate checks, so sibling capture paths diverge.
4. Visual grounding calls Playwright screenshot directly and retains image bytes
   in process outside the artifact manifest and privacy gate.
5. Screenshot, DOM, accessibility, diagnostics, network, and event/report
   collectors registered with the gate are no-ops. Their acknowledgement proves
   promise completion, not suppression or isolation.
6. DOM and network artifacts are sanitized after page/network capture. The
   `SecretRedactor` only knows values explicitly registered during execution and
   does not prove absence of unknown secrets, protected pixels, encoded forms,
   or derived values.
7. `attempt.json` and `events.jsonl` are written directly. Event emission is
   suppressed only while gate state is non-normal and is not admitted as
   evidence through one authority.
8. Trace and recording construct artifact manifests themselves. Trace safety is
   asserted after archive sanitation; recording safety is inferred from segment
   state rather than a common admission proof.
9. Praxis evidence providers collect public DOM, accessibility, and visual
   evidence by provider convention, not by scoped Veil capability. Praxis has
   no typed required/optional channel negotiation with privacy authority.
10. Artifact API, MCP, and web retrieval trust `availability === "available"`.
    There is no admission identifier, decision digest, policy digest, or current
    retention/destruction disposition to verify.
11. `PrivacyGate.getDecision` derives authority only from a global mutable state
    and channel. It is not bound to principal, environment, origin, transaction,
    browser context, page/frame, document epoch, operation, classification,
    scope, or expiry.
12. Page close and browser disconnect seal only the recording coordinator in
    their direct handlers. This permits sibling collector/session state to
    diverge during lifecycle loss.

## Required invariants and enforcement points

- Only Veil compiles effective privacy policy; most-restrictive-wins and the
  hard safety floor are invariant-preserving and deterministic.
- Every privacy-affecting operation validates a current, opaque capability at
  its execution boundary. Possession of an artifact path or object reference is
  never authority.
- Every collector transition has a manifest, observable state, timeout,
  idempotent acknowledgement, and fail-closed consequence.
- No protected value or pixel becomes evidence. Masking occurs before capture;
  uncertainty creates an omission, never post-capture repair.
- Only Veil admission can create an `available` artifact or store bytes. The DB
  record and bytes are committed consistently or the bytes are destroyed.
- Quarantined/destroyed bytes are irretrievable from API, MCP, UI, filesystem,
  caches, archives, reports, and recovery paths.
- Policy, document, frame, page, context, origin, cancellation, and expiry
  changes invalidate affected capabilities before further collection.
- Praxis can degrade optional evidence or fail required evidence, but cannot
  weaken Veil or translate a privacy failure into success.
- Public projections contain safe reason codes and digests only; protected
  values, selectors, mask source content, and internal capabilities never cross
  the boundary.

## Verification ownership

- Implementation owner supplies focused contract, lifecycle, failure, and
  migration evidence for each milestone.
- An independent architecture/privacy reviewer traces the entire affected
  lifecycle and records blocker/high findings in the readiness ledger.
- An independent verification reviewer audits whether the evidence actually
  proves the gate, including sibling paths and negative assertions.
- Any blocker/high finding reopens its originating milestone. Remediation must
  be followed by focused verification, independent re-review, and both complete
  Veil and Praxis campaign families when the finding crosses integration or
  cutoff boundaries.


# Protected lifecycle boundedness re-audit

Date: 2026-08-11

Scope: protected execution supervision and recovery activation. The durable
`protected_operations` state model, dispatch boundary, at-most-once semantics,
lease/fencing rules, and recovery classifications are unchanged.

## Invariant

Every externally controlled asynchronous protected stage has an explicit
lifecycle owner, a finite termination mechanism, and deterministic durable
timeout or process-loss semantics. Cooperative cancellation is not treated as
proof that underlying work stopped; durable late effects remain fenced.

## Stage ledger

| High-risk stage | Verdict | Enforced boundary and durable result |
| --- | --- | --- |
| Safe-context parking | `BOUNDED_BY_CALLER` | Veil collector and emitter deadlines; pre-dispatch failure settles not applied. |
| Portable storage-state export | `PROVEN_BOUNDED` | `portable_state_export` supervisor; pre-dispatch, safe retry. |
| Session-storage export | `PROVEN_BOUNDED` | `session_state_export` supervisor; pre-dispatch, safe retry. |
| Capsule/browser-context bootstrap | `PROVEN_BOUNDED` | `capsule_bootstrap` supervisor plus bounded destruction escalation. |
| Capsule preparation setup | `PROVEN_BOUNDED` | Owned by the capsule bootstrap stage. |
| Secret resolution and native preparation | `PROVEN_BOUNDED` | `protected_preparation` supervisor; pre-dispatch, no dispatch. |
| Preparation assertions | `PROVEN_BOUNDED` | Native/Praxis timeouts inside the outer preparation stage. |
| Calibration verification | `PROVEN_BOUNDED` | `calibration_verification` supervisor; pre-dispatch. |
| Preparation-boundary callback | `PROVEN_BOUNDED` | `preparation_verification_callback` supervisor; pre-dispatch. |
| Dispatch authorization repository work | `BOUNDED_BY_CALLER` | PostgreSQL connection, statement, lock, idle-transaction, and caller query deadlines. Commit/response ambiguity is recovered from durable state and never authorizes redispatch. |
| Context provenance: safe parked/protected | `PROVEN_BOUNDED` | Pre-dispatch supervised callbacks. |
| Context provenance: tainted/destroyed/resumed | `PROVEN_BOUNDED` | Post-dispatch supervised callbacks; stale durable writes require the current fence. |
| Mutation-dispatch callback | `PROVEN_BOUNDED` | Post-dispatch supervisor; timeout becomes recovery required. |
| Response-envelope acquisition | `PROVEN_BOUNDED` | Finite settlement, closed late admission, complete-set-only staging. A timed-out optional network adapter may fall through to another declared acquisition method. |
| Atomic output persistence | `BOUNDED_BY_CALLER` | Stage deadline plus one PostgreSQL transaction and fencing. Ambiguous caller acknowledgement is recovered from committed references. |
| Staged-output recovery | `BOUNDED_BY_CALLER` | Stage deadline plus current claim/fence; no redispatch. |
| Read-only staged-output disposal | `PROVEN_BOUNDED` | Authoritative `failed_not_applied` transition/lease-expiry claim deletes encrypted staging in the same transaction. |
| Clipboard finalization | `PROVEN_BOUNDED` | Per-attempt deadline; unverifiable clearing remains fail closed. |
| Capsule destruction | `PROVEN_BOUNDED` | Bounded context close followed by bounded browser termination fallback. |
| Protected repository heartbeat | `PROVEN_BOUNDED` | Every call and shutdown tail has a hard deadline. |
| Protected heartbeat ownership | `PROVEN_BOUNDED` | One outer owner spans dispatch through final durable settlement; one outer `finally` stops renewal on every return/failure. |
| Adaptive runtime heartbeat | `PROVEN_BOUNDED` | Bounded renewal and shutdown tail. |
| Capture settlement (`markCaptured`) | `PROVEN_BOUNDED` | Post-dispatch stage supervisor. |
| Custom reconciliation | `PROVEN_BOUNDED` | Post-dispatch stage supervisor; timeout cannot authorize retry. |
| Clean-session recreation | `PROVEN_BOUNDED` | Post-dispatch stage supervisor. |
| Reauthentication | `PROVEN_BOUNDED` | Post-dispatch stage supervisor. |
| Continuation browser work | `BOUNDED_BY_CALLER` | Declared Playwright/Praxis timeouts inside a lifecycle signal and stage-owned recreation/reauthentication. |
| Safe-boundary establishment | `PROVEN_BOUNDED` | Coordinator stage deadline plus bounded Veil emitter. |
| Safe-boundary collector confirmation | `PROVEN_BOUNDED` | Veil acknowledgement deadline. Failure seals and never resumes collectors. |
| Evidence resumption callback | `PROVEN_BOUNDED` | Post-confirmation supervisor with lifecycle signal; failure settles recovery required. |
| Final transition and record | `BOUNDED_BY_CALLER` | PostgreSQL deadline policy and current fence; heartbeat remains owned until execute returns. |
| Mission expired-operation activation | `RECOVERABLE_AFTER_PROCESS_LOSS` | Projection triggers the execution kernel for every unleased active state; the protected repository claim remains the sole recovery authority. |
| Authoring runtime shutdown | `PROVEN_BOUNDED` | Bounded heartbeat tail, browser/session close, and lease release. |

## PostgreSQL timeout and ambiguity policy

Defaults are connection 5 seconds, server statement 30 seconds, lock 5 seconds,
idle transaction 30 seconds, and caller query 35 seconds. The caller deadline is
longer than the server statement deadline so PostgreSQL normally supplies the
authoritative cancellation result. All values are configurable through the
corresponding `DATABASE_*_TIMEOUT_MS` environment variables.

A lost response is never interpreted as rollback. Recovery claims the durable
row with a new fence, observes an already committed complete reference map, and
does not dispatch again. A former owner cannot transition or persist with its
stale fence.

## Read-only staging lifecycle

Encrypted response staging is temporary recovery material only. When the
authoritative read-only operation becomes `failed_not_applied`, staging is
deleted in the same repository transaction. A retry therefore cannot consume a
stale staged set. No staged plaintext is stored or projected.

## Verification evidence

- Focused Executor lifecycle suites: 63 passed, 0 failed, 0 skipped.
- Focused API lifecycle suites: 60 passed, 0 failed, 0 skipped.
- Focused Veil suites: 18 passed, 0 failed, 0 skipped.
- Real protected Postgres integration: 14 passed, 0 failed, 0 skipped.
- Controlled qualification: readonly input, text output, and interrupted
  acquisition each dispatched exactly once. Successful scenarios committed two
  opaque references; interruption committed zero and settled recovery required.
- Execution-kernel, Mission authoring, privacy-foundation, and subsystem
  boundary checks passed.

Final blocking counts:

```text
STRUCTURAL_GAP = 0
UNPROVEN = 0
```

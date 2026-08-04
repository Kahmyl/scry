# Praxis runtime ownership

Praxis owns an interaction as one transaction, from admission through effect verification. Browser mutation, target identity, and document freshness are not caller responsibilities.

## Enforced invariants

1. A mutating transaction acquires the page mutation lane before observation and retains it through terminal verification. Observation, grounding, revalidation, dispatch, and verification therefore share one serialized view of the page.
2. Dispatch occurs at most once. A transaction never repairs stale evidence by redispatching.
3. Every target handle belongs to one page, one frame, one frame-document epoch, and one runtime element identity. Epoch changes invalidate observation caches. Handle use still requires target-specific semantic revalidation, so unrelated page animation cannot invalidate a stable control while a detached or replaced control remains unusable.
4. Grounding evaluates one bounded document graph. The main frame is always in scope; child frames are included only when their origin is explicitly authorized or they are opaque documents descended from an authorized frame.
5. Frame identity contributes to the sanitized target fingerprint. Identical controls in different documents remain distinct candidates and can be rejected as ambiguous.
6. The coordinator owns mutation-lane acquisition and release. The dispatcher owns browser control only and cannot create a second concurrency boundary.
7. Read-only transactions do not acquire the mutation lane. They remain concurrent but still require exact target revalidation and a passed local proof before success.
8. The transaction coordinator creates one monotonic dispatch boundary. Input resolution, read-only readiness checks, and final freshness checks occur before it. Focus, scrolling performed by an action, pointer movement, keyboard input, and activation are treated as browser control and occur only after the boundary. Only the dispatcher may cross it, exactly once, immediately before the mutating browser call.
9. Terminal status, mutation outcome, retry disposition, and safe actions derive from that boundary. Adapter errors cannot claim that mutation started or did not start independently.
10. Pointer activation is pinned to the exact element observed immediately before dispatch. A navigation-safe runtime receipt must prove that the exact element emitted the application click event; successful browser transport alone is insufficient. Replacement or frame detachment during activation therefore returns an inconclusive, unknown mutation with unsafe retry and can never activate a replacement target.

## Lifecycle

```text
admit request
  -> acquire mutation lane when required
  -> observe authorized document graph
  -> plan an operation- and role-aware bounded candidate inventory
  -> suppress ancestor noise and collapse semantically equivalent actions
  -> ground one frame-owned target deterministically
  -> revalidate runtime identity, capability, and semantic identity
  -> perform at most one bounded re-observation after a proven render transition
  -> arm authored effect observer
  -> prepare input and perform read-only readiness checks
  -> revalidate frame freshness
  -> pin the exact activation element and arm its local activation receipt
  -> record mutation boundary exactly once
  -> dispatch exactly once
  -> verify local state
  -> verify authored effect
  -> release mutation lane at the terminal result
```

Cancellation while waiting for the lane cannot dispatch. Cancellation or uncertainty after browser control begins retains the existing conservative `unknown` mutation outcome and unsafe retry disposition.

## Candidate and freshness policy

Grounding no longer starts from a flat, page-wide list of arbitrary containers. Preferred semantic roles define the primary inventory; operation capabilities define a bounded fallback; a diagnostic broad inventory is used only when no compatible family exists. Exact identity and role matches dominate containing text, ancestor containers cannot compete with equivalent descendants, and duplicate controls with the same exact semantic identity and destination count as one action.

Document epochs remain the authority for cache invalidation, not target truth. Target truth is established against the opaque runtime element identity immediately before dispatch. A changed target may trigger one pre-dispatch re-observation under the existing mutation lease; repeated change is a typed, non-mutating refusal. Praxis never revives an old handle and never retries after the mutation boundary.

## Compatibility boundary

Public API, MCP, persistence, durable event, and dashboard contracts are unchanged. Iframe support is an intentional capability expansion inside the existing allowed-origin policy. Legacy grounding entry points use the current page origin as their default frame boundary.

## Change verification gate

Every pull request or main-branch update that changes Praxis, its contracts, policy package, campaign verifiers, dependency lockfile, or Praxis architecture records triggers two required production-shaped CI jobs:

1. `Real HTTP production campaigns` runs the accepted baseline, 100-scenario, resilience, and adversarial-certification corpora with real Chrome against real local HTTP applications.
2. `Live public application campaign` runs the independent 25-application public HTTPS corpus with real Chrome and no external mutation.

Both jobs are blocking. They retain their complete campaign output for 30 days, report skipped and failed scenarios explicitly, and do not weaken expectations or silently retry failures. Docker publication reruns both campaign groups before any image is published, so a release cannot rely only on an earlier pull-request result.

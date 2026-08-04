# Threat model

## Protected assets

- Test credentials and secret references.
- Application data reachable during a run.
- Worker host, filesystem, network, and environment variables.
- Run plans, events, reports, screenshots, video, and traces.
- Integrity of test outcomes and audit history.

## Trust boundaries

- Test plans are untrusted, including plans produced by Codex.
- Application pages, DOM content, scripts, and network responses are untrusted.
- The API authenticates callers but does not make their plans safe.
- The worker is the final enforcement point and must not trust prior validation.
- Artifact viewers must treat captured HTML, text, URLs, and files as untrusted.

## Primary threats and Phase 0 controls

| Threat                             | Required control                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| SSRF or external navigation        | Exact HTTP(S) origin allowlist, enforced on every navigation and request         |
| Destructive application action     | MVP deny-by-default capability policy and staging-only guidance                  |
| Prompt injection from page content | No runtime AI or replanning in the MVP                                           |
| Secret disclosure                  | Plans use secret references; secret values are forbidden in stored events        |
| Infinite or expensive execution    | Wall-clock, action, and navigation budgets                                       |
| Arbitrary code execution           | No evaluate/script action in protocol v1                                         |
| Duplicate queue delivery           | Immutable attempts and fenced worker claims                                      |
| Worker crash                       | Heartbeat, terminal infrastructure status, and best-effort artifact finalization |
| Malicious artifact                 | Content-type validation, safe download behavior, and no inline active HTML       |
| Audit record tampering             | Append-only events and immutable execution snapshots                             |

## Navigation policy

- Only `http:` and `https:` are accepted.
- URLs are resolved and compared by origin, not by string prefix.
- Redirects are checked at every hop.
- Popups and new pages are blocked unless a future policy explicitly permits them.
- Worker-level request interception must enforce the same origin rule.
- Loopback, link-local, and private-network destinations require an explicit local
  development policy and must not be enabled by a submitted plan.

## Credential policy

- Plans may contain secret identifiers but never secret values.
- Secrets are resolved inside the execution boundary immediately before use.
- Planner/model inputs never receive resolved secrets.
- Events record the reference and operation, not the resolved value.
- Screenshots and traces are sensitive artifacts even when fields are masked.

## Residual MVP risks

A fresh Playwright context is not a security sandbox. It does not isolate the
worker process, host filesystem, browser vulnerabilities, or network. Hosted
production execution must progress to a fresh browser process and ultimately an
ephemeral container or job boundary per attempt.
